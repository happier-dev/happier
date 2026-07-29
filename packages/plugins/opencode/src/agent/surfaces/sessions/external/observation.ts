import { createHash } from 'node:crypto';

import type {
  AgentExternalSessionObservationContribution,
  AgentExternalSessionsResolvedIdentity,
  ExternalSessionsSource,
  ExternalAgentObservationLinkEvidenceBatchV1,
  ExternalAgentObservationReconcileResultV1,
} from '@happier-dev/plugin-sdk/experimental/sessions';

import {
  readOpenCodeManagedServerEndpointRegistration,
  readOpenCodeManagedServerEndpointRegistrationByGenerationToken,
} from '../../../runtime/server/endpoint.js';
import {
  type OpenCodeGlobalEvent,
  type OpenCodeGlobalEventDelivery,
  subscribeOpenCodeGlobalEvents,
} from '../../../runtime/server/openCodeServerClient.js';
import { asRecord, normalizeString } from '../../../runtime/server/openCodeParsing.js';
import type { OpenCodeServerTransport } from '../../../runtime/server/transport.js';
import {
  createOpenCodeExternalSessionClient,
  validateOpenCodeExternalSessionsSource,
} from './client.js';

const OBSERVATION_FACT_TTL_MS = 30_000;
const RESOURCE_KEY_PREFIX = 'opencode-resource-v1:';
const LINK_KEY_PREFIX = 'opencode-link-v1:';
const EXPLICIT_EXTERNAL_GENERATION = 'explicit-external';
const MAX_OPAQUE_KEY_LENGTH = 256;

type SubscribeOpenCodeGlobalEvents = typeof subscribeOpenCodeGlobalEvents;
type OpenCodeFetch = (input: string, init?: RequestInit) => Promise<Response>;
type ExternalAgentObservationLeafFact =
  ExternalAgentObservationLinkEvidenceBatchV1['items'][number]['facts'][number];

function normalizedSourceOrThrow(
  identity: AgentExternalSessionsResolvedIdentity,
  env: Readonly<Record<string, string | undefined>>,
): Readonly<{ baseUrl: string; directory: string | null }> {
  if (identity.source.kind !== 'opencodeServer') {
    throw new Error('provider/source mismatch');
  }
  const legacySource: ExternalSessionsSource = {
    kind: 'opencodeServer',
    ...(typeof identity.source.baseUrl === 'string'
      ? { baseUrl: identity.source.baseUrl }
      : {}),
    ...(typeof identity.source.directory === 'string'
      ? { directory: identity.source.directory }
      : {}),
  };
  const validation = validateOpenCodeExternalSessionsSource({
    source: legacySource,
    env,
    baseUrlAuthority: 'canonical',
  });
  if (!validation.ok) {
    throw new Error(validation.error);
  }
  const baseUrl = validation.source.kind === 'opencodeServer'
    ? normalizeString(validation.source.baseUrl)
    : '';
  if (!baseUrl) {
    throw new Error('OpenCode observation requires a canonical source baseUrl');
  }
  const directory = validation.source.kind === 'opencodeServer'
    ? normalizeString(validation.source.directory) || null
    : null;
  return { baseUrl, directory };
}

function endpointGenerationForBaseUrl(baseUrl: string): string {
  return readOpenCodeManagedServerEndpointRegistration(baseUrl)?.generationToken
    ?? EXPLICIT_EXTERNAL_GENERATION;
}

function hashOpaqueIdentity(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('base64url');
}

function buildResourceKeyForGeneration(baseUrl: string, endpointGeneration: string): string {
  return `${RESOURCE_KEY_PREFIX}${endpointGeneration}:${hashOpaqueIdentity(baseUrl)}`;
}

function buildResourceKey(baseUrl: string): string {
  const resourceKey = buildResourceKeyForGeneration(
    baseUrl,
    endpointGenerationForBaseUrl(baseUrl),
  );
  if (resourceKey.length > MAX_OPAQUE_KEY_LENGTH) {
    throw new Error('OpenCode observation endpoint identity exceeds the bounded resource key');
  }
  return resourceKey;
}

function parseResourceKey(resourceKey: string): Readonly<{
  endpointGeneration: string;
  baseUrlHash: string;
}> {
  if (!resourceKey.startsWith(RESOURCE_KEY_PREFIX)) {
    throw new Error('OpenCode observation resource key is invalid');
  }
  const remainder = resourceKey.slice(RESOURCE_KEY_PREFIX.length);
  const separator = remainder.indexOf(':');
  if (separator <= 0 || separator === remainder.length - 1) {
    throw new Error('OpenCode observation resource key is invalid');
  }
  const endpointGeneration = remainder.slice(0, separator);
  const baseUrlHash = remainder.slice(separator + 1);
  if (!/^[A-Za-z0-9_-]{43}$/u.test(baseUrlHash)) {
    throw new Error('OpenCode observation resource key is invalid');
  }
  return { endpointGeneration, baseUrlHash };
}

