import { createHash } from 'node:crypto';

import type {
  AgentExternalSessionObservationContribution,
  AgentExternalSessionsResolvedIdentity,
  AgentExternalSessionObservationLinkEvidenceBatchV1,
  AgentExternalSessionObservationReconcileResultV1,
} from '@happier-dev/plugin-sdk/sessions/external';

import {
  type OpenCodeGlobalEvent,
  type OpenCodeGlobalEventDelivery,
  subscribeOpenCodeGlobalEvents,
} from '../../../runtime/server/openCodeServerClient.js';
import { asRecord, normalizeString } from '../../../runtime/server/openCodeParsing.js';
import {
  createOpenCodeExternalSessionClient,
  type OpenCodeExternalSessionSource,
  validateOpenCodeExternalSessionsSource,
} from './client.js';
import {
  createManagedEndpointFetch,
  MANAGED_ENDPOINT_TRANSPORT_BASE_URL,
} from './managedEndpointFetch.js';

const OBSERVATION_FACT_TTL_MS = 30_000;
const RESOURCE_KEY_PREFIX = 'opencode-resource-v2:';
const LINK_KEY_PREFIX = 'opencode-link-v1:';
const MAX_OPAQUE_KEY_LENGTH = 256;
const MANAGED_ENDPOINT_RESOURCE_MARKER = 'opencode-current-global-managed-endpoint-v1';

type SubscribeOpenCodeGlobalEvents = typeof subscribeOpenCodeGlobalEvents;
type ExternalAgentObservationLeafFact =
  AgentExternalSessionObservationLinkEvidenceBatchV1['items'][number]['facts'][number];
type NormalizedOpenCodeObservationSource =
  | Readonly<{
    mode: 'managed';
    directory: string | null;
  }>
  | Readonly<{
    mode: 'external';
    baseUrl: string;
    directory: string | null;
  }>;
type ResolvedOpenCodeObservationResource =
  | Readonly<{
    mode: 'managed';
    endpointIdentity: string;
  }>
  | Readonly<{
    mode: 'external';
    endpointIdentity: string;
  }>;

function normalizedSourceOrThrow(
  identity: AgentExternalSessionsResolvedIdentity,
  env: Readonly<Record<string, string | undefined>>,
): NormalizedOpenCodeObservationSource {
  if (identity.source.kind !== 'opencodeServer') {
    throw new Error('provider/source mismatch');
  }
  const source: OpenCodeExternalSessionSource = {
    ...identity.source,
    kind: 'opencodeServer',
  };
  const validation = validateOpenCodeExternalSessionsSource({
    source,
    env,
    baseUrlAuthority: 'canonical',
  });
  if (!validation.ok) {
    throw new Error(validation.error);
  }
  const directory = normalizeString(validation.source.directory) || null;
  if (validation.source.managedEndpoint === true) {
    if (normalizeString(validation.source.baseUrl)) {
      throw new Error('OpenCode observation source mode is ambiguous');
    }
    return { mode: 'managed', directory };
  }
  const baseUrl = normalizeString(validation.source.baseUrl);
  if (!baseUrl) {
    throw new Error('OpenCode observation requires an explicit external source baseUrl');
  }
  return { mode: 'external', baseUrl, directory };
}

function hashOpaqueIdentity(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('base64url');
}

function buildResourceKey(source: NormalizedOpenCodeObservationSource): string {
  const endpointIdentity = hashOpaqueIdentity(
    source.mode === 'managed'
      ? MANAGED_ENDPOINT_RESOURCE_MARKER
      : source.baseUrl,
  );
  const resourceKey = `${RESOURCE_KEY_PREFIX}${source.mode}:${endpointIdentity}`;
  if (resourceKey.length > MAX_OPAQUE_KEY_LENGTH) {
    throw new Error('OpenCode observation endpoint identity exceeds the bounded resource key');
  }
  return resourceKey;
}

function parseResourceKey(resourceKey: string): Readonly<{
  mode: 'managed' | 'external';
  endpointIdentity: string;
}> {
  if (!resourceKey.startsWith(RESOURCE_KEY_PREFIX)) {
    throw new Error('OpenCode observation resource key is invalid');
  }
  const remainder = resourceKey.slice(RESOURCE_KEY_PREFIX.length);
  const separator = remainder.indexOf(':');
  if (separator <= 0 || separator === remainder.length - 1) {
    throw new Error('OpenCode observation resource key is invalid');
  }
  const mode = remainder.slice(0, separator);
  const endpointIdentity = remainder.slice(separator + 1);
  if (
    (mode !== 'managed' && mode !== 'external')
    || !/^[A-Za-z0-9_-]{43}$/u.test(endpointIdentity)
  ) {
    throw new Error('OpenCode observation resource key is invalid');
  }
  return { mode, endpointIdentity };
}

