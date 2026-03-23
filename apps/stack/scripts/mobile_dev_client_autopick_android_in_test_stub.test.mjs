import test from 'node:test';
import assert from 'node:assert/strict';
import { createMobileDevClientTestFixture } from './testkit/mobile_dev_client_testkit.mjs';

test('hstack mobile-dev-client autopicks android + adb serial when an Android device is connected', async (t) => {
  const fixture = await createMobileDevClientTestFixture(t, {
    importMetaUrl: import.meta.url,
    prefix: 'hstack-mobile-dev-client-autopick-android-',
  });
  await fixture.writeAdbDevicesBin();
  await fixture.writeNoopBin('java');
  await fixture.writeXcrunListBin();

  const env = fixture.buildEnv({ androidHome: true, expoToken: 'test-token' });
  const res = await fixture.run(['--install'], { env });
  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstderr:\n${res.stderr}\nstdout:\n${res.stdout}`);

  const parsed = JSON.parse(res.stdout.trim() || '{}');
  assert.equal(parsed.platform, 'android');
  assert.equal(parsed.strategy, 'expo_run_android');

  const step0Args = Array.isArray(parsed.steps?.[0]?.args) ? parsed.steps[0].args.join(' ') : '';
  assert.ok(step0Args.includes('--run-android'), `expected plan to include --run-android\nstdout:\n${res.stdout}`);
  assert.ok(step0Args.includes('--device=ABC123'), `expected plan to include autopicked --device=ABC123\nstdout:\n${res.stdout}`);
});
