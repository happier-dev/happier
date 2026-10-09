import test from 'node:test';
import assert from 'node:assert/strict';
import { createExpoSubmitFixture } from '../pipeline/expo/fixtures/expo-submit.mjs';

test('expo submit attempts every requested prerelease platform but reports any submission failure', (t) => {
  for (const environment of ['preview', 'dev']) {
    const { result, calls, restored } = createExpoSubmitFixture(t, {
      environment, nonproduction: true, cloud: true, latest: true, platform: 'all', submitFailure: true,
    });
    assert.equal(result.status, 1, result.stderr || result.stdout);
    const uploads = calls.filter((call) => call.kind === 'eas' && call.args.includes('submit'));
    assert.deepEqual(uploads.map((call) => call.args[call.args.indexOf('--platform') + 1]), ['ios', 'android']);
    assert.match(result.stdout, new RegExp(`::warning::Expo submit failed for ios in ${environment}`));
    assert.match(result.stdout, new RegExp(`::warning::Expo submit failed for android in ${environment}`));
    assert.equal(restored, true);
  }
});
