import { isDeepStrictEqual } from 'node:util';

import { decodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { openBoxBundleWithSecretKey } from '@happier-dev/protocol/crypto/boxBundle';
import type { RunnerActivationBindingV1 } from '@happier-dev/protocol/ephemeralRunner/activation';
import { runnerActivationProjectionBindingV1 } from '@happier-dev/protocol/ephemeralRunner/projection';
import type { RunnerConsentV1 } from '@happier-dev/protocol/ephemeralRunner/consent';
import type {
  RunnerClaimV1,
  RunnerEndpointFactsContentV1,
  RunnerEndpointFactsV1,
} from '@happier-dev/protocol/ephemeralRunner/endpoint';
import type { RunnerReadinessV1 } from '@happier-dev/protocol/ephemeralRunner/readiness';
import type {
  RunnerActivationProgressPhaseV1,
} from '@happier-dev/protocol/ephemeralRunner/progress';
import type { RunnerActivationProgressUpdateV1 } from '@happier-dev/protocol/ephemeralRunner/progressProof';
import { RunnerEndpointDeclineResponseV1Schema, RunnerEndpointProjectionResponseV1Schema } from '@happier-dev/protocol/ephemeralRunner/endpointProjection';
import type { RunnerEndpointProjectionRequestV1, RunnerEndpointProjectionResponseV1 } from '@happier-dev/protocol/ephemeralRunner/endpointProjection';
import { computeRunnerLaunchManifestCommitmentV1, deriveRunnerLaunchManifestAgentTargetKeyV1, RunnerLaunchManifestV1Schema } from '@happier-dev/protocol/ephemeralRunner/launchManifest';
import type { RunnerLaunchManifestV1 } from '@happier-dev/protocol/ephemeralRunner/launchManifest';
import type {
  EphemeralRunnerConnectionState,
  EphemeralRunnerControlPlaneConnection,
} from './controlPlane';
import type { RunnerBrokerReadinessProjectionV1 } from '@happier-dev/protocol/teams';

export type EphemeralRunnerControlRequest = (
  path: string,
  init: Readonly<RequestInit>,
  signal: AbortSignal,
) => Promise<unknown>;

export class EphemeralRunnerControlHttpError extends Error {
  constructor(readonly status: number) {
    super(`runner_control_http_${status}`);
    this.name = 'EphemeralRunnerControlHttpError';
  }
}

export type EphemeralRunnerMaterializedProjection = Extract<
  RunnerEndpointProjectionResponseV1,
  { status: 'materialized' }
>;

type ProjectionProofFactory = (launchManifestCommitment: string | null) => RunnerEndpointProjectionRequestV1 | unknown;
type ProgressProofFactory = (phase: RunnerActivationProgressPhaseV1) => RunnerActivationProgressUpdateV1 | unknown;

export class EphemeralRunnerControlTransportError extends Error {
  constructor(readonly cause: unknown) {
    super('runner_control_transport_unavailable');
  }
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Proof-only Runner control transport. It deliberately has no bearer-token
 * parameter: Account authentication cannot accidentally enter this boundary.
 */
export function createEphemeralRunnerHttpControlConnection<Manifest = RunnerLaunchManifestV1>(input: Readonly<{
  activationId: string;
  expectedBinding?: RunnerActivationBindingV1;
  request: EphemeralRunnerControlRequest;
  createProjectionProof: ProjectionProofFactory;
  createProgressProof?: ProgressProofFactory;
  pollIntervalMs?: number;
  parseProjection?: (value: unknown) => RunnerEndpointProjectionResponseV1;
  parseManifest?: (value: unknown) => Manifest;
  computeManifestCommitment?: (value: Manifest) => string;
  deriveManifestAgentTargetKey?: (value: unknown) => string;
  closeTransport?: () => Promise<void>;
}>): EphemeralRunnerControlPlaneConnection<Manifest> & Readonly<{
  waitForMaterialization(args: Readonly<{
    launchManifestCommitment: string;
    signal: AbortSignal;
    /** Recovery reads fail fast when the Home transport is unavailable. */
    retryTransportErrors?: boolean;
  }>): Promise<EphemeralRunnerMaterializedProjection>;
  readBrokerReadinessProjection(): RunnerBrokerReadinessProjectionV1 | null;
}> {
  const base = `/v1/ephemeral-runners/activations/${encodeURIComponent(input.activationId)}/endpoint`;
  const pollIntervalMs = input.pollIntervalMs ?? 1_000;
  const parseProjection = input.parseProjection ?? ((value) => RunnerEndpointProjectionResponseV1Schema.parse(value));
  const parseManifest = input.parseManifest ?? ((value) => RunnerLaunchManifestV1Schema.parse(value) as Manifest);
  const computeCommitment = input.computeManifestCommitment
    ?? ((value) => computeRunnerLaunchManifestCommitmentV1(value));
  const deriveManifestAgentTargetKey = input.deriveManifestAgentTargetKey ?? deriveRunnerLaunchManifestAgentTargetKeyV1;
  const listeners = new Set<(state: EphemeralRunnerConnectionState) => void>();
  let closed = false;
  let reviewedLaunchManifestCommitment: string | null = null;
  let readinessProjection: RunnerBrokerReadinessProjectionV1 | null = null;
  let submittedEndpointFactsProof: Readonly<{
    activationSignature: string;
    installationSignature: string;
  }> | null = null;
  let submittedEndpointFactsContent: RunnerEndpointFactsContentV1 | null = null;

  const call = async (operation: string | null, method: 'DELETE' | 'POST' | 'PUT', body: unknown, signal: AbortSignal) => {
    if (closed) throw new Error('runner_control_connection_closed');
    try {
      const value = await input.request(operation === null ? base : `${base}/${operation}`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }, signal);
      for (const listener of listeners) listener('connected');
      return value;
    } catch (error) {
      if (signal.aborted) throw error;
      if (error instanceof EphemeralRunnerControlHttpError) {
        for (const listener of listeners) listener('connected');
        throw error;
      }
      for (const listener of listeners) listener('reconnecting');
      throw new EphemeralRunnerControlTransportError(error);
    }
  };

  const projection = async (commitment: string | null, signal: AbortSignal) => {
    const value = parseProjection(await call('projection', 'POST', input.createProjectionProof(commitment), signal));
    if (value.status === 'pending') readinessProjection = value.brokerReadiness;
    if (
      input.expectedBinding
      && (value.status === 'pending' || value.status === 'materialized')
      && !isDeepStrictEqual(runnerActivationProjectionBindingV1(value.activation), input.expectedBinding)
    ) throw new Error('runner_projection_binding_mismatch');
    return value;
  };

  const callIdempotent = async (
    operation: string | null,
    method: 'DELETE' | 'POST' | 'PUT',
    body: unknown,
    signal: AbortSignal,
  ): Promise<unknown> => {
    while (true) {
      try {
        return await call(operation, method, body, signal);
      } catch (error) {
        if (signal.aborted || !(error instanceof EphemeralRunnerControlTransportError)) throw error;
        await delay(pollIntervalMs, signal);
      }
    }
  };

  const waitForProjection = async (
    commitment: string | null,
    accept: (value: RunnerEndpointProjectionResponseV1) => boolean,
    signal: AbortSignal,
    retryTransportErrors = true,
  ): Promise<RunnerEndpointProjectionResponseV1> => {
    while (true) {
      let value: RunnerEndpointProjectionResponseV1;
      try {
        value = await projection(commitment, signal);
      } catch (error) {
        if (signal.aborted) throw error;
        if (!(error instanceof EphemeralRunnerControlTransportError)) throw error;
        if (!retryTransportErrors) throw error;
        await delay(pollIntervalMs, signal);
        continue;
      }
      if (value.status === 'unavailable' || value.status === 'conflict') {
        throw new Error(`runner_projection_${value.status}:${value.reason}`);
      }
      if (accept(value)) return value;
      await delay(pollIntervalMs, signal);
    }
  };

  return Object.freeze({
    async claim({ claim, signal }) {
      const response = await callIdempotent('claim', 'POST', claim, signal) as { claim?: unknown };
      return response?.claim;
    },
    async storeEndpointFacts({ endpointFacts, endpointFactsContent, signal }: {
      endpointFacts: RunnerEndpointFactsV1;
      endpointFactsContent: RunnerEndpointFactsContentV1;
      signal: AbortSignal;
    }) {
      await callIdempotent('facts', 'PUT', endpointFacts, signal);
      submittedEndpointFactsProof = {
        activationSignature: endpointFacts.activationSignature,
        installationSignature: endpointFacts.installationSignature,
      };
      submittedEndpointFactsContent = endpointFactsContent;
    },
    async reportProgress({ phase, signal }: { phase: RunnerActivationProgressPhaseV1; signal: AbortSignal }) {
      if (!input.createProgressProof) throw new Error('runner_progress_proof_unavailable');
      try {
        await callIdempotent('progress', 'PUT', input.createProgressProof(phase), signal);
      } catch (error) {
        // Progress is creator presentation, never authority. The Home rejects a
        // publication when the recorded phase is already at or beyond this one
        // (409) or when the activation no longer accepts progress (404) —
        // which is exactly what happens when the creator commits
        // materialization while `preparing_encryption`/`creating_session` are
        // still in flight. Failing the run there would abandon a Session that
        // was successfully created. Every authoritative step after this one
        // rechecks the same activation state and fails on its own terms.
        if (error instanceof EphemeralRunnerControlHttpError && (error.status === 404 || error.status === 409)) return;
        throw error;
      }
    },
    async waitForReview({ binding, runnerBoxSecretKey, directory, signal }) {
      const projected = await waitForProjection(null, (value) => value.status === 'pending' && value.activation.review !== null, signal);
      if (projected.status !== 'pending' || projected.activation.review === null) throw new Error('runner_review_invalid');
      const review = projected.activation.review;
      const opened = openBoxBundleWithSecretKey({
        bundle: decodeBase64(review.sealedLaunchManifest, 'base64url'),
        recipientSecretKey: runnerBoxSecretKey,
      });
      if (!opened) throw new Error('runner_review_invalid');
      try {
        let decoded: unknown;
        try {
          decoded = JSON.parse(new TextDecoder().decode(opened));
        } catch {
          throw new Error('runner_review_invalid');
        }
        const manifest = parseManifest(decoded);
        let manifestAgentTargetKey: string;
        try {
          manifestAgentTargetKey = deriveManifestAgentTargetKey(decoded);
        } catch {
          throw new Error('runner_review_invalid');
        }
        if (manifestAgentTargetKey !== review.agentTargetKey) throw new Error('runner_review_invalid');
        if (
          input.expectedBinding
          && (
            !manifest
            || typeof manifest !== 'object'
            || !('binding' in manifest)
            || !isDeepStrictEqual(manifest.binding, input.expectedBinding)
          )
        ) throw new Error('runner_review_binding_mismatch');
        if (computeCommitment(manifest) !== review.launchManifestCommitment) throw new Error('runner_review_invalid');
        if (submittedEndpointFactsProof === null
          || !isDeepStrictEqual(review.endpointFactsProof, submittedEndpointFactsProof)) {
          throw new Error('runner_review_binding_mismatch');
        }
        if (
          submittedEndpointFactsContent === null
          || !manifest
          || typeof manifest !== 'object'
          || !('endpointFacts' in manifest)
          || !isDeepStrictEqual(manifest.endpointFacts, submittedEndpointFactsContent)
        ) throw new Error('runner_review_binding_mismatch');
        if (
          !manifest
          || typeof manifest !== 'object'
          || !('machineContentKeyBinding' in manifest)
          || !isDeepStrictEqual(manifest.machineContentKeyBinding, review.machineContentKeyBinding)
        ) throw new Error('runner_review_binding_mismatch');
        if (
          !('displayFacts' in manifest)
          || !isDeepStrictEqual(manifest.displayFacts, review.displayFacts)
        ) throw new Error('runner_review_binding_mismatch');
        // The Home-readable sidecar selection — not the sealed one — is what the
        // Home projects as broker readiness and later admits, so a substituted
        // resource/application/revision must fail before this endpoint renders
        // the review and collects a signed Allow.
        if (
          !('credentialSelectionBinding' in manifest)
          || !isDeepStrictEqual(manifest.credentialSelectionBinding, review.credentialSelectionBinding)
        ) throw new Error('runner_review_binding_mismatch');
        reviewedLaunchManifestCommitment = review.launchManifestCommitment;
        return {
          manifest,
          launchManifestCommitment: review.launchManifestCommitment,
          authoringCommitment: binding.authoringCommitment,
          directory: (
            manifest
            && typeof manifest === 'object'
            && 'endpointFacts' in manifest
            && manifest.endpointFacts
            && typeof manifest.endpointFacts === 'object'
            && 'directory' in manifest.endpointFacts
            && typeof manifest.endpointFacts.directory === 'string'
          ) ? manifest.endpointFacts.directory : directory,
        };
      } finally {
        opened.fill(0);
      }
    },
    async submitConsent({ consent, signal }: { consent: RunnerConsentV1; signal: AbortSignal }) {
      await callIdempotent('consent', 'PUT', consent, signal);
    },
    async submitReadiness({ readiness, signal }: { readiness: RunnerReadinessV1; signal: AbortSignal }) {
      await callIdempotent('readiness', 'PUT', readiness, signal);
    },
    async decline({ claim, signal }: { claim: RunnerClaimV1; signal: AbortSignal }) {
      void claim;
      return RunnerEndpointDeclineResponseV1Schema.parse(
        await call(null, 'DELETE', input.createProjectionProof(reviewedLaunchManifestCommitment), signal),
      );
    },
    onConnectionState(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async close() {
      closed = true;
      listeners.clear();
      await input.closeTransport?.();
    },
    readBrokerReadinessProjection: () => readinessProjection,
    async waitForMaterialization({ launchManifestCommitment, signal, retryTransportErrors = true }) {
      const result = await waitForProjection(
        launchManifestCommitment,
        (value) => value.status === 'materialized',
        signal,
        retryTransportErrors,
      );
      if (result.status !== 'materialized') throw new Error('runner_materialization_invalid');
      return result;
    },
  });
}
