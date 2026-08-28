import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

import {
  resolveCurrentManagedStackPluginUiContext,
  attestCurrentManagedStackPluginUi,
  deleteCurrentManagedStackNewSessionDraft,
  deleteCurrentManagedStackSession,
  prepareCurrentManagedStackDeclarativeLifecycleFixture,
  prepareCurrentManagedStackNativePublicFixture,
  prepareCurrentManagedStackSessionAgentFixture,
  readCurrentManagedStackSessionIds,
  type CurrentManagedStackPluginUiContext,
} from '../pluginPlatform/currentManagedStackPluginUiQa';
import {
  appendMobileMaestroManifestEvidence,
  resolveSelectedMobileTargetDeviceId,
} from './mobileMaestroRunner';
import { runDefaultMobileMaestroCli } from './mobileMaestroCli';
import {
  captureCurrentSourceDisposableSessionId,
  resolveCurrentSourceDisposableSessionDeletionTarget,
  resolveMobilePluginPlatformCurrentSourceExitCode,
  resolveMobilePluginPlatformCurrentSourceRun,
  type CurrentSourceDisposableSessionCapture,
} from './mobilePluginPlatformCurrentSourceInput';

/**
 * Genuine system boundaries behind the current-source row. Tests may override
 * these to drive the real orchestration; production always uses the canonical
 * implementations below.
 */
export type MobilePluginPlatformCurrentSourceCliDeps = Readonly<{
  runMobileMaestroCli: typeof runDefaultMobileMaestroCli;
  resolvePluginUiContext: typeof resolveCurrentManagedStackPluginUiContext;
  attestPluginUi: typeof attestCurrentManagedStackPluginUi;
  prepareNativePublicFixture: typeof prepareCurrentManagedStackNativePublicFixture;
  prepareDeclarativeLifecycleFixture: typeof prepareCurrentManagedStackDeclarativeLifecycleFixture;
  prepareSessionAgentFixture: typeof prepareCurrentManagedStackSessionAgentFixture;
  readSessionIds: typeof readCurrentManagedStackSessionIds;
  deleteSession: typeof deleteCurrentManagedStackSession;
  deleteNewSessionDraft: typeof deleteCurrentManagedStackNewSessionDraft;
  appendManifestEvidence: typeof appendMobileMaestroManifestEvidence;
}>;

const defaultCurrentSourceCliDeps: MobilePluginPlatformCurrentSourceCliDeps = {
  runMobileMaestroCli: runDefaultMobileMaestroCli,
  resolvePluginUiContext: resolveCurrentManagedStackPluginUiContext,
  attestPluginUi: attestCurrentManagedStackPluginUi,
  prepareNativePublicFixture: prepareCurrentManagedStackNativePublicFixture,
  prepareDeclarativeLifecycleFixture: prepareCurrentManagedStackDeclarativeLifecycleFixture,
  prepareSessionAgentFixture: prepareCurrentManagedStackSessionAgentFixture,
  readSessionIds: readCurrentManagedStackSessionIds,
  deleteSession: deleteCurrentManagedStackSession,
  deleteNewSessionDraft: deleteCurrentManagedStackNewSessionDraft,
  appendManifestEvidence: appendMobileMaestroManifestEvidence,
};

