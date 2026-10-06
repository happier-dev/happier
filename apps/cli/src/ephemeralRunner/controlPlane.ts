import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';

import type { MachineInstallationIdentityV1 } from '@happier-dev/protocol';
import type { HomeConnectionDescriptorV1 } from '@happier-dev/protocol/auth/accountDirectory';
import { decodeBase64, encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { sealBoxBundle } from '@happier-dev/protocol/crypto/boxBundle';
import { signMachineInstallationProof } from '@happier-dev/protocol/machines/identity/installationIdentity';
import type { RunnerActivationBindingV1 } from '@happier-dev/protocol/ephemeralRunner/activation';
import { signRunnerClaimV1, signRunnerEndpointFactsV1, verifyRunnerClaimV1 } from '@happier-dev/protocol/ephemeralRunner/endpoint';
import type { RunnerClaimV1, RunnerEndpointFactsContentV1, RunnerEndpointFactsV1 } from '@happier-dev/protocol/ephemeralRunner/endpoint';
import { signRunnerConsentV1 } from '@happier-dev/protocol/ephemeralRunner/consent';
import type { RunnerConsentV1 } from '@happier-dev/protocol/ephemeralRunner/consent';
import type { RunnerReadinessV1 } from '@happier-dev/protocol/ephemeralRunner/readiness';
import type { RunnerEndpointDeclineResponseV1 } from '@happier-dev/protocol/ephemeralRunner/endpointProjection';
import type { PluginInstallationReview } from '@happier-dev/protocol/marketplace/internal';
import type { PluginRegistryProfileRequirement, PluginResourceSelection } from '@/plugins/daemon/changeContract';
import type { RunnerActivationProgressPhaseV1 } from '@happier-dev/protocol/ephemeralRunner/progress';
import tweetnacl from 'tweetnacl';

import packageJson from '../../package.json';
import type { VerifiedEphemeralRunnerActivationFile } from './activationFile';
import type { EphemeralRunnerLocalState } from './localState';

export type EphemeralRunnerEndpointPhase =
  | 'connecting'
  | 'selecting_folder'
  | 'reviewing'
  | 'installing_agent'
  | 'checking_ai_access'
  | 'waiting_for_materialization'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'completed'
  | 'failed';

export type EphemeralRunnerConnectionState = 'connected' | 'reconnecting';

/**
 * What the endpoint user is told went wrong, as a closed classification.
 *
 * The sentence itself belongs to the localized presentation owner
 * (`endpointTerminalUi`), which is why there is no message here: a failure the
 * controller phrased in English would never be rendered or translated.
 *
 * `before_session` is the retryable pre-materialization failure.
 * `before_session_terminal` is the same phase without a usable recovery — no
 * Session, Machine or AccessKey was ever created, so the user must not be sent
 * to an ordinary Session that does not exist. `session_runtime_or_stop` is the
 * only kind that may name one, because by then it really exists.
 */
export type EphemeralRunnerEndpointFailure = Readonly<{
  kind: 'before_session' | 'before_session_terminal' | 'session_runtime_or_stop' | 'activation_close_unconfirmed';
}>;

export type EphemeralRunnerEndpointSnapshot = Readonly<{
  phase: EphemeralRunnerEndpointPhase;
  connection: EphemeralRunnerConnectionState;
  /** Closed, user-safe presentation. Raw provider/runtime errors never reach a shell. */
  failure?: EphemeralRunnerEndpointFailure;
  /** Recovery is safe only before the activation has materialized a Session. */
  canRetry?: boolean;
}>;

export type VerifiedEphemeralRunnerReview<Manifest> = Readonly<{
  manifest: Manifest;
  launchManifestCommitment: string;
  /** The creator's original prepared-submission commitment, always carried by the activation binding. */
  authoringCommitment: string;
  directory: string;
}>;

export type EphemeralRunnerControlPlaneConnection<Manifest> = Readonly<{
  claim(input: Readonly<{ claim: RunnerClaimV1; signal: AbortSignal }>): Promise<unknown>;
  storeEndpointFacts(input: Readonly<{
    endpointFacts: RunnerEndpointFactsV1;
    endpointFactsContent: RunnerEndpointFactsContentV1;
    signal: AbortSignal;
  }>): Promise<void>;
  reportProgress(input: Readonly<{ phase: RunnerActivationProgressPhaseV1; signal: AbortSignal }>): Promise<void>;
  /** Opens and strictly verifies the canonical sealed review projection. */
  waitForReview(input: Readonly<{
    binding: RunnerActivationBindingV1;
    claim: RunnerClaimV1;
    runnerBoxSecretKey: Uint8Array;
    directory: string;
    signal: AbortSignal;
  }>): Promise<VerifiedEphemeralRunnerReview<Manifest>>;
  submitConsent(input: Readonly<{ consent: RunnerConsentV1; signal: AbortSignal }>): Promise<void>;
  submitReadiness(input: Readonly<{ readiness: RunnerReadinessV1; signal: AbortSignal }>): Promise<void>;
  decline(input: Readonly<{ claim: RunnerClaimV1; signal: AbortSignal }>): Promise<RunnerEndpointDeclineResponseV1>;
  onConnectionState(listener: (state: EphemeralRunnerConnectionState) => void): () => void;
  close(): Promise<void>;
}>;

export type EphemeralRunnerRuntimeHandle = Readonly<{
  terminal: Promise<Readonly<{ status: 'completed' }> | Readonly<{ status: 'failed'; error: Error }>>;
  stop(): Promise<void>;
}>;

/**
 * The endpoint's answer for the exact reviewed Agent plugin generation.
 *
 * Both kinds take this one path: a bundled Agent the Runner artifact already
 * carries resolves to `review: null` with no-op apply/release, and an Agent
 * contributed by an installed external plugin carries the canonical
 * installation review a present endpoint user decides on. The endpoint gains no
 * Runner-specific registry, trust tier or installer: the acquisition is
 * performed by the canonical plugin change owner in the activation-local Home.
 */
export type ReviewedRunnerPluginAcquisition = Readonly<{
  review: PluginInstallationReview | null;
  /**
   * Installs and trusts the exact committed generation with the endpoint's own
   * optional host-access choices. A no-op for a bundled Agent.
   */
  apply(input: Readonly<{
    signal: AbortSignal;
    optionalSelections: readonly PluginResourceSelection[];
  }>): Promise<void>;
  /** Releases an undecided prepared candidate on every terminal path. Idempotent. */
  release(): Promise<void>;
}>;

/**
 * The canonical plugin change owner could not prepare the reviewed generation
 * because its registry needs a registry profile on the activation-local Home.
 * Private registry authentication is the endpoint's explicit selection and is
 * never inferred from the creator: the endpoint answers, the answer is applied
 * through the canonical npm registry profile service, and preparation runs
 * again.
 */
export type ReviewedRunnerPluginRegistrySelection = Readonly<{
  kind: 'registryProfileRequired';
  requirement: PluginRegistryProfileRequirement;
  /**
   * Signs in (or, with `credential: null`, selects without a credential) this
   * Home's profile for the named registry, then prepares again.
   */
  selectRegistryProfile(input: Readonly<{
    credential: string | null;
    signal: AbortSignal;
  }>): Promise<ReviewedRunnerPluginPreparation>;
}>;

export type ReviewedRunnerPluginPreparation =
  | ReviewedRunnerPluginAcquisition
  | ReviewedRunnerPluginRegistrySelection;

/** The endpoint's explicit registry answer; `null` declines the activation. */
export type EphemeralRunnerRegistryProfileDecision = Readonly<{ credential: string | null }> | null;

export type EphemeralRunnerDependencies<Manifest, Materialized, Preparation> = Readonly<{
  createConnection(input: Readonly<{
    home: HomeConnectionDescriptorV1;
    /** Activation-local home; auth transport identity must never fall back to persistent CLI state. */
    homeDirectory: string;
    binding: RunnerActivationBindingV1;
    activationSecretKey: Uint8Array;
    installation: MachineInstallationIdentityV1;
    signal: AbortSignal;
  }>): Promise<EphemeralRunnerControlPlaneConnection<Manifest>>;
  /**
   * Prepares the reviewed Agent plugin generation against the activation-local
   * Home, before the endpoint is asked to allow anything. It never installs:
   * the returned `apply` is called only after an affirmative decision.
   */
  prepareReviewedPluginAcquisition(input: Readonly<{
    manifest: Manifest;
    homeDirectory: string;
    signal: AbortSignal;
  }>): Promise<ReviewedRunnerPluginPreparation>;
  prepareAgent(input: Readonly<{
    manifest: Manifest;
    environment: NodeJS.ProcessEnv;
    homeDirectory: string;
    signal: AbortSignal;
  }>): Promise<Preparation>;
  /** Releases request-scoped Agent/plugin preparation on every terminal path. */
  releasePreparation(input: Readonly<{ preparation: Preparation }>): Promise<void>;
  /** Lane 10's fixed readiness application. This seam cannot carry a prompt or inference request. */
  checkNonInferenceReadiness(input: Readonly<{
    binding: RunnerActivationBindingV1;
    claim: RunnerClaimV1;
    consent: RunnerConsentV1;
    manifest: Manifest;
    launchManifestCommitment: string;
    /** Process-local opening key for the endpoint-authenticated sealed bootstrap. */
    runnerBoxSecretKey: Uint8Array;
    /** Process-local signing custody; the callee must not retain either key. */
    activationSecretKey: Uint8Array;
    installationSecretKey: Uint8Array;
    homeDirectory: string;
    preparation: Preparation;
    signal: AbortSignal;
  }>): Promise<Readonly<{ status: 'ready'; readiness: RunnerReadinessV1 }> | Readonly<{ status: 'denied' | 'unavailable'; reason: string }>>;
  materialize(input: Readonly<{
    binding: RunnerActivationBindingV1;
    claim: RunnerClaimV1;
    consent: RunnerConsentV1;
    manifest: Manifest;
    launchManifestCommitment: string;
    /** Process-local key that opens the creator-sealed runtime bootstrap. */
    runnerBoxSecretKey: Uint8Array;
    preparation: Preparation;
    signal: AbortSignal;
    /** Recovery must settle locally when the Home cannot confirm projection. */
    retryTransportErrors?: boolean;
  }>): Promise<Materialized>;
  startSession(input: Readonly<{
    binding: RunnerActivationBindingV1;
    manifest: Manifest;
    materialized: Materialized;
    preparation: Preparation;
    localState: EphemeralRunnerLocalState;
    /**
     * This endpoint's own Machine installation key. The runtime proves with it
     * that this exact Machine executed a Home-relayed public Action, the same
     * way an ordinary daemon does.
     */
    installationPrivateKey: string;
    signal: AbortSignal;
    /** The ordinary Session/process terminal owner, exposed before Agent admission. */
    onRuntimeStopReady(stop: () => Promise<void>): void;
    /**
     * The running Session's own transport connectivity, from the canonical
     * runtime owner. Before the Session exists the window reflects the
     * activation control connection; once it is running, that connection is no
     * longer what the user is waiting on, so a live Session outage must be able
     * to move the window to Reconnecting instead of showing a stale
     * "connected". This is the same shape `onRuntimeStopReady` establishes: the
     * runtime hands its fact over, and the endpoint stays the single presenter.
     */
    onRuntimeConnectionState(state: EphemeralRunnerConnectionState): void;
  }>): Promise<EphemeralRunnerRuntimeHandle>;
  /** Releases process-local bootstrap custody after the ordinary Session runtime has terminated. */
  releaseMaterialized(input: Readonly<{
    materialized: Materialized;
  }>): Promise<void>;
}>;

/**
 * The endpoint's one consent answer. Allow carries its choices for the
 * reviewed plugin's optional host access — each off unless the endpoint user
 * turned it on — in the canonical plugin-installation selection shape, so the
 * same change owner that decides every other installation validates them.
 */
export type EphemeralRunnerConsentDecision =
  | Readonly<{ allow: false }>
  | Readonly<{ allow: true; optionalSelections: readonly PluginResourceSelection[] }>;

export type EphemeralRunnerEndpointUi<Manifest> = Readonly<{
  selectDirectory(input: Readonly<{ signal: AbortSignal }>): Promise<string | null>;
  /**
   * Asks the endpoint to sign in to the reviewed plugin's private registry,
   * before the installation review exists. Declining declines the activation.
   */
  requestRegistryProfile(input: Readonly<{
    requirement: PluginRegistryProfileRequirement;
    signal: AbortSignal;
  }>): Promise<EphemeralRunnerRegistryProfileDecision>;
  reviewAndRequestConsent(input: Readonly<{
    review: VerifiedEphemeralRunnerReview<Manifest>;
    /**
     * The canonical installation review for the reviewed Agent's plugin, when
     * the endpoint must acquire it. `null` means nothing is being installed.
     */
    pluginInstallation: PluginInstallationReview | null;
    signal: AbortSignal;
  }>): Promise<EphemeralRunnerConsentDecision>;
  confirmActiveClose(input: Readonly<{
    phase: Extract<EphemeralRunnerEndpointPhase, 'starting' | 'running'>;
    signal: AbortSignal;
  }>): Promise<'stop' | 'keep_open'>;
  requestFailureRecovery(input: Readonly<{
    failure: EphemeralRunnerEndpointFailure;
    canRetry: boolean;
    signal: AbortSignal;
  }>): Promise<'retry' | 'exit'>;
  bindControls(controls: Readonly<{
    requestStop(): Promise<'kept_open' | 'stopped'>;
  }>): () => void;
  present(snapshot: EphemeralRunnerEndpointSnapshot): void;
  /**
   * Releases whatever process resources this surface holds — a native shell's
   * stdin reader, for instance. Called by the endpoint application on every
   * terminal outcome and before a retry builds a replacement. Idempotent.
   */
  dispose?(): void;
}>;

export type EphemeralRunnerControllerResult =
  | Readonly<{ status: 'completed' }>
  | Readonly<{ status: 'retry_requested' }>
  | Readonly<{ status: 'declined' | 'cancelled' }>
  | Readonly<{ status: 'failed'; error: Error }>;

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error('Ephemeral Runner failed');
}

