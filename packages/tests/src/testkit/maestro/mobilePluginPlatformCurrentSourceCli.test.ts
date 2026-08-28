import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { runMobilePluginPlatformCurrentSourceCli } from './mobilePluginPlatformCurrentSourceCli';
import {
  CURRENT_SOURCE_SESSION_AGENT_LOCAL_ID,
  CURRENT_SOURCE_SESSION_AGENT_PLUGIN_ID,
  buildCurrentManagedStackSessionAgentSelectors,
} from '../pluginPlatform/currentManagedStackPluginUiQa';
import {
  captureCurrentSourceDisposableSessionId,
  MOBILE_PLUGIN_PLATFORM_CURRENT_SOURCE_FLOW,
  resolveCurrentSourceDisposableSessionCleanupId,
  resolveCurrentSourceDisposableSessionDeletionTarget,
  resolveMobilePluginPlatformCurrentSourceExitCode,
  resolveMobilePluginPlatformCurrentSourceRun,
} from './mobilePluginPlatformCurrentSourceInput';

const requiredEnv: NodeJS.ProcessEnv = {
  HAPPIER_E2E_SERVER_URL: 'http://127.0.0.1:3005',
  HAPPIER_E2E_CURRENT_SOURCE_PLUGIN_ID: 'acme.current-source',
  HAPPIER_E2E_CURRENT_SOURCE_RN_SURFACE_URL: 'happier-dev:///plugins/acme.current-source/rn',
  HAPPIER_E2E_CURRENT_SOURCE_RN_SENTINEL: 'current-source-rn',
  HAPPIER_E2E_CURRENT_SOURCE_RN_SENTINEL_AFTER_UPDATE: 'current-source-rn-v2',
  HAPPIER_E2E_CURRENT_SOURCE_HOSTED_SURFACE_URL: 'happier-dev:///plugins/acme.current-source/hosted',
  HAPPIER_E2E_CURRENT_SOURCE_HOSTED_SENTINEL: 'current-source-hosted',
  HAPPIER_E2E_CURRENT_SOURCE_HOSTED_SENTINEL_AFTER_UPDATE: 'current-source-hosted-v2',
  HAPPIER_E2E_CURRENT_SOURCE_HOSTED_HISTORY_ACTION_ID: 'current-source-hosted-push-history',
  HAPPIER_E2E_CURRENT_SOURCE_HOSTED_HISTORY_SENTINEL: 'current-source-hosted-history',
  HAPPIER_E2E_CURRENT_SOURCE_TARGETED_SURFACE_URL: 'happier-dev:///plugins/acme.current-source/targeted',
  HAPPIER_E2E_CURRENT_SOURCE_TARGETED_SENTINEL: 'current-source-targeted',
  HAPPIER_E2E_CURRENT_SOURCE_TARGETED_SENTINEL_AFTER_UPDATE: 'current-source-targeted-v2',
  HAPPIER_E2E_CURRENT_SOURCE_COMPOSER_ACTION_ID: 'plugin-composer-action:acme.current-source/review',
  HAPPIER_E2E_CURRENT_SOURCE_COMPOSER_CONTROL_ID: 'plugin-composer-control:acme.current-source/mode',
  HAPPIER_E2E_CURRENT_SOURCE_COMPOSER_ACTION_RESULT_ID: 'current-source-composer-result',
  HAPPIER_E2E_CURRENT_SOURCE_COMPOSER_ATTACHMENT_ID: 'current-source-composer-attachment',
  HAPPIER_E2E_CURRENT_SOURCE_COMPOSER_REFERENCE_ID: 'current-source-composer-reference',
  HAPPIER_E2E_CURRENT_SOURCE_COMPOSER_REGION_ID: 'current-source-composer-region',
  HAPPIER_E2E_CURRENT_SOURCE_TRANSCRIPT_SENTINEL: 'current-source-transcript',
};

