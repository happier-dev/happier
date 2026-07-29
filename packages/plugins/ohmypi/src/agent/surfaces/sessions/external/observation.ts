import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';

import {
  deriveExternalSessionActivity,
  type AgentExternalSessionObservationContribution,
  type AgentExternalSessionsResolvedIdentity,
  type ExternalAgentObservationLinkEvidenceBatchV1,
} from '@happier-dev/plugin-sdk/experimental/sessions';

import { validateOhMyPiExternalSessionSource } from './source.js';

const RESOURCE_KEY_PREFIX = 'ohmypi-file-resource-v1:';
const LINK_KEY_PREFIX = 'ohmypi-file-link-v1:';
const RECONCILIATION_FACT_TTL_MS = 1_000;
const MAX_OPAQUE_KEY_LENGTH = 256;

type ExternalAgentObservationLeafFact =
  ExternalAgentObservationLinkEvidenceBatchV1['items'][number]['facts'][number];

export type OhMyPiObservationFileState = Readonly<{
  dev: number | bigint;
  ino: number | bigint;
  birthtimeMs: number;
  mtimeMs: number;
}>;

type OhMyPiObservationLinkedFile = Readonly<{
  agentDir: string;
  sessionFilePath: string;
  remoteSessionId: string;
}>;

async function readObservationFileState(filePath: string): Promise<OhMyPiObservationFileState> {
  const metadata = await lstat(filePath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error('Oh My Pi observation source is not a regular session file');
  }
  return metadata;
}

function readNonemptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readLinkedFile(
  identity: AgentExternalSessionsResolvedIdentity,
  env: NodeJS.ProcessEnv,
): OhMyPiObservationLinkedFile {
  if (identity.source.kind !== 'ohMyPiAgentDir') {
    throw new Error('provider/source mismatch');
  }
  const validation = validateOhMyPiExternalSessionSource({
    source: {
      kind: 'ohMyPiAgentDir',
      ...(readNonemptyString(identity.source.agentDir)
        ? { agentDir: readNonemptyString(identity.source.agentDir)! }
        : {}),
    },
    env,
  });
  if (!validation.ok || validation.source.kind !== 'ohMyPiAgentDir') {
    throw new Error(validation.ok ? 'provider/source mismatch' : validation.error);
  }
  const sourcePath = readNonemptyString(identity.source.sessionFilePath);
  const linkPath = readNonemptyString(identity.linkData.sessionFilePath);
  if (!sourcePath || !linkPath || sourcePath !== linkPath) {
    throw new Error('Oh My Pi observation requires one resolved sessionFilePath');
  }
  const remoteSessionId = readNonemptyString(identity.remoteSessionId);
  if (!remoteSessionId) {
    throw new Error('Oh My Pi observation requires a native session id');
  }
  const agentDir = readNonemptyString(validation.source.agentDir);
  if (!agentDir) {
    throw new Error('Oh My Pi observation requires a canonical agent root');
  }
  return {
    agentDir,
    sessionFilePath: sourcePath,
    remoteSessionId,
  };
}

function hashOpaqueIdentity(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('base64url');
}

function buildDescriptor(
  linkedFile: OhMyPiObservationLinkedFile,
): Readonly<{
  resourceKey: string;
  linkKey: string;
  changeObservation: 'reconcile_only';
}> {
  const resourceKey = `${RESOURCE_KEY_PREFIX}${hashOpaqueIdentity(JSON.stringify({
    agentDir: linkedFile.agentDir,
    sessionFilePath: linkedFile.sessionFilePath,
  }))}`;
  const linkKey = `${LINK_KEY_PREFIX}${hashOpaqueIdentity(JSON.stringify({
    agentDir: linkedFile.agentDir,
    sessionFilePath: linkedFile.sessionFilePath,
    remoteSessionId: linkedFile.remoteSessionId,
  }))}`;
  if (resourceKey.length > MAX_OPAQUE_KEY_LENGTH || linkKey.length > MAX_OPAQUE_KEY_LENGTH) {
    throw new Error('Oh My Pi observation identity exceeds the bounded opaque-key contract');
  }
  return { resourceKey, linkKey, changeObservation: 'reconcile_only' };
}