function resolveResource(
  resourceKey: string,
): ResolvedOpenCodeObservationResource {
  const parsed = parseResourceKey(resourceKey);
  if (parsed.mode === 'managed') {
    const managedSource: NormalizedOpenCodeObservationSource = {
      mode: 'managed',
      directory: null,
    };
    if (buildResourceKey(managedSource) !== resourceKey) {
      throw new Error('OpenCode observation resource belongs to an unavailable managed endpoint');
    }
    return {
      mode: 'managed',
      endpointIdentity: parsed.endpointIdentity,
    };
  }
  return {
    mode: 'external',
    endpointIdentity: parsed.endpointIdentity,
  };
}

function resourceMatchesLinkedSource(
  resource: ResolvedOpenCodeObservationResource,
  linkedSource: NormalizedOpenCodeObservationSource,
): boolean {
  if (resource.mode === 'managed') {
    return linkedSource.mode === 'managed'
      && hashOpaqueIdentity(MANAGED_ENDPOINT_RESOURCE_MARKER)
      === resource.endpointIdentity;
  }
  if (linkedSource.mode !== 'external') return false;
  return hashOpaqueIdentity(linkedSource.baseUrl) === resource.endpointIdentity;
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
  return {
    resourceKey: buildResourceKey(source),
    linkKey: buildLinkKey(source.directory, request.remoteSessionId),
  };
}

export function createOpenCodeExternalSessionObservationContribution(params: Readonly<{
  env?: Readonly<Record<string, string | undefined>>;
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

    async observeResource(request) {
      const resource = resolveResource(request.resourceKey);
      const controller = new AbortController();
      const abort = () => controller.abort(request.signal.reason);
      if (request.signal.aborted) {
        abort();
      } else {
        request.signal.addEventListener('abort', abort, { once: true });
      }
      let disposed = false;
      void subscribeGlobalEvents({
        // Owned or attached, the endpoint lives with the managed service and
        // the host issues the request; observation holds no address and no
        // transport of its own.
        baseUrl: MANAGED_ENDPOINT_TRANSPORT_BASE_URL,
        fetch: createManagedEndpointFetch(request.managedEndpointRead),
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
          request.requestReconcile();
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
        let resource: ResolvedOpenCodeObservationResource | null;
        try {
          resource = resolveResource(request.resourceKey);
        } catch {
          resource = null;
        }
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
              !resourceMatchesLinkedSource(resource, linkedSource)
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
          AgentExternalSessionObservationReconcileResultV1,
          { purpose: 'observation_evidence' }
        >['outcomes'][number];
      const outcomes: ReconcileOutcome[] = request.links.map(({ linkKey }) => ({
        linkKey,
        facts: [retrievalFailedFact(observedAtMs)],
      }));
      let resource: ResolvedOpenCodeObservationResource;
      try {
        resource = resolveResource(request.resourceKey);
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
      type DirectoryGroup = Readonly<{
        source: OpenCodeExternalSessionSource;
        links: DirectoryLink[];
      }>;
      const linksByDirectory = new Map<string | null, DirectoryGroup>();
      for (const [index, link] of request.links.entries()) {
        try {
          const linkedSource = normalizedSourceOrThrow(link.linkedSource, env);
          const remoteSessionId = normalizeString(link.linkedSource.remoteSessionId);
          if (
            !resourceMatchesLinkedSource(resource, linkedSource)
            || !remoteSessionId
            || buildLinkKey(linkedSource.directory, remoteSessionId) !== link.linkKey
          ) {
            continue;
          }
          const directoryGroup = linksByDirectory.get(linkedSource.directory) ?? {
            source: linkedSource.mode === 'managed'
              ? {
                  kind: 'opencodeServer',
                  managedEndpoint: true,
                  ...(linkedSource.directory ? { directory: linkedSource.directory } : {}),
                }
              : {
                  kind: 'opencodeServer',
                  baseUrl: linkedSource.baseUrl,
                  ...(linkedSource.directory ? { directory: linkedSource.directory } : {}),
                },
            links: [],
          };
          directoryGroup.links.push({ index, linkKey: link.linkKey, remoteSessionId });
          linksByDirectory.set(linkedSource.directory, directoryGroup);
        } catch {
          // Invalid link identities remain isolated retrieval failures.
        }
      }

      await Promise.all([...linksByDirectory.entries()].map(
        async ([_directory, directoryGroup]) => {
          try {
            const client = await createOpenCodeExternalSessionClient({
              source: directoryGroup.source,
              env,
              baseUrlAuthority: 'canonical',
              managedEndpointRead: request.managedEndpointRead,
            });
            try {
              const statuses = await client.sessionStatusList({ signal: request.signal });
              for (const link of directoryGroup.links) {
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
