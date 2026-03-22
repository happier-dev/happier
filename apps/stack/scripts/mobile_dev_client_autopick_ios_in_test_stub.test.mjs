import test from 'node:test';
import assert from 'node:assert/strict';
import { createMobileDevClientTestFixture } from './testkit/mobile_dev_client_testkit.mjs';

test('hstack mobile-dev-client autopicks ios when an iPhone is connected over USB', async (t) => {
  const fixture = await createMobileDevClientTestFixture(t, {
    importMetaUrl: import.meta.url,
    prefix: 'hstack-mobile-dev-client-autopick-ios-',
  });
  await fixture.writeAdbDevicesBin({ hasDevice: false });
  await fixture.writeXcrunListBin(`[
  {
    "identifier": "IOS-USB-1",
    "name": "Leeroy’s iPhone",
    "platform": "com.apple.platform.iphoneos",
    "interface": "usb",
    "available": true,
    "simulator": false
  }
]`);

  const env = fixture.buildEnv();
  const res = await fixture.run(['--install'], { env });
  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstderr:\n${res.stderr}\nstdout:\n${res.stdout}`);

  const parsed = JSON.parse(res.stdout.trim() || '{}');
  assert.equal(parsed.platform, 'ios');
  assert.equal(parsed.strategy, 'ios');
  const step0Args = Array.isArray(parsed.steps?.[0]?.args) ? parsed.steps[0].args.join(' ') : '';
  assert.ok(step0Args.includes('--run-ios'), `expected plan to include --run-ios\nstdout:\n${res.stdout}`);
});
