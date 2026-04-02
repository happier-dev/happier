import test from 'node:test';
import assert from 'node:assert/strict';

import { createMobileDevClientTestFixture } from './mobile_dev_client_testkit.mjs';

test('mobile dev-client testkit clears host Android SDK env vars unless explicitly requested', async (t) => {
  const prevAndroidHome = process.env.ANDROID_HOME;
  const prevAndroidSdkRoot = process.env.ANDROID_SDK_ROOT;

  process.env.ANDROID_HOME = '/tmp/host-android-home';
  process.env.ANDROID_SDK_ROOT = '/tmp/host-android-sdk-root';

  try {
    const fixture = await createMobileDevClientTestFixture(t, {
      importMetaUrl: import.meta.url,
      prefix: 'hstack-mobile-dev-client-env-sanitize-',
    });

    const envNoSdk = fixture.buildEnv();
    assert.equal(envNoSdk.ANDROID_HOME, undefined);
    assert.equal(envNoSdk.ANDROID_SDK_ROOT, undefined);

    const envWithSdk = fixture.buildEnv({ androidHome: true });
    assert.ok(String(envWithSdk.ANDROID_HOME || '').length > 0);
  } finally {
    if (prevAndroidHome == null) delete process.env.ANDROID_HOME;
    else process.env.ANDROID_HOME = prevAndroidHome;
    if (prevAndroidSdkRoot == null) delete process.env.ANDROID_SDK_ROOT;
    else process.env.ANDROID_SDK_ROOT = prevAndroidSdkRoot;
  }
});

