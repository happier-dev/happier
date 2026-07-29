import { createHash } from 'node:crypto';
import { join } from 'node:path';

import type {
  AgentExternalSessionObservationContribution,
  AgentExternalSessionsResolvedIdentity,
  ExternalAgentObservationLinkEvidenceBatchV1,
  ExternalSessionsSource,
} from '@happier-dev/plugin-sdk/experimental/sessions';
import {
  deriveExternalSessionActivity,
} from '@happier-dev/plugin-sdk/experimental/sessions';

import {
  resolveConfiguredCodexHomePath,
  homeEntries,
} from '../../../rollout/discovery/homeEntries.js';
import {
  inventoryCodexRootSessionRolloutFiles,
  type CodexRolloutFile,
} from '../../../rollout/discovery/sessionsForHome.js';
import {
  inferCodexExternalSessionsActiveServerDir,
  validateCodexExternalSessionsSourcePolicy,
} from './sourceValidation.js';

const RESOURCE_KEY_PREFIX = 'codex-rollout-set-resource-v1:';
const LINK_KEY_PREFIX = 'codex-rollout-set-link-v1:';
const RECONCILIATION_FACT_TTL_MS = 15_000;
const MAX_OPAQUE_KEY_LENGTH = 256;
const MAX_REMOTE_SESSION_ID_LENGTH = 2_000;

type ResolvedCodexObservationIdentity = Readonly<{
  activeServerDir: string;
  codexHome: string;
  remoteSessionId: string;
  source: ExternalSessionsSource;
}>;

type ExternalAgentObservationLeafFact =
  ExternalAgentObservationLinkEvidenceBatchV1['items'][number]['facts'][number];

function readOptionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : null;
}

function isSafeConnectedServiceId(raw: unknown): raw is string {
  return typeof raw === 'string'
    && /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u.test(raw.trim());
}

function toLegacyCodexSource(
  identity: AgentExternalSessionsResolvedIdentity,
): ExternalSessionsSource {
  if (identity.source.kind !== 'codexHome') {
    throw new Error('provider/source mismatch');
  }
  const home = identity.source.home;
  if (home !== 'user' && home !== 'connectedService') {
    throw new Error('Codex observation requires a qualified home');
  }
  const homePath = readOptionalString(identity.source.homePath);
  const connectedServiceId = readOptionalString(
    identity.source.connectedServiceId,
  );
  const connectedServiceProfileId = readOptionalString(
    identity.source.connectedServiceProfileId,
  );
  const connectedServiceGroupId = readOptionalString(
    identity.source.connectedServiceGroupId,
  );
  return {
    kind: 'codexHome',
    home,
    ...(homePath ? { homePath } : {}),
    ...(connectedServiceId ? { connectedServiceId } : {}),
    ...(connectedServiceProfileId ? { connectedServiceProfileId } : {}),
    ...(connectedServiceGroupId ? { connectedServiceGroupId } : {}),
  };
}

function resolveIdentity(
  identity: AgentExternalSessionsResolvedIdentity,
  env: NodeJS.ProcessEnv,
): ResolvedCodexObservationIdentity {
  const remoteSessionId = identity.remoteSessionId.trim();
  if (
    !remoteSessionId
    || remoteSessionId.length > MAX_REMOTE_SESSION_ID_LENGTH
  ) {
    throw new Error('Codex observation requires a bounded native session id');
  }
  const requestedSource = toLegacyCodexSource(identity);
  const configuredCodexHomePath = resolveConfiguredCodexHomePath(env);
  const validation = validateCodexExternalSessionsSourcePolicy({
    source: requestedSource,
    configuredCodexHomePath,
    canonicalRequestedHomePath: readOptionalString(requestedSource.homePath),
    isSafeConnectedServiceId,
  });
  if (!validation.ok || validation.source.kind !== 'codexHome') {
    throw new Error(validation.ok ? 'provider/source mismatch' : validation.error);
  }
  const codexHome = readOptionalString(validation.source.homePath);
  if (!codexHome) {
    throw new Error('Codex observation requires a canonical home path');
  }
  const activeServerDir = validation.source.home === 'connectedService'
    ? inferCodexExternalSessionsActiveServerDir(identity.source)
    : '';
  if (validation.source.home === 'connectedService' && !activeServerDir) {
    throw new Error(
      'Codex connected-service observation requires a qualified active server root',
    );
  }
  return {
    activeServerDir: activeServerDir ?? '',
    codexHome,
    remoteSessionId,
    source: validation.source,
  };
}

function hashOpaqueIdentity(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(value), 'utf8')
    .digest('base64url');
}

