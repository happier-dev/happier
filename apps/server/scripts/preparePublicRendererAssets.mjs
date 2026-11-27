import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export { PUBLIC_RENDERER_ASSET_PATHS } from './publicRendererAssetPaths.mjs';

export async function preparePublicRendererAssets({
  projectDir = resolve(dirname(fileURLToPath(import.meta.url)), '..'),
  traceInputs = false,
} = {}) {
  const { buildPublicProfileRenderer } = await import('./buildPublicProfileRenderer.mjs');
  const { buildPublicShareViewerBundle } = await import('./buildPublicShareViewer.mjs');
  const options = { projectDir, traceInputs };
  const profile = await buildPublicProfileRenderer(options);
  const share = await buildPublicShareViewerBundle(options);
  return [...profile.inputPaths, ...share.inputPaths];
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await preparePublicRendererAssets();
}
