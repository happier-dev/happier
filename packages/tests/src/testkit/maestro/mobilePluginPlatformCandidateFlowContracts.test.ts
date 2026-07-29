import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const flowRoot = new URL('../../../suites/mobile-e2e/flows/plugin-platform-candidate/', import.meta.url);
const bootstrapRoot = new URL('../../../suites/mobile-e2e/flows/_bootstrap/', import.meta.url);
const sharedFlowRoot = new URL('../../../suites/mobile-e2e/flows/_shared/', import.meta.url);

function readFlow(name: string): string {
  return readFileSync(new URL(name, flowRoot), 'utf8');
}

describe('Plugin Platform exact-candidate native Maestro flow contracts', () => {
  it('covers the complete connected lifecycle with stable accessibility ids', () => {
    const online = readFlow('online-install-and-inspector.yaml');
    const updated = readFlow('updated-cache-replacement.yaml');
    const offline = readFlow('offline-read-only.yaml');
    const reconnected = readFlow('reconnected.yaml');
    const rolledBack = readFlow('rolled-back.yaml');
    const uninstalled = readFlow('uninstalled.yaml');
    const combined = [online, updated, offline, reconnected, rolledBack, uninstalled].join('\n');

    expect(online).toContain('settings.plugins.marketplace.installed.${HAPPIER_E2E_PLUGIN_ID}');
    expect(online).toContain('.action.disable');
    expect(online).toContain('.action.enable');
    expect(online).toContain('inspector-reload-${HAPPIER_E2E_PLUGIN_ID}');
    expect(online).toContain('candidate-native-host-api-ok');
    expect(online).toContain('candidate-native-crash-trigger');
    expect(online).toContain('plugin-rn-ui-unavailable');
    expect(online.match(/id: \$\{HAPPIER_E2E_PLUGIN_TAB_ID\}/g)).toHaveLength(2);
    expect(online).toContain('settings.plugins.management.diagnostics.live');
    expect(updated).toContain('${HAPPIER_E2E_PLUGIN_SENTINEL_V2}');
    expect(updated).toContain('assertNotVisible:\n    id: ${HAPPIER_E2E_PLUGIN_SENTINEL_V1}');
    expect(offline).toContain('settings.plugins.marketplace.readOnlySnapshot');
    expect(reconnected).toContain('assertNotVisible:\n    id: settings.plugins.marketplace.readOnlySnapshot');
    expect(rolledBack).toContain('${HAPPIER_E2E_PLUGIN_SENTINEL_V1}');
    expect(uninstalled).toContain('assertNotVisible:\n    id: ${HAPPIER_E2E_PLUGIN_TAB_ID}');
    expect((combined.match(/takeScreenshot:/g) ?? []).length).toBeGreaterThanOrEqual(6);

    expect(combined).toContain('id: ${HAPPIER_E2E_PLUGIN_TAB_ID}');
    expect(combined).not.toContain('app-scope-right-sidebar-tab:plugin:acme.native-candidate:main');
    expect(combined).not.toContain('candidate-native-version-1.0.0');
    expect(combined).not.toContain('candidate-native-version-1.1.0');
    expect(combined).not.toMatch(/(?:tapOn|assertVisible|assertNotVisible):\s+["'][^"']+["']/u);
    expect(combined).not.toContain('\n    text:');
  });

  it('clears persisted app credentials before creating the isolated connected-machine account', () => {
    const bootstrap = readFileSync(
      new URL('connectedMachineTerminalAuth.yaml', bootstrapRoot),
      'utf8',
    );

    expect(bootstrap).toContain('clearState: true');
    expect(bootstrap).toContain('clearKeychain: true');
  });

  it('dismisses the one-time mobile brand hero after the clean credential reset', () => {
    const connectDevClient = readFileSync(
      new URL('connectDevClientIfNeeded.yaml', sharedFlowRoot),
      'utf8',
    );

    expect(connectDevClient).toContain('id: brand-hero-get-started');
    expect(connectDevClient).toContain('tapOn:\n          id: brand-hero-get-started');
    expect(
      (connectDevClient.match(/First time here\.\*/gu) ?? []).length,
    ).toBeGreaterThanOrEqual(3);
  });

  it('uses the current welcome decision owner ids for relay setup and account creation', () => {
    const flowByName = new Map([
      'configureServerIfNeeded.yaml',
      'loginCreateAccount.yaml',
      'waitForWelcomeCreateAccount.yaml',
    ].map((name) => [name, readFileSync(new URL(name, sharedFlowRoot), 'utf8')]));
    const combined = [...flowByName.values()].join('\n');

    expect(combined).toContain('id: welcome-decision-panel');
    expect(combined).toContain('id: welcome-primary-start');
    expect(combined).not.toContain('id: welcome-hero');
    expect(combined).not.toContain('id: welcome-create-account');
    expect(flowByName.get('configureServerIfNeeded.yaml')).toContain(
      'file: acceptIosOpenInPromptMaybe.yaml',
    );
  });

  it('binds source builds and both platform commands to explicit packed inputs', () => {
    const cliSource = readFileSync(new URL('./mobilePluginPlatformCandidateCli.ts', import.meta.url), 'utf8');
    const packageJson = readFileSync(new URL('../../../package.json', import.meta.url), 'utf8');

    expect(cliSource).toContain("'HAPPIER_E2E_PLUGIN_PLATFORM_CANDIDATE'");
    expect(cliSource).not.toContain("'HAPPIER_E2E_PLUGIN_PLATFORM_SDK_TARBALL'");
    expect(cliSource).not.toContain("'HAPPIER_E2E_PLUGIN_PLATFORM_CLI_TARBALL'");
    expect(cliSource).toContain("'HAPPIER_E2E_PLUGIN_PLATFORM_REUSE_CLI_INSTALL_ROOT'");
    expect(cliSource).not.toContain('preparePluginPlatformTarballQa');
    expect(cliSource).toContain('preparePluginPlatformCandidateQa');
    expect(cliSource).toContain('preparePackedNovelConnectedAccountDeviceQa');
    expect(cliSource).toContain(
      "'HAPPIER_E2E_PACKED_NOVEL_QA_HANDOFF_MANIFEST'",
    );
    expect(cliSource).toContain('packedNovelConnectedAccount.pluginArchivePath');
    expect(cliSource).toContain(
      'packedNovelConnectedAccount.isolation.happyHomeDir',
    );
    expect(cliSource).toContain(
      'packedNovelConnectedAccount.isolation.databasePath',
    );
    expect(cliSource).not.toContain(
      'packedNovelConnectedAccount.isolation.pluginRoot',
    );
    expect(cliSource).not.toContain(
      'packedNovelConnectedAccount.isolation.configRoot',
    );
    expect(cliSource).toContain(
      'startPackedNovelConnectedAccountProvider',
    );
    expect(cliSource).toContain('findSensitiveArtifactFiles');
    expect(cliSource).toContain(
      'rootPath: packedNovelConnectedAccount.isolation.root',
    );
    expect(cliSource).toContain('rootPath: mobileMaestroLogsRoot');
    expect(cliSource).toContain('packedNovelManualToken');
    expect(cliSource).toContain('PACKED_NOVEL_DEVICE_ACCOUNT_SECRET');
    expect(cliSource).toContain('PACKED_NOVEL_DEVICE_ISSUED_CREDENTIAL');
    expect(cliSource).toContain('strict: true');
    expect(cliSource).toContain(
      'packed_novel_device_sensitive_artifact_leak_detected',
    );
    expect(
      cliSource.lastIndexOf('findSensitiveArtifactFiles({'),
    ).toBeGreaterThan(
      cliSource.lastIndexOf('await stopPackedDaemon()'),
    );
    expect(cliSource).toContain('resolveReusablePackedCliEntrypoint');
    expect(cliSource).toContain("HAPPIER_E2E_PLUGIN_PLATFORM_PREPARE_ONLY === '1'");
    expect(cliSource).toContain('cliLaunchSpec: {');
    expect(cliSource).toContain('args: [prepared.cliEntrypoint]');
    expect(cliSource).toContain('randomUUID()');
    expect(cliSource).toContain('const pluginId = `acme.native-candidate-${executionId}`');
    expect(cliSource).toContain('HAPPIER_E2E_PLUGIN_SENTINEL_V1');
    expect(cliSource).toContain('HAPPIER_E2E_PLUGIN_SENTINEL_V2');
    expect(cliSource).toContain("'@happier-dev/plugin-sdk': `file:${input.sdkTarballPath}`");
    expect(cliSource).toContain("'@swc/helpers': '0.5.23'");
    expect(cliSource).toContain("platforms: ['ios', 'android']");
    expect(cliSource).toContain('v1NativeArtifacts.iosDigest === v2NativeArtifacts.iosDigest');
    expect(cliSource).toContain('context.hostApi.context()');
    expect(cliSource).toContain('testID="candidate-native-host-api-ok"');
    expect(cliSource).toContain('accessibilityLabel="Test plugin failure isolation"');
    expect(cliSource).toContain("if (crashRequested) throw new Error('candidate_native_requested_crash')");
    expect(packageJson).toContain('test:mobile:e2e:ios:plugin-platform-candidate');
    expect(packageJson).toContain('test:mobile:e2e:android:plugin-platform-candidate');
  });

  it('keeps device acceptance on manual and device modes while OAuth remains browser-owned', () => {
    const flow = readFlow('packed-novel-manual-device.yaml');

    expect(flow).toContain('id: connected-account-mode:manual');
    expect(flow).toContain('id: connected-account-mode:device');
    expect(flow).toContain('id: connected-account-mode:oauth');
    expect(flow).toContain('tapOn:\n    id: connected-account-mode:manual');
    expect(flow).toContain('id: connected-account-manual:token');
    expect(flow).toContain('id: connected-account-manual:submit');
    expect(flow).toContain('id: connected-account:account-a');
    expect(flow).toContain('tapOn:\n    id: connected-account-mode:device');
    expect(flow).toContain(
      'inputText: ${HAPPIER_E2E_PACKED_NOVEL_PROVIDER_ORIGIN}',
    );
    expect(flow).toContain(
      'inputText: ${HAPPIER_E2E_PACKED_NOVEL_ACCOUNT_SECRET}',
    );
    expect(
      (
        flow.match(
          /tapOn:\n    id: connected-account-device:poll/gu,
        ) ?? []
      ),
    ).toHaveLength(2);
    expect(flow).toContain('id: connected-account:device-account');
    expect(flow).not.toContain(
      'tapOn:\n    id: connected-account-mode:oauth',
    );
    expect(flow).not.toContain('connected-account-oauth:open');
  });
});