describe('current-source Plugin UI mobile QA', () => {
  it('attributes exactly the one Session created inside the send window and retains ambiguity', () => {
    expect(resolveCurrentSourceDisposableSessionCleanupId({
      before: new Set(['existing', 'pre-send-concurrent']),
      after: new Set(['existing', 'pre-send-concurrent', 'owned']),
    })).toEqual({ status: 'attributed', sessionId: 'owned' });
    expect(resolveCurrentSourceDisposableSessionCleanupId({
      before: new Set(['existing']),
      after: new Set(['existing']),
    })).toEqual({ status: 'absent' });
    expect(resolveCurrentSourceDisposableSessionCleanupId({
      before: new Set(['existing']),
      after: new Set(['existing', 'owned', 'concurrent']),
    })).toEqual({ status: 'ambiguous', deltaCount: 2 });
  });

  it('arms exact cleanup as soon as the sent Session exists and keeps unreadable reads non-authoritative', async () => {
    const reads: Array<ReadonlySet<string>> = [
      new Set(['existing']),
      new Set(['existing', 'owned']),
    ];
    await expect(captureCurrentSourceDisposableSessionId({
      before: new Set(['existing']),
      readSessionIds: async () => reads.shift() ?? new Set(['existing']),
      delayMs: 0,
    })).resolves.toEqual({ sessionId: 'owned', conflict: null, readError: null });

    let ambiguousReads = 0;
    await expect(captureCurrentSourceDisposableSessionId({
      before: new Set(['existing']),
      readSessionIds: async () => {
        ambiguousReads += 1;
        return new Set(['existing', 'owned', 'concurrent']);
      },
      delayMs: 0,
    })).resolves.toEqual({
      sessionId: null,
      conflict: 'plugin_ui_current_source_disposable_session_identity_ambiguous:2',
      readError: null,
    });
    expect(ambiguousReads).toBe(1);

    const readFailure = new Error('session snapshot unavailable');
    await expect(captureCurrentSourceDisposableSessionId({
      before: new Set(['existing']),
      readSessionIds: async () => {
        throw readFailure;
      },
      attempts: 2,
      delayMs: 0,
    })).resolves.toEqual({ sessionId: null, conflict: null, readError: readFailure });
  });

  it('settles deletion from the armed exact Session only and fails closed otherwise', () => {
    expect(resolveCurrentSourceDisposableSessionDeletionTarget({
      sessionId: 'owned',
      conflict: null,
      readError: null,
    })).toBe('owned');
    expect(resolveCurrentSourceDisposableSessionDeletionTarget({
      sessionId: null,
      conflict: null,
      readError: null,
    })).toBeNull();
    expect(() => resolveCurrentSourceDisposableSessionDeletionTarget({
      sessionId: null,
      conflict: 'plugin_ui_current_source_disposable_session_identity_ambiguous:2',
      readError: null,
    })).toThrow('plugin_ui_current_source_disposable_session_identity_ambiguous:2');
    const captureReadFailure = new Error('snapshot down during capture');
    expect(() => resolveCurrentSourceDisposableSessionDeletionTarget({
      sessionId: null,
      conflict: null,
      readError: captureReadFailure,
    })).toThrow('plugin_ui_current_source_disposable_session_identity_unreadable');
  });

  it('forces the canonical current-source lifecycle and loaded-native identity', () => {
    const result = resolveMobilePluginPlatformCurrentSourceRun({
      argv: [
        'node',
        'script',
        '--platform',
        'ios',
        '--flows=old.yaml',
        '--serverUrl',
        'http://stale.invalid',
      ],
      env: requiredEnv,
      managedStack: {
        serverUrl: 'http://127.0.0.1:3005',
      },
    });

    expect(result.argv).toEqual([
      'node',
      'script',
      '--platform',
      'ios',
      '--flows',
      MOBILE_PLUGIN_PLATFORM_CURRENT_SOURCE_FLOW,
      '--serverUrl',
      'http://127.0.0.1:3005',
    ]);
    expect(result.env).toMatchObject({
      HAPPIER_E2E_MOBILE_MANAGE_METRO: '1',
      HAPPIER_E2E_EXPO_CLEAR: '1',
      HAPPIER_E2E_UCX_NATIVE_LOADED_IDENTITY: '1',
      HAPPIER_E2E_ATTEST_INSTALLED_NATIVE_APP: '1',
      HAPPIER_E2E_MOBILE_CONNECTED_MACHINE_MODE: 'none',
      HAPPIER_E2E_NATIVE_MODULE_PROBE_FLOW:
        'suites/mobile-e2e/flows/plugin-platform-current-source/native-module-probe.yaml',
    });
  });

  it('rejects an unmanaged current-source row', () => {
    expect(() => resolveMobilePluginPlatformCurrentSourceRun({
      argv: ['node', 'script', '--platform', 'android'],
      env: requiredEnv,
    })).toThrow(/canonical managed Stack context/u);
  });

  it('derives managed Stack server and machine identity without caller-owned surface URLs', () => {
    const result = resolveMobilePluginPlatformCurrentSourceRun({
      argv: ['node', 'script', '--platform', 'android'],
      env: {
        HAPPIER_E2E_SERVER_URL: 'http://ambient.invalid',
        HAPPIER_E2E_MOBILE_CONNECTED_MACHINE_MODE: 'cli-terminal-daemon',
      },
      managedStack: {
        serverUrl: 'http://managed.localhost:53288',
      },
    });

    expect(result.argv).toContain('http://managed.localhost:53288');
    expect(result.env.HAPPIER_E2E_MOBILE_CONNECTED_MACHINE_MODE).toBe('none');
    expect(result.env.HAPPIER_E2E_CURRENT_SOURCE_RN_SURFACE_URL).toBeUndefined();
  });

  it('does not credit a green device flow without exact loaded-bundle identity', () => {
    expect(resolveMobilePluginPlatformCurrentSourceExitCode({
      exitCode: 0,
      loadedRuntimeKind: 'blocked',
    })).toBe(2);
    expect(resolveMobilePluginPlatformCurrentSourceExitCode({
      exitCode: 7,
      loadedRuntimeKind: null,
    })).toBe(7);
    expect(resolveMobilePluginPlatformCurrentSourceExitCode({
      exitCode: 0,
      loadedRuntimeKind: 'observed',
      installedNativeAppIdentityKind: null,
    })).toBe(2);
    expect(resolveMobilePluginPlatformCurrentSourceExitCode({
      exitCode: 0,
      loadedRuntimeKind: 'observed',
      installedNativeAppIdentityKind: 'ios-app-bundle-file-set',
    })).toBe(0);
  });

  it('keeps native identity and managed source lifecycle probes candidate-free', () => {
    const probe = readFileSync(
      new URL('../../../suites/mobile-e2e/flows/plugin-platform-current-source/native-module-probe.yaml', import.meta.url),
      'utf8',
    );
    const revisionProbe = readFileSync(
      new URL('../../../suites/mobile-e2e/flows/_shared/loadedBundleRevisionProbe.yaml', import.meta.url),
      'utf8',
    );
    const managedPresent = readFileSync(
      new URL('../../../suites/mobile-e2e/flows/plugin-platform-current-source/managed-source-present.yaml', import.meta.url),
      'utf8',
    );
    const managedPublicNative = readFileSync(
      new URL('../../../suites/mobile-e2e/flows/plugin-platform-current-source/managed-public-native.yaml', import.meta.url),
      'utf8',
    );
    const managedPublicHosted = readFileSync(
      new URL('../../../suites/mobile-e2e/flows/plugin-platform-current-source/managed-public-hosted.yaml', import.meta.url),
      'utf8',
    );
    const managedPublicComposer = readFileSync(
      new URL('../../../suites/mobile-e2e/flows/plugin-platform-current-source/managed-public-composer.yaml', import.meta.url),
      'utf8',
    );
    const managedPublicComposerRetained = readFileSync(
      new URL('../../../suites/mobile-e2e/flows/plugin-platform-current-source/managed-public-composer-retained.yaml', import.meta.url),
      'utf8',
    );
    const managedPublicHostedAbsent = readFileSync(
      new URL('../../../suites/mobile-e2e/flows/plugin-platform-current-source/managed-public-hosted-absent.yaml', import.meta.url),
      'utf8',
    );
    const managedPublicTransition = readFileSync(
      new URL('../../../suites/mobile-e2e/flows/plugin-platform-current-source/managed-public-native-transition.yaml', import.meta.url),
      'utf8',
    );
    const managedPublicHostedTransition = readFileSync(
      new URL('../../../suites/mobile-e2e/flows/plugin-platform-current-source/managed-public-hosted-transition.yaml', import.meta.url),
      'utf8',
    );

    expect(probe).toContain('clearState: false');
    expect(probe).toContain('clearKeychain: false');
    expect(probe).toContain('native-crypto-worker-probe-module-available:pass');
    expect(probe).toContain('native-crypto-worker-probe-js-responsive:pass');
    expect(revisionProbe).toContain(
      'native-crypto-worker-probe-loaded-bundle-revision:${HAPPIER_E2E_EXPECTED_LOADED_BUNDLE_REVISION}',
    );
    expect(managedPresent).toContain('HAPPIER_E2E_CURRENT_SOURCE_PANEL_TAB_ID');
    expect(managedPresent).toContain('HAPPIER_E2E_CURRENT_SOURCE_EXPECTED_TEXT');
    expect(managedPublicNative).toContain('HAPPIER_E2E_CURRENT_SOURCE_TARGETED_READY_ID');
    expect(managedPublicTransition).toContain('HAPPIER_E2E_CURRENT_SOURCE_PREVIOUS_TARGETED_READY_ID');
    expect(managedPublicTransition).toContain('HAPPIER_E2E_CURRENT_SOURCE_PREVIOUS_RN_SENTINEL');
    expect(managedPublicHosted).toContain('HAPPIER_E2E_CURRENT_SOURCE_HOSTED_READY_ID');
    expect(managedPublicHostedTransition).toContain('HAPPIER_E2E_CURRENT_SOURCE_PREVIOUS_HOSTED_READY_ID');
    expect(managedPublicHostedTransition).toContain('HAPPIER_E2E_CURRENT_SOURCE_PREVIOUS_HOSTED_SENTINEL');
    expect(managedPublicHostedAbsent).toContain('HAPPIER_E2E_CURRENT_SOURCE_HOSTED_READY_ID');
    expect(managedPublicHosted).toContain('- back');
    expect(managedPublicComposer).toContain('HAPPIER_E2E_CURRENT_SOURCE_NEW_SESSION_URL');
    expect(managedPublicComposer).toContain('HAPPIER_E2E_CURRENT_SOURCE_COMPOSER_ATTACHMENT_LABEL');
    expect(managedPublicComposerRetained).toContain('HAPPIER_E2E_CURRENT_SOURCE_COMPOSER_ATTACHMENT_LABEL');
    const completeCurrentSourceFlow = [
      probe,
      revisionProbe,
      managedPresent,
      managedPublicNative,
      managedPublicHosted,
      managedPublicComposer,
      managedPublicComposerRetained,
      managedPublicHostedAbsent,
      managedPublicTransition,
      managedPublicHostedTransition,
    ].join('\n');
    expect(completeCurrentSourceFlow).not.toMatch(/tarball|\.tgz/u);
    expect(completeCurrentSourceFlow).not.toMatch(/artifact[_-]?handle|cache[_-]?key|storage[_-]?partition/iu);
  });
});