export async function runMobilePluginPlatformCurrentSourceCli(input: Readonly<{
  argv: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  deps?: Partial<MobilePluginPlatformCurrentSourceCliDeps>;
}> = {
  argv: process.argv,
  cwd: process.cwd(),
  env: process.env,
}): Promise<number> {
  const deps: MobilePluginPlatformCurrentSourceCliDeps = {
    ...defaultCurrentSourceCliDeps,
    ...input.deps,
  };
  const platformValue = (() => {
    const index = input.argv.findIndex((arg) => arg === '--platform');
    const explicit = index >= 0 ? input.argv[index + 1] : input.argv.find((arg) => arg.startsWith('--platform='))?.slice('--platform='.length);
    return explicit === 'ios' || explicit === 'android' ? explicit : null;
  })();
  if (!platformValue) throw new Error('plugin_ui_current_source_native_platform_required');
  if (!resolveSelectedMobileTargetDeviceId({
    env: input.env,
    platform: platformValue,
    args: input.argv,
  })) {
    throw new Error(`plugin_ui_current_source_${platformValue}_device_identity_required`);
  }
  const context = await deps.resolvePluginUiContext({
    env: input.env,
    requiredPublicationComponents: ['server', 'daemon'],
  });
  const stackAttestation = await deps.attestPluginUi({
    context,
    artifactPlatform: platformValue,
  });
  if (stackAttestation.daemonMachineId !== context.daemon.machineId) {
    throw new Error('plugin_ui_current_source_managed_daemon_machine_identity_mismatch');
  }
  const nativeFixture = await deps.prepareNativePublicFixture({
    context,
    rowId: randomUUID(),
  });
  const fixture = await deps.prepareDeclarativeLifecycleFixture({
    context,
    rowId: randomUUID(),
  }).catch(async (error) => {
    const cleanup = await Promise.allSettled([nativeFixture.cleanup()]);
    const cleanupError = cleanup[0]?.status === 'rejected' ? cleanup[0].reason : null;
    if (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Declarative fixture preparation and native fixture cleanup both failed');
    }
    throw error;
  });
  const sessionAgentFixture = await deps.prepareSessionAgentFixture({
    context,
    rowId: randomUUID(),
  }).catch(async (error) => {
    const cleanup = await Promise.allSettled([fixture.cleanup(), nativeFixture.cleanup()]);
    const cleanupErrors = cleanup.flatMap((entry) => entry.status === 'rejected' ? [entry.reason] : []);
    if (cleanupErrors.length > 0) {
      throw new AggregateError([error, ...cleanupErrors], 'Session Agent fixture preparation and prior fixture cleanup both failed');
    }
    throw error;
  });
  const newSessionDraftId = randomUUID();
  const resolved = resolveMobilePluginPlatformCurrentSourceRun({
    ...input,
    managedStack: {
      serverUrl: context.serverUrl,
    },
  });
  const runPhase = async (
    runFlow: (path: string, env?: NodeJS.ProcessEnv) => Promise<{ exitCode: number }>,
    path: string,
    env: NodeJS.ProcessEnv = {},
  ): Promise<number> => (await runFlow(path, env)).exitCode;
  const lifecycleEvidence: Array<Readonly<Record<string, unknown>>> = [{
    phase: 'installed-v1',
    ...fixture.installed,
  }];
  const nativeLifecycleEvidence: Array<Readonly<Record<string, unknown>>> = [{
    phase: 'installed-v1',
    ...nativeFixture.installed,
  }];
  let result: Awaited<ReturnType<typeof runDefaultMobileMaestroCli>> | null = null;
  let finalStackAttestation: Awaited<ReturnType<typeof attestCurrentManagedStackPluginUi>> | null = null;
  let disposableSessionCapture: CurrentSourceDisposableSessionCapture = {
    sessionId: null,
    conflict: null,
    readError: null,
  };
  let sessionAgentSessionCapture: CurrentSourceDisposableSessionCapture = {
    sessionId: null,
    conflict: null,
    readError: null,
  };
  let runError: unknown = null;
  let cleanupError: unknown = null;
  try {
    result = await deps.runMobileMaestroCli({
      argv: resolved.argv,
      cwd: input.cwd,
      env: resolved.env,
    }, {
      runScenario: async ({ runFlow }) => {
        const fixtureEnv: NodeJS.ProcessEnv = {
          HAPPIER_E2E_CURRENT_SOURCE_PANEL_TAB_ID: fixture.panelTabTestId,
        };
        let code = await runPhase(
          runFlow,
          'suites/mobile-e2e/flows/plugin-platform-current-source/managed-inspector-native.yaml',
        );
        if (code !== 0) return code;
        const mobileScheme = resolved.env.HAPPIER_E2E_MOBILE_APP_SCHEME;
        if (!mobileScheme) throw new Error('plugin_ui_current_source_mobile_app_scheme_missing');
        const nativeEnv = (
          version: 'v1' | 'v2',
          generation: typeof nativeFixture.installed,
          hostedArtifact: Awaited<ReturnType<typeof nativeFixture.hostedArtifact>>,
        ): NodeJS.ProcessEnv => ({
          HAPPIER_E2E_CURRENT_SOURCE_PLUGIN_ID: nativeFixture.pluginId,
          HAPPIER_E2E_CURRENT_SOURCE_RN_SURFACE_URL: `${mobileScheme}:///${nativeFixture.rnSurfaceUrlPath.replace(/^\//u, '')}`,
          HAPPIER_E2E_CURRENT_SOURCE_HOSTED_SURFACE_URL: `${mobileScheme}:///${nativeFixture.hostedSurfaceUrlPath.replace(/^\//u, '')}`,
          HAPPIER_E2E_CURRENT_SOURCE_RN_SENTINEL: version === 'v1' ? nativeFixture.sentinels.rnV1 : nativeFixture.sentinels.rnV2,
          HAPPIER_E2E_CURRENT_SOURCE_HOSTED_SENTINEL: version === 'v1' ? nativeFixture.sentinels.hostedV1 : nativeFixture.sentinels.hostedV2,
          HAPPIER_E2E_CURRENT_SOURCE_HOSTED_HISTORY_ACTION_ID: nativeFixture.sentinels.hostedHistoryAction,
          HAPPIER_E2E_CURRENT_SOURCE_HOSTED_HISTORY_SENTINEL: version === 'v1'
            ? nativeFixture.sentinels.hostedHistoryV1
            : nativeFixture.sentinels.hostedHistoryV2,
          HAPPIER_E2E_CURRENT_SOURCE_TARGETED_SENTINEL: version === 'v1'
            ? nativeFixture.sentinels.targetedV1
            : nativeFixture.sentinels.targetedV2,
          HAPPIER_E2E_CURRENT_SOURCE_TARGETED_READY_ID: [
            'plugin-targeted-surface-ready',
            nativeFixture.pluginId,
            generation.appliedGeneration,
            nativeFixture.pluginId,
            'qa-source',
            generation.appliedGeneration,
            nativeFixture.pluginId,
            'qa-native',
            'reactNative',
          ].join(':'),
          HAPPIER_E2E_CURRENT_SOURCE_HOSTED_READY_ID: [
            'plugin-hosted-web-native-ready',
            nativeFixture.pluginId,
            'qa-hosted',
            generation.contributionProjectionGeneration,
            hostedArtifact.digest,
          ].join(':'),
          HAPPIER_E2E_CURRENT_SOURCE_COMPOSER_CONTROL_ID: nativeFixture.sentinels.composerControl,
          HAPPIER_E2E_CURRENT_SOURCE_COMPOSER_SECONDARY_CONTROL_ID: nativeFixture.sentinels.composerSecondaryControl,
          HAPPIER_E2E_CURRENT_SOURCE_COMPOSER_REGION_ID: nativeFixture.sentinels.composerRegion,
          HAPPIER_E2E_CURRENT_SOURCE_COMPOSER_CHOICE_LABEL: 'Attach Current source QA facts',
          HAPPIER_E2E_CURRENT_SOURCE_COMPOSER_ATTACHMENT_LABEL: nativeFixture.sentinels.composerAttachmentV1,
          HAPPIER_E2E_CURRENT_SOURCE_COMPOSER_REFERENCE_LABEL: nativeFixture.sentinels.composerReference,
          HAPPIER_E2E_CURRENT_SOURCE_AGENT_TITLE: nativeFixture.sentinels.agentTitle,
          HAPPIER_E2E_CURRENT_SOURCE_TRANSCRIPT_SENTINEL: nativeFixture.sentinels.transcriptSentinel,
          HAPPIER_E2E_CURRENT_SOURCE_RESOURCE_SENTINEL: version === 'v1'
            ? nativeFixture.sentinels.resourceV1
            : nativeFixture.sentinels.resourceV2,
          HAPPIER_E2E_CURRENT_SOURCE_ACTION_RUN_ID: nativeFixture.sentinels.actionRun,
          HAPPIER_E2E_CURRENT_SOURCE_ACTION_BUSY_ID: nativeFixture.sentinels.actionBusy,
          HAPPIER_E2E_CURRENT_SOURCE_ACTION_SETTLED_ID: nativeFixture.sentinels.actionSettled,
          HAPPIER_E2E_CURRENT_SOURCE_ACTION_RESULT_SENTINEL: version === 'v1'
            ? nativeFixture.sentinels.actionResultV1
            : nativeFixture.sentinels.actionResultV2,
          HAPPIER_E2E_CURRENT_SOURCE_NEW_SESSION_URL:
            `${mobileScheme}:///new?draftId=${encodeURIComponent(newSessionDraftId)}`,
        });
        const nativeV1Artifact = await nativeFixture.artifact(platformValue);
        const hostedV1Artifact = await nativeFixture.hostedArtifact();
        nativeLifecycleEvidence.push({
          phase: 'artifacts-v1',
          native: nativeV1Artifact,
          hosted: hostedV1Artifact,
        });
        const nativeV1Env = nativeEnv('v1', nativeFixture.installed, hostedV1Artifact);
        code = await runPhase(
          runFlow,
          'suites/mobile-e2e/flows/plugin-platform-current-source/managed-public-native.yaml',
          nativeV1Env,
        );
        if (code !== 0) return code;
        code = await runPhase(
          runFlow,
          'suites/mobile-e2e/flows/plugin-platform-current-source/managed-public-hosted.yaml',
          nativeV1Env,
        );
        if (code !== 0) return code;
        // Canonical New Session creation/send handoff: this Composer flow owns
        // the deep-link draft open, the send, and the transcript assertion.
        // Snapshot immediately before the window, run the flow, then arm exact
        // cleanup from the single Session the window created — as soon as it
        // exists. The Account snapshots here are attribution diagnostics for
        // this window only; deletion is authorized exclusively by the armed
        // exact id, so unrelated concurrent Sessions are undeletable by
        // construction. A failed handoff arms nothing: its window delta cannot
        // distinguish the row's own Session from an unrelated concurrent one,
        // and failing closed leaks a disposable Session rather than risking
        // another writer's Session.
        const disposableWindowBefore = await deps.readSessionIds(context);
        code = await runPhase(
          runFlow,
          'suites/mobile-e2e/flows/plugin-platform-current-source/managed-public-composer.yaml',
          nativeV1Env,
        );
        if (code === 0) {
          disposableSessionCapture = await captureCurrentSourceDisposableSessionId({
            before: disposableWindowBefore,
            readSessionIds: () => deps.readSessionIds(context),
          });
          if (disposableSessionCapture.sessionId) {
            nativeLifecycleEvidence.push({
              phase: 'disposable-session-armed',
              sessionId: disposableSessionCapture.sessionId,
            });
          }
        }
        if (code !== 0) return code;
        const nativeV2 = await nativeFixture.applyV2();
        nativeLifecycleEvidence.push({ phase: 'applied-v2', ...nativeV2 });
        if (nativeV2.appliedGeneration === nativeFixture.installed.appliedGeneration) {
          throw new Error('plugin_ui_current_source_native_v2_generation_did_not_advance');
        }
        const nativeV2Artifact = await nativeFixture.artifact(platformValue);
        const hostedV2Artifact = await nativeFixture.hostedArtifact();
        nativeLifecycleEvidence.push({
          phase: 'artifacts-v2',
          native: nativeV2Artifact,
          hosted: hostedV2Artifact,
        });
        const nativeV2Env = nativeEnv('v2', nativeV2, hostedV2Artifact);
        code = await runPhase(
          runFlow,
          'suites/mobile-e2e/flows/plugin-platform-current-source/managed-public-composer-retained.yaml',
          nativeV1Env,
        );
        if (code !== 0) return code;
        code = await runPhase(
          runFlow,
          'suites/mobile-e2e/flows/plugin-platform-current-source/managed-public-native-transition.yaml',
          {
            ...nativeV2Env,
            HAPPIER_E2E_CURRENT_SOURCE_PREVIOUS_TARGETED_READY_ID:
              nativeV1Env.HAPPIER_E2E_CURRENT_SOURCE_TARGETED_READY_ID,
            HAPPIER_E2E_CURRENT_SOURCE_PREVIOUS_RN_SENTINEL:
              nativeFixture.sentinels.rnV1,
          },
        );
        if (code !== 0) return code;
        code = await runPhase(
          runFlow,
          'suites/mobile-e2e/flows/plugin-platform-current-source/managed-public-hosted-transition.yaml',
          {
            ...nativeV2Env,
            HAPPIER_E2E_CURRENT_SOURCE_PREVIOUS_HOSTED_READY_ID:
              nativeV1Env.HAPPIER_E2E_CURRENT_SOURCE_HOSTED_READY_ID,
            HAPPIER_E2E_CURRENT_SOURCE_PREVIOUS_HOSTED_SENTINEL:
              nativeFixture.sentinels.hostedV1,
          },
        );
        if (code !== 0) return code;
        await nativeFixture.disable();
        nativeLifecycleEvidence.push({ phase: 'disabled', pluginId: nativeFixture.pluginId });
        code = await runPhase(
          runFlow,
          'suites/mobile-e2e/flows/plugin-platform-current-source/managed-public-absent.yaml',
          nativeV2Env,
        );
        if (code !== 0) return code;
        code = await runPhase(
          runFlow,
          'suites/mobile-e2e/flows/plugin-platform-current-source/managed-public-hosted-absent.yaml',
          nativeV2Env,
        );
        if (code !== 0) return code;
        const nativeEnabled = await nativeFixture.enable();
        nativeLifecycleEvidence.push({ phase: 'enabled-v2', ...nativeEnabled });
        code = await runPhase(
          runFlow,
          'suites/mobile-e2e/flows/plugin-platform-current-source/managed-public-native.yaml',
          nativeEnv('v2', nativeEnabled, hostedV2Artifact),
        );
        if (code !== 0) return code;
        code = await runPhase(
          runFlow,
          'suites/mobile-e2e/flows/plugin-platform-current-source/managed-public-hosted.yaml',
          nativeEnv('v2', nativeEnabled, hostedV2Artifact),
        );
        if (code !== 0) return code;
        await nativeFixture.uninstall();
        nativeLifecycleEvidence.push({ phase: 'uninstalled-v2', pluginId: nativeFixture.pluginId });
        code = await runPhase(
          runFlow,
          'suites/mobile-e2e/flows/plugin-platform-current-source/managed-public-absent.yaml',
          nativeV2Env,
        );
        if (code !== 0) return code;
        code = await runPhase(
          runFlow,
          'suites/mobile-e2e/flows/plugin-platform-current-source/managed-public-hosted-absent.yaml',
          nativeV2Env,
        );
        if (code !== 0) return code;
        const nativeRestored = await nativeFixture.reinstallV1();
        nativeLifecycleEvidence.push({ phase: 'reinstalled-v1', ...nativeRestored });
        if (nativeRestored.appliedGeneration !== nativeFixture.installed.appliedGeneration) {
          throw new Error('plugin_ui_current_source_native_v1_generation_not_restored');
        }
        const nativeRestoredArtifact = await nativeFixture.artifact(platformValue);
        const hostedRestoredArtifact = await nativeFixture.hostedArtifact();
        if (nativeRestoredArtifact.digest !== nativeV1Artifact.digest) {
          throw new Error('plugin_ui_current_source_native_v1_artifact_not_restored');
        }
        if (hostedRestoredArtifact.digest !== hostedV1Artifact.digest) {
          throw new Error('plugin_ui_current_source_hosted_v1_artifact_not_restored');
        }
        nativeLifecycleEvidence.push({
          phase: 'artifacts-restored-v1',
          native: nativeRestoredArtifact,
          hosted: hostedRestoredArtifact,
        });
        const nativeRestoredEnv = nativeEnv('v1', nativeRestored, hostedRestoredArtifact);
        code = await runPhase(
          runFlow,
          'suites/mobile-e2e/flows/plugin-platform-current-source/managed-public-native-transition.yaml',
          {
            ...nativeRestoredEnv,
            HAPPIER_E2E_CURRENT_SOURCE_PREVIOUS_TARGETED_READY_ID:
              nativeV2Env.HAPPIER_E2E_CURRENT_SOURCE_TARGETED_READY_ID,
            HAPPIER_E2E_CURRENT_SOURCE_PREVIOUS_RN_SENTINEL:
              nativeFixture.sentinels.rnV2,
          },
        );
        if (code !== 0) return code;
        code = await runPhase(
          runFlow,
          'suites/mobile-e2e/flows/plugin-platform-current-source/managed-public-hosted-transition.yaml',
          {
            ...nativeRestoredEnv,
            HAPPIER_E2E_CURRENT_SOURCE_PREVIOUS_HOSTED_READY_ID:
              nativeV2Env.HAPPIER_E2E_CURRENT_SOURCE_HOSTED_READY_ID,
            HAPPIER_E2E_CURRENT_SOURCE_PREVIOUS_HOSTED_SENTINEL:
              nativeFixture.sentinels.hostedV2,
          },
        );
        if (code !== 0) return code;
        code = await runPhase(
          runFlow,
          'suites/mobile-e2e/flows/plugin-platform-current-source/managed-source-present.yaml',
          { ...fixtureEnv, HAPPIER_E2E_CURRENT_SOURCE_EXPECTED_TEXT: fixture.v1Text },
        );
        if (code !== 0) return code;
        const v2 = await fixture.applyV2();
        lifecycleEvidence.push({ phase: 'applied-v2', ...v2 });
        if (v2.appliedGeneration === fixture.installed.appliedGeneration) {
          throw new Error('plugin_ui_current_source_v2_generation_did_not_advance');
        }
        code = await runPhase(
          runFlow,
          'suites/mobile-e2e/flows/plugin-platform-current-source/managed-source-present.yaml',
          { ...fixtureEnv, HAPPIER_E2E_CURRENT_SOURCE_EXPECTED_TEXT: fixture.v2Text },
        );
        if (code !== 0) return code;
        await fixture.disable();
        lifecycleEvidence.push({ phase: 'disabled', pluginId: fixture.pluginId });
        code = await runPhase(
          runFlow,
          'suites/mobile-e2e/flows/plugin-platform-current-source/managed-source-absent.yaml',
          fixtureEnv,
        );
        if (code !== 0) return code;
        const enabled = await fixture.enable();
        lifecycleEvidence.push({ phase: 'enabled-v2', ...enabled });
        code = await runPhase(
          runFlow,
          'suites/mobile-e2e/flows/plugin-platform-current-source/managed-source-present.yaml',
          { ...fixtureEnv, HAPPIER_E2E_CURRENT_SOURCE_EXPECTED_TEXT: fixture.v2Text },
        );
        if (code !== 0) return code;
        await fixture.uninstall();
        lifecycleEvidence.push({ phase: 'uninstalled-v2', pluginId: fixture.pluginId });
        code = await runPhase(
          runFlow,
          'suites/mobile-e2e/flows/plugin-platform-current-source/managed-source-absent.yaml',
          fixtureEnv,
        );
        if (code !== 0) return code;
        const restored = await fixture.reinstallV1();
        lifecycleEvidence.push({ phase: 'reinstalled-v1', ...restored });
        if (restored.appliedGeneration !== fixture.installed.appliedGeneration) {
          throw new Error('plugin_ui_current_source_v1_generation_not_restored');
        }
        code = await runPhase(
          runFlow,
          'suites/mobile-e2e/flows/plugin-platform-current-source/managed-source-present.yaml',
          { ...fixtureEnv, HAPPIER_E2E_CURRENT_SOURCE_EXPECTED_TEXT: fixture.v1Text },
        );
        if (code !== 0) return code;
        // Canonical external Session Agent journey for the exact qualified
        // example identity: chip-picker selection, prompt, host confirmation,
        // assistant settlement, a later cancelled turn, and recovery on the
        // same Session. The disposable Session window is attributed exactly
        // like the Composer flow above.
        const sessionAgentWindowBefore = await deps.readSessionIds(context);
        code = await runPhase(
          runFlow,
          'suites/mobile-e2e/flows/plugin-platform-current-source/managed-session-agent.yaml',
          {
            HAPPIER_E2E_SESSION_AGENT_CHIP_PICKER_OPTION_ID: sessionAgentFixture.selectors.chipPickerOption,
            HAPPIER_E2E_SESSION_AGENT_ASSISTANT_TEXT: sessionAgentFixture.assistantText,
            HAPPIER_E2E_SESSION_AGENT_PROMPT: 'Run the deterministic check for the current-source native row.',
            HAPPIER_E2E_SESSION_AGENT_CANCEL_PROMPT: 'Cancel this deterministic check for the current-source native row.',
            HAPPIER_E2E_SESSION_AGENT_RECOVERY_PROMPT: 'Recover with this deterministic check for the current-source native row.',
          },
        );
        if (code === 0) {
          sessionAgentSessionCapture = await captureCurrentSourceDisposableSessionId({
            before: sessionAgentWindowBefore,
            readSessionIds: () => deps.readSessionIds(context),
          });
          if (sessionAgentSessionCapture.sessionId) {
            lifecycleEvidence.push({
              phase: 'session-agent-disposable-session-armed',
              sessionId: sessionAgentSessionCapture.sessionId,
            });
          }
        }
        return code;
      },
    });
  } catch (error) {
    runError = error;
  }
  try {
    finalStackAttestation = await deps.attestPluginUi({
      context,
      artifactPlatform: platformValue,
    });
    if (
      finalStackAttestation.runtimeSnapshotId !== stackAttestation.runtimeSnapshotId
      || finalStackAttestation.daemonRuntimeId !== stackAttestation.daemonRuntimeId
      || finalStackAttestation.daemonPid !== stackAttestation.daemonPid
      || finalStackAttestation.daemonDistClosureFingerprint !== stackAttestation.daemonDistClosureFingerprint
      || finalStackAttestation.uiProducer.processInstanceFingerprint !== stackAttestation.uiProducer.processInstanceFingerprint
    ) {
      throw new Error('plugin_ui_current_source_runtime_identity_changed_during_row');
    }
  } catch (error) {
    runError = runError
      ? new AggregateError([runError, error], 'Current-source mobile row and final Stack attestation both failed')
      : error;
  }
  const cleanupFailures: unknown[] = [];
  try {
    await deps.deleteNewSessionDraft(context, newSessionDraftId);
    nativeLifecycleEvidence.push({ phase: 'owned-new-session-draft-retired', draftId: newSessionDraftId });
  } catch (error) {
    cleanupFailures.push(error);
  }
  try {
    // Deletes exactly the id armed at the creation/send handoff — never a
    // post-run Account-wide delta. Attribution conflicts and unreadable
    // snapshot reads fail closed here: they delete nothing and aggregate.
    const disposableSessionId = resolveCurrentSourceDisposableSessionDeletionTarget(disposableSessionCapture);
    if (disposableSessionId) {
      await deps.deleteSession(context, disposableSessionId);
      nativeLifecycleEvidence.push({ phase: 'disposable-session-deleted', sessionId: disposableSessionId });
    }
  } catch (error) {
    cleanupFailures.push(error);
  }
  try {
    const sessionAgentSessionId = resolveCurrentSourceDisposableSessionDeletionTarget(sessionAgentSessionCapture);
    if (sessionAgentSessionId) {
      await deps.deleteSession(context, sessionAgentSessionId);
      lifecycleEvidence.push({ phase: 'session-agent-disposable-session-deleted', sessionId: sessionAgentSessionId });
    }
  } catch (error) {
    cleanupFailures.push(error);
  }
  const fixtureCleanup = await Promise.allSettled([fixture.cleanup(), nativeFixture.cleanup(), sessionAgentFixture.cleanup()]);
  fixtureCleanup.forEach((entry) => {
    if (entry.status === 'rejected') cleanupFailures.push(entry.reason);
  });
  if (fixtureCleanup[0]?.status === 'fulfilled') {
    lifecycleEvidence.push({ phase: 'cleanup-retired', pluginId: fixture.pluginId });
  }
  if (fixtureCleanup[1]?.status === 'fulfilled') {
    nativeLifecycleEvidence.push({ phase: 'cleanup-retired', pluginId: nativeFixture.pluginId });
  }
  if (fixtureCleanup[2]?.status === 'fulfilled') {
    lifecycleEvidence.push({ phase: 'session-agent-cleanup-retired', pluginId: sessionAgentFixture.pluginId });
  }
  if (cleanupFailures.length === 1) cleanupError = cleanupFailures[0];
  if (cleanupFailures.length > 1) {
    cleanupError = new AggregateError(cleanupFailures, 'Current-source mobile cleanup had multiple failures');
  }
  if (runError && cleanupError) {
    throw new AggregateError([runError, cleanupError], 'Current-source mobile row and fixture cleanup both failed');
  }
  if (runError) throw runError;
  if (cleanupError) throw cleanupError;
  if (!result) throw new Error('plugin_ui_current_source_mobile_runner_missing_result');
  deps.appendManifestEvidence({
    manifestPath: result.manifestPath,
    evidence: {
      currentManagedStackPluginUi: {
        stackName: stackAttestation.stackName,
        runtimeJsonPath: stackAttestation.runtimeJsonPath,
        runtimeSnapshotId: stackAttestation.runtimeSnapshotId,
        uiProducer: stackAttestation.uiProducer,
        publicationComponents: context.runtime.publicationComponents,
        daemonPid: stackAttestation.daemonPid,
        daemonRuntimeId: stackAttestation.daemonRuntimeId,
        daemonMachineId: stackAttestation.daemonMachineId,
        daemonDistClosureFingerprint: stackAttestation.daemonDistClosureFingerprint,
        inspector: {
          pluginId: stackAttestation.pluginId,
          desiredGeneration: stackAttestation.desiredGeneration,
          appliedGeneration: stackAttestation.appliedGeneration,
          contributionProjectionGeneration: stackAttestation.contributionProjectionGeneration,
          artifact: stackAttestation.artifact,
        },
        sourceFixtureLifecycle: [...lifecycleEvidence],
        nativePublicFixtureLifecycle: [...nativeLifecycleEvidence],
        sessionAgentFixture: {
          pluginId: sessionAgentFixture.pluginId,
          agentLocalId: sessionAgentFixture.agentLocalId,
          qualifiedAgentId: sessionAgentFixture.qualifiedAgentId,
          installedGeneration: sessionAgentFixture.installed.appliedGeneration,
          sourceRootOwned: sessionAgentFixture.ownsSourceRoot,
        },
        finalRuntimeIdentity: finalStackAttestation ? {
          runtimeSnapshotId: finalStackAttestation.runtimeSnapshotId,
          daemonPid: finalStackAttestation.daemonPid,
          daemonRuntimeId: finalStackAttestation.daemonRuntimeId,
          daemonDistClosureFingerprint: finalStackAttestation.daemonDistClosureFingerprint,
          uiProducer: finalStackAttestation.uiProducer,
        } : null,
      },
    },
  });
  const exitCode = resolveMobilePluginPlatformCurrentSourceExitCode({
    exitCode: result.exitCode,
    loadedRuntimeKind: result.ucxLoadedNativeRuntime?.kind ?? null,
    installedNativeAppIdentityKind: result.installedNativeAppIdentity?.kind ?? null,
  });
  if (exitCode === 2) {
    const blocker = result.ucxLoadedNativeRuntime ?? {
      kind: 'blocked' as const,
      code: 'loaded_native_identity_missing',
      detail: 'The canonical mobile runner did not return loaded native identity.',
    };
    // eslint-disable-next-line no-console
    console.error(`[tests] current-source Plugin UI native QA blocked: ${JSON.stringify(blocker)}`);
  }
  return exitCode;
}

const currentFilePath = fileURLToPath(import.meta.url);
const entrypointPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (entrypointPath === currentFilePath) {
  void runMobilePluginPlatformCurrentSourceCli()
    .then((exitCode) => process.exit(exitCode))
    .catch((error) => {
      // eslint-disable-next-line no-console
      console.error(error instanceof Error ? error.stack ?? error.message : String(error));
      process.exit(1);
    });
}
