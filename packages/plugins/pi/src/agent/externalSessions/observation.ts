import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';

import {
  deriveExternalSessionActivity,
  type AgentExternalSessionObservationContribution,
  type AgentExternalSessionObservationLinkEvidenceBatchV1,
} from '@happier-dev/plugin-sdk/sessions/external';
import type {
  AgentExternalSessionsResolvedIdentity,
} from '@happier-dev/plugin-sdk/sessions/external';
import {
  canonicalizePathSync } from '@happier-dev/plugin-sdk/fs';

import { readCanonicalPiAgentRuntimeDescriptorV1 } from '../../protocol/runtimeDescriptorV1.js';
import {
  isPiSessionFileInside,
  type PiExternalSessionFileState,
} from './files.js';
import { resolvePiExternalSessionSource } from './source.js';

const RESOURCE_KEY_PREFIX = 'pi-file-resource-v1:';
const LINK_KEY_PREFIX = 'pi-file-link-v1:';
const RECONCILIATION_FACT_TTL_MS = 1_000;
const MAX_OPAQUE_KEY_LENGTH = 256;

type ExternalAgentObservationLeafFact =
  AgentExternalSessionObservationLinkEvidenceBatchV1['items'][number]['facts'][number];

type PiObservationLinkedFile = Readonly<{
  agentDir: string;
  sessionFile: string;
  remoteSessionId: string;
}>;

async function readObservationFileState(filePath: string): Promise<PiExternalSessionFileState> {
  const metadata = await lstat(filePath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error('Pi observation source is not a regular session file');
  }
  return metadata;
}

function readNonemptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readLinkedFile(
  identity: AgentExternalSessionsResolvedIdentity,
  env: NodeJS.ProcessEnv,
): PiObservationLinkedFile {
  const resolvedSource = resolvePiExternalSessionSource({ source: identity.source, env });
  if (!resolvedSource) throw new Error('agent/source mismatch');

  const sourceFile = readNonemptyString(identity.source.sessionFile);
  // The resolved link data carries the session file inside the runtime descriptor;
  // a top-level `sessionFile` there would be rejected by host owner metadata.
  const linkFile = readCanonicalPiAgentRuntimeDescriptorV1(
    identity.linkData.runtimeDescriptorV1,
  )?.sessionFile ?? null;
  if (!sourceFile || !linkFile) {
    throw new Error('Pi observation requires one resolved session file');
  }
  const canonicalSourceFile = canonicalizePathSync(sourceFile);
  const canonicalLinkFile = canonicalizePathSync(linkFile);
  if (
    canonicalSourceFile !== canonicalLinkFile
    || !isPiSessionFileInside(resolvedSource.sessionsRoot, canonicalSourceFile)
  ) {
    throw new Error('Pi observation session file does not match the resolved source');
  }

  const remoteSessionId = readNonemptyString(identity.remoteSessionId);
  if (!remoteSessionId) {
    throw new Error('Pi observation requires a native session id');
  }
  return {
    agentDir: resolvedSource.agentDir,
    sessionFile: canonicalSourceFile,
    remoteSessionId,
  };
}

function hashOpaqueIdentity(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('base64url');
}

function buildDescriptor(
  linkedFile: PiObservationLinkedFile,
): Readonly<{
  resourceKey: string;
  linkKey: string;
  changeObservation: 'reconcile_only';
}> {
  const resourceKey = `${RESOURCE_KEY_PREFIX}${hashOpaqueIdentity(JSON.stringify({
    agentDir: linkedFile.agentDir,
    sessionFile: linkedFile.sessionFile,
  }))}`;
  const linkKey = `${LINK_KEY_PREFIX}${hashOpaqueIdentity(JSON.stringify({
    agentDir: linkedFile.agentDir,
    sessionFile: linkedFile.sessionFile,
    remoteSessionId: linkedFile.remoteSessionId,
  }))}`;
  if (resourceKey.length > MAX_OPAQUE_KEY_LENGTH || linkKey.length > MAX_OPAQUE_KEY_LENGTH) {
    throw new Error('Pi observation identity exceeds the bounded opaque-key contract');
  }
  return { resourceKey, linkKey, changeObservation: 'reconcile_only' };
}

function buildGrouping(
  linkedFile: PiObservationLinkedFile,
): Readonly<{ resourceKey: string; linkKey: string }> {
  return {
    resourceKey: `${RESOURCE_KEY_PREFIX}${hashOpaqueIdentity(JSON.stringify({
      agentDir: linkedFile.agentDir,
      sessionFile: linkedFile.sessionFile,
    }))}`,
    linkKey: `${LINK_KEY_PREFIX}${hashOpaqueIdentity(JSON.stringify({
      agentDir: linkedFile.agentDir,
      sessionFile: linkedFile.sessionFile,
      remoteSessionId: linkedFile.remoteSessionId,
    }))}`,
  };
}

