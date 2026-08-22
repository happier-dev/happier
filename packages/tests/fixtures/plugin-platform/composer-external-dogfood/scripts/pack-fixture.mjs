import { resolve } from 'node:path';

import { runPackedComposerExternalDogfood } from '../../../../scripts/plugin-platform/run-packed-composer-external-dogfood.mjs';

const sdkTarballPath = process.env.HAPPIER_COMPOSER_DOGFOOD_SDK_TARBALL;
const pluginUiTarballPath = process.env.HAPPIER_COMPOSER_DOGFOOD_PLUGIN_UI_TARBALL;
if (!sdkTarballPath || !pluginUiTarballPath) {
  throw new Error(
    'Set HAPPIER_COMPOSER_DOGFOOD_SDK_TARBALL and HAPPIER_COMPOSER_DOGFOOD_PLUGIN_UI_TARBALL '
      + 'to the publisher-issued current SDK/Plugin UI tarballs. '
      + 'This fixture never packs source SDK or Plugin UI packages.',
  );
}

const result = await runPackedComposerExternalDogfood({
  sdkTarballPath: resolve(sdkTarballPath),
  pluginUiTarballPath: resolve(pluginUiTarballPath),
});
process.stdout.write(`${JSON.stringify(result)}\n`);