function buildGrouping(
  linkedFile: OhMyPiObservationLinkedFile,
): Readonly<{ resourceKey: string; linkKey: string }> {
  return {
    resourceKey: `${RESOURCE_KEY_PREFIX}${hashOpaqueIdentity(JSON.stringify({
      agentDir: linkedFile.agentDir,
      sessionFilePath: linkedFile.sessionFilePath,
    }))}`,
    linkKey: `${LINK_KEY_PREFIX}${hashOpaqueIdentity(JSON.stringify({
      agentDir: linkedFile.agentDir,
      sessionFilePath: linkedFile.sessionFilePath,
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
  fileState: OhMyPiObservationFileState;
  env: NodeJS.ProcessEnv;
  nowMs: number;
}>): ExternalAgentObservationLeafFact[] {
  const activity = deriveExternalSessionActivity({
    updatedAtMs: params.fileState.mtimeMs,
    nowMs: params.nowMs,
    env: params.env,
  });
  const turnFact: ExternalAgentObservationLeafFact = activity === 'active_recently'
    ? {
      kind: 'recent_activity',
      evidenceClass: 'reconciliation',
      observedAtMs: params.nowMs,
      expiresAtMs: params.nowMs + RECONCILIATION_FACT_TTL_MS,
    }
    : activity === 'idle'
      ? {
        kind: 'successful_empty',
        emptyTurnPhase: 'unsupported',
        evidenceClass: 'reconciliation',
        observedAtMs: params.nowMs,
        expiresAtMs: params.nowMs + RECONCILIATION_FACT_TTL_MS,
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

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new Error('Oh My Pi observation reconciliation was cancelled');
}

export function createOhMyPiExternalSessionObservationContribution(params: Readonly<{
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  readFileState?: (filePath: string) => Promise<OhMyPiObservationFileState>;
}> = {}): AgentExternalSessionObservationContribution {
  const env = params.env ?? process.env;
  const now = params.now ?? Date.now;
  const readState = params.readFileState ?? readObservationFileState;

  return Object.freeze({
    describeResource(identity) {
      const linkedFile = readLinkedFile(identity, env);
      return buildGrouping(linkedFile);
    },

    observeResource() {
      // The activation contribution cannot reach the host-owned fileFollow service.
      // Reconciliation remains useful without coupling status to transcript follow or
      // adding a competing watcher/timer.
      return Object.freeze({ dispose() {} });
    },

    async reconcileResource(request) {
      throwIfAborted(request.signal);
      if (request.purpose === 'resource_descriptors') {
        const resolvedLinks = request.links.map((link) => ({
          linkKey: link.linkKey,
          linkedFile: readLinkedFile(link.linkedSource, env),
        }));
        const stateByFile = new Map<string, Promise<OhMyPiObservationFileState>>();
        const outcomes = await Promise.all(resolvedLinks.map(async ({ linkKey, linkedFile }) => {
          const cacheKey = `${linkedFile.agentDir}\u0000${linkedFile.sessionFilePath}`;
          let statePromise = stateByFile.get(cacheKey);
          if (!statePromise) {
            statePromise = Promise.resolve().then(
              () => readState(linkedFile.sessionFilePath),
            );
            stateByFile.set(cacheKey, statePromise);
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
      const observedAtMs = Math.max(0, Math.min(
        Number.MAX_SAFE_INTEGER,
        Math.trunc(now()),
      ));
      const stateByFile = new Map<string, Promise<OhMyPiObservationFileState>>();
      const outcomes = await Promise.all(request.links.map(async (link) => {
        try {
          const linkedFile = readLinkedFile(link.linkedSource, env);
          const cacheKey = `${linkedFile.agentDir}\u0000${linkedFile.sessionFilePath}`;
          let statePromise = stateByFile.get(cacheKey);
          if (!statePromise) {
            statePromise = readState(linkedFile.sessionFilePath);
            stateByFile.set(cacheKey, statePromise);
          }
          const fileState = await statePromise;
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
            facts: successfulFacts({
              fileState,
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

export const ohMyPiExternalSessionObservationContribution =
  createOhMyPiExternalSessionObservationContribution();