function configuredUnauthenticatedBaseUrl(
  env: Readonly<Record<string, string | undefined>>,
): string | null {
  const validation = validateOpenCodeExternalSessionsSource({
    source: { kind: 'opencodeServer' },
    env,
  });
  if (!validation.ok || validation.source.kind !== 'opencodeServer') return null;
  return normalizeString(validation.source.baseUrl) || null;
}

function resolveResource(
  resourceKey: string,
  env: Readonly<Record<string, string | undefined>>,
): Readonly<{
  baseUrl: string;
  headers?: Readonly<Record<string, string>>;
  endpointGeneration: string;
  transport?: OpenCodeServerTransport;
}> {
  const parsed = parseResourceKey(resourceKey);
  if (parsed.endpointGeneration === EXPLICIT_EXTERNAL_GENERATION) {
    const baseUrl = configuredUnauthenticatedBaseUrl(env);
    if (
      !baseUrl
      || readOpenCodeManagedServerEndpointRegistration(baseUrl)
      || buildResourceKeyForGeneration(baseUrl, parsed.endpointGeneration) !== resourceKey
    ) {
      throw new Error('OpenCode observation resource belongs to a stale endpoint generation');
    }
    return {
      baseUrl,
      endpointGeneration: parsed.endpointGeneration,
    };
  }
  const registration =
    readOpenCodeManagedServerEndpointRegistrationByGenerationToken(
      parsed.endpointGeneration,
    );
  if (
    !registration
    || buildResourceKeyForGeneration(
      registration.baseUrl,
      registration.generationToken,
    ) !== resourceKey
  ) {
    throw new Error('OpenCode observation resource belongs to a stale endpoint generation');
  }
  return {
    baseUrl: registration.baseUrl,
    ...(registration.headers ? { headers: registration.headers } : {}),
    endpointGeneration: registration.generationToken,
    transport: registration.transport,
  };
}

function buildLinkKey(directory: string | null, remoteSessionId: string): string {
  const normalizedSessionId = normalizeString(remoteSessionId);
  if (!normalizedSessionId) {
    throw new Error('OpenCode observation requires a native session id');
  }
  const identity = JSON.stringify([directory, normalizedSessionId]);
  return `${LINK_KEY_PREFIX}${createHash('sha256').update(identity, 'utf8').digest('base64url')}`;
}

function turnPhaseFact(
  value: 'working' | 'retrying' | 'idle',
  evidenceClass: 'agent_native' | 'reconciliation',
  observedAtMs: number,
): ExternalAgentObservationLeafFact {
  return {
    kind: 'turn_phase',
    evidenceClass,
    observedAtMs,
    expiresAtMs: observedAtMs + OBSERVATION_FACT_TTL_MS,
    value,
  };
}

function mapOpenCodeStatus(type: unknown): 'working' | 'retrying' | 'idle' | null {
  if (type === 'busy') return 'working';
  if (type === 'retry') return 'retrying';
  if (type === 'idle') return 'idle';
  return null;
}

function readEventPayload(event: OpenCodeGlobalEvent): Readonly<{
  type: string;
  properties: Readonly<Record<string, unknown>> | null;
}> {
  const type = normalizeString(event.payload?.type ?? event.type);
  return {
    type,
    properties: asRecord(event.payload?.properties ?? event.properties),
  };
}

function readEventTurnPhase(event: OpenCodeGlobalEvent):
  | Readonly<{
    kind: 'fact';
    directory: string;
    remoteSessionId: string;
    value: 'working' | 'retrying' | 'idle';
  }>
  | Readonly<{ kind: 'reconcile' }>
  | null {
  const payload = readEventPayload(event);
  if (
    payload.type !== 'session.idle'
    && payload.type !== 'session.status'
    && payload.type !== 'session.error'
  ) {
    return null;
  }
  if (payload.type === 'session.error') return { kind: 'reconcile' };
  const directory = normalizeString(event.directory);
  const remoteSessionId = normalizeString(payload.properties?.sessionID);
  if (!directory || !remoteSessionId) return { kind: 'reconcile' };
  if (payload.type === 'session.idle') {
    return { kind: 'fact', directory, remoteSessionId, value: 'idle' };
  }
  const value = mapOpenCodeStatus(asRecord(payload.properties?.status)?.type);
  return value
    ? { kind: 'fact', directory, remoteSessionId, value }
    : { kind: 'reconcile' };
}

