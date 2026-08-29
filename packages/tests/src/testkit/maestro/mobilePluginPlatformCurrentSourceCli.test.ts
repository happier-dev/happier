import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  MobilePluginPlatformCurrentSourceJourneyExitError,
  runMobilePluginPlatformCurrentSourceCli,
} from './mobilePluginPlatformCurrentSourceCli';
import {
  CURRENT_SOURCE_SESSION_AGENT_LOCAL_ID,
  CURRENT_SOURCE_SESSION_AGENT_PLUGIN_ID,
  CURRENT_SOURCE_SESSION_AGENT_QUALIFIED_TARGET_ID,
  buildCurrentManagedStackSessionAgentSelectors,
  type CurrentManagedStackSessionAgentFixture,
} from '../pluginPlatform/currentManagedStackPluginUiQa';
import { runDefaultMobileMaestroCli } from './mobileMaestroCli';
import {
  MOBILE_PLUGIN_PLATFORM_CURRENT_SOURCE_FLOW,
  readCurrentSourceDisposableSessionExactFact,
  resolveCurrentSourceDisposableSessionDeletionTarget,
  resolveMobilePluginPlatformCurrentSourceExitCode,
  resolveMobilePluginPlatformCurrentSourceRun,
  type CurrentSourceDisposableSessionExactFact,
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
  it('keeps the production exact-fact source fail-closed while the canonical spawn-attempt surface is unwired', async () => {
    await expect(readCurrentSourceDisposableSessionExactFact()).resolves.toEqual({
      status: 'unavailable',
      reason: 'plugin_ui_current_source_disposable_session_exact_fact_source_not_wired',
    });
  });

  it('deletes only from a bound exact fact and fails closed on missing, conflicting, and unreadable facts', () => {
    expect(resolveCurrentSourceDisposableSessionDeletionTarget({
      status: 'bound',
      sessionId: OWNED_SESSION_ID,
    })).toBe(OWNED_SESSION_ID);
    expect(() => resolveCurrentSourceDisposableSessionDeletionTarget({ status: 'missing' }))
      .toThrow('plugin_ui_current_source_disposable_session_identity_missing');
    expect(() => resolveCurrentSourceDisposableSessionDeletionTarget({ status: 'conflicting', matches: 2 }))
      .toThrow('plugin_ui_current_source_disposable_session_identity_conflicting:2');
    const readFailure = new Error('exact fact source unavailable');
    expect(() => resolveCurrentSourceDisposableSessionDeletionTarget({
      status: 'unreadable',
      error: readFailure,
    })).toThrow('plugin_ui_current_source_disposable_session_identity_unreadable');
    // An unwired fact source also deletes nothing.
    expect(resolveCurrentSourceDisposableSessionDeletionTarget({
      status: 'unavailable',
      reason: 'plugin_ui_current_source_disposable_session_exact_fact_source_not_wired',
    })).toBeNull();
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
    const managedPublicComposerSend = readFileSync(
      new URL('../../../suites/mobile-e2e/flows/plugin-platform-current-source/managed-public-composer-send.yaml', import.meta.url),
      'utf8',
    );
    const managedPublicComposerTranscript = readFileSync(
      new URL('../../../suites/mobile-e2e/flows/plugin-platform-current-source/managed-public-composer-transcript.yaml', import.meta.url),
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
    // The exact disposable-Session handoff is split: create/send proves the
    // send's own custody and never asserts the transcript; the transcript
    // proof runs as its own flow after the owning CLI armed exact cleanup.
    expect(managedPublicComposerSend).toContain('HAPPIER_E2E_CURRENT_SOURCE_NEW_SESSION_URL');
    expect(managedPublicComposerSend).toContain('new-session-composer-send');
    expect(managedPublicComposerSend).toContain('notVisible');
    expect(managedPublicComposerSend).toContain('new-session-composer-input');
    expect(managedPublicComposerSend).not.toContain('HAPPIER_E2E_CURRENT_SOURCE_TRANSCRIPT_SENTINEL');
    expect(managedPublicComposerTranscript).toContain('HAPPIER_E2E_CURRENT_SOURCE_TRANSCRIPT_SENTINEL');
    expect(managedPublicComposerTranscript).toContain('transcript-composer-attachment:.*');
    expect(managedPublicComposerTranscript).not.toContain('new-session-composer-send');
    expect(managedPublicComposerRetained).toContain('HAPPIER_E2E_CURRENT_SOURCE_COMPOSER_ATTACHMENT_LABEL');
    // The native surface observes the fixture's dynamic Resource and the full
    // Action busy -> settled -> result transition through the real host.
    expect(managedPublicNative).toContain('HAPPIER_E2E_CURRENT_SOURCE_RESOURCE_SENTINEL');
    expect(managedPublicNative).toContain('HAPPIER_E2E_CURRENT_SOURCE_ACTION_RUN_ID');
    expect(managedPublicNative).toContain('HAPPIER_E2E_CURRENT_SOURCE_ACTION_BUSY_ID');
    expect(managedPublicNative).toContain('HAPPIER_E2E_CURRENT_SOURCE_ACTION_SETTLED_ID');
    expect(managedPublicNative).toContain('HAPPIER_E2E_CURRENT_SOURCE_ACTION_RESULT_SENTINEL');
    const completeCurrentSourceFlow = [
      probe,
      revisionProbe,
      managedPresent,
      managedPublicNative,
      managedPublicHosted,
      managedPublicComposerSend,
      managedPublicComposerTranscript,
      managedPublicComposerRetained,
      managedPublicHostedAbsent,
      managedPublicTransition,
      managedPublicHostedTransition,
    ].join('\n');
    expect(completeCurrentSourceFlow).not.toMatch(/tarball|\.tgz/u);
    expect(completeCurrentSourceFlow).not.toMatch(/artifact[_-]?handle|cache[_-]?key|storage[_-]?partition/iu);
  });
});

