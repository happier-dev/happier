import test from 'node:test';
import assert from 'node:assert/strict';

import { ensureBetaReviewSubmission } from './testflight-beta-review.mjs';

function concurrentReviewError() {
  return Object.assign(new Error('another build is in review'), {
    status: 422,
    body: {
      errors: [{ code: 'ENTITY_UNPROCESSABLE.ANOTHER_BUILD_IN_REVIEW' }],
    },
  });
}

test('automatic beta review defers when another build in the train is already under review', async () => {
  const logs = [];
  await ensureBetaReviewSubmission({
    build: { id: 'build-264', relationships: {} },
    submitBetaReview: 'auto',
    request: async () => {
      throw concurrentReviewError();
    },
    log: (message) => logs.push(message),
  });
  assert.deepEqual(logs, [
    '[pipeline] deferred beta review submission for build build-264 because another build in the train is already under review',
  ]);
});

test('explicit beta review submission fails when another build is already under review', async () => {
  await assert.rejects(
    ensureBetaReviewSubmission({
      build: { id: 'build-264', relationships: {} },
      submitBetaReview: 'true',
      request: async () => {
        throw concurrentReviewError();
      },
    }),
    /another build is in review/,
  );
});

test('automatic beta review does not hide unrelated App Store Connect errors', async () => {
  const error = Object.assign(new Error('invalid submission'), {
    status: 422,
    body: { errors: [{ code: 'ENTITY_ERROR.INVALID' }] },
  });
  await assert.rejects(
    ensureBetaReviewSubmission({
      build: { id: 'build-264', relationships: {} },
      submitBetaReview: 'auto',
      request: async () => {
        throw error;
      },
    }),
    /invalid submission/,
  );
});
