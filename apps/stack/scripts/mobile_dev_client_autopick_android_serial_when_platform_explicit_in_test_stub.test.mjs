import test from 'node:test';
import assert from 'node:assert/strict';
import { createMobileDevClientTestFixture } from './testkit/mobile_dev_client_testkit.mjs';

test('hstack mobile-dev-client --platform=android autopicks adb serial when a single Android device is connected', async (t) => {
  const fixture = await createMobileDevClientTestFixture(t, {
    importMetaUrl: import.meta.url,
    prefix: 'hstack-mobile-dev-client-autopick-android-platform-',
  });
  await fixture.writeAdbDevicesBin();
  await fixture.writeNoopBin('java');

  const env = fixture.buildEnv({ androidHome: true });
  const res = await fixture.run(['--install', '--platform=android'], { env });
  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstderr:\n${res.stderr}\nstdout:\n${res.stdout}`);

  const parsed = JSON.parse(res.stdout.trim() || '{}');
  assert.equal(parsed.platform, 'android');

  const step0Args = Array.isArray(parsed.steps?.[0]?.args) ? parsed.steps[0].args.join(' ') : '';
  assert.ok(step0Args.includes('--device=ABC123'), `expected plan to include autopicked --device=ABC123\nstdout:\n${res.stdout}`);
});