const COMPOSER_SEND_FLOW = 'suites/mobile-e2e/flows/plugin-platform-current-source/managed-public-composer-send.yaml';
const COMPOSER_TRANSCRIPT_FLOW = 'suites/mobile-e2e/flows/plugin-platform-current-source/managed-public-composer-transcript.yaml';
const COMPOSER_RETAINED_FLOW = 'suites/mobile-e2e/flows/plugin-platform-current-source/managed-public-composer-retained.yaml';
const SESSION_AGENT_SEND_FLOW = 'suites/mobile-e2e/flows/plugin-platform-current-source/managed-session-agent-send.yaml';
const SESSION_AGENT_TRANSCRIPT_FLOW = 'suites/mobile-e2e/flows/plugin-platform-current-source/managed-session-agent-transcript.yaml';
const OWNED_SESSION_ID = 'session-owned';
const OWNED_V2_SESSION_ID = 'session-owned-v2';
const OWNED_AGENT_SESSION_ID = 'session-agent-owned';
const CONCURRENT_SESSION_ID = 'session-concurrent';

type RowHarnessOverrides = Readonly<{
  flowExitCode?: (flowPath: string, occurrence: number) => number;
  readDisposableSessionExactFact?: (armIndex: number) => Promise<CurrentSourceDisposableSessionExactFact>;
  deleteSession?: (context: unknown, sessionId: string) => Promise<void>;
  finalDaemonPid?: number;
}>;

const NATIVE_PUBLIC_FLOW_PREFIX = 'suites/mobile-e2e/flows/plugin-platform-current-source/managed-public-';

/**
 * Validates the env the production orchestration actually passes to each
 * current-source flow. A missing, empty, or version-mismatched variable fails
 * the fake loudly, so an under-populated harness fixture can never false-green
 * the real row.
 */