const COMPOSER_FLOW = 'suites/mobile-e2e/flows/plugin-platform-current-source/managed-public-composer.yaml';
const COMPOSER_RETAINED_FLOW = 'suites/mobile-e2e/flows/plugin-platform-current-source/managed-public-composer-retained.yaml';
const OWNED_SESSION_ID = 'session-owned';
const CONCURRENT_SESSION_ID = 'session-concurrent';

type RowHarnessOverrides = Readonly<{
  flowExitCode?: (flowPath: string) => number;
  readSessionIds?: (readCount: number) => Promise<ReadonlySet<string>>;
  deleteSession?: (sessionId: string) => Promise<void>;
  finalDaemonPid?: number;
}>;

function createRowHarness(overrides: RowHarnessOverrides = {}) {
  const deletedSessionIds: string[] = [];
  const deletedDraftIds: string[] = [];
  const retiredPlugins: string[] = [];
  const manifestEvidence: Array<Readonly<Record<string, unknown>>> = [];
  let readCount = 0;
  let attestCalls = 0;

  const context = {
    runtimeJsonPath: '/tmp/qa/stack.runtime.json',
    stackDir: '/tmp/qa',
    stackName: 'qa-stack',
    cliHome: '/tmp/qa/cli',
    uiUrl: 'http://ui.invalid',
    serverUrl: 'http://127.0.0.1:3005',
    account: {
      accountId: 'account-1',
      serverId: 'server-1',
      serverIdentityId: null,
      uiServerId: 'ui-server-1',
    },
    daemon: {
      pid: 4242,
      port: 44517,
      controlToken: 'control-token',
      statePath: '/tmp/qa/cli/servers/current/daemon.state.json',
      runtimeId: 'runtime-1',
      machineId: 'machine-1',
      runtimeEntrypoint: '/tmp/qa/cli/daemon.mjs',
      distClosureFingerprint: 'fp-1',
    },
    runtime: {
      updatedAt: null,
      runtimeSnapshotId: 'snapshot-1',
      selectedSnapshotId: 'snapshot-1',
      pendingManualRestart: false as const,
      publicationComponents: { server: 'current' as const, daemon: 'current' as const },
    },
    uiProducer: {
      mode: 'snapshot' as const,
      stackName: 'qa-stack',
      runtimeJsonPath: '/tmp/qa/stack.runtime.json',
      projectDir: null,
      pid: process.pid,
      processInstanceFingerprint: 'uiproc-1',
    },
    authStorage: { localStorage: {}, sessionStorage: {} },
  };
  const generation = (appliedGeneration: string, contributionProjectionGeneration: string) => ({
    pluginId: 'qa.current-source.native.test',
    desiredGeneration: appliedGeneration,
    appliedGeneration,
    contributionProjectionGeneration,
  });
  const nativeFixture = {
    pluginId: 'qa.current-source.native.test',
    pluginRoot: '/tmp/qa/native-fixture',
    rnSurfaceUrlPath: 'plugins/qa/rn',
    hostedSurfaceUrlPath: 'plugins/qa/hosted',
    declarativeSurfaceUrlPath: 'plugins/qa/declarative',
    sentinels: {
      rnV1: 'rn-v1',
      rnV2: 'rn-v2',
      hostedV1: 'hosted-v1',
      hostedV2: 'hosted-v2',
      hostedHistoryAction: 'history-action',
      hostedHistoryV1: 'history-v1',
      hostedHistoryV2: 'history-v2',
      declarativeV1: 'declarative-v1',
      declarativeV2: 'declarative-v2',
      actionTestId: 'action-testid',
      actionLabel: 'action-label',
      targetedV1: 'targeted-v1',
      targetedV2: 'targeted-v2',
      composerControl: 'composer-control',
      composerSecondaryControl: 'composer-secondary-control',
      composerChoiceLabel: 'composer-choice-label',
      composerAttachmentV1: 'composer-attachment-v1',
      composerReference: 'composer-reference',
      composerRegion: 'composer-region',
      agentTitle: 'agent-title',
      transcriptSentinel: 'transcript-sentinel',
    },
    installed: generation('gen-native-1', 'proj-1'),
    artifact: async () => ({ digest: 'digest-native-1', entry: 'native.js', byteSize: 10 }),
    hostedArtifact: async () => ({ digest: 'digest-hosted-1', entry: 'hosted.js', byteSize: 10 }),
    applyV2: async () => generation('gen-native-2', 'proj-2'),
    disable: async () => generation('gen-native-2', 'proj-2'),
    enable: async () => generation('gen-native-2', 'proj-2'),
    uninstall: async () => undefined,
    reinstallV1: async () => generation('gen-native-1', 'proj-1'),
    cleanup: async () => {
      retiredPlugins.push('native');
    },
  };
  const fixture = {
    pluginId: 'qa.current-stack.mobile.test',
    pluginRoot: '/tmp/qa/declarative-fixture',
    panelTabTestId: 'panel-tab-testid',
    v1Text: 'declarative-v1-text',
    v2Text: 'declarative-v2-text',
    composer: {
      actionTestId: 'declarative-action-testid',
      actionLabel: 'declarative-action-label',
      controlTestId: 'declarative-control-testid',
      choiceLabel: 'declarative-choice-label',
      attachmentLabel: 'declarative-attachment-label',
      referenceLabel: 'declarative-reference-label',
      regionText: 'declarative-region-text',
    },
    installed: generation('gen-declarative-1', 'proj-1'),
    applyV2: async () => generation('gen-declarative-2', 'proj-2'),
    disable: async () => generation('gen-declarative-2', 'proj-2'),
    enable: async () => generation('gen-declarative-2', 'proj-2'),
    uninstall: async () => undefined,
    reinstallV1: async () => generation('gen-declarative-1', 'proj-1'),
    cleanup: async () => {
      retiredPlugins.push('declarative');
    },
  };
  const sessionAgentFixture = {
    pluginId: CURRENT_SOURCE_SESSION_AGENT_PLUGIN_ID,
    agentLocalId: CURRENT_SOURCE_SESSION_AGENT_LOCAL_ID,
    qualifiedAgentId: 'examples.session-agent/deterministic',
    displayTitle: 'Session Agent QA',
    assistantText: 'session-agent-assistant-text',
    reasoningText: 'session-agent-reasoning-text',
    updatedReasoningText: 'session-agent-reasoning-text-v2',
    confirmationTitle: 'session-agent-confirmation-title',
    sourceRoot: '/tmp/qa/session-agent-example',
    ownsSourceRoot: true,
    installed: generation('gen-agent-1', 'proj-agent-1'),
    selectors: buildCurrentManagedStackSessionAgentSelectors(),
    reattach: () => undefined,
    generation: async () => generation('gen-agent-1', 'proj-agent-1'),
    applySourceUpdate: async () => generation('gen-agent-2', 'proj-agent-2'),
    disable: async () => generation('gen-agent-2', 'proj-agent-2'),
    enable: async () => generation('gen-agent-2', 'proj-agent-2'),
    reinstall: async () => generation('gen-agent-1', 'proj-agent-1'),
    uninstall: async () => undefined,
    cleanup: async () => {
      retiredPlugins.push('session-agent');
    },
  };
  const attestation = {
    stackName: 'qa-stack',
    runtimeJsonPath: '/tmp/qa/stack.runtime.json',
    runtimeUpdatedAt: null,
    runtimeSnapshotId: 'snapshot-1',
    selectedSnapshotId: 'snapshot-1',
    pendingManualRestart: false as const,
    uiProducer: context.uiProducer,
    daemonPid: 4242,
    daemonRuntimeId: 'runtime-1',
    daemonMachineId: 'machine-1',
    daemonRuntimeEntrypoint: '/tmp/qa/cli/daemon.mjs',
    daemonDistClosureFingerprint: 'fp-1',
    daemonPingVerified: true as const,
    accountId: 'account-1',
    serverId: 'server-1',
    serverIdentityId: null,
    pluginId: 'happier.inspector' as const,
    desiredGeneration: 'gen-inspector',
    appliedGeneration: 'gen-inspector',
    contributionProjectionGeneration: 'gen-inspector',
    artifact: { platform: 'android' as const, digest: 'digest-inspector', entry: 'inspector.js', byteSize: 10 },
  };
  const deps = {
    resolvePluginUiContext: async () => context,
    attestPluginUi: async () => {
      attestCalls += 1;
      if (attestCalls >= 2 && overrides.finalDaemonPid !== undefined) {
        return { ...attestation, daemonPid: overrides.finalDaemonPid };
      }
      return attestation;
    },
    prepareNativePublicFixture: async () => nativeFixture,
    prepareDeclarativeLifecycleFixture: async () => fixture,
    prepareSessionAgentFixture: async () => sessionAgentFixture,
    readSessionIds: async () => {
      readCount += 1;
      if (overrides.readSessionIds) return await overrides.readSessionIds(readCount);
      return readCount === 1
        ? new Set<string>(['existing'])
        : new Set<string>(['existing', OWNED_SESSION_ID]);
    },
    deleteSession: async (sessionId: string) => {
      deletedSessionIds.push(sessionId);
      if (overrides.deleteSession) await overrides.deleteSession(sessionId);
    },
    deleteNewSessionDraft: async (_context: unknown, draftId: string) => {
      deletedDraftIds.push(draftId);
    },
    appendManifestEvidence: (params: Readonly<{ evidence: Readonly<Record<string, unknown>> }>) => {
      manifestEvidence.push(params.evidence);
    },
    runMobileMaestroCli: (async (_input, options) => {
      const exitCode = await options.runScenario?.({
        defaultFlowPath: 'suites/mobile-e2e/flows/plugin-platform-current-source/managed-inspector-native.yaml',
        serverUrlHost: '127.0.0.1',
        serverUrlDevice: '10.0.2.2',
        platform: 'android',
        runFlow: async (flowPath: string) => ({
          exitCode: overrides.flowExitCode ? overrides.flowExitCode(flowPath) : 0,
        }),
      }) ?? 0;
      return {
        exitCode,
        runDir: '/tmp/qa/run',
        manifestPath: '/tmp/qa/run/manifest.json',
        debugOutputDir: '/tmp/qa/run/debug',
        server: null,
        metro: null,
        ucxLoadedNativeRuntime: {
          kind: 'observed',
          fullMetroReload: true,
          fastRefresh: 'disabled_via_expo_no_dev',
          bundle: { url: 'http://bundle.invalid/index.bundle', revision: 'rev-1' },
          deviceReportedBundle: { revision: 'rev-1' },
          moduleProbe: {
            flow: 'suites/mobile-e2e/flows/plugin-platform-current-source/native-module-probe.yaml',
            status: 'passed',
          },
        },
        installedNativeAppIdentity: {
          kind: 'android-base-apk',
          baseApkSha256: 'apk-sha-1',
          runtimeVersion: '1.0.0',
        },
      };
  }) as typeof runDefaultMobileMaestroCli,
  };
  const runRow = () => runMobilePluginPlatformCurrentSourceCli({
    argv: ['node', 'mobile-current-source', '--platform', 'android', '--device', 'test-device'],
    cwd: '/tmp/qa',
    env: { HAPPIER_E2E_MOBILE_APP_SCHEME: 'happier-dev' },
    deps,
  });
  return { runRow, deletedSessionIds, deletedDraftIds, retiredPlugins, manifestEvidence };
}

