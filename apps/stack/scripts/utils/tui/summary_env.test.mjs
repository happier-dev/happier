import test from 'node:test';
import assert from 'node:assert/strict';

import { mergeEnvForTuiSummary } from './summary_env.mjs';

test('mergeEnvForTuiSummary prefers process env values over stack env file', () => {
  const out = mergeEnvForTuiSummary({
    stackEnvFromFile: { HAPPIER_STACK_REPO_DIR: '/from/file', HAPPIER_STACK_STACK: 'file' },
    processEnv: { HAPPIER_STACK_REPO_DIR: '/from/process', HAPPIER_STACK_STACK: 'process' },
  });
  assert.equal(out.HAPPIER_STACK_REPO_DIR, '/from/process');
  assert.equal(out.HAPPIER_STACK_STACK, 'process');
});

test('mergeEnvForTuiSummary falls back to stack env file when process env is missing', () => {
  const out = mergeEnvForTuiSummary({
    stackEnvFromFile: { HAPPIER_STACK_REPO_DIR: '/from/file' },
    processEnv: {},
  });
  assert.equal(out.HAPPIER_STACK_REPO_DIR, '/from/file');
});

