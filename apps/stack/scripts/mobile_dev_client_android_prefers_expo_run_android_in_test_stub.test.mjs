import test from 'node:test';
import assert from 'node:assert/strict';
import { createMobileDevClientTestFixture } from './testkit/mobile_dev_client_testkit.mjs';

test('hstack mobile-dev-client --platform=android prefers expo run:android (test stub) when Android SDK is configured', async (t) => {
  const fixture = await createMobileDevClientTestFixture(t, {
    importMetaUrl: import.meta.url,
    prefix: 'hstack-mobile-dev-client-stub-',
  });
  await fixture.writeNoopBin('adb');
  await fixture.writeNoopBin('java');

  const env = fixture.buildEnv({ androidHome: true });
  const res = await fixture.run(['--install', '--platform=android'], { env });
  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstderr:\n${res.stderr}\nstdout:\n${res.stdout}`);

  const parsed = JSON.parse(res.stdout.trim() || '{}');
  assert.equal(parsed.platform, 'android');
  assert.equal(parsed.strategy, 'expo_run_android');
  const step0Args = Array.isArray(parsed.steps?.[0]?.args) ? parsed.steps[0].args.join(' ') : '';
  assert.ok(step0Args.includes('scripts/mobile.mjs'), `expected plan to run hstack mobile\nstdout:\n${res.stdout}`);
  assert.ok(step0Args.includes('--run-android'), `expected plan to include --run-android\nstdout:\n${res.stdout}`);
});