describe('current-source Plugin UI mobile QA row cleanup', () => {
  it('deletes the exact armed Session when a downstream assertion fails after exact creation', async () => {
    const harness = createRowHarness({
      flowExitCode: (flowPath) => (flowPath === COMPOSER_RETAINED_FLOW ? 3 : 0),
    });

    await expect(harness.runRow()).resolves.toBe(3);

    expect(harness.deletedSessionIds).toEqual([OWNED_SESSION_ID]);
    expect(harness.deletedDraftIds).toHaveLength(1);
    expect(harness.retiredPlugins).toEqual(['declarative', 'native', 'session-agent']);
  });

  it('deletes nothing when the creation window is ambiguous, aggregating the conflict', async () => {
    const harness = createRowHarness({
      readSessionIds: async (readCount) => (readCount === 1
        ? new Set<string>(['existing'])
        : new Set<string>(['existing', OWNED_SESSION_ID, CONCURRENT_SESSION_ID])),
    });

    await expect(harness.runRow())
      .rejects.toThrow('plugin_ui_current_source_disposable_session_identity_ambiguous:2');

    expect(harness.deletedSessionIds).toEqual([]);
    expect(harness.deletedDraftIds).toHaveLength(1);
    expect(harness.retiredPlugins).toEqual(['declarative', 'native', 'session-agent']);
  });

  it('deletes nothing when the exact-ID attribution read fails, aggregating the failure', async () => {
    const harness = createRowHarness({
      readSessionIds: async (readCount) => {
        if (readCount === 1) return new Set<string>(['existing']);
        throw new Error('session snapshot unavailable');
      },
    });

    await expect(harness.runRow())
      .rejects.toThrow('plugin_ui_current_source_disposable_session_identity_unreadable');

    expect(harness.deletedSessionIds).toEqual([]);
    expect(harness.deletedDraftIds).toHaveLength(1);
  });

  it('never deletes an unrelated concurrent Session delta when the send never landed', async () => {
    const harness = createRowHarness({
      flowExitCode: (flowPath) => (flowPath === COMPOSER_FLOW ? 4 : 0),
      readSessionIds: async (readCount) => (readCount === 1
        ? new Set<string>(['existing'])
        : new Set<string>(['existing', CONCURRENT_SESSION_ID])),
    });

    await expect(harness.runRow()).resolves.toBe(4);

    expect(harness.deletedSessionIds).toEqual([]);
    expect(harness.deletedDraftIds).toHaveLength(1);
  });

  it('deletes only the armed Session even though a concurrent Session appears afterwards', async () => {
    const harness = createRowHarness({
      readSessionIds: async (readCount) => {
        if (readCount === 1) return new Set<string>(['existing']);
        if (readCount === 2) return new Set<string>(['existing', OWNED_SESSION_ID]);
        return new Set<string>(['existing', OWNED_SESSION_ID, CONCURRENT_SESSION_ID]);
      },
    });

    await expect(harness.runRow()).resolves.toBe(0);

    expect(harness.deletedSessionIds).toEqual([OWNED_SESSION_ID]);
    expect(harness.deletedDraftIds).toHaveLength(1);
    const lifecycle = harness.manifestEvidence[0]?.currentManagedStackPluginUi as {
      nativePublicFixtureLifecycle?: Array<Readonly<Record<string, unknown>>>;
    };
    expect(lifecycle.nativePublicFixtureLifecycle).toContainEqual({
      phase: 'disposable-session-armed',
      sessionId: OWNED_SESSION_ID,
    });
    expect(lifecycle.nativePublicFixtureLifecycle).toContainEqual({
      phase: 'disposable-session-deleted',
      sessionId: OWNED_SESSION_ID,
    });
  });

  it('aggregates a cleanup delete failure with the original run failure', async () => {
    const harness = createRowHarness({
      flowExitCode: (flowPath) => (flowPath === COMPOSER_RETAINED_FLOW ? 3 : 0),
      deleteSession: async () => {
        throw new Error('disposable session delete failed');
      },
    });

    await expect(harness.runRow()).rejects.toThrow('disposable session delete failed');

    expect(harness.deletedSessionIds).toEqual([OWNED_SESSION_ID]);
    expect(harness.deletedDraftIds).toHaveLength(1);
    expect(harness.retiredPlugins).toEqual(['declarative', 'native', 'session-agent']);
  });

  it('aggregates a cleanup delete failure with a thrown row failure', async () => {
    const harness = createRowHarness({
      deleteSession: async () => {
        throw new Error('disposable session delete failed');
      },
      // Force a thrown row failure on top of the cleanup failure by making the
      // final Stack attestation observe a runtime identity change.
      finalDaemonPid: 5151,
    });

    const thrown = await harness.runRow().then(() => null, (error) => error);

    expect(thrown).toBeInstanceOf(AggregateError);
    const causes = (thrown as AggregateError).errors.map((error) => String((error as Error).message));
    expect(causes.some((message) => message.includes('runtime_identity_changed_during_row'))).toBe(true);
    expect(causes.some((message) => message.includes('disposable session delete failed'))).toBe(true);
    expect(harness.deletedSessionIds).toEqual([OWNED_SESSION_ID]);
    expect(harness.deletedDraftIds).toHaveLength(1);
    expect(harness.retiredPlugins).toEqual(['declarative', 'native', 'session-agent']);
  });
});

