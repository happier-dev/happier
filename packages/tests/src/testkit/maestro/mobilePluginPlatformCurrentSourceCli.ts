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
  type CurrentManagedStackPluginUiContext,
} from '../pluginPlatform/currentManagedStackPluginUiQa';
import {
  appendMobileMaestroManifestEvidence,
  resolveSelectedMobileTargetDeviceId,
} from './mobileMaestroRunner';
import { runDefaultMobileMaestroCli } from './mobileMaestroCli';
import {
  readCurrentSourceDisposableSessionExactFact,
  resolveCurrentSourceDisposableSessionDeletionTarget,
  resolveMobilePluginPlatformCurrentSourceExitCode,
  resolveMobilePluginPlatformCurrentSourceRun,
  type CurrentSourceDisposableSessionExactFact,
} from './mobilePluginPlatformCurrentSourceInput';

/**
 * Structured cause for the current-source mobile row's own nonzero journey
 * exit. Constructed exactly once after the mobile runner returns, so every
 * downstream failure aggregation can include the original failing exit
 * without swallowing or duplicating it.
 */
export class MobilePluginPlatformCurrentSourceJourneyExitError extends Error {
  readonly code = 'plugin_ui_current_source_mobile_journey_exit';
  readonly exitCode: number;

  constructor(exitCode: number) {
    super(`plugin_ui_current_source_mobile_journey_exit_${exitCode}`);
    this.name = 'MobilePluginPlatformCurrentSourceJourneyExitError';
    this.exitCode = exitCode;
  }
}

/**
 * The scenario ends at the first non-bound terminal exact-fact state: every
 * later phase would only create more Sessions this row can neither name nor
 * delete. The armed fact itself is preserved for the finally cleanup and its
 * evidence, and cleanup still runs below.
 */
function stopUnlessDisposableSessionFactBound(fact: CurrentSourceDisposableSessionExactFact): void {
  if (fact.status !== 'bound') {
    throw new Error(`plugin_ui_current_source_disposable_session_exact_fact_not_bound:${fact.status}`);
  }
}

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
  deleteSession: typeof deleteCurrentManagedStackSession;
  deleteNewSessionDraft: typeof deleteCurrentManagedStackNewSessionDraft;
  readDisposableSessionExactFact: typeof readCurrentSourceDisposableSessionExactFact;
  appendManifestEvidence: typeof appendMobileMaestroManifestEvidence;
}>;