function assertCurrentSourceNativeFlowEnv(env: NodeJS.ProcessEnv | undefined): void {
  const required = [
    'HAPPIER_E2E_CURRENT_SOURCE_PLUGIN_ID',
    'HAPPIER_E2E_CURRENT_SOURCE_RN_SURFACE_URL',
    'HAPPIER_E2E_CURRENT_SOURCE_HOSTED_SURFACE_URL',
    'HAPPIER_E2E_CURRENT_SOURCE_RN_SENTINEL',
    'HAPPIER_E2E_CURRENT_SOURCE_HOSTED_SENTINEL',
    'HAPPIER_E2E_CURRENT_SOURCE_TARGETED_SENTINEL',
    'HAPPIER_E2E_CURRENT_SOURCE_TARGETED_READY_ID',
    'HAPPIER_E2E_CURRENT_SOURCE_HOSTED_READY_ID',
    'HAPPIER_E2E_CURRENT_SOURCE_COMPOSER_CONTROL_ID',
    'HAPPIER_E2E_CURRENT_SOURCE_COMPOSER_SECONDARY_CONTROL_ID',
    'HAPPIER_E2E_CURRENT_SOURCE_COMPOSER_REGION_ID',
    'HAPPIER_E2E_CURRENT_SOURCE_COMPOSER_CHOICE_LABEL',
    'HAPPIER_E2E_CURRENT_SOURCE_COMPOSER_ATTACHMENT_LABEL',
    'HAPPIER_E2E_CURRENT_SOURCE_COMPOSER_REFERENCE_LABEL',
    'HAPPIER_E2E_CURRENT_SOURCE_AGENT_TITLE',
    'HAPPIER_E2E_CURRENT_SOURCE_TRANSCRIPT_SENTINEL',
    'HAPPIER_E2E_CURRENT_SOURCE_RESOURCE_SENTINEL',
    'HAPPIER_E2E_CURRENT_SOURCE_ACTION_RUN_ID',
    'HAPPIER_E2E_CURRENT_SOURCE_ACTION_BUSY_ID',
    'HAPPIER_E2E_CURRENT_SOURCE_ACTION_SETTLED_ID',
    'HAPPIER_E2E_CURRENT_SOURCE_ACTION_RESULT_SENTINEL',
    'HAPPIER_E2E_CURRENT_SOURCE_NEW_SESSION_URL',
  ];
  for (const key of required) {
    const value = env?.[key];
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new Error(`current-source flow env ${key} missing or empty`);
    }
  }
  const rnSentinel = env?.HAPPIER_E2E_CURRENT_SOURCE_RN_SENTINEL;
  const version = rnSentinel === 'rn-v1' ? 'v1' : rnSentinel === 'rn-v2' ? 'v2' : null;
  if (!version) {
    throw new Error(`current-source flow env RN sentinel is not a fixture v1/v2 value: ${String(rnSentinel)}`);
  }
  if (env?.HAPPIER_E2E_CURRENT_SOURCE_RESOURCE_SENTINEL !== `resource-${version}`) {
    throw new Error('current-source flow env resource sentinel does not match the RN fixture generation');
  }
  if (env?.HAPPIER_E2E_CURRENT_SOURCE_ACTION_RUN_ID !== 'action-run'
    || env?.HAPPIER_E2E_CURRENT_SOURCE_ACTION_BUSY_ID !== 'action-busy'
    || env?.HAPPIER_E2E_CURRENT_SOURCE_ACTION_SETTLED_ID !== 'action-settled') {
    throw new Error('current-source flow env Action sentinels missing');
  }
  if (env?.HAPPIER_E2E_CURRENT_SOURCE_ACTION_RESULT_SENTINEL !== `action-result-${version}`) {
    throw new Error('current-source flow env Action result sentinel does not match the RN fixture generation');
  }
  // Composer reference and attachment presentation facts are generation
  // sentinels like every other fixture value: each flow's env must advertise
  // exactly its own generation's labels, so a fresh post-update v2 dispatch
  // can never silently run against v1 labels (or vice versa).
  if (env?.HAPPIER_E2E_CURRENT_SOURCE_COMPOSER_ATTACHMENT_LABEL !== `composer-attachment-${version}`) {
    throw new Error('current-source flow env Composer attachment label does not match the fixture generation');
  }
  if (env?.HAPPIER_E2E_CURRENT_SOURCE_COMPOSER_REFERENCE_LABEL !== `composer-reference-${version}`) {
    throw new Error('current-source flow env Composer reference label does not match the fixture generation');
  }
  if (!/^happier-dev:\/\/\/new\?draftId=[0-9a-f-]{36}$/u.test(env?.HAPPIER_E2E_CURRENT_SOURCE_NEW_SESSION_URL ?? '')) {
    throw new Error('current-source flow env New Session URL is not the QA-owned deep-link draft');
  }
}

