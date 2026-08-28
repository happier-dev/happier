import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const flowUrl = new URL('../../../suites/mobile-e2e/flows/F10.nativeCryptoWorkerProbe.yaml', import.meta.url);
const revisionFlowUrl = new URL(
  '../../../suites/mobile-e2e/flows/_shared/loadedBundleRevisionProbe.yaml',
  import.meta.url,
);
const currentSourceProbeUrl = new URL(
  '../../../suites/mobile-e2e/flows/plugin-platform-current-source/native-module-probe.yaml',
  import.meta.url,
);

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

  it('keeps loaded revision assertion in one non-overridable runner-owned flow', () => {
    const probe = readFileSync(flowUrl, 'utf8');
    const currentSourceProbe = readFileSync(currentSourceProbeUrl, 'utf8');
    const revisionProbe = readFileSync(revisionFlowUrl, 'utf8');
    const marker = 'native-crypto-worker-probe-loaded-bundle-revision:${HAPPIER_E2E_EXPECTED_LOADED_BUNDLE_REVISION}';

    expect(probe).not.toContain(marker);
    expect(currentSourceProbe).not.toContain(marker);
    expect(revisionProbe).toContain(`id: ${marker}`);
    expect(revisionProbe).toContain('clearState: false');
  });
});