function retrievalFailedFacts(observedAtMs: number): ExternalAgentObservationLeafFact[] {
  return (['liveness', 'turn_phase', 'boundary'] as const).map((axis) => ({
    kind: 'retrieval_failed',
    axis,
    evidenceClass: 'reconciliation',
    observedAtMs,
  }));
}

function successfulFacts(params: Readonly<{
  fileState: PiExternalSessionFileState;
  env: NodeJS.ProcessEnv;
  nowMs: number;
}>): ExternalAgentObservationLeafFact[] {
  const activity = deriveExternalSessionActivity({
    updatedAtMs: params.fileState.mtimeMs,
    nowMs: params.nowMs,
    env: params.env,
  });
  const expiresAtMs = clampObservationTime(
    params.nowMs + RECONCILIATION_FACT_TTL_MS,
  );
  const activityFact: ExternalAgentObservationLeafFact =
    activity === 'active_recently'
      ? {
        kind: 'recent_activity',
        evidenceClass: 'reconciliation',
        observedAtMs: params.nowMs,
        expiresAtMs,
      }
      : activity === 'idle'
        ? {
          kind: 'successful_empty',
          emptyTurnPhase: 'unsupported',
          evidenceClass: 'reconciliation',
          observedAtMs: params.nowMs,
          expiresAtMs,
        }
        : {
          kind: 'retrieval_failed',
          axis: 'turn_phase',
          evidenceClass: 'reconciliation',
          observedAtMs: params.nowMs,
        };
  return [
    activityFact,
    ...(['liveness', 'boundary'] as const).map((axis) => ({
      kind: 'unsupported' as const,
      axis,
      evidenceClass: 'reconciliation' as const,
      observedAtMs: params.nowMs,
    })),
  ];
}

function clampObservationTime(nowMs: number): number {
  if (!Number.isFinite(nowMs)) return 0;
  return Math.max(
    0,
    Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(nowMs)),
  );
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new Error('Pi observation reconciliation was cancelled');
}

export function createPiExternalSessionObservationContribution(params: Readonly<{
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  readFileState?: (filePath: string) => Promise<PiExternalSessionFileState>;
}> = {}): AgentExternalSessionObservationContribution {
  const env = params.env ?? process.env;
  const now = params.now ?? Date.now;
  const readState = params.readFileState ?? readObservationFileState;

  return Object.freeze({
    describeResource(identity) {
      const linkedFile = readLinkedFile(identity, env);
      return buildGrouping(linkedFile);
    },

    observeResource(request) {
      throwIfAborted(request.signal);
      if (!request.resourceKey.startsWith(RESOURCE_KEY_PREFIX)) {
        throw new Error('Pi observation resource key is invalid');
      }
      return Object.freeze({ dispose() {} });
    },

    async reconcileResource(request) {
      throwIfAborted(request.signal);
      if (request.purpose === 'resource_descriptors') {
        const resolvedLinks = request.links.map((link) => ({
          linkKey: link.linkKey,
          linkedFile: readLinkedFile(link.linkedSource, env),
        }));
        const stateByFile = new Map<string, Promise<PiExternalSessionFileState>>();
        const outcomes = await Promise.all(resolvedLinks.map(async ({ linkKey, linkedFile }) => {
          let statePromise = stateByFile.get(linkedFile.sessionFile);
          if (!statePromise) {
            statePromise = Promise.resolve().then(
              () => readState(linkedFile.sessionFile),
            );
            stateByFile.set(linkedFile.sessionFile, statePromise);
          }
          try {
            await statePromise;
            throwIfAborted(request.signal);
            return {
              kind: 'described' as const,
              descriptor: buildDescriptor(linkedFile),
            };
          } catch {
            throwIfAborted(request.signal);
            return {
              kind: 'unavailable' as const,
              linkKey,
            };
          }
        }));
        throwIfAborted(request.signal);
        return {
          purpose: 'resource_descriptors',
          outcomes,
        };
      }
      const observedAtMs = clampObservationTime(now());
      const outcomes = await Promise.all(request.links.map(async (link) => {
        try {
          const linkedFile = readLinkedFile(link.linkedSource, env);
          const fileState = await readState(linkedFile.sessionFile);
          throwIfAborted(request.signal);
          const descriptor = buildDescriptor(linkedFile);
          if (
            descriptor.resourceKey !== request.resourceKey
            || descriptor.linkKey !== link.linkKey
          ) {
            return {
              linkKey: link.linkKey,
              facts: retrievalFailedFacts(observedAtMs),
            };
          }
          return {
            linkKey: link.linkKey,
            facts: successfulFacts({ fileState, env, nowMs: observedAtMs }),
          };
        } catch {
          throwIfAborted(request.signal);
          return {
            linkKey: link.linkKey,
            facts: retrievalFailedFacts(observedAtMs),
          };
        }
      }));
      throwIfAborted(request.signal);
      return {
        purpose: 'observation_evidence',
        outcomes,
      };
    },
  });
}

export const piExternalSessionObservationContribution =
  createPiExternalSessionObservationContribution();