function createRowHarness(overrides: RowHarnessOverrides = {}) {
  const deletedSessionIds: string[] = [];
  const deletedDraftIds: string[] = [];
  const retiredPlugins: string[] = [];
  const manifestEvidence: Array<Readonly<Record<string, unknown>>> = [];
  /** Real orchestration timeline: flow phases and exact-fact arming, in order. */
  const timeline: string[] = [];
  const flowOccurrences = new Map<string, number>();
  let armCount = 0;
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
      composerAttachmentV2: 'composer-attachment-v2',
      composerReferenceV1: 'composer-reference-v1',
      composerReferenceV2: 'composer-reference-v2',
      composerRegion: 'composer-region',
      agentTitle: 'agent-title',
      transcriptSentinel: 'transcript-sentinel',
      resourceV1: 'resource-v1',
      resourceV2: 'resource-v2',
      actionRun: 'action-run',
      actionBusy: 'action-busy',
      actionSettled: 'action-settled',
      actionResultV1: 'action-result-v1',
      actionResultV2: 'action-result-v2',
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
  const sessionAgentFixture: CurrentManagedStackSessionAgentFixture = {
    pluginId: CURRENT_SOURCE_SESSION_AGENT_PLUGIN_ID,
    agentLocalId: CURRENT_SOURCE_SESSION_AGENT_LOCAL_ID,
    qualifiedAgentId: CURRENT_SOURCE_SESSION_AGENT_QUALIFIED_TARGET_ID,
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
    deleteSession: async (context: unknown, sessionId: string) => {
      // Production calls deleteSession(context, sessionId): only the exact
      // bound sessionId is a deletion record — never the context object.
      deletedSessionIds.push(sessionId);
      if (overrides.deleteSession) await overrides.deleteSession(context, sessionId);
    },
    deleteNewSessionDraft: async (_context: unknown, draftId: string) => {
      deletedDraftIds.push(draftId);
    },
    readDisposableSessionExactFact: async () => {
      armCount += 1;
      timeline.push(`arm-disposable-session-fact:${armCount}`);
      if (overrides.readDisposableSessionExactFact) {
        return await overrides.readDisposableSessionExactFact(armCount);
      }
      // Three distinct disposable Sessions are armed per row: the v1 Composer
      // handoff Session, the fresh post-update v2 Composer dispatch Session,
      // and the Session Agent journey Session.
      return {
        status: 'bound',
        sessionId: armCount === 1
          ? OWNED_SESSION_ID
          : armCount === 2 ? OWNED_V2_SESSION_ID : OWNED_AGENT_SESSION_ID,
      } as const;
    },
    appendManifestEvidence: (params: Readonly<{ evidence: Readonly<Record<string, unknown>> }>) => {
      manifestEvidence.push(params.evidence);
    },
    runMobileMaestroCli: (async (
      _input: Parameters<typeof runDefaultMobileMaestroCli>[0],
      options: Parameters<typeof runDefaultMobileMaestroCli>[1],
    ) => {
      const exitCode = await options?.runScenario?.({
        defaultFlowPath: 'suites/mobile-e2e/flows/plugin-platform-current-source/managed-inspector-native.yaml',
        serverUrlHost: '127.0.0.1',
        serverUrlDevice: '10.0.2.2',
        platform: 'android',
        runFlow: async (flowPath: string, env?: NodeJS.ProcessEnv) => {
          timeline.push(`flow:${flowPath}`);
          const occurrence = (flowOccurrences.get(flowPath) ?? 0) + 1;
          flowOccurrences.set(flowPath, occurrence);
          if (flowPath.startsWith(NATIVE_PUBLIC_FLOW_PREFIX)) {
            assertCurrentSourceNativeFlowEnv(env);
          }
          return {
            exitCode: overrides.flowExitCode ? overrides.flowExitCode(flowPath, occurrence) : 0,
          };
        },
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
  return { runRow, deletedSessionIds, deletedDraftIds, retiredPlugins, manifestEvidence, timeline };
}

describe('current-source Plugin UI mobile QA row cleanup', () => {
  it('arms the exact fact between the create/send and transcript flows and deletes the bound id on transcript failure', async () => {
    const harness = createRowHarness({
      flowExitCode: (flowPath) => (flowPath === COMPOSER_TRANSCRIPT_FLOW ? 3 : 0),
    });

    await expect(harness.runRow()).resolves.toBe(3);

    // Arming sits immediately after the send flow and before the transcript
    // proof, so a transcript failure can no longer leak the owned Session.
    const sendIndex = harness.timeline.indexOf(`flow:${COMPOSER_SEND_FLOW}`);
    const armIndex = harness.timeline.indexOf('arm-disposable-session-fact:1');
    const transcriptIndex = harness.timeline.indexOf(`flow:${COMPOSER_TRANSCRIPT_FLOW}`);
    expect(sendIndex).toBeGreaterThanOrEqual(0);
    expect(armIndex).toBe(sendIndex + 1);
    expect(transcriptIndex).toBe(armIndex + 1);
    // The armed Composer disposable Session is still cleaned by its exact
    // bound id despite the transcript failure; the v2 dispatch and the
    // Session-Agent arm never run because the row stops at the transcript
    // failure. Both QA-owned New Session drafts are always retired.
    expect(harness.deletedSessionIds).toEqual([OWNED_SESSION_ID]);
    expect(harness.deletedDraftIds).toHaveLength(2);
    expect(harness.retiredPlugins).toEqual(['declarative', 'native', 'session-agent']);
  });

  it('stops the journey at a conflicting Composer fact, deletes nothing, and never creates the later Sessions', async () => {
    const harness = createRowHarness({
      readDisposableSessionExactFact: async () => ({ status: 'conflicting', matches: 2 }),
    });

    const thrown = await harness.runRow().then(() => null, (error) => error);

    // A conflicting fact is a terminal non-bound state: the journey stops at
    // the first send boundary, the conflicting fact deletes nothing, and the
    // later v2/Session-Agent arming never happens, so their Sessions are
    // never even created.
    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).errors.map((error) => String((error as Error).message))).toEqual([
      'plugin_ui_current_source_disposable_session_exact_fact_not_bound:conflicting',
      'plugin_ui_current_source_disposable_session_identity_conflicting:2',
    ]);
    expect(harness.deletedSessionIds).toEqual([]);
    expect(harness.deletedSessionIds).not.toContain(CONCURRENT_SESSION_ID);
    expect(harness.deletedDraftIds).toHaveLength(2);
    expect(harness.retiredPlugins).toEqual(['declarative', 'native', 'session-agent']);
    expect(harness.manifestEvidence).toEqual([]);
  });

  it('stops the journey at a missing exact fact, deletes nothing, and never creates the later Sessions', async () => {
    const harness = createRowHarness({
      readDisposableSessionExactFact: async () => ({ status: 'missing' }),
    });

    const thrown = await harness.runRow().then(() => null, (error) => error);

    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).errors.map((error) => String((error as Error).message))).toEqual([
      'plugin_ui_current_source_disposable_session_exact_fact_not_bound:missing',
      'plugin_ui_current_source_disposable_session_identity_missing',
    ]);
    expect(harness.deletedSessionIds).toEqual([]);
    expect(harness.deletedSessionIds).not.toContain(CONCURRENT_SESSION_ID);
    expect(harness.deletedDraftIds).toHaveLength(2);
    expect(harness.manifestEvidence).toEqual([]);
  });

  it('stops the journey at an unreadable exact fact, deletes nothing, and never creates the later Sessions', async () => {
    const harness = createRowHarness({
      readDisposableSessionExactFact: async () => ({
        status: 'unreadable',
        error: new Error('exact fact source down'),
      }),
    });

    const thrown = await harness.runRow().then(() => null, (error) => error);

    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).errors.map((error) => String((error as Error).message))).toEqual([
      'plugin_ui_current_source_disposable_session_exact_fact_not_bound:unreadable',
      'plugin_ui_current_source_disposable_session_identity_unreadable',
    ]);
    expect(harness.deletedSessionIds).toEqual([]);
    expect(harness.deletedSessionIds).not.toContain(CONCURRENT_SESSION_ID);
    expect(harness.deletedDraftIds).toHaveLength(2);
    expect(harness.manifestEvidence).toEqual([]);
  });

  it('never arms or deletes anything when the send never landed', async () => {
    const harness = createRowHarness({
      flowExitCode: (flowPath) => (flowPath === COMPOSER_SEND_FLOW ? 4 : 0),
      readDisposableSessionExactFact: async () => ({
        status: 'bound',
        sessionId: CONCURRENT_SESSION_ID,
      }),
    });

    await expect(harness.runRow()).resolves.toBe(4);

    expect(harness.timeline.some((entry) => entry.startsWith('arm-disposable-session-fact'))).toBe(false);
    expect(harness.deletedSessionIds).toEqual([]);
    expect(harness.deletedDraftIds).toHaveLength(2);
  });

  it('deletes only the bound Session ids even while unrelated concurrent Sessions exist, and runs the fresh post-update v2 Composer dispatch between the retained and transition flows', async () => {
    const harness = createRowHarness({
      // Three distinct arming calls, each returning its own expected owned
      // id: the v1 Composer handoff Session, the fresh post-update v2
      // Composer dispatch Session, and the Session-Agent journey Session.
      readDisposableSessionExactFact: async (armIndex) => ({
        status: 'bound',
        sessionId: armIndex === 1
          ? OWNED_SESSION_ID
          : armIndex === 2 ? OWNED_V2_SESSION_ID : OWNED_AGENT_SESSION_ID,
      }),
    });

    await expect(harness.runRow()).resolves.toBe(0);

    // The fresh post-update dispatch is a second full Composer send on its
    // own draft: it sits between the retained v1 immutability proof and the
    // native transition, with the v2 exact fact armed from its own landed
    // send before its transcript proof runs.
    const retainedIndex = harness.timeline.indexOf(`flow:${COMPOSER_RETAINED_FLOW}`);
    // The v2 dispatch reuses the split send/transcript flows, so its phases
    // are the second (last) occurrences in the timeline.
    const v2SendIndex = harness.timeline.lastIndexOf(`flow:${COMPOSER_SEND_FLOW}`);
    const v2ArmIndex = harness.timeline.indexOf('arm-disposable-session-fact:2');
    const v2TranscriptIndex = harness.timeline.lastIndexOf(`flow:${COMPOSER_TRANSCRIPT_FLOW}`);
    expect(retainedIndex).toBeGreaterThanOrEqual(0);
    expect(v2SendIndex).toBe(retainedIndex + 1);
    expect(v2ArmIndex).toBe(v2SendIndex + 1);
    expect(v2TranscriptIndex).toBe(v2ArmIndex + 1);

    // Only bound exact ids are ever deletion targets; a concurrent Session
    // (even one sharing the corridor) can never enter them.
    expect(harness.deletedSessionIds).toEqual([OWNED_SESSION_ID, OWNED_V2_SESSION_ID, OWNED_AGENT_SESSION_ID]);
    expect(harness.deletedSessionIds).not.toContain(CONCURRENT_SESSION_ID);
    expect(harness.deletedDraftIds).toHaveLength(2);
    const lifecycle = harness.manifestEvidence[0]?.currentManagedStackPluginUi as {
      nativePublicFixtureLifecycle?: Array<Readonly<Record<string, unknown>>>;
    };
    expect(lifecycle.nativePublicFixtureLifecycle).toContainEqual({
      phase: 'disposable-session-armed',
      fact: 'bound',
      sessionId: OWNED_SESSION_ID,
    });
    expect(lifecycle.nativePublicFixtureLifecycle).toContainEqual({
      phase: 'disposable-session-deleted',
      sessionId: OWNED_SESSION_ID,
    });
    expect(lifecycle.nativePublicFixtureLifecycle).toContainEqual({
      phase: 'disposable-session-v2-armed',
      fact: 'bound',
      sessionId: OWNED_V2_SESSION_ID,
    });
    expect(lifecycle.nativePublicFixtureLifecycle).toContainEqual({
      phase: 'disposable-session-v2-deleted',
      sessionId: OWNED_V2_SESSION_ID,
    });
  });

  it('stops the production row at the first unavailable exact fact before the v2 and Session-Agent Sessions', async () => {
    const harness = createRowHarness({
      readDisposableSessionExactFact: async () => await readCurrentSourceDisposableSessionExactFact(),
    });

    // Unavailable is a terminal non-bound fact state: the journey stops
    // immediately after the first Composer send boundary, so the transcript
    // proof, the fresh v2 Composer dispatch, and the Session Agent journey
    // never run and never create further undeletable Sessions.
    const thrown = await harness.runRow().then(() => null, (error) => error);
    expect(thrown).toBeInstanceOf(AggregateError);
    const unavailableCause = 'plugin_ui_current_source_disposable_session_exact_fact_unavailable:plugin_ui_current_source_disposable_session_exact_fact_source_not_wired';
    expect((thrown as AggregateError).errors.map((error) => String((error as Error).message))).toEqual([
      'plugin_ui_current_source_disposable_session_exact_fact_not_bound:unavailable',
      unavailableCause,
    ]);

    // Only one send and one arming happened; no v2 dispatch or Session-Agent
    // flow ran. No unrelated or owned Session is deletable without a bound
    // exact fact, and no success manifest is written for the blocked row.
    expect(harness.timeline.filter((entry) => entry === `flow:${COMPOSER_SEND_FLOW}`)).toHaveLength(1);
    expect(harness.timeline.some((entry) => entry.startsWith('arm-disposable-session-fact:2'))).toBe(false);
    expect(harness.timeline.some((entry) => entry === `flow:${SESSION_AGENT_SEND_FLOW}`)).toBe(false);
    expect(harness.deletedSessionIds).toEqual([]);
    expect(harness.deletedDraftIds).toHaveLength(2);
    expect(harness.retiredPlugins).toEqual(['declarative', 'native', 'session-agent']);
    expect(harness.manifestEvidence).toEqual([]);
  });

  it('aggregates the original nonzero journey exit with the cleanup failure', async () => {
    const harness = createRowHarness({
      flowExitCode: (flowPath) => (flowPath === COMPOSER_RETAINED_FLOW ? 3 : 0),
      deleteSession: async (_context, sessionId) => {
        if (sessionId === OWNED_SESSION_ID) throw new Error('disposable session delete failed');
      },
    });

    const thrown = await harness.runRow().then(() => null, (error) => error);

    // One AggregateError must carry BOTH the original nonzero journey exit and
    // the cleanup cause — the cleanup failure may not swallow the exit code.
    expect(thrown).toBeInstanceOf(AggregateError);
    const causes = (thrown as AggregateError).errors;
    expect(causes).toHaveLength(2);
    // The journey exit is the structured, exit-typed cause, not a bare Error.
    expect(causes[0]).toBeInstanceOf(MobilePluginPlatformCurrentSourceJourneyExitError);
    const journeyExit = causes[0] as MobilePluginPlatformCurrentSourceJourneyExitError;
    expect(journeyExit.exitCode).toBe(3);
    expect(journeyExit.code).toBe('plugin_ui_current_source_mobile_journey_exit');
    expect(journeyExit.name).toBe('MobilePluginPlatformCurrentSourceJourneyExitError');
    expect(String(journeyExit.message)).toMatch(/plugin_ui_current_source_mobile_journey_exit_3$/u);
    expect(String((causes[1] as Error).message)).toBe('disposable session delete failed');
    expect(harness.deletedSessionIds).toEqual([OWNED_SESSION_ID]);
    expect(harness.deletedDraftIds).toHaveLength(2);
    expect(harness.retiredPlugins).toEqual(['declarative', 'native', 'session-agent']);
  });

  it('aggregates a cleanup delete failure with a thrown row failure', async () => {
    const harness = createRowHarness({
      deleteSession: async (_context, sessionId) => {
        if (sessionId === OWNED_SESSION_ID) throw new Error('disposable session delete failed');
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
    expect(harness.deletedSessionIds).toEqual([OWNED_SESSION_ID, OWNED_V2_SESSION_ID, OWNED_AGENT_SESSION_ID]);
    expect(harness.deletedDraftIds).toHaveLength(2);
    expect(harness.retiredPlugins).toEqual(['declarative', 'native', 'session-agent']);
  });

  it('stops at a non-bound v2 fact before the v2 transcript and Session-Agent Session while the bound v1 id is still cleaned', async () => {
    const harness = createRowHarness({
      readDisposableSessionExactFact: async (armIndex) => (armIndex === 1
        ? { status: 'bound', sessionId: OWNED_SESSION_ID }
        : { status: 'missing' }),
    });

    const thrown = await harness.runRow().then(() => null, (error) => error);

    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).errors.map((error) => String((error as Error).message))).toEqual([
      'plugin_ui_current_source_disposable_session_exact_fact_not_bound:missing',
      'plugin_ui_current_source_disposable_session_identity_missing',
    ]);

    // The v2 exact fact is armed between the second send and its transcript:
    // the non-bound fact stops the journey there, so the v2 transcript and
    // the Session-Agent journey never run, while the already-bound v1 id is
    // still deleted by its own exact fact.
    const v2SendIndex = harness.timeline.lastIndexOf(`flow:${COMPOSER_SEND_FLOW}`);
    expect(v2SendIndex).toBeGreaterThanOrEqual(0);
    expect(harness.timeline.indexOf('arm-disposable-session-fact:2')).toBe(v2SendIndex + 1);
    expect(harness.timeline.filter((entry) => entry === `flow:${COMPOSER_TRANSCRIPT_FLOW}`)).toHaveLength(1);
    expect(harness.timeline.some((entry) => entry === `flow:${SESSION_AGENT_SEND_FLOW}`)).toBe(false);
    expect(harness.deletedSessionIds).toEqual([OWNED_SESSION_ID]);
    expect(harness.deletedSessionIds).not.toContain(OWNED_V2_SESSION_ID);
    expect(harness.deletedSessionIds).not.toContain(OWNED_AGENT_SESSION_ID);
    expect(harness.deletedDraftIds).toHaveLength(2);
    expect(harness.manifestEvidence).toEqual([]);
  });

  it('cleans the exact v1 and v2 ids when the second v2 transcript proof fails', async () => {
    const harness = createRowHarness({
      flowExitCode: (flowPath, occurrence) =>
        flowPath === COMPOSER_TRANSCRIPT_FLOW && occurrence === 2 ? 3 : 0,
    });

    await expect(harness.runRow()).resolves.toBe(3);

    // Both armed Composer facts delete their own exact bound ids; the
    // Session-Agent journey never runs, so its Session is neither created
    // nor armed, and no unrelated id is ever a target.
    expect(harness.timeline.lastIndexOf(`flow:${COMPOSER_TRANSCRIPT_FLOW}`)).toBeGreaterThan(
      harness.timeline.indexOf('arm-disposable-session-fact:2'),
    );
    expect(harness.deletedSessionIds).toEqual([OWNED_SESSION_ID, OWNED_V2_SESSION_ID]);
    expect(harness.deletedSessionIds).not.toContain(OWNED_AGENT_SESSION_ID);
    expect(harness.deletedSessionIds).not.toContain(CONCURRENT_SESSION_ID);
    expect(harness.timeline.some((entry) => entry === `flow:${SESSION_AGENT_SEND_FLOW}`)).toBe(false);
    expect(harness.deletedDraftIds).toHaveLength(2);
  });

  it('cleans the armed Session-Agent id when its downstream confirmation/recovery proof fails', async () => {
    const harness = createRowHarness({
      flowExitCode: (flowPath) => (flowPath === SESSION_AGENT_TRANSCRIPT_FLOW ? 5 : 0),
    });

    await expect(harness.runRow()).resolves.toBe(5);

    // The Session-Agent exact fact is armed between its send flow and the
    // downstream confirmation/cancellation/recovery proof, so this failure
    // still deletes the exact created Session id.
    const sendIndex = harness.timeline.indexOf(`flow:${SESSION_AGENT_SEND_FLOW}`);
    const armIndex = harness.timeline.indexOf('arm-disposable-session-fact:3');
    const transcriptIndex = harness.timeline.indexOf(`flow:${SESSION_AGENT_TRANSCRIPT_FLOW}`);
    expect(sendIndex).toBeGreaterThanOrEqual(0);
    expect(armIndex).toBe(sendIndex + 1);
    expect(transcriptIndex).toBe(armIndex + 1);
    expect(harness.deletedSessionIds).toEqual([OWNED_SESSION_ID, OWNED_V2_SESSION_ID, OWNED_AGENT_SESSION_ID]);
    expect(harness.deletedSessionIds).not.toContain(CONCURRENT_SESSION_ID);
    expect(harness.deletedDraftIds).toHaveLength(2);
  });

  it('aggregates the structured journey exit, final attestation failure, and cleanup failure exactly once each', async () => {
    const harness = createRowHarness({
      flowExitCode: (flowPath) => (flowPath === COMPOSER_RETAINED_FLOW ? 3 : 0),
      deleteSession: async (_context, sessionId) => {
        if (sessionId === OWNED_SESSION_ID) throw new Error('disposable session delete failed');
      },
      // Force a final attestation failure on top of the nonzero journey exit
      // by making it observe a runtime identity change.
      finalDaemonPid: 5151,
    });

    const thrown = await harness.runRow().then(() => null, (error) => error);

    // Every distinct cause appears exactly once, journey exit first: the
    // attestation failure must not swallow the journey exit, and the cleanup
    // failure must not swallow either.
    expect(thrown).toBeInstanceOf(AggregateError);
    const causes = (thrown as AggregateError).errors;
    expect(causes).toHaveLength(3);
    expect(causes[0]).toBeInstanceOf(MobilePluginPlatformCurrentSourceJourneyExitError);
    const journeyExit = causes[0] as MobilePluginPlatformCurrentSourceJourneyExitError;
    expect(journeyExit.exitCode).toBe(3);
    expect(journeyExit.code).toBe('plugin_ui_current_source_mobile_journey_exit');
    expect(journeyExit.name).toBe('MobilePluginPlatformCurrentSourceJourneyExitError');
    expect(String(journeyExit.message)).toMatch(/plugin_ui_current_source_mobile_journey_exit_3$/u);
    expect(String((causes[1] as Error).message)).toContain('runtime_identity_changed_during_row');
    expect(String((causes[2] as Error).message)).toBe('disposable session delete failed');
    expect(harness.deletedSessionIds).toEqual([OWNED_SESSION_ID]);
    expect(harness.deletedDraftIds).toHaveLength(2);
  });
});

