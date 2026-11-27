export const PUBLIC_RENDERER_ASSET_PATHS: { readonly profile: string; readonly share: string };
export function preparePublicRendererAssets(input?: { projectDir?: string; traceInputs?: boolean }): Promise<string[]>;
