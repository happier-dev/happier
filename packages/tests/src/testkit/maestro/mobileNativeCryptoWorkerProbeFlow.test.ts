import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const flowUrl = new URL('../../../suites/mobile-e2e/flows/F10.nativeCryptoWorkerProbe.yaml', import.meta.url);

const requiredProbeIds = [
  'native-crypto-worker-probe-status:pass',
  'native-crypto-worker-probe-module-available:pass',
  'native-crypto-worker-probe-batch-source:pass',
  'native-crypto-worker-probe-data-key:pass',
  'native-crypto-worker-probe-secretbox:pass',
  'native-crypto-worker-probe-aes-gcm:pass',
  'native-crypto-worker-probe-invalid-items:pass',
  'native-crypto-worker-probe-js-responsive:pass',
] as const;

describe('native crypto worker mobile probe flow', () => {
  it('asserts native runtime vector checks separately from onboarding', () => {
    const flow = readFileSync(flowUrl, 'utf8');

    expect(flow).toContain('_shared/connectUsingLaunchUrl.yaml');
    expect(flow).toContain('_shared/loginCreateAccount.yaml');
    expect(flow).toContain('${HAPPIER_E2E_MOBILE_APP_ID}:///dev/native-crypto-worker');
    expect(flow).toContain('${HAPPIER_E2E_MOBILE_APP_SCHEME}:///dev/native-crypto-worker');
    expect(flow).not.toContain('HAPPIER_E2E_DEV_CLIENT_NATIVE_CRYPTO_WORKER_LAUNCH_URL');
    for (const testId of requiredProbeIds) {
      expect(flow).toContain(`id: ${testId}`);
    }
  });
});