const FAILURE_BEFORE_SESSION = Object.freeze({ kind: 'before_session' as const });
const FAILURE_BEFORE_SESSION_TERMINAL = Object.freeze({ kind: 'before_session_terminal' as const });
const FAILURE_SESSION_RUNTIME_OR_STOP = Object.freeze({ kind: 'session_runtime_or_stop' as const });

function endpointFailure(input: Readonly<{
  canRetry: boolean;
  /** A Session, Machine and AccessKey exist only once materialization succeeded. */
  sessionExists: boolean;
}>): EphemeralRunnerEndpointFailure {
  if (input.canRetry) return FAILURE_BEFORE_SESSION;
  return input.sessionExists ? FAILURE_SESSION_RUNTIME_OR_STOP : FAILURE_BEFORE_SESSION_TERMINAL;
}

export function createEphemeralRunnerController<Manifest, Materialized, Preparation>(input: Readonly<{
  activation: Pick<VerifiedEphemeralRunnerActivationFile, 'binding' | 'activationSecretKey'>;
  home: HomeConnectionDescriptorV1;
  localState: EphemeralRunnerLocalState;
  installation: MachineInstallationIdentityV1;
  dependencies: EphemeralRunnerDependencies<Manifest, Materialized, Preparation>;
  ui: EphemeralRunnerEndpointUi<Manifest>;
  signal?: AbortSignal;
}>) {
  const lifetime = new AbortController();
  let externalStopRequested = false;
  let recoveryAbort: AbortController | null = null;
  let declineAbort: AbortController | null = null;
  const externalAbort = () => {
    externalStopRequested = true;
    recoveryAbort?.abort(input.signal?.reason);
    declineAbort?.abort(input.signal?.reason);
    lifetime.abort(input.signal?.reason);
  };
  input.signal?.addEventListener('abort', externalAbort, { once: true });
  let phase: EphemeralRunnerEndpointPhase = 'connecting';
  let connectionState: EphemeralRunnerConnectionState = 'connected';
  let connection: EphemeralRunnerControlPlaneConnection<Manifest> | null = null;
  let runtime: EphemeralRunnerRuntimeHandle | null = null;
  let runtimeStopOwner: (() => Promise<void>) | null = null;
  let runtimeStartPromise: Promise<EphemeralRunnerRuntimeHandle> | null = null;
  let runtimeStopPromise: Promise<void> | null = null;
  let materialized: Materialized | null = null;
  let preparation: Preparation | null = null;
  let pluginAcquisition: ReviewedRunnerPluginAcquisition | null = null;
  let activeClaim: RunnerClaimV1 | null = null;
  let runPromise: Promise<EphemeralRunnerControllerResult> | null = null;
  let stopPromise: Promise<void> | null = null;
  let stopFailure: Error | null = null;
  let cleanupPromise: Promise<void> | null = null;
  let releaseMaterializedPromise: Promise<void> | null = null;
  let releasePreparationPromise: Promise<void> | null = null;
  let unsubscribeConnection: (() => void) | null = null;
  let unbindUiControls: (() => void) | null = null;
  let closeDecisionPromise: Promise<'kept_open' | 'stopped'> | null = null;
  let declinePromise: Promise<void> | null = null;
  let declineResult:
    | Readonly<{ ok: true; outcome: RunnerEndpointDeclineResponseV1 }>
    | Readonly<{ ok: false; error: Error }>
    | null = null;
  let closeUnconfirmed = false;
  let recoverMaterializedForStop: (() => Promise<void>) | null = null;

  const present = (nextPhase: EphemeralRunnerEndpointPhase, canRetry?: boolean) => {
    phase = nextPhase;
    input.ui.present(Object.freeze({
      phase,
      connection: connectionState,
      ...(nextPhase === 'failed' && canRetry !== undefined
        ? { failure: closeUnconfirmed
          ? { kind: 'activation_close_unconfirmed' as const }
          : endpointFailure({ canRetry, sessionExists: materialized !== null }) }
        : {}),
      ...(canRetry !== undefined ? { canRetry } : {}),
    }));
  };
  const cleanup = async () => {
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = (async () => {
      unsubscribeConnection?.();
      unsubscribeConnection = null;
      unbindUiControls?.();
      unbindUiControls = null;
      if (preparation !== null) {
        releasePreparationPromise ??= input.dependencies.releasePreparation({ preparation });
        await releasePreparationPromise.catch(() => undefined);
      }
      // Idempotent at its owner: an applied acquisition has no candidate left
      // to release, and a declined or failed one must not leave a prepared
      // candidate behind in the activation-local Home.
      await pluginAcquisition?.release().catch(() => undefined);
      pluginAcquisition = null;
      await connection?.close().catch(() => undefined);
      connection = null;
      try {
        await input.localState.dispose();
      } finally {
        input.activation.activationSecretKey.fill(0);
        lifetime.abort();
        input.signal?.removeEventListener('abort', externalAbort);
      }
    })();
    return cleanupPromise;
  };
  const releaseMaterializedOnce = async () => {
    if (materialized === null) return;
    if (releaseMaterializedPromise) return releaseMaterializedPromise;
    const target = materialized;
    releaseMaterializedPromise = input.dependencies.releaseMaterialized({
      materialized: target,
    });
    return releaseMaterializedPromise;
  };
  const stopRuntimeOnce = async () => {
    const stopOwner = runtimeStopOwner ?? runtime?.stop;
    if (!stopOwner) return;
    runtimeStopPromise ??= stopOwner();
    try {
      await runtimeStopPromise;
    } catch (error) {
      stopFailure ??= asError(error);
    }
  };

  const beginDecline = () => {
    if (declinePromise || !connection || !activeClaim || materialized !== null) return;
    declineAbort = new AbortController();
    declinePromise = connection.decline({ claim: activeClaim, signal: declineAbort.signal }).then(
      (outcome) => { declineResult = { ok: true, outcome }; },
      (error: unknown) => { declineResult = { ok: false, error: asError(error) }; },
    );
  };

  const settleDecline = async (cancelPending: boolean) => {
    if (!declinePromise) return;
    // Local work has unwound before this boundary. A Home response already
    // observed is reconciled below; otherwise local exit cancels the request
    // rather than keeping the window and signing custody alive for an ack.
    if (cancelPending && declineResult === null) {
      declineAbort?.abort(new Error('Ephemeral Runner local close'));
    }
    await declinePromise;
    if (declineResult?.ok && declineResult.outcome.status === 'unavailable' && declineResult.outcome.reason === 'already_materialized') {
      if (!recoverMaterializedForStop) {
        stopFailure ??= new Error('runner_materialized_stop_context_unavailable');
        closeUnconfirmed = true;
        return;
      }
      await recoverMaterializedForStop();
      return;
    }
    if (declineResult && (!declineResult.ok
      || declineResult.outcome.status === 'conflict'
      || (declineResult.outcome.status === 'unavailable'
        && (declineResult.outcome.reason === 'creator_unavailable' || declineResult.outcome.reason === 'recipient_mismatch')))) {
      // Currentness can be refused before the Home checks materialization.
      // Neither refusal proves that no Session exists or that it was stopped.
      closeUnconfirmed = true;
      stopFailure ??= declineResult.ok ? new Error('runner_activation_close_unconfirmed') : declineResult.error;
    }
  };

  const declineActivation = async () => {
    beginDecline();
    await settleDecline(false);
    if (stopFailure) throw stopFailure;
  };

  const stop = async () => {
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      if (phase !== 'completed' && phase !== 'failed') present('stopping');
      beginDecline();
      lifetime.abort(new Error('Ephemeral Runner stop requested'));
      // The ordinary Session/process terminal path owns server revocation. The
      // endpoint only settles its local runtime and bootstrap custody.
      if (runtimeStartPromise !== null) {
        try {
          runtime ??= await runtimeStartPromise;
        } catch {
          // The run path retains the construction failure. A close request only
          // waits until no late runtime can escape local cleanup.
        }
      }
      await stopRuntimeOnce();
      if (materialized !== null) {
        try {
          await releaseMaterializedOnce();
        } catch (error) {
          stopFailure ??= asError(error);
        }
      }
      if (stopFailure) throw stopFailure;
    })();
    return stopPromise;
  };

  const requestClose = async (): Promise<'kept_open' | 'stopped'> => {
    if (closeDecisionPromise) return closeDecisionPromise;
    closeDecisionPromise = (async () => {
      if (phase === 'starting' || phase === 'running') {
        const decision = await input.ui.confirmActiveClose({
          phase,
          signal: lifetime.signal,
        });
        if (decision === 'keep_open') return 'kept_open';
      }
      externalStopRequested = true;
      recoveryAbort?.abort(new Error('Ephemeral Runner close requested'));
      // An in-content Decline may be awaiting a response. The existing close
      // control is the local escape; it never starts a competing request.
      declineAbort?.abort(new Error('Ephemeral Runner close requested'));
      await stop().catch(() => undefined);
      if (runPromise !== null) await runPromise;
      return 'stopped';
    })();
    try {
      return await closeDecisionPromise;
    } finally {
      closeDecisionPromise = null;
    }
  };

  unbindUiControls = input.ui.bindControls({ requestStop: requestClose });

  const run = async (): Promise<EphemeralRunnerControllerResult> => {
    if (runPromise) return runPromise;
    runPromise = (async () => {
      const runnerBox = tweetnacl.box.keyPair();
      let claim: RunnerClaimV1 | null = null;
      try {
        present('connecting');
        connection = await input.dependencies.createConnection({
          home: input.home,
          homeDirectory: input.localState.homeDirectory,
          binding: input.activation.binding,
          activationSecretKey: input.activation.activationSecretKey,
          installation: input.installation,
          signal: lifetime.signal,
        });
        lifetime.signal.throwIfAborted();
        unsubscribeConnection = connection.onConnectionState((next) => {
          connectionState = next;
          input.ui.present(Object.freeze({ phase, connection: connectionState }));
        });
        const installationPrivateKey = decodeBase64(input.installation.privateKey, 'base64url');
        const installationProof = signMachineInstallationProof({
          payload: {
            version: 1,
            installationId: input.installation.installationId,
            machineId: input.activation.binding.machineId,
            accountId: input.activation.binding.creatorAccountId,
          },
          privateKey: input.installation.privateKey,
        });
        claim = signRunnerClaimV1({
          payload: {
            v: 1,
            purpose: 'happier.ephemeral-session-runner.claim',
            binding: input.activation.binding,
            runnerBoxPublicKey: encodeBase64(runnerBox.publicKey, 'base64url'),
            installation: {
              installationId: input.installation.installationId,
              publicKey: input.installation.publicKey,
              proof: installationProof,
            },
            protocolEpoch: 1,
          },
          activationSecretKey: input.activation.activationSecretKey,
        });
        // A claim request can commit at the Home even when its response is lost.
        // Retain the exact locally signed claim before crossing that boundary so
        // Stop can race it through the canonical activation close operation.
        activeClaim = claim;
        const relayedClaim = await connection.claim({ claim, signal: lifetime.signal });
        const verifiedClaim = verifyRunnerClaimV1({
          claim: relayedClaim,
          expectedBinding: input.activation.binding,
        });
        if (!verifiedClaim) throw new Error('The Home returned a different Runner claim');
        claim = verifiedClaim;
        activeClaim = claim;

        let directory: string;
        if (input.activation.binding.workspace.kind === 'endpoint_home') {
          directory = input.localState.endpointHomeDirectory;
        } else {
          present('selecting_folder');
          const selectedDirectory = await input.ui.selectDirectory({ signal: lifetime.signal });
          lifetime.signal.throwIfAborted();
          // Each UI owner keeps an OS-picker dismissal on its existing
          // outstanding folder request. A null result therefore represents the
          // endpoint's explicit Cancel request (or a dead native shell), and is
          // the only folder-step input that closes this claimed activation.
          if (selectedDirectory === null) {
            await declineActivation();
            return { status: 'declined' };
          }
          directory = selectedDirectory;
        }
        // The strict endpoint-facts schema accepts exactly the platforms a
        // Runner artifact is published for. Narrow the Node value explicitly
        // so an unexpected platform fails before any material is signed.
        const platform = process.platform === 'darwin' || process.platform === 'linux' || process.platform === 'win32'
          ? process.platform
          : null;
        if (!platform) throw new Error('runner_endpoint_platform_unsupported');
        const factsContent = {
          v: 1 as const,
          directory,
          machine: {
            host: hostname(),
            platform,
            happyCliVersion: packageJson.version,
            // Happier state is activation-local; the OS home is captured before
            // that isolation and remains the canonical endpoint-home policy target.
            happyHomeDir: input.localState.homeDirectory,
            homeDir: input.localState.endpointHomeDirectory,
          },
        };
        const recipient = input.activation.binding.endpointFactsRecipient;
        const content = recipient.mode === 'plain'
          ? { t: 'plain' as const, v: factsContent }
          : {
              t: 'encrypted' as const,
              c: encodeBase64(sealBoxBundle({
                plaintext: new TextEncoder().encode(JSON.stringify(factsContent)),
                recipientPublicKey: decodeBase64(recipient.contentPublicKey, 'base64url'),
                randomBytes: (length) => new Uint8Array(randomBytes(length)),
              }), 'base64url'),
            };
        let endpointFacts: RunnerEndpointFactsV1;
        try {
          endpointFacts = signRunnerEndpointFactsV1({
            payload: {
              v: 1,
              purpose: 'happier.ephemeral-session-runner.endpoint-facts',
              claim: claim.payload,
              content,
            },
            activationSecretKey: input.activation.activationSecretKey,
            installationSecretKey: installationPrivateKey,
          });
        } finally {
          installationPrivateKey.fill(0);
        }
        await connection.storeEndpointFacts({ endpointFacts, endpointFactsContent: factsContent, signal: lifetime.signal });

        present('reviewing');
        const review = await connection.waitForReview({
          binding: input.activation.binding,
          claim,
          runnerBoxSecretKey: runnerBox.secretKey,
          directory,
          signal: lifetime.signal,
        });
        if (review.directory !== directory) throw new Error('Reviewed directory does not match endpoint selection');
        // The activation binding always carries the creator's original authoring
        // commitment, so this comparison is unconditional: a reviewed manifest
        // that re-authored the request must never reach the consent surface.
        if (review.authoringCommitment !== input.activation.binding.authoringCommitment) {
          throw new Error('Reviewed authoring does not match the activation commitment');
        }
        // The reviewed Agent's plugin generation is prepared — never installed —
        // before the endpoint is asked to allow anything, so its canonical
        // installation review is part of the one consent decision.
        let prepared = await input.dependencies.prepareReviewedPluginAcquisition({
          manifest: review.manifest,
          homeDirectory: input.localState.homeDirectory,
          signal: lifetime.signal,
        });
        // A private registry is signed in to only by the endpoint's explicit
        // answer; a rejected credential asks again, and declining declines.
        while ('kind' in prepared) {
          const registryDecision = await input.ui.requestRegistryProfile({
            requirement: prepared.requirement,
            signal: lifetime.signal,
          });
          if (registryDecision === null) {
            await declineActivation();
            return { status: 'declined' };
          }
          prepared = await prepared.selectRegistryProfile({
            credential: registryDecision.credential,
            signal: lifetime.signal,
          });
        }
        pluginAcquisition = prepared;
        let decision: Awaited<ReturnType<typeof input.ui.reviewAndRequestConsent>> | null = null;
        let reviewNeedsConsent = true;
        while (true) {
          if (reviewNeedsConsent) {
            decision = await input.ui.reviewAndRequestConsent({
              review,
              pluginInstallation: pluginAcquisition.review,
              signal: lifetime.signal,
            });
            if (!decision.allow) {
              await declineActivation();
              return { status: 'declined' };
            }
            reviewNeedsConsent = false;
          }
          // Allow installs the exact committed generation before the consent
          // signature exists, so a failed acquisition can be repaired against
          // the same claim without manufacturing a second activation.
          present('installing_agent');
          if (decision === null) throw new Error('runner_consent_decision_unavailable');
          try {
            await pluginAcquisition.apply({
              signal: lifetime.signal,
              optionalSelections: decision.optionalSelections,
            });
            break;
          } catch (error) {
            if (lifetime.signal.aborted) throw error;
            await pluginAcquisition.release().catch(() => undefined);
            recoveryAbort = new AbortController();
            const recovery = await input.ui.requestFailureRecovery({
              failure: endpointFailure({ canRetry: true, sessionExists: false }),
              canRetry: true,
              signal: recoveryAbort.signal,
            }).catch(() => 'exit' as const);
            recoveryAbort = null;
            if (recovery !== 'retry') throw error;
            const previousReview = pluginAcquisition.review;
            const replacement = await input.dependencies.prepareReviewedPluginAcquisition({
              manifest: review.manifest,
              homeDirectory: input.localState.homeDirectory,
              signal: lifetime.signal,
            });
            if ('kind' in replacement) throw new Error('runner_plugin_registry_selection_required');
            pluginAcquisition = replacement;
            reviewNeedsConsent = JSON.stringify(previousReview) !== JSON.stringify(replacement.review);
          }
        }
        lifetime.signal.throwIfAborted();
        const consentInstallationKey = decodeBase64(input.installation.privateKey, 'base64url');
        let consent: RunnerConsentV1;
        try {
          consent = signRunnerConsentV1({
            payload: {
              v: 1,
              purpose: 'happier.ephemeral-session-runner.consent',
              allow: true,
              claim: claim.payload,
              launchManifestCommitment: review.launchManifestCommitment,
            },
            activationSecretKey: input.activation.activationSecretKey,
            installationSecretKey: consentInstallationKey,
          });
        } finally {
          consentInstallationKey.fill(0);
        }
        await connection.submitConsent({ consent, signal: lifetime.signal });

        present('installing_agent');
        while (preparation === null) {
          try {
            preparation = await input.dependencies.prepareAgent({
              manifest: review.manifest,
              environment: input.localState.environment,
              homeDirectory: input.localState.homeDirectory,
              signal: lifetime.signal,
            });
          } catch (error) {
            if (lifetime.signal.aborted) throw error;
            present('failed', true);
            recoveryAbort = new AbortController();
            const recovery = await input.ui.requestFailureRecovery({
              failure: endpointFailure({ canRetry: true, sessionExists: false }),
              canRetry: true,
              signal: recoveryAbort.signal,
            }).catch(() => 'exit' as const);
            recoveryAbort = null;
            if (recovery !== 'retry') throw error;
            present('installing_agent');
          }
        }
        lifetime.signal.throwIfAborted();
        const preparedAgent = preparation;
        const materializationInput = {
          binding: input.activation.binding,
          claim,
          consent,
          manifest: review.manifest,
          launchManifestCommitment: review.launchManifestCommitment,
          runnerBoxSecretKey: runnerBox.secretKey,
          preparation: preparedAgent,
        };
        const startMaterializedRuntime = async (value: Materialized) => {
          runtimeStartPromise = input.dependencies.startSession({
            binding: input.activation.binding,
            manifest: review.manifest,
            materialized: value,
            preparation: preparedAgent,
            localState: input.localState,
            installationPrivateKey: input.installation.privateKey,
            signal: lifetime.signal,
            onRuntimeStopReady: (stopOwner) => {
              runtimeStopOwner ??= stopOwner;
              if (lifetime.signal.aborted) void stopRuntimeOnce();
            },
            onRuntimeConnectionState: (next) => {
              unsubscribeConnection?.();
              unsubscribeConnection = null;
              if (connectionState === next) return;
              connectionState = next;
              input.ui.present(Object.freeze({ phase, connection: connectionState }));
            },
          });
          if (lifetime.signal.aborted) await stopRuntimeOnce();
          runtime = await runtimeStartPromise;
          return runtime;
        };
        recoverMaterializedForStop = async () => {
          // A confirmed materialization winner is no longer an activation
          // cancellation. Reuse its existing bootstrap and the ordinary Stop
          // owner; the aborted run signal prevents Agent admission.
          materialized ??= await input.dependencies.materialize({
            ...materializationInput,
            signal: new AbortController().signal,
            retryTransportErrors: false,
          });
          if (runtimeStartPromise === null) {
            await startMaterializedRuntime(materialized).catch((error: unknown) => {
              if (runtimeStopOwner === null) throw error;
            });
          }
          await stopRuntimeOnce();
          if (stopFailure) throw stopFailure;
          await releaseMaterializedOnce();
        };
        let readiness: Awaited<ReturnType<typeof input.dependencies.checkNonInferenceReadiness>>;
        while (true) {
          try {
            present('checking_ai_access');
            await connection.reportProgress({ phase: 'checking_ai_access', signal: lifetime.signal });
            const readinessInstallationKey = decodeBase64(input.installation.privateKey, 'base64url');
            try {
              readiness = await input.dependencies.checkNonInferenceReadiness({
                binding: input.activation.binding,
                claim,
                consent,
                manifest: review.manifest,
                launchManifestCommitment: review.launchManifestCommitment,
                runnerBoxSecretKey: runnerBox.secretKey,
                activationSecretKey: input.activation.activationSecretKey,
                installationSecretKey: readinessInstallationKey,
                homeDirectory: input.localState.homeDirectory,
                preparation,
                signal: lifetime.signal,
              });
            } finally {
              readinessInstallationKey.fill(0);
            }
            if (readiness.status !== 'ready') throw new Error(`AI access is ${readiness.status}: ${readiness.reason}`);
            await connection.submitReadiness({ readiness: readiness.readiness, signal: lifetime.signal });
            break;
          } catch (error) {
            if (lifetime.signal.aborted) throw error;
            present('failed', true);
            recoveryAbort = new AbortController();
            const recovery = await input.ui.requestFailureRecovery({
              failure: endpointFailure({ canRetry: true, sessionExists: false }),
              canRetry: true,
              signal: recoveryAbort.signal,
            }).catch(() => 'exit' as const);
            recoveryAbort = null;
            if (recovery !== 'retry') throw error;
          }
        }
        present('waiting_for_materialization');
        materialized = await input.dependencies.materialize({
          ...materializationInput,
          signal: lifetime.signal,
        });
        if (!lifetime.signal.aborted) present('starting');
        const runningRuntime = await startMaterializedRuntime(materialized);
        // The endpoint can be stopped while the canonical runtime owner is
        // still constructing. Do not let a late successful construction
        // escape the already-settled Stop and become invisible work.
        if (lifetime.signal.aborted) {
          await stopRuntimeOnce();
          if (stopFailure) throw stopFailure;
          try {
            await releaseMaterializedOnce();
          } catch (error) {
            stopFailure ??= asError(error);
            throw stopFailure;
          }
          lifetime.signal.throwIfAborted();
        }
        present('running');
        const terminal = await runningRuntime.terminal;
        await stop();
        if (externalStopRequested) return { status: 'cancelled' };
        if (terminal.status === 'failed') throw terminal.error;
        present('completed');
        return { status: 'completed' };
      } catch (error) {
        const normalized = asError(error);
        const wasCancelled = externalStopRequested;
        await stop().catch(() => undefined);
        await settleDecline(wasCancelled).catch((declineError: unknown) => {
          stopFailure ??= asError(declineError);
          closeUnconfirmed = true;
        });
        if (wasCancelled && materialized !== null) {
          try {
            await releaseMaterializedOnce();
          } catch (releaseError) {
            stopFailure ??= asError(releaseError);
          }
        }
        if (wasCancelled && stopFailure === null) return { status: 'cancelled' };
        const failure = stopFailure ?? normalized;
        // Retry restarts this process's whole run, which mints a fresh box key
        // and installation identity. Once a claim has been sent, the Home has
        // recorded exactly one winning claim and `stop()` above has already
        // declined that activation, so a second run can only be rejected.
        // Offering Retry there is an invitation into a guaranteed failure loop.
        const canRetry = materialized === null && activeClaim === null;
        const publicFailure = closeUnconfirmed
          ? { kind: 'activation_close_unconfirmed' as const }
          : endpointFailure({ canRetry, sessionExists: materialized !== null });
        present('failed', canRetry);
        recoveryAbort = new AbortController();
        const recovery = externalStopRequested ? 'exit' : await input.ui.requestFailureRecovery({
          failure: publicFailure,
          canRetry,
          signal: recoveryAbort.signal,
        }).catch(() => 'exit' as const);
        recoveryAbort = null;
        if (recovery === 'retry' && materialized === null) return { status: 'retry_requested' };
        return { status: 'failed', error: failure };
      } finally {
        declineAbort?.abort();
        runnerBox.secretKey.fill(0);
        await cleanup();
      }
    })();
    return runPromise;
  };

  return Object.freeze({
    run,
    requestClose,
    stop: async () => {
      externalStopRequested = true;
      recoveryAbort?.abort(new Error('Ephemeral Runner stop requested'));
      declineAbort?.abort(new Error('Ephemeral Runner stop requested'));
      await stop();
    },
  });
}
