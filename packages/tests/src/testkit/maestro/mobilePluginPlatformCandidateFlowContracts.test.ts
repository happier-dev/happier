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
    const trustRevoked = readFlow('trust-revoked.yaml');
    const rolledBack = readFlow('rolled-back.yaml');
    const uninstalled = readFlow('uninstalled.yaml');
    const combined = [online, updated, offline, reconnected, trustRevoked, rolledBack, uninstalled].join('\n');

    expect(online).toContain('settings.plugins.marketplace.installed.${HAPPIER_E2E_PLUGIN_ID}');
    expect(online).toContain('.action.disable');
    expect(online).toContain('.action.enable');
    expect(online).toContain('inspector-reload-selected-${HAPPIER_E2E_PLUGIN_ID}');
    expect(online).not.toContain('inspector-reload-all');
    expect(online).toContain('candidate-native-host-api-ok');
    expect(online).toContain('candidate-native-crash-trigger');
    expect(online).toContain('plugin-rn-ui-unavailable');
    expect(online.match(/id: \$\{HAPPIER_E2E_PLUGIN_TAB_ID\}/g)).toHaveLength(2);
    expect(online).toContain('settings.plugins.management.diagnostics.live');
    expect(updated).toContain('${HAPPIER_E2E_PLUGIN_SENTINEL_V2}');
    expect(updated).toContain('assertNotVisible:\n    id: ${HAPPIER_E2E_PLUGIN_SENTINEL_V1}');
    expect(updated).toContain('voice-surface-status:sidebar:disconnected');
    expect(offline).toContain('settings.plugins.marketplace.readOnlySnapshot');
    expect(reconnected).toContain('packed-targeted-provider-title');
    expect(reconnected).toContain('packed-targeted-context-action');
    expect(reconnected).toContain('settings.voice.provider.examples.packed-targeted-projection-contributor%2Fpacked-conversation.default');
    expect(trustRevoked).toContain('plugin-app-page-unavailable');
    expect(trustRevoked).toContain('assertNotVisible:\n    id: packed-targeted-context-action');
    expect(trustRevoked).toContain('settings.voice.provider.off');
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

  it('consumes the packed targeted client Action fixture through the incumbent online, replacement, offline, and live-v2 lifecycle phases', () => {
    const online = readFlow('online-install-and-inspector.yaml');
    const updated = readFlow('updated-cache-replacement.yaml');
    const offline = readFlow('offline-read-only.yaml');
    const reconnected = readFlow('reconnected.yaml');
    const trustRevoked = readFlow('trust-revoked.yaml');
    const uninstalled = readFlow('uninstalled.yaml');
    const qaSource = readFileSync(
      new URL('./pluginPlatformCandidateQa.ts', import.meta.url),
      'utf8',
    );

    for (const flow of [online, updated, offline]) {
      expect(flow).toContain('packed-targeted-provider-title');
      expect(flow).toContain('packed-targeted-context-action');
      expect(flow).toContain('packed-targeted-context-result');
      expect(flow).toContain('packed-targeted-web-only-context-action');
    }
    expect(online).toContain('packed-targeted-stale-context-action');
    expect(online).toContain('packed-targeted-web-only-context-action');
    expect(online.indexOf('packed-targeted-stale-context-action'))
      .toBeLessThan(online.indexOf('- pressKey: HOME'));
    expect(updated.indexOf('- launchApp:'))
      .toBeLessThan(updated.indexOf('visible: retired'));
    expect(updated).toContain('retired');
    expect(updated).toContain('Packed provider detail 1.0.1');
    expect(updated).toContain('voice-surface-status:sidebar:disconnected');
    for (const flow of [online, updated, offline]) {
      expect(flow).toContain('platform-unavailable');
    }
    expect(offline).toContain('settings.plugins.marketplace.readOnlySnapshot');
    expect(offline).toContain('page:ui');
    expect(reconnected).toContain('packed-targeted-provider-title');
    expect(trustRevoked).toContain('plugin-app-page-unavailable');
    expect(uninstalled).toContain('plugin-app-page-unavailable');
    expect(reconnected).toContain('packed-targeted-context-action');
    expect(trustRevoked).toContain('packed-targeted-context-action');
    expect(uninstalled).toContain('packed-targeted-context-action');

    expect(qaSource).toContain('targetArchivePath');
    expect(qaSource).toContain('contributorV1ArchivePath');
    expect(qaSource).toContain('contributorV2ArchivePath');
    expect(qaSource).toContain("kind: 'forgetTrust'");
    expect(qaSource).toContain('requestPluginChange');
    expect(qaSource).toMatch(
      /runRequiredFlow\(\s*'suites\/mobile-e2e\/flows\/plugin-platform-candidate\/reconnected\.yaml'[\s\S]+?'plugins',\s*'disable',\s*input\.targeted\.contributorPluginId,\s*'--json'[\s\S]+?trust-revoked\.yaml[\s\S]+?'plugins',\s*'enable',\s*input\.targeted\.contributorPluginId,\s*'--json'[\s\S]+?reconnected\.yaml[\s\S]+?requestPluginChange\(\{\s*kind: 'forgetTrust'/u,
    );
    expect(qaSource).toContain("trust-revoked.yaml");
    expect(qaSource).toMatch(
      /requestPluginChange\(\{\s*kind: 'forgetTrust'[\s\S]+?trust-revoked\.yaml[\s\S]+?contributorV2ArchivePath[\s\S]+?reconnected\.yaml[\s\S]+?'plugins',\s*'uninstall',\s*input\.targeted\.contributorPluginId,\s*'--json'/u,
    );
    expect(qaSource.indexOf('await input.stopDaemon()'))
      .toBeLessThan(qaSource.indexOf("offline-read-only.yaml"));
  });

  it('schedules the shared UCX native baseline through an actual Session and keyboard-focus attestation', () => {
    const baseline = readFlow('ucx-baseline-navigation.yaml');
    const qaSource = readFileSync(
      new URL('./pluginPlatformCandidateQa.ts', import.meta.url),
      'utf8',
    );

    for (const selector of [
      'main-header-start-new-session',
      'new-session-composer-input',
      'new-session-composer-send',
      'settings-connect-terminal-scan',
      'settings.voice.privacy.currentUiContextMode',
      'dropdown-option-off',
      'dropdown-option-automatic',
      'dropdown-option-on_demand',
      'packed-targeted-provider-title',
      'packed-targeted-context-action',
    ]) {
      expect(baseline).toContain(`id: ${selector}`);
    }
    expect(baseline).toContain('file: ../_shared/gotoNewSessionComposer.yaml');
    expect(baseline).toContain('inputText: "UCX_NATIVE_SESSION_DESTINATION"');
    expect(baseline).toContain('id: transcript-chat-list');
    expect(baseline).toContain('id: session-composer-input');
    expect(baseline).toMatch(
      /assertVisible:\n\s+id: session-composer-input\n\s+focused: true/u,
    );
    expect(baseline).toMatch(
      /hideKeyboard\n- back[\s\S]+?id: "session-list-item-\.\*"/u,
    );
    expect(baseline).toContain(':///settings/voice/privacy');
    expect(baseline).toContain(':///plugins/examples.packed-targeted-projection-contributor/packed-provider-page');
    expect(baseline).not.toContain('happier.triage');
    expect(baseline).not.toContain('voiceQa');
    expect(baseline).not.toContain('voice-surface-toggle');
    expect(qaSource.indexOf('ucx-baseline-navigation.yaml'))
      .toBeLessThan(qaSource.indexOf('online-install-and-inspector.yaml'));
  });

  it('keeps the shared normal native Triage journey on the validated schema-v2 handoff and accessibility contracts', () => {
    const normal = readFlow('ucx-normal-triage-voice.yaml');
    const qaSource = readFileSync(
      new URL('./pluginPlatformCandidateQa.ts', import.meta.url),
      'utf8',
    );
    const cliSource = readFileSync(
      new URL('./mobilePluginPlatformCandidateCli.ts', import.meta.url),
      'utf8',
    );
    const inputSource = readFileSync(
      new URL('./mobilePluginPlatformCandidateInput.ts', import.meta.url),
      'utf8',
    );

    expect(normal).toContain('connected-account-mode:manual');
    expect(normal).toContain('connected-account-manual:token');
    expect(normal).toContain('HAPPIER_E2E_TRIAGE_GITHUB_VOICE_QA_GITHUB_TOKEN');
    expect(normal).toContain('Add ${HAPPIER_E2E_TRIAGE_GITHUB_VOICE_QA_SCOPE_TITLE} to Happier');
    expect(normal).toContain('Added to Happier.');
    expect(normal).toContain('${HAPPIER_E2E_TRIAGE_GITHUB_VOICE_QA_ISSUE_A_TITLE}');
    expect(normal).toContain('${HAPPIER_E2E_TRIAGE_GITHUB_VOICE_QA_ISSUE_B_TITLE}');
    expect(normal).toContain('voice-surface:sidebar');
    expect(normal).toContain('voice-surface-toggle:sidebar');
    expect(normal).toContain('dropdown-option-off');
    expect(normal).toContain('dropdown-option-on_demand');
    expect(normal).toContain('dropdown-option-automatic');
    expect(normal).toContain('- back');
    expect(normal).toContain('settings.voice.provider.${HAPPIER_E2E_TRIAGE_GITHUB_VOICE_QA_VOICE_ADAPTER_ID}.local');
    expect(normal).toContain('dropdown-option-${HAPPIER_E2E_TRIAGE_GITHUB_VOICE_QA_VOICE_CONVERSATION_MODE}');
    expect(normal).toContain('dropdown-option-${HAPPIER_E2E_TRIAGE_GITHUB_VOICE_QA_VOICE_AGENT_ID}');
    expect(normal).toContain('happier_voice_e2e_text_turn=UCX_VOICE_READ_A');
    expect(normal).toContain('happier_voice_e2e_text_turn=UCX_VOICE_OPEN_B');
    expect(normal).toContain('happier_voice_e2e_text_turn=UCX_VOICE_STAGE_STALE_A');
    expect(normal).toContain('happier_voice_e2e_text_turn=UCX_VOICE_INVOKE_STALE_A');
    expect(normal).toContain('UCX Voice refused stale current UI command: stale_surface.');
    expect(normal).toContain('not native microphone/STT certification');
    expect(normal).toContain('does not close the broader acoustic/device Voice QA gates');
    expect(normal).toContain('settings.voice.ui.activityFeedEnabled');
    expect(normal).not.toContain('packed-conversation');

    const readMarker = 'happier_voice_e2e_text_turn=UCX_VOICE_READ_A';
    const openMarker = 'happier_voice_e2e_text_turn=UCX_VOICE_OPEN_B';
    const staleStageMarker = 'happier_voice_e2e_text_turn=UCX_VOICE_STAGE_STALE_A';
    const readOnlySegment = normal.slice(normal.indexOf(readMarker), normal.indexOf(openMarker));
    const openCommandSegment = normal.slice(normal.indexOf(openMarker), normal.indexOf(staleStageMarker));

    expect(normal.indexOf(readMarker)).toBeLessThan(normal.indexOf(openMarker));
    expect(readOnlySegment).toContain('visible: ${HAPPIER_E2E_TRIAGE_GITHUB_VOICE_QA_ISSUE_A_TITLE}');
    expect(readOnlySegment).not.toContain('visible: ${HAPPIER_E2E_TRIAGE_GITHUB_VOICE_QA_ISSUE_B_TITLE}');
    expect(openCommandSegment).toContain('visible: ${HAPPIER_E2E_TRIAGE_GITHUB_VOICE_QA_ISSUE_B_TITLE}');
    expect(openCommandSegment).toContain('- back');
    expect(openCommandSegment.indexOf('visible: ${HAPPIER_E2E_TRIAGE_GITHUB_VOICE_QA_ISSUE_B_TITLE}'))
      .toBeLessThan(openCommandSegment.indexOf('- back'));
    expect(openCommandSegment.indexOf('- back'))
      .toBeLessThan(openCommandSegment.lastIndexOf('visible: ${HAPPIER_E2E_TRIAGE_GITHUB_VOICE_QA_ISSUE_A_TITLE}'));
    expect(openCommandSegment).not.toContain('- tapOn: ${HAPPIER_E2E_TRIAGE_GITHUB_VOICE_QA_ISSUE_B_TITLE}');

    expect(qaSource.indexOf('ucx-baseline-navigation.yaml'))
      .toBeLessThan(qaSource.indexOf('ucx-normal-triage-voice.yaml'));
    expect(qaSource.indexOf('ucx-normal-triage-voice.yaml'))
      .toBeLessThan(qaSource.indexOf('online-install-and-inspector.yaml'));
    expect(cliSource).toContain('prepareNativeTriageGithubVoiceQa');
    expect(cliSource).toContain('fakeClaudeFixturePath');
    expect(cliSource).toContain('voice-current-ui-triage');
    expect(cliSource).toContain('fakeClaude: triageVoiceFakeClaude');
    expect(inputSource).toContain('HAPPIER_E2E_TRIAGE_GITHUB_VOICE_QA_HANDOFF_MANIFEST');
    expect(inputSource).toContain('loadPackedTriageGithubVoiceQaHandoff');
    expect(inputSource).toContain('assertPackedTriageGithubVoiceQaCompletionHandoff');
    expect(inputSource).toContain('assertPackedTriageGithubVoiceQaCandidate');
    expect(inputSource).toContain("adapterId: 'local_conversation'");
    expect(qaSource).toContain('HAPPIER_E2E_TRIAGE_GITHUB_VOICE_QA_VOICE_MICROPHONE_FIXTURE_PATH');
  });

  it('exercises the packed fixture Voice surface after each live-v2 reactivation and retires it on each lifecycle boundary', () => {
    const online = readFlow('online-install-and-inspector.yaml');
    const reconnected = readFlow('reconnected.yaml');
    const trustRevoked = readFlow('trust-revoked.yaml');
    const uninstalled = readFlow('uninstalled.yaml');
    const cliSource = readFileSync(
      new URL('./mobilePluginPlatformCandidateCli.ts', import.meta.url),
      'utf8',
    );
    const packedVoiceProviderRow =
      'settings.voice.provider.examples.packed-targeted-projection-contributor%2Fpacked-conversation.default';

    expect(online).toContain(packedVoiceProviderRow);
    expect(online).toContain('settings.voice.ui.activityFeedEnabled');
    expect(online).toContain('voice-surface-toggle:sidebar');
    expect(online).toContain('voice-surface-activity-toggle:sidebar');
    expect(online).toContain('Packed Voice action completed for packed-provider-detail.');
    expect(reconnected).toContain(packedVoiceProviderRow);
    expect(reconnected).toContain('packed-targeted-context-action');
    expect(reconnected).toContain('page:ui');
    expect(reconnected).toContain('voice-surface-toggle:sidebar');
    expect(reconnected).toContain('when:\n      notVisible: "Packed Voice action completed for packed-provider-detail."');
    expect(reconnected).toContain('Packed Voice action completed for packed-provider-detail.');
    expect(trustRevoked).toContain('settings.voice.provider.off');
    expect(trustRevoked).toContain('assertNotVisible:\n    id: ' + packedVoiceProviderRow);
    expect(trustRevoked).toContain('voice-surface-status:sidebar:disconnected');
    expect(uninstalled).toContain(packedVoiceProviderRow);
    expect(uninstalled).toContain('voice-surface-status:sidebar:disconnected');
    expect((cliSource.match(/HAPPIER_FEATURE_VOICE__ENABLED: '1'/g) ?? [])).toHaveLength(2);
    expect(
      (cliSource.match(/HAPPIER_FEATURE_VOICE__REQUIRE_SUBSCRIPTION: '0'/g) ?? []),
    ).toHaveLength(2);
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

  it('binds source builds and both platform commands to one exact candidate or row-local artifact basis', () => {
    const cliSource = readFileSync(new URL('./mobilePluginPlatformCandidateCli.ts', import.meta.url), 'utf8');
    const inputSource = readFileSync(new URL('./mobilePluginPlatformCandidateInput.ts', import.meta.url), 'utf8');
    const packageJson = readFileSync(new URL('../../../package.json', import.meta.url), 'utf8');

    expect(inputSource).toContain("HAPPIER_E2E_PLUGIN_PLATFORM_CANDIDATE");
    expect(inputSource).toContain('HAPPIER_E2E_UCX_NATIVE_SDK_TARBALL');
    expect(inputSource).toContain('HAPPIER_E2E_UCX_NATIVE_PLUGIN_UI_TARBALL');
    expect(inputSource).toContain('HAPPIER_E2E_UCX_NATIVE_CLI_TARBALL');
    expect(inputSource).toContain('requirePackedCandidateBrowserQaInputs');
    expect(inputSource).toContain("artifactBasis: 'row_local_natural'");
    expect(cliSource).not.toContain("'HAPPIER_E2E_PLUGIN_PLATFORM_SDK_TARBALL'");
    expect(cliSource).not.toContain("'HAPPIER_E2E_PLUGIN_PLATFORM_CLI_TARBALL'");
    expect(cliSource).toContain("'HAPPIER_E2E_PLUGIN_PLATFORM_REUSE_CLI_INSTALL_ROOT'");
    expect(cliSource).not.toContain('preparePluginPlatformTarballQa');
    expect(cliSource).toContain('preparePluginPlatformCandidateQa');
    expect(cliSource).toContain('prepareRowLocalNativePluginPlatformQa');
    expect(cliSource).toContain('preparePackedUcxWebQa');
    expect(cliSource).toContain('preparePackedNovelConnectedAccountDeviceQa');
    expect(cliSource).toContain('HAPPIER_E2E_UCX_NATIVE_LOADED_IDENTITY: \'1\'');
    expect(cliSource).toContain('appendMobileUcxNativeRowAttestation');
    expect(cliSource).toContain('runManagedChildCommand({');
    expect(cliSource).not.toContain('plugin_platform_mobile_candidate_preflight_blocked');
    expect(cliSource).not.toContain('resolveMobilePluginPlatformCandidateMetroDevClientAttestationBlocker');
    expect(cliSource).toContain('createReactNativeRepackResolveOptions');
    expect(cliSource).toContain(
      'createReactNativeRepackResolveOptions(Repack.getResolveOptions(platform))',
    );
    expect(cliSource).not.toContain('...Repack.getResolveOptions(platform)');
    expect(cliSource).toContain("view.container = 'rightSidebarTab';");
    expect(cliSource).toContain("view.target = { kind: 'app' };");
    expect(cliSource).toContain('delete view.placement;');
    expect(cliSource).not.toContain("view.placement = 'app.rightSidebarTab';");
    expect(inputSource).toContain(
      'HAPPIER_E2E_PACKED_NOVEL_QA_HANDOFF_MANIFEST',
    );
    expect(cliSource).toContain('packedNovelConnectedAccount.pluginArchivePath');
    expect(cliSource).toContain(
      'packedNovelConnectedAccount.publicAuthoring.archivePath',
    );
    expect(cliSource).toContain(
      'packedNovelConnectedAccount.publicAuthoring.hostedWeb.digest',
    );
    expect(cliSource).toContain(
      'Packed public authoring device install did not commit',
    );
    expect(cliSource).toContain('packedNovelConnectedAccount?.isolation');
    expect(cliSource).toContain('nativeRuntimeIsolation.happyHomeDir');
    expect(cliSource).toContain('nativeRuntimeIsolation.databasePath');
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
    expect(cliSource).toContain(
      "import { PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1 } from '@happier-dev/plugin-sdk/ui/build';",
    );
    expect(cliSource).toContain(
      "'@swc/helpers': PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1.devDependencies['@swc/helpers'],",
    );
    expect(cliSource).not.toContain("'@swc/helpers': '0.5.23'");
    expect(cliSource).toContain("import { defineBuildConfig } from '@happier-dev/plugin-sdk/ui/build'");
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
