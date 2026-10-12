// PNG imports are inlined as base64 strings by esbuild (see esbuild.config.mjs).
declare module "*.png" {
	const base64: string;
	export default base64;
}