const defaultCurrentSourceCliDeps: MobilePluginPlatformCurrentSourceCliDeps = {
  runMobileMaestroCli: runDefaultMobileMaestroCli,
  resolvePluginUiContext: resolveCurrentManagedStackPluginUiContext,
  attestPluginUi: attestCurrentManagedStackPluginUi,
  prepareNativePublicFixture: prepareCurrentManagedStackNativePublicFixture,
  prepareDeclarativeLifecycleFixture: prepareCurrentManagedStackDeclarativeLifecycleFixture,
  prepareSessionAgentFixture: prepareCurrentManagedStackSessionAgentFixture,
  deleteSession: deleteCurrentManagedStackSession,
  deleteNewSessionDraft: deleteCurrentManagedStackNewSessionDraft,
  readDisposableSessionExactFact: readCurrentSourceDisposableSessionExactFact,
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
  // The fresh post-update Composer dispatch runs on its own QA-owned draft so
  // the created v2 Session is exactly cleanup-scoped like the v1 one.
  const v2NewSessionDraftId = randomUUID();
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
  let disposableSessionFact: CurrentSourceDisposableSessionExactFact | null = null;
  let disposableSessionV2Fact: CurrentSourceDisposableSessionExactFact | null = null;
  let sessionAgentSessionFact: CurrentSourceDisposableSessionExactFact | null = null;
  let runError: unknown = null;
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
          // Composer reference and attachment presentation facts are
          // generation-qualified like every other fixture sentinel: a v2 flow
          // env must never advertise a v1 label, or the loaded journey could
          // pass while the reloaded projection actually lost currentness.
          HAPPIER_E2E_CURRENT_SOURCE_COMPOSER_ATTACHMENT_LABEL: version === 'v1'
            ? nativeFixture.sentinels.composerAttachmentV1
            : nativeFixture.sentinels.composerAttachmentV2,
          HAPPIER_E2E_CURRENT_SOURCE_COMPOSER_REFERENCE_LABEL: version === 'v1'
            ? nativeFixture.sentinels.composerReferenceV1
            : nativeFixture.sentinels.composerReferenceV2,
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
        // Canonical New Session creation/send handoff, split so exact cleanup
        // is armed from the creation/send owner's own fact BEFORE the
        // transcript proof runs. The create/send flow ends at the send's own
        // custody proof; only a landed send arms the fact, and the fact — never
        // an Account-wide delta, timing window, or URL guess — is the sole
        // deletion authority. Missing/conflicting/unreadable facts delete
        // nothing and aggregate as cleanup failures.
        code = await runPhase(
          runFlow,
          'suites/mobile-e2e/flows/plugin-platform-current-source/managed-public-composer-send.yaml',
          nativeV1Env,
        );
        if (code !== 0) return code;
        disposableSessionFact = await deps.readDisposableSessionExactFact();
        nativeLifecycleEvidence.push({
          phase: 'disposable-session-armed',
          fact: disposableSessionFact.status,
          ...(disposableSessionFact.status === 'bound'
            ? { sessionId: disposableSessionFact.sessionId }
            : {}),
        });
        // A non-bound fact is terminal: the row stops here instead of
        // creating the v2 and Session-Agent Sessions it could never clean.
        stopUnlessDisposableSessionFactBound(disposableSessionFact);
        code = await runPhase(
          runFlow,
          'suites/mobile-e2e/flows/plugin-platform-current-source/managed-public-composer-transcript.yaml',
          nativeV1Env,
        );
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
        // Fresh post-update Composer dispatch on a new QA-owned draft: the
        // reloaded v2 projection must still carry the full Composer path. The
        // deterministic Agent rejects another generation's reference and
        // attachment facts before input acceptance, so a settled v2
        // transcript proves the fresh dispatch resolved and adopted exactly
        // qa:v2 and the v2 attachment facts. The retained v1 assertion above
        // remains the persisted v1 transcript immutability proof.
        code = await runPhase(
          runFlow,
          'suites/mobile-e2e/flows/plugin-platform-current-source/managed-public-composer-send.yaml',
          {
            ...nativeV2Env,
            HAPPIER_E2E_CURRENT_SOURCE_NEW_SESSION_URL:
              `${mobileScheme}:///new?draftId=${encodeURIComponent(v2NewSessionDraftId)}`,
          },
        );
        if (code !== 0) return code;
        disposableSessionV2Fact = await deps.readDisposableSessionExactFact();
        nativeLifecycleEvidence.push({
          phase: 'disposable-session-v2-armed',
          fact: disposableSessionV2Fact.status,
          ...(disposableSessionV2Fact.status === 'bound'
            ? { sessionId: disposableSessionV2Fact.sessionId }
            : {}),
        });
        // Same terminal boundary for the fresh v2 dispatch: a non-bound v2
        // fact stops before the v2 transcript and the Session-Agent Session.
        stopUnlessDisposableSessionFactBound(disposableSessionV2Fact);
        code = await runPhase(
          runFlow,
          'suites/mobile-e2e/flows/plugin-platform-current-source/managed-public-composer-transcript.yaml',
          nativeV2Env,
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
        // example identity: chip-picker selection, prompt, and the send's own
        // custody proof, split from the downstream host-confirmation,
        // settlement, cancellation, and recovery proof exactly like the
        // Composer flows above. The disposable Session is armed from the exact
        // creation/send fact BEFORE any downstream assertion can fail, so a
        // downstream failure still cleans the bound exact Agent Session.
        const sessionAgentEnv: NodeJS.ProcessEnv = {
          HAPPIER_E2E_SESSION_AGENT_CHIP_PICKER_OPTION_ID: sessionAgentFixture.selectors.chipPickerOption,
          HAPPIER_E2E_SESSION_AGENT_ASSISTANT_TEXT: sessionAgentFixture.assistantText,
          HAPPIER_E2E_SESSION_AGENT_PROMPT: 'Run the deterministic check for the current-source native row.',
          HAPPIER_E2E_SESSION_AGENT_CANCEL_PROMPT: 'Cancel this deterministic check for the current-source native row.',
          HAPPIER_E2E_SESSION_AGENT_RECOVERY_PROMPT: 'Recover with this deterministic check for the current-source native row.',
        };
        code = await runPhase(
          runFlow,
          'suites/mobile-e2e/flows/plugin-platform-current-source/managed-session-agent-send.yaml',
          sessionAgentEnv,
        );
        if (code !== 0) return code;
        sessionAgentSessionFact = await deps.readDisposableSessionExactFact();
        lifecycleEvidence.push({
          phase: 'session-agent-disposable-session-armed',
          fact: sessionAgentSessionFact.status,
          ...(sessionAgentSessionFact.status === 'bound'
            ? { sessionId: sessionAgentSessionFact.sessionId }
            : {}),
        });
        stopUnlessDisposableSessionFactBound(sessionAgentSessionFact);
        code = await runPhase(
          runFlow,
          'suites/mobile-e2e/flows/plugin-platform-current-source/managed-session-agent-transcript.yaml',
          sessionAgentEnv,
        );
        if (code !== 0) return code;
        return code;
      },
    });
  } catch (error) {
    runError = error;
  }
  // The journey's own nonzero exit is an orchestration result, not a thrown
  // error: construct its structured cause exactly once, so every failure
  // combination below carries the original failing exit without swallowing
  // or duplicating it.
  const journeyExitFailure = result && result.exitCode !== 0
    ? new MobilePluginPlatformCurrentSourceJourneyExitError(result.exitCode)
    : null;
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
    await deps.deleteNewSessionDraft(context, v2NewSessionDraftId);
    nativeLifecycleEvidence.push({ phase: 'owned-new-session-v2-draft-retired', draftId: v2NewSessionDraftId });
  } catch (error) {
    cleanupFailures.push(error);
  }
  const disposeExactSession = async (
    fact: CurrentSourceDisposableSessionExactFact | null,
    phases: Readonly<{ deleted: string; unavailable: string }>,
    evidence: Array<Readonly<Record<string, unknown>>>,
  ): Promise<void> => {
    if (!fact) return;
    // Deletes exactly the id bound by the creation/send fact — never a
    // post-run Account-wide delta. Missing/conflicting/unreadable facts fail
    // closed here: they delete nothing and aggregate.
    if (fact.status === 'unavailable') {
      evidence.push({ phase: phases.unavailable, reason: fact.reason });
      // An unwired exact-fact source can neither name nor delete the Session
      // this row created: treating that as success would false-green a loaded
      // row while its own disposable Session leaks. Keep the lifecycle
      // evidence, then block the row observably until the canonical
      // creation/send owner binds the exact id for this harness.
      cleanupFailures.push(
        new Error(`plugin_ui_current_source_disposable_session_exact_fact_unavailable:${fact.reason}`),
      );
      return;
    }
    try {
      const disposableSessionId = resolveCurrentSourceDisposableSessionDeletionTarget(fact);
      if (disposableSessionId) {
        await deps.deleteSession(context, disposableSessionId);
        evidence.push({ phase: phases.deleted, sessionId: disposableSessionId });
      }
    } catch (error) {
      cleanupFailures.push(error);
    }
  };
  try {
    await disposeExactSession(disposableSessionFact, {
      deleted: 'disposable-session-deleted',
      unavailable: 'disposable-session-exact-fact-unavailable',
    }, nativeLifecycleEvidence);
    await disposeExactSession(disposableSessionV2Fact, {
      deleted: 'disposable-session-v2-deleted',
      unavailable: 'disposable-session-v2-exact-fact-unavailable',
    }, nativeLifecycleEvidence);
    await disposeExactSession(sessionAgentSessionFact, {
      deleted: 'session-agent-disposable-session-deleted',
      unavailable: 'session-agent-disposable-session-exact-fact-unavailable',
    }, lifecycleEvidence);
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
  // Aggregate every distinct cause exactly once — structured journey exit,
  // attestation and run errors, then cleanup errors. A sole journey exit
  // stays a returned result: the raw nonzero exit code below is the canonical
  // row outcome.
  const failureCauses: unknown[] = [
    ...(journeyExitFailure ? [journeyExitFailure] : []),
    ...(runError ? [runError] : []),
    ...cleanupFailures,
  ];
  if (failureCauses.length === 1) {
    if (!journeyExitFailure) throw failureCauses[0];
  } else if (failureCauses.length > 1) {
    throw new AggregateError(
      failureCauses,
      'Current-source mobile row failed with journey, attestation, or cleanup causes',
    );
  }
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