describe('current-source lifecycle ownership', () => {
  it('keeps granular split flows as the sole lifecycle owner: no competing monolith flow and no executable reference', () => {
    const testsRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
    const flowsDir = join(testsRoot, 'suites', 'mobile-e2e', 'flows', 'plugin-platform-current-source');
    const retiredMonolithFlow = 'lifecycle.yaml';
    // The retired exploratory monolith flow must not exist alongside the
    // maintained split flows owned by the current-source CLI.
    expect(existsSync(join(flowsDir, retiredMonolithFlow))).toBe(false);

    // No maintained executable source may wire the retired monolith back in.
    const offenders: Array<string> = [];
    const visit = (candidate: string): void => {
      if (statSync(candidate).isDirectory()) {
        if (candidate.split(/[\\/]/u).at(-1) === 'node_modules') return;
        for (const entry of readdirSync(candidate)) visit(join(candidate, entry));
        return;
      }
      if (!/\.(ts|mts|mjs|json|yaml|yml)$/u.test(candidate)) return;
      if (/\.test\.[a-z]+$/u.test(candidate) || /\.d\.mts$/u.test(candidate)) return;
      if (readFileSync(candidate, 'utf8').includes('plugin-platform-current-source/lifecycle')) offenders.push(candidate);
    };
    for (const executableRoot of [join(testsRoot, 'src'), join(testsRoot, 'scripts'), join(testsRoot, 'package.json')]) {
      visit(executableRoot);
    }
    // Maestro runFlow wiring under the current-source flows dir executes by
    // relative path, so the sibling flows are checked directly.
    for (const entry of readdirSync(flowsDir)) {
      if (entry === retiredMonolithFlow || !/\.(yaml|yml)$/u.test(entry)) continue;
      if (readFileSync(join(flowsDir, entry), 'utf8').includes(retiredMonolithFlow)) offenders.push(entry);
    }
    expect(offenders).toEqual([]);
  });
});