describe('current-source lifecycle ownership', () => {
  it('keeps granular split flows as the sole lifecycle owner: no competing monolith flow and no executable reference', () => {
    const testsRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
    const flowsDir = join(testsRoot, 'suites', 'mobile-e2e', 'flows', 'plugin-platform-current-source');
    const retiredMonolithFlow = 'lifecycle.yaml';
    const retiredCombinedComposerFlow = 'managed-public-composer.yaml';
    const retiredCombinedSessionAgentFlow = 'managed-session-agent.yaml';
    // The retired exploratory monolith flow must not exist alongside the
    // maintained split flows owned by the current-source CLI.
    expect(existsSync(join(flowsDir, retiredMonolithFlow))).toBe(false);
    // The combined composer flow is superseded by the create/send and
    // transcript split, which lets the CLI arm exact cleanup in between.
    expect(existsSync(join(flowsDir, retiredCombinedComposerFlow))).toBe(false);
    // The combined Session-Agent flow is superseded the same way: the
    // create/send flow ends at the send's custody proof so the CLI arms exact
    // cleanup before the downstream confirmation/recovery proof runs.
    expect(existsSync(join(flowsDir, retiredCombinedSessionAgentFlow))).toBe(false);

    // No maintained executable source may wire a retired combined flow back in.
    const retiredFlowNames = [retiredMonolithFlow, retiredCombinedComposerFlow, retiredCombinedSessionAgentFlow];
    const offenders: Array<string> = [];
    const visit = (candidate: string): void => {
      if (statSync(candidate).isDirectory()) {
        if (candidate.split(/[\\/]/u).at(-1) === 'node_modules') return;
        for (const entry of readdirSync(candidate)) visit(join(candidate, entry));
        return;
      }
      if (!/\.(ts|mts|mjs|json|yaml|yml)$/u.test(candidate)) return;
      if (/\.test\.[a-z]+$/u.test(candidate) || /\.d\.mts$/u.test(candidate)) return;
      const content = readFileSync(candidate, 'utf8');
      if (retiredFlowNames.some((name) => content.includes(name))) offenders.push(candidate);
    };
    for (const executableRoot of [join(testsRoot, 'src'), join(testsRoot, 'scripts'), join(testsRoot, 'package.json')]) {
      visit(executableRoot);
    }
    // Maestro runFlow wiring under the current-source flows dir executes by
    // relative path, so the sibling flows are checked directly.
    for (const entry of readdirSync(flowsDir)) {
      if (retiredFlowNames.includes(entry) || !/\.(yaml|yml)$/u.test(entry)) continue;
      const content = readFileSync(join(flowsDir, entry), 'utf8');
      if (retiredFlowNames.some((name) => content.includes(name))) offenders.push(entry);
    }
    expect(offenders).toEqual([]);
  });
});