function describeResolvedIdentityFromInventory(
  resolved: ResolvedCodexObservationIdentity,
  inventory: Readonly<{
    sourceGeneration: readonly string[];
    files: readonly Pick<CodexRolloutFile, 'filePath'>[];
  }>,
): Readonly<{
  resourceKey: string;
  linkKey: string;
  changeObservation: 'watch_file_changes';
  watchFileChanges: Readonly<{
    files: string[];
    topologyDirectories: string[];
  }>;
}> {
  const linkIdentity = [
    resolved.codexHome,
    resolved.remoteSessionId,
  ];
  const resourceKey = `${RESOURCE_KEY_PREFIX}${hashOpaqueIdentity([
    resolved.codexHome,
  ])}`;
  const linkKey = `${LINK_KEY_PREFIX}${hashOpaqueIdentity(linkIdentity)}`;
  if (
    resourceKey.length > MAX_OPAQUE_KEY_LENGTH
    || linkKey.length > MAX_OPAQUE_KEY_LENGTH
  ) {
    throw new Error(
      'Codex observation identity exceeds the bounded opaque-key contract',
    );
  }
  const files = inventory.files
    .map(({ filePath }) => filePath)
    .sort((left, right) => left.localeCompare(right));
  if (files.length === 0 || files.length > 32) {
    throw new Error(
      'Codex observation requires a complete bounded rollout file set',
    );
  }
  const topologyDirectories = Array.from(new Set([
    join(resolved.codexHome, 'sessions'),
    join(resolved.codexHome, 'archived_sessions'),
  ])).sort((left, right) => left.localeCompare(right));
  if (topologyDirectories.length !== 2) {
    throw new Error(
      'Codex observation requires two distinct bounded topology roots',
    );
  }
  return {
    resourceKey,
    linkKey,
    changeObservation: 'watch_file_changes',
    watchFileChanges: { files, topologyDirectories },
  };
}

function groupResolvedIdentity(
  resolved: ResolvedCodexObservationIdentity,
): Readonly<{ resourceKey: string; linkKey: string }> {
  return {
    resourceKey: `${RESOURCE_KEY_PREFIX}${hashOpaqueIdentity([
      resolved.codexHome,
    ])}`,
    linkKey: `${LINK_KEY_PREFIX}${hashOpaqueIdentity([
      resolved.codexHome,
      resolved.remoteSessionId,
    ])}`,
  };
}

