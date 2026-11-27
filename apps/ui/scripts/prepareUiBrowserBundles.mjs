import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { UI_BROWSER_BUNDLE_PATHS } from './sourceUiAssetPaths.mjs';

export async function prepareUiBrowserBundles({
  uiPackageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..'),
} = {}) {
  const repoRoot = resolve(uiPackageDir, '../..');
  const { buildHostedHtmlGuestBootstrap } = await import('../../../packages/plugin-sdk/scripts/buildHostedHtmlGuestBootstrap.mjs');
  await buildHostedHtmlGuestBootstrap({
    packageRoot: resolve(repoRoot, 'packages/plugin-sdk'),
    outputFile: resolve(uiPackageDir, UI_BROWSER_BUNDLE_PATHS.hostedGuest),
    // Hosted HTML draws plugin-ui's controls from plugin-ui's own metrics.
    presentationKit: resolve(repoRoot, 'packages/plugin-ui/src/hostedHtml/hostedHtmlKit.ts'),
  });
  const { buildStreamWebViewBundle } = await import('../tools/stream/buildStreamWebViewBundle.mjs');
  await buildStreamWebViewBundle({ expoAppDir: uiPackageDir });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await prepareUiBrowserBundles();
}
