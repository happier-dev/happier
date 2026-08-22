import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  appendMobileUcxNativeRowAttestation,
  appendMobilePluginPlatformCandidateRunAttestation,
  resolveMobilePluginPlatformCandidateMetroDevClientAttestationBlocker,
  type MobilePluginPlatformCandidateRunAttestationInput,
} from './mobilePluginPlatformCandidateAttestation';

describe('appendMobilePluginPlatformCandidateRunAttestation', () => {
  const candidate = {
    runId: 'candidate-run-1',
    sdk: {
      packageName: '@happier-dev/plugin-sdk',
      version: '1.2.3',
      integrity: 'sha512-sdk',
    },
    pluginUi: {
      packageName: '@happier-dev/plugin-ui',
      version: '1.2.3',
      integrity: 'sha512-ui',
    },
    cli: {
      packageName: '@happier-dev/cli',
      version: '1.2.3',
      integrity: 'sha512-cli',
    },
  } as const;

  const ucxContributor = {
    v1: {
      archiveSha256: 'sha256:ucx-v1',
      appliedGeneration: 'generation-v1',
    },
    v2: {
      archiveSha256: 'sha256:ucx-v2',
      appliedGeneration: 'generation-v2',
    },
  } as const;

  async function createMetroDevClientManifest(): Promise<string> {
    const runDir = await mkdtemp(join(tmpdir(), 'happier-mobile-candidate-attestation-'));
    const manifestPath = join(runDir, 'manifest.json');
    await writeFile(manifestPath, `${JSON.stringify({
      tool: 'maestro',
      runId: 'maestro-run-1',
      platform: 'android',
      deviceId: 'emulator-5554',
      appId: 'dev.happier.app.publicdev.devclient',
      metroUrlHost: 'http://127.0.0.1:8081',
      metroUrlDevice: 'http://10.0.2.2:8081',
      devClientLaunchUrl: 'exp+dev://expo-development-client/?url=http%3A%2F%2F10.0.2.2%3A8081',
      env: { androidDevClientRuntimeVersion: 'runtime-fingerprint' },
      preservedRunnerFact: true,
    }, null, 2)}\n`, 'utf8');
    return manifestPath;
  }

  it('records row-local artifacts with an independently observed loaded native identity', async () => {
    const manifestPath = await createMetroDevClientManifest();

    const outcome = await appendMobileUcxNativeRowAttestation({
      manifestPath,
      row: {
        sdk: candidate.sdk,
        pluginUi: candidate.pluginUi,
        cli: candidate.cli,
        plugin: {
          id: 'examples.packed-targeted-projection-contributor',
          v1: {
            version: '1.0.0',
            archiveSha256: 'sha256:ucx-v1',
            appliedGeneration: 'generation-v1',
          },
          v2: {
            version: '1.0.1',
            archiveSha256: 'sha256:ucx-v2',
            appliedGeneration: 'generation-v2',
          },
        },
      },
      installedApp: {
        kind: 'android-base-apk',
        baseApkSha256: 'sha256:android-apk',
        runtimeVersion: 'runtime-fingerprint',
      },
      loadedRuntime: {
        kind: 'observed',
        fullMetroReload: true,
        fastRefresh: 'disabled_via_expo_no_dev',
        bundle: {
          url: 'http://10.0.2.2:8081/apps/ui/index.ts.bundle?platform=android&dev=false',
          revision: 'sha256:metro-bundle',
        },
        deviceReportedBundle: {
          revision: 'sha256:metro-bundle',
        },
        moduleProbe: {
          flow: 'suites/mobile-e2e/flows/F10.nativeCryptoWorkerProbe.yaml',
          status: 'passed',
        },
      },
    });

    const written = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
    expect(outcome).toMatchObject({
      status: 'observed',
      row: {
        sdk: candidate.sdk,
        pluginUi: candidate.pluginUi,
        cli: candidate.cli,
        plugin: {
          id: 'examples.packed-targeted-projection-contributor',
          v2: { archiveSha256: 'sha256:ucx-v2' },
        },
      },
      loadedRuntime: {
        bundle: { revision: 'sha256:metro-bundle' },
        moduleProbe: { status: 'passed' },
      },
    });
    expect(written).toMatchObject({
      pluginPlatformUcxNativeAttestation: {
        v: 1,
        status: 'observed',
        row: {
          sdk: candidate.sdk,
          pluginUi: candidate.pluginUi,
          cli: candidate.cli,
        },
        selectedApp: {
          platform: 'android',
          installedApp: {
            kind: 'android-base-apk',
            baseApkSha256: 'sha256:android-apk',
            capturePoint: 'before_maestro_process_start',
          },
        },
        loadedRuntime: {
          fullMetroReload: true,
          fastRefresh: 'disabled_via_expo_no_dev',
          bundle: { revision: 'sha256:metro-bundle' },
          deviceReportedBundle: { revision: 'sha256:metro-bundle' },
          moduleProbe: { status: 'passed' },
        },
      },
    });
    expect(JSON.stringify(written)).not.toContain('candidate-run-1');
  });

  it('keeps host-served bundle evidence and a passing module probe blocked when the selected device reports a different digest', async () => {
    const manifestPath = await createMetroDevClientManifest();
    const hostServedRuntime = {
      kind: 'observed' as const,
      fullMetroReload: true as const,
      fastRefresh: 'disabled_via_expo_no_dev' as const,
      bundle: {
        url: 'http://10.0.2.2:8081/apps/ui/index.ts.bundle?platform=android&dev=false',
        revision: 'sha256:host-served-bundle',
      },
      deviceReportedBundle: {
        revision: 'sha256:another-device-loaded-bundle',
      },
      moduleProbe: {
        flow: 'suites/mobile-e2e/flows/F10.nativeCryptoWorkerProbe.yaml' as const,
        status: 'passed' as const,
      },
    };

    const outcome = await appendMobileUcxNativeRowAttestation({
      manifestPath,
      row: {
        sdk: candidate.sdk,
        pluginUi: candidate.pluginUi,
        cli: candidate.cli,
        plugin: {
          id: 'examples.packed-targeted-projection-contributor',
          v1: {
            version: '1.0.0',
            archiveSha256: 'sha256:ucx-v1',
            appliedGeneration: 'generation-v1',
          },
          v2: {
            version: '1.0.1',
            archiveSha256: 'sha256:ucx-v2',
            appliedGeneration: 'generation-v2',
          },
        },
      },
      installedApp: {
        kind: 'android-base-apk',
        baseApkSha256: 'sha256:android-apk',
        runtimeVersion: 'runtime-fingerprint',
      },
      loadedRuntime: hostServedRuntime,
    });

    expect(outcome).toMatchObject({
      status: 'blocked',
      blocker: {
        code: 'loaded_native_identity_unavailable',
        detail: expect.stringContaining('does not match'),
      },
    });
    expect(JSON.stringify(outcome)).not.toContain('"status":"observed"');
  });

  it('returns the same typed blocker before Maestro can start against the Metro dev-client topology', () => {
    const outcome = resolveMobilePluginPlatformCandidateMetroDevClientAttestationBlocker({
      candidate,
      installedApp: {
        kind: 'android-base-apk',
        baseApkSha256: 'sha256:android-apk',
        runtimeVersion: 'runtime-fingerprint',
      },
    });

    expect(outcome).toMatchObject({
      kind: 'blocked',
      code: 'exact_device_loaded_javascript_identity_unavailable',
      candidateRunId: 'candidate-run-1',
      topology: 'expo-dev-client-metro',
    });
    expect(outcome.wakeCondition).toContain('digest from the selected device');
    expect(outcome.wakeCondition).toContain('candidate run');
  });

  it('does not mistake an iOS app-bundle identity for a device-loaded JavaScript identity', () => {
    const outcome = resolveMobilePluginPlatformCandidateMetroDevClientAttestationBlocker({
      candidate,
      installedApp: {
        kind: 'ios-app-bundle-file-set',
        appBundleFileSetSha256: 'sha256:ios-app-bundle',
      },
    });

    expect(outcome).toMatchObject({
      kind: 'blocked',
      code: 'exact_device_loaded_javascript_identity_unavailable',
      topology: 'expo-dev-client-metro',
    });
  });

  it('records a typed blocker instead of a candidate success when Metro cannot prove device-loaded JavaScript identity', async () => {
    const manifestPath = await createMetroDevClientManifest();
    const outcome = await appendMobilePluginPlatformCandidateRunAttestation({
      manifestPath,
      candidate,
      installedApp: {
        kind: 'android-base-apk',
        baseApkSha256: 'sha256:android-apk',
        runtimeVersion: 'runtime-fingerprint',
      },
      ucxContributor,
    });

    const written = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
    expect(outcome).toMatchObject({
      kind: 'blocked',
      code: 'exact_device_loaded_javascript_identity_unavailable',
      candidateRunId: 'candidate-run-1',
      topology: 'expo-dev-client-metro',
    });
    expect(written).toMatchObject({
      tool: 'maestro',
      runId: 'maestro-run-1',
      preservedRunnerFact: true,
      pluginPlatformCandidateAttestation: {
        v: 1,
        status: 'blocked',
        candidate: {
          runId: 'candidate-run-1',
          sdk: {
            packageName: '@happier-dev/plugin-sdk',
            version: '1.2.3',
            integrity: 'sha512-sdk',
          },
          pluginUi: {
            packageName: '@happier-dev/plugin-ui',
            version: '1.2.3',
            integrity: 'sha512-ui',
          },
          cli: {
            packageName: '@happier-dev/cli',
            version: '1.2.3',
            integrity: 'sha512-cli',
          },
        },
        selectedApp: {
          platform: 'android',
          deviceId: 'emulator-5554',
          appId: 'dev.happier.app.publicdev.devclient',
          installedApp: {
            kind: 'android-base-apk',
            baseApkSha256: 'sha256:android-apk',
            runtimeVersion: 'runtime-fingerprint',
            capturePoint: 'before_maestro_process_start',
          },
        },
        blocker: {
          kind: 'blocked',
          code: 'exact_device_loaded_javascript_identity_unavailable',
          candidateRunId: 'candidate-run-1',
          topology: 'expo-dev-client-metro',
        },
        ucxContributor: {
          v1: {
            archiveSha256: 'sha256:ucx-v1',
            appliedGeneration: 'generation-v1',
          },
          v2: {
            archiveSha256: 'sha256:ucx-v2',
            appliedGeneration: 'generation-v2',
          },
        },
      },
    });
    expect(JSON.stringify(written)).not.toContain('unattested');
  });

  it('blocks before any candidate claim when selected installed-app identity is unavailable', async () => {
    const manifestPath = await createMetroDevClientManifest();
    const input: MobilePluginPlatformCandidateRunAttestationInput = {
      manifestPath,
      candidate,
      installedApp: {
        kind: 'unavailable',
        reason: 'selected_android_base_apk_could_not_be_attested',
      },
      ucxContributor,
    };

    const outcome = await appendMobilePluginPlatformCandidateRunAttestation(input);
    const written = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;

    expect(outcome).toMatchObject({
      kind: 'blocked',
      code: 'installed_app_identity_unavailable',
      candidateRunId: 'candidate-run-1',
      topology: 'expo-dev-client-metro',
      detail: 'selected_android_base_apk_could_not_be_attested',
    });
    expect(written).toMatchObject({
      pluginPlatformCandidateAttestation: {
        status: 'blocked',
        selectedApp: {
          installedApp: {
            kind: 'unavailable',
            reason: 'selected_android_base_apk_could_not_be_attested',
            capturePoint: 'before_maestro_process_start',
          },
        },
        blocker: {
          code: 'installed_app_identity_unavailable',
        },
      },
    });
  });
});