function readEventTranscriptChange(event: OpenCodeGlobalEvent):
  | Readonly<{
    kind: 'correlated';
    directory: string;
    remoteSessionId: string;
  }>
  | Readonly<{ kind: 'reconcile' }>
  | null {
  const payload = readEventPayload(event);
  if (
    payload.type !== 'session.updated'
    && payload.type !== 'message.updated'
    && payload.type !== 'message.part.updated'
    && payload.type !== 'message.part.created'
    && payload.type !== 'message.part.delta'
  ) {
    return null;
  }
  const directory = normalizeString(event.directory);
  const remoteSessionId = normalizeString(payload.properties?.sessionID)
    || normalizeString(asRecord(payload.properties?.session)?.id)
    || normalizeString(asRecord(payload.properties?.part)?.sessionID)
    || normalizeString(asRecord(payload.properties?.info)?.sessionID);
  return directory && remoteSessionId
    ? { kind: 'correlated', directory, remoteSessionId }
    : { kind: 'reconcile' };
}

function retrievalFailedFact(observedAtMs: number): ExternalAgentObservationLeafFact {
  return {
    kind: 'retrieval_failed',
    evidenceClass: 'reconciliation',
    observedAtMs,
    axis: 'turn_phase',
  };
}

function describeOpenCodeObservationResource(
  request: AgentExternalSessionsResolvedIdentity,
  env: Readonly<Record<string, string | undefined>>,
) {
  const source = normalizedSourceOrThrow(request, env);
  if (
    !readOpenCodeManagedServerEndpointRegistration(source.baseUrl)
    && configuredUnauthenticatedBaseUrl(env) !== source.baseUrl
  ) {
    throw new Error(
      'OpenCode unauthenticated observation requires the configured endpoint',
    );
  }
  return {
    resourceKey: buildResourceKey(source.baseUrl),
    linkKey: buildLinkKey(source.directory, request.remoteSessionId),
  };
}

