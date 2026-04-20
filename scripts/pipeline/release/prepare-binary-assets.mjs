// @ts-check

import { prepareBinaryAssetsMain } from './publishing/prepare-binary-assets.mjs';

prepareBinaryAssetsMain().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
