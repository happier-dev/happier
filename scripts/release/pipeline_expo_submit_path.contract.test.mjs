import test from 'node:test';
import assert from 'node:assert/strict';
import { createExpoSubmitFixture } from '../pipeline/expo/fixtures/expo-submit.mjs';

test('expo submit selects and verifies the exact latest Android cloud build before upload', (t) => {
  const { result, calls, restored } = createExpoSubmitFixture(t, { environment: 'dev', nonproduction: true, cloud: true, latest: true });
  assert.equal(result.status, 0, result.stderr);
  const upload = calls.find((call) => call.kind === 'eas' && call.args.includes('submit'));
  assert.ok(upload.args.includes('--id') && upload.args.includes('exact-build'));
  assert.ok(upload.args.includes('--profile') && upload.args.includes('publicdev'));
  assert.equal(upload.args.includes('--latest'), false);
  assert.equal(upload.appEnv, 'dev');
  assert.equal(restored, true);
});

test('expo submit supports --path for a verified local Android AAB', (t) => {
  const { result, calls, restored } = createExpoSubmitFixture(t, { environment: 'dev', nonproduction: true });
  assert.equal(result.status, 0, result.stderr);
  const upload = calls.find((call) => call.kind === 'eas' && call.args.includes('submit'));
  assert.ok(upload.args.includes('--path'));
  assert.match(upload.args[upload.args.indexOf('--path') + 1], /\.aab$/);
  assert.ok(upload.args.includes('--profile') && upload.args.includes('publicdev'));
  assert.equal(upload.args.includes('--latest'), false);
  assert.equal(upload.appEnv, 'dev');
  assert.equal(restored, true);
});
