// @ts-check

import { publishBinaryReleaseMain } from './publishing/publish-binary-release.mjs';

publishBinaryReleaseMain({ productId: 'cli' }).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