function clampObservationTime(nowMs: number): number {
  if (!Number.isFinite(nowMs)) return 0;
  return Math.max(
    0,
    Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(nowMs)),
  );
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
  latestMtimeMs: number;
  env: NodeJS.ProcessEnv;
  nowMs: number;
}>): ExternalAgentObservationLeafFact[] {
  const activity = deriveExternalSessionActivity({
    updatedAtMs: params.latestMtimeMs,
    nowMs: params.nowMs,
    env: params.env,
  });
  const activityFact: ExternalAgentObservationLeafFact =
    activity === 'active_recently'
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
    activityFact,
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

export function createCodexExternalSessionObservationContribution(params: Readonly<{
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}> = {}): AgentExternalSessionObservationContribution {
  const readEnv = () => params.env ?? process.env;
  const now = params.now ?? Date.now;

  return Object.freeze({
    describeResource(request) {
      return groupResolvedIdentity(resolveIdentity(request, readEnv()));
    },

    observeResource(request) {
      request.signal.throwIfAborted();
      if (!request.resourceKey.startsWith(RESOURCE_KEY_PREFIX)) {
        throw new Error('Codex observation resource key is invalid');
      }
      // The activation facet cannot consume the host-owned fileFollow service.
      // Reconciliation remains useful without coupling status to transcript
      // follow or creating a second watcher, timer, registry, or currentness owner.
      return Object.freeze({ dispose() {} });
    },

    async reconcileResource(request) {
      request.signal.throwIfAborted();
      if (!request.resourceKey.startsWith(RESOURCE_KEY_PREFIX)) {
        throw new Error('Codex observation resource key is invalid');
      }
      if (request.links.length === 0) {
        throw new Error(
          'Codex observation reconciliation requires a current link',
        );
      }
      const observedAtMs = clampObservationTime(now());
      const resolvedLinks = request.links.map((link) => {
        try {
          return {
            link,
            resolved: resolveIdentity(link.linkedSource, readEnv()),
          } as const;
        } catch {
          return { link, resolved: null } as const;
        }
      });
      request.signal.throwIfAborted();

      const qualifiedLinks = await Promise.all(resolvedLinks.map(
        async ({ link, resolved }) => {
          if (!resolved) return { link, resolved, home: null } as const;
          try {
            const homes = await homeEntries({
              source: resolved.source,
              activeServerDir: resolved.activeServerDir,
              env: readEnv(),
            });
            request.signal.throwIfAborted();
            return {
              link,
              resolved,
              home: homes[0] ?? null,
            } as const;
          } catch (error) {
            if (request.signal.aborted) throw error;
            return { link, resolved, home: null } as const;
          }
        },
      ));
      request.signal.throwIfAborted();
      const firstQualified = qualifiedLinks.find(
        (entry) => entry.resolved !== null && entry.home !== null,
      );
      if (!firstQualified?.resolved || !firstQualified.home) {
        return request.purpose === 'resource_descriptors'
          ? {
            purpose: 'resource_descriptors',
            outcomes: request.links.map((link) => ({
              kind: 'unavailable' as const,
              linkKey: link.linkKey,
            })),
          }
          : {
            purpose: 'observation_evidence',
            outcomes: request.links.map((link) => ({
              linkKey: link.linkKey,
              facts: retrievalFailedFacts(observedAtMs),
            })),
          };
      }
      // homeEntries is the canonical source boundary and returns exactly one
      // qualified user/profile/group home. It may realpath a platform alias
      // such as /var -> /private/var, so consume its verified path directly.
      const firstResolved = firstQualified.resolved;
      const home = firstQualified.home;

      const inventory = await inventoryCodexRootSessionRolloutFiles({
        codexHome: home.codexHome,
        remoteSessionIds: qualifiedLinks.flatMap(({ resolved, home: linkHome }) => (
          resolved?.codexHome === firstResolved.codexHome
          && linkHome?.codexHome === home.codexHome
            ? [resolved.remoteSessionId]
            : []
        )),
        signal: request.signal,
      });
      const filesByRemoteSessionId = new Map(
        inventory.requested.map(({ remoteSessionId, files }) => [
          remoteSessionId,
          files,
        ]),
      );
      const expectedResourceKey = `${RESOURCE_KEY_PREFIX}${hashOpaqueIdentity([
        firstResolved.codexHome,
      ])}`;
      if (request.purpose === 'resource_descriptors') {
        const outcomes = qualifiedLinks.map(({ link, resolved, home: linkHome }) => {
          const files = (
            resolved?.codexHome === firstResolved.codexHome
            && linkHome?.codexHome === home.codexHome
          )
            ? filesByRemoteSessionId.get(resolved.remoteSessionId) ?? []
            : [];
          if (!resolved || !linkHome) {
            return {
              kind: 'unavailable' as const,
              linkKey: link.linkKey,
            };
          }
          try {
            const descriptor = describeResolvedIdentityFromInventory(
              resolved,
              {
                sourceGeneration: inventory.sourceGeneration,
                files,
              },
            );
            if (
              resolved.codexHome !== firstResolved.codexHome
              || linkHome.codexHome !== home.codexHome
              || descriptor.linkKey !== link.linkKey
            ) {
              return {
                kind: 'unavailable' as const,
                linkKey: link.linkKey,
              };
            }
            return {
              kind: 'described' as const,
              descriptor,
            };
          } catch {
            return {
              kind: 'unavailable' as const,
              linkKey: link.linkKey,
            };
          }
        });
        request.signal.throwIfAborted();
        return {
          purpose: 'resource_descriptors',
          outcomes,
        };
      }

      const outcomes = qualifiedLinks.map(({ link, resolved, home: linkHome }) => {
        const files = (
          resolved?.codexHome === firstResolved.codexHome
          && linkHome?.codexHome === home.codexHome
        )
          ? filesByRemoteSessionId.get(resolved.remoteSessionId) ?? []
          : [];
        const expectedLinkKey = resolved
          ? `${LINK_KEY_PREFIX}${hashOpaqueIdentity([
            resolved.codexHome,
            resolved.remoteSessionId,
          ])}`
          : null;
        if (
          !resolved
          || !linkHome
          || resolved.codexHome !== firstResolved.codexHome
          || linkHome.codexHome !== home.codexHome
          || request.resourceKey !== expectedResourceKey
          || link.linkKey !== expectedLinkKey
          || files.length === 0
          || files.length > 32
        ) {
          return {
            linkKey: link.linkKey,
            facts: retrievalFailedFacts(observedAtMs),
          };
        }
        const latestMtimeMs = files.reduce<number | null>(
          (latest, file) => (
            latest === null || file.mtimeMs > latest
              ? file.mtimeMs
              : latest
          ),
          null,
        );
        return {
          linkKey: link.linkKey,
          facts: latestMtimeMs === null
            ? retrievalFailedFacts(observedAtMs)
            : successfulFacts({
              latestMtimeMs,
              env: readEnv(),
              nowMs: observedAtMs,
            }),
        };
      });
      request.signal.throwIfAborted();
      return {
        purpose: 'observation_evidence',
        outcomes,
      };
    },
  });
}

export const codexExternalSessionObservationContribution =
  createCodexExternalSessionObservationContribution();
