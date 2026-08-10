// @ts-check

import { publishBinaryReleaseMain } from './publishing/publish-binary-release.mjs';

const TRANSIENT_UPLOAD_CONNECTIVITY_EXHAUSTED_EXIT_CODE = 75;

publishBinaryReleaseMain({ productId: 'server' }).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  const childStatus = error && typeof error === 'object' && 'status' in error
    ? Number(error.status)
    : 1;
  process.exit(
    childStatus === TRANSIENT_UPLOAD_CONNECTIVITY_EXHAUSTED_EXIT_CODE
      ? TRANSIENT_UPLOAD_CONNECTIVITY_EXHAUSTED_EXIT_CODE
      : 1,
  );
});