export function createOpenCodeExternalSessionObservationContribution(params: Readonly<{
  env?: Readonly<Record<string, string | undefined>>;
  fetchFn?: OpenCodeFetch;
  now?: () => number;
  subscribeGlobalEvents?: SubscribeOpenCodeGlobalEvents;
}> = {}): AgentExternalSessionObservationContribution {
  const env = params.env ?? process.env;
  const now = params.now ?? Date.now;
  const subscribeGlobalEvents = params.subscribeGlobalEvents ?? subscribeOpenCodeGlobalEvents;

  return Object.freeze({
    describeResource(request) {
      return describeOpenCodeObservationResource(request, env);
    },

    observeResource(request) {
      const resource = resolveResource(request.resourceKey, env);
      const controller = new AbortController();
      const abort = () => controller.abort(request.signal.reason);
      if (request.signal.aborted) {
        abort();
      } else {
        request.signal.addEventListener('abort', abort, { once: true });
      }
      let disposed = false;
      void subscribeGlobalEvents({
        baseUrl: resource.baseUrl,
        headers: resource.headers,
        ...(resource.transport ? { fetch: resource.transport.fetch } : {}),
        signal: controller.signal,
        onUnavailable() {
          if (!controller.signal.aborted) request.requestReconcile();
        },
        onEvent(event, delivery: OpenCodeGlobalEventDelivery) {
          if (controller.signal.aborted) return;
          if (delivery.provenance === 'connection-boundary') {
            request.requestReconcile();
            return;
          }
          const transcriptChange = readEventTranscriptChange(event);
          if (transcriptChange?.kind === 'correlated') {
            request.requestTranscriptRefresh(buildLinkKey(
              transcriptChange.directory,
              transcriptChange.remoteSessionId,
            ));
            return;
          }
          if (transcriptChange?.kind === 'reconcile') {
            request.requestReconcile();
            return;
          }
          const status = readEventTurnPhase(event);
          if (!status) return;
          if (
            delivery.provenance !== 'accepted-live'
            || status.kind === 'reconcile'
          ) {
            request.requestReconcile();
            return;
          }
          const observedAtMs = now();
          request.emit({
            items: [{
              linkKey: buildLinkKey(status.directory, status.remoteSessionId),
              facts: [turnPhaseFact(status.value, 'agent_native', observedAtMs)],
            }],
          });
        },
      }).then(() => {
        if (!controller.signal.aborted) request.requestReconcile();
      }).catch(() => {
        if (!controller.signal.aborted) request.requestReconcile();
      });

      return Object.freeze({
        dispose() {
          if (disposed) return;
          disposed = true;
          request.signal.removeEventListener('abort', abort);
          controller.abort('OpenCode observation disposed');
        },
      });
    },

    async reconcileResource(request) {
      if (request.links.length === 0) {
        throw new Error('OpenCode observation reconciliation requires at least one current link');
      }
      if (request.purpose === 'resource_descriptors') {
        const resource = (() => {
          try {
            return resolveResource(request.resourceKey, env);
          } catch {
            return null;
          }
        })();
        const outcomes = request.links.map((link) => {
          if (!resource) {
            return {
              kind: 'unavailable' as const,
              linkKey: link.linkKey,
            };
          }
          try {
            const linkedSource = normalizedSourceOrThrow(link.linkedSource, env);
            const remoteSessionId = normalizeString(link.linkedSource.remoteSessionId);
            if (
              linkedSource.baseUrl !== resource.baseUrl
              || !remoteSessionId
              || buildLinkKey(linkedSource.directory, remoteSessionId) !== link.linkKey
            ) {
              throw new Error('OpenCode observation link does not belong to its resource');
            }
            return {
              kind: 'described' as const,
              descriptor: {
                resourceKey: request.resourceKey,
                linkKey: link.linkKey,
                changeObservation: 'observe_resource' as const,
              },
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
      const observedAtMs = now();
      type ReconcileOutcome =
        Extract<
          ExternalAgentObservationReconcileResultV1,
          { purpose: 'observation_evidence' }
        >['outcomes'][number];
      const outcomes: ReconcileOutcome[] = request.links.map(({ linkKey }) => ({
        linkKey,
        facts: [retrievalFailedFact(observedAtMs)],
      }));
      let resource: ReturnType<typeof resolveResource>;
      try {
        resource = resolveResource(request.resourceKey, env);
      } catch {
        return {
          purpose: 'observation_evidence',
          outcomes,
        };
      }

      type DirectoryLink = Readonly<{
        index: number;
        linkKey: string;
        remoteSessionId: string;
      }>;
      const linksByDirectory = new Map<string | null, DirectoryLink[]>();
      for (const [index, link] of request.links.entries()) {
        try {
          const linkedSource = normalizedSourceOrThrow(link.linkedSource, env);
          const remoteSessionId = normalizeString(link.linkedSource.remoteSessionId);
          if (
            linkedSource.baseUrl !== resource.baseUrl
            || !remoteSessionId
            || buildLinkKey(linkedSource.directory, remoteSessionId) !== link.linkKey
          ) {
            continue;
          }
          const directoryLinks = linksByDirectory.get(linkedSource.directory) ?? [];
          directoryLinks.push({ index, linkKey: link.linkKey, remoteSessionId });
          linksByDirectory.set(linkedSource.directory, directoryLinks);
        } catch {
          // Invalid link identities remain isolated retrieval failures.
        }
      }

      await Promise.all([...linksByDirectory.entries()].map(
        async ([directory, directoryLinks]) => {
          try {
            const client = await createOpenCodeExternalSessionClient({
              source: {
                kind: 'opencodeServer',
                baseUrl: resource.baseUrl,
                ...(directory ? { directory } : {}),
              },
              env,
              baseUrlAuthority: 'canonical',
              ...(resource.transport
                ? { transport: resource.transport }
                : { fetchFn: params.fetchFn }),
              headers: resource.headers,
            });
            try {
              const statuses = await client.sessionStatusList({ signal: request.signal });
              for (const link of directoryLinks) {
                if (!Object.prototype.hasOwnProperty.call(statuses, link.remoteSessionId)) {
                  outcomes[link.index] = {
                    linkKey: link.linkKey,
                    facts: [{
                      kind: 'successful_empty',
                      evidenceClass: 'reconciliation',
                      observedAtMs,
                      expiresAtMs: observedAtMs + OBSERVATION_FACT_TTL_MS,
                      emptyTurnPhase: 'idle',
                    }],
                  };
                  continue;
                }
                const value = mapOpenCodeStatus(statuses[link.remoteSessionId]?.type);
                outcomes[link.index] = {
                  linkKey: link.linkKey,
                  facts: [
                    value
                      ? turnPhaseFact(value, 'reconciliation', observedAtMs)
                      : retrievalFailedFact(observedAtMs),
                  ],
                };
              }
            } finally {
              await client.dispose();
            }
          } catch {
            // This directory's prefilled failures do not poison other directory groups.
          }
        },
      ));

      return {
        purpose: 'observation_evidence',
        outcomes,
      };
    },
  });
}

export const openCodeExternalSessionObservationContribution =
  createOpenCodeExternalSessionObservationContribution();
