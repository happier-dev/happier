import { createHash } from 'node:crypto';
import {
  deriveExternalSessionActivity,
  type AgentExternalSessionObservationContribution,
  type AgentExternalSessionObservationLinkEvidenceBatchV1,
} from '@happier-dev/plugin-sdk/sessions/external';
import type {
  AgentExternalSessionsResolvedIdentity,
} from '@happier-dev/plugin-sdk/sessions/external';
import {
  canonicalizePathSync,
} from '@happier-dev/plugin-sdk/fs';

import {
  authorizeAntigravityConversationTranscriptFile,
  isSafeAntigravityConversationId,
  resolveAntigravityBrainDir,
} from './conversationStore.js';
import {
  formatAntigravityTranscriptSourceRevision,
  snapshotAntigravityTranscriptSource,
  type AntigravityTranscriptSourceSnapshot,
} from './transcript/jsonl.js';

const RESOURCE_KEY_PREFIX = 'antigravity-transcript-resource-v1:';
const LINK_KEY_PREFIX = 'antigravity-transcript-link-v1:';
const RECONCILIATION_FACT_TTL_MS = 15_000;
const MAX_OPAQUE_KEY_LENGTH = 256;
const MAX_REMOTE_SESSION_ID_LENGTH = 2_000;

type ExternalAgentObservationLeafFact =
  AgentExternalSessionObservationLinkEvidenceBatchV1['items'][number]['facts'][number];

type AntigravityObservationLinkedIdentity = Readonly<{
  brainDir: string;
  conversationId: string;
  sourceRevision: string;
}>;

type AntigravityObservationLinkedFile = AntigravityObservationLinkedIdentity & Readonly<{
  transcriptPath: string;
}>;

function readNonemptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : null;
}

function readLinkedIdentity(
  identity: AgentExternalSessionsResolvedIdentity,
  env: NodeJS.ProcessEnv,
): AntigravityObservationLinkedIdentity {
  if (identity.source.kind !== 'antigravityCliPrint') {
    throw new Error('provider/source mismatch');
  }
  const brainDir = readNonemptyString(identity.source.brainDir);
  const configuredBrainDir = canonicalizePathSync(
    resolveAntigravityBrainDir(env),
  );
  const requestedBrainDir = brainDir
    ? canonicalizePathSync(brainDir)
    : null;
  if (!requestedBrainDir || requestedBrainDir !== configuredBrainDir) {
    throw new Error(
      'Antigravity observation requires the configured canonical brain directory',
    );
  }
  const conversationId = readNonemptyString(identity.remoteSessionId);
  const sourceConversationId = readNonemptyString(
    identity.source.conversationId,
  );
  if (
    !conversationId
    || conversationId.length > MAX_REMOTE_SESSION_ID_LENGTH
    || !isSafeAntigravityConversationId(conversationId)
    || sourceConversationId !== conversationId
  ) {
    throw new Error(
      'Antigravity observation requires one qualified conversation identity',
    );
  }
  const sourceRevision = readNonemptyString(identity.source.sourceRevision);
  const linkedSourceRevision = readNonemptyString(identity.linkData.sourceRevision);
  if (!sourceRevision || linkedSourceRevision !== sourceRevision) {
    throw new Error(
      'Antigravity observation requires one qualified transcript source revision',
    );
  }
  return {
    brainDir: requestedBrainDir,
    conversationId,
    sourceRevision,
  };
}

async function readLinkedFile(
  identity: AgentExternalSessionsResolvedIdentity,
  env: NodeJS.ProcessEnv,
): Promise<AntigravityObservationLinkedFile> {
  const linkedIdentity = readLinkedIdentity(identity, env);
  const authorization = await authorizeAntigravityConversationTranscriptFile({
    brainDir: linkedIdentity.brainDir,
    conversationId: linkedIdentity.conversationId,
  });
  if (authorization.status !== 'authorized') {
    throw new Error('Antigravity observation transcript is unavailable or unauthorized');
  }
  return { ...linkedIdentity, transcriptPath: authorization.transcriptPath };
}

function hashOpaqueIdentity(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(value), 'utf8')
    .digest('base64url');
}

function buildDescriptor(
  linkedFile: AntigravityObservationLinkedFile,
): Readonly<{
  resourceKey: string;
  linkKey: string;
  changeObservation: 'watch_file_changes';
  watchFileChanges: Readonly<{ files: string[] }>;
}> {
  const { resourceKey, linkKey } = buildGrouping(linkedFile);
  if (
    resourceKey.length > MAX_OPAQUE_KEY_LENGTH
    || linkKey.length > MAX_OPAQUE_KEY_LENGTH
  ) {
    throw new Error(
      'Antigravity observation identity exceeds the bounded opaque-key contract',
    );
  }
  return {
    resourceKey,
    linkKey,
    changeObservation: 'watch_file_changes',
    watchFileChanges: { files: [linkedFile.transcriptPath] },
  };
}

function buildGrouping(
  linkedFile: AntigravityObservationLinkedIdentity,
): Readonly<{ resourceKey: string; linkKey: string }> {
  return {
    resourceKey: `${RESOURCE_KEY_PREFIX}${hashOpaqueIdentity({
      brainDir: linkedFile.brainDir,
      conversationId: linkedFile.conversationId,
    })}`,
    linkKey: `${LINK_KEY_PREFIX}${hashOpaqueIdentity({
      brainDir: linkedFile.brainDir,
      conversationId: linkedFile.conversationId,
    })}`,
  };
}

function retrievalFailedFacts(
  observedAtMs: number,
): ExternalAgentObservationLeafFact[] {
  return (['liveness', 'turn_phase', 'boundary'] as const).map((axis) => ({
    kind: 'retrieval_failed',
    axis,
    evidenceClass: 'reconciliation',
    observedAtMs,
  }));
}

function successfulFacts(params: Readonly<{
  mtimeMs: number;
  env: NodeJS.ProcessEnv;
  nowMs: number;
}>): ExternalAgentObservationLeafFact[] {
  const activity = deriveExternalSessionActivity({
    updatedAtMs: params.mtimeMs,
    nowMs: params.nowMs,
    env: params.env,
  });
  const expiresAtMs = clampObservationTime(
    params.nowMs + RECONCILIATION_FACT_TTL_MS,
  );
  const turnFact: ExternalAgentObservationLeafFact =
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
    turnFact,
    {
      kind: 'unsupported',
      axis: 'liveness',
      evidenceClass: 'reconciliation',
      observedAtMs: params.nowMs,
    },
    {
      kind: 'unsupported',
      axis: 'boundary',
      evidenceClass: 'reconciliation',
      observedAtMs: params.nowMs,
    },
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
    : new Error('Antigravity observation reconciliation was cancelled');
}

export function createAntigravityExternalSessionObservationContribution(
  params: Readonly<{
    env?: NodeJS.ProcessEnv;
    now?: () => number;
    readSnapshot?: (
      transcriptPath: string,
    ) => Promise<AntigravityTranscriptSourceSnapshot | null>;
  }> = {},
): AgentExternalSessionObservationContribution {
  const env = params.env ?? process.env;
  const now = params.now ?? Date.now;
  const readSnapshot =
    params.readSnapshot ?? snapshotAntigravityTranscriptSource;

  return Object.freeze({
    describeResource(identity) {
      return buildGrouping(readLinkedIdentity(identity, env));
    },

    observeResource(request) {
      request.signal.throwIfAborted();
      if (!request.resourceKey.startsWith(RESOURCE_KEY_PREFIX)) {
        throw new Error('Antigravity observation resource key is invalid');
      }
      // File lifecycle and change delivery remain host-owned. This facet only
      // describes the canonical transcript file and reconciles content-free facts.
      return Object.freeze({ dispose() {} });
    },

    async reconcileResource(request) {
      throwIfAborted(request.signal);
      if (request.links.length === 0) {
        throw new Error(
          'Antigravity observation reconciliation requires a current link',
        );
      }
      if (request.purpose === 'resource_descriptors') {
        const snapshotsByFile = new Map<
          string,
          Promise<AntigravityTranscriptSourceSnapshot | null>
        >();
        const outcomes = await Promise.all(request.links.map(async (link) => {
          try {
            const linkedFile = await readLinkedFile(link.linkedSource, env);
            let snapshotPromise = snapshotsByFile.get(linkedFile.transcriptPath);
            if (!snapshotPromise) {
              snapshotPromise = Promise.resolve().then(
                () => readSnapshot(linkedFile.transcriptPath),
              );
              snapshotsByFile.set(linkedFile.transcriptPath, snapshotPromise);
            }
            const snapshot = await snapshotPromise;
            throwIfAborted(request.signal);
            if (!snapshot) {
              return {
                kind: 'unavailable' as const,
                linkKey: link.linkKey,
              };
            }
            return {
              kind: 'described' as const,
              descriptor: buildDescriptor(linkedFile),
            };
          } catch {
            throwIfAborted(request.signal);
            return {
              kind: 'unavailable' as const,
              linkKey: link.linkKey,
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
          const linkedFile = await readLinkedFile(link.linkedSource, env);
          const snapshot = await readSnapshot(linkedFile.transcriptPath);
          throwIfAborted(request.signal);
          if (!snapshot) {
            return {
              linkKey: link.linkKey,
              facts: retrievalFailedFacts(observedAtMs),
            };
          }
          const descriptor = buildDescriptor(linkedFile);
          if (
            linkedFile.sourceRevision !== snapshot.sourceRevision
            || descriptor.resourceKey !== request.resourceKey
            || descriptor.linkKey !== link.linkKey
          ) {
            return {
              linkKey: link.linkKey,
              facts: retrievalFailedFacts(observedAtMs),
            };
          }
          return {
            linkKey: link.linkKey,
            facts: successfulFacts({
              mtimeMs: snapshot.mtimeMs,
              env,
              nowMs: observedAtMs,
            }),
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

export const antigravityExternalSessionObservationContribution =
  createAntigravityExternalSessionObservationContribution();
