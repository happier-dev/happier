import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  AgentExternalSessionsManagedEndpointRead,
  AgentExternalSessionsResolvedIdentity,
  AgentExternalSessionObservationLinkEvidenceBatchV1,
} from '@happier-dev/plugin-sdk/sessions/external';
import type {
  OpenCodeGlobalEvent,
  OpenCodeGlobalEventDelivery,
} from '../../../runtime/server/openCodeServerClient.js';
import { createOpenCodeExternalSessionsContribution } from './contribution.js';
import { createOpenCodeExternalSessionObservationContribution } from './observation.js';

function linkedSource(
  remoteSessionId: string,
  baseUrl = 'http://127.0.0.1:49196/',
  directory = '/tmp/project',
): AgentExternalSessionsResolvedIdentity {
  return {
    source: {
      kind: 'opencodeServer',
      baseUrl,
      directory,
    },
    remoteSessionId,
    linkData: {},
  };
}

function linkedManagedSource(
  remoteSessionId: string,
  directory = '/tmp/project',
): AgentExternalSessionsResolvedIdentity {
  return {
    source: {
      kind: 'opencodeServer',
      managedEndpoint: true,
      directory,
    },
    remoteSessionId,
    linkData: {},
  };
}

const unavailableManagedEndpointRead: AgentExternalSessionsManagedEndpointRead = async () => {
  throw new Error('Managed endpoint read is unavailable');
};

const liveReadByBaseUrl = new Map<string, AgentExternalSessionsManagedEndpointRead>();

async function registerCredential(
  baseUrl: string,
  _secret: string,
  fetchImpl: (input: string | URL, init?: RequestInit) => Promise<Response> =
    async () => new Response('{}'),
  mode: 'managedSpawn' | 'externalAttach' = 'managedSpawn',
): Promise<Readonly<{
  managedEndpointRead: AgentExternalSessionsManagedEndpointRead;
  dispose(): void;
}>> {
  const normalizedBaseUrl = baseUrl.replace(/\/+$/u, '');
  const managedEndpointRead = vi.fn<AgentExternalSessionsManagedEndpointRead>(async (request) => {
    if (liveReadByBaseUrl.get(normalizedBaseUrl) !== managedEndpointRead) {
      throw new Error('Managed endpoint read is unavailable or stale');
    }
    const response = await fetchImpl(
      new URL(request.pathAndQuery, `${normalizedBaseUrl}/`),
      {
        method: 'GET',
        ...(request.headers ? { headers: request.headers } : {}),
      },
    );
    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      headers: Object.fromEntries(response.headers.entries()),
      body: response.body,
    };
  });
  liveReadByBaseUrl.set(normalizedBaseUrl, managedEndpointRead);
  return Object.freeze({
    managedEndpointRead,
    dispose() {
      if (liveReadByBaseUrl.get(normalizedBaseUrl) === managedEndpointRead) {
        liveReadByBaseUrl.delete(normalizedBaseUrl);
      }
    },
  });
}

describe('OpenCode External Session observation', () => {
  afterEach(() => {
    liveReadByBaseUrl.clear();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('resolves a managed source without persisting endpoint authority in its observation keys', async () => {
    const baseUrl = 'http://127.0.0.1:49196';
    const registration = await registerCredential(baseUrl, 'managed-source');
    const externalSessions = createOpenCodeExternalSessionsContribution({ env: {} });

    const resolvedSource = await externalSessions.resolveSource({
      source: { kind: 'opencodeServer' },
      signal: new AbortController().signal,
      deadlineAtMs: Date.now() + 10_000,
      maxSerializedBytes: 100_000,
      managedEndpointRead: registration.managedEndpointRead,
    });
    expect(resolvedSource).toEqual({
      ok: true,
      value: {
        source: {
          kind: 'opencodeServer',
          managedEndpoint: true,
        },
      },
    });
    if (!resolvedSource.ok) throw new Error('Expected a managed OpenCode source');

    const observation = createOpenCodeExternalSessionObservationContribution({
      env: { HAPPIER_OPENCODE_SERVER_URL: baseUrl },
    });
    const descriptor = observation.describeResource({
      source: resolvedSource.value.source,
      remoteSessionId: 'ses-managed',
      linkData: {},
    });

    expect(descriptor.resourceKey).toMatch(
      /^opencode-resource-v2:managed:[A-Za-z0-9_-]{43}$/u,
    );
    expect(descriptor.resourceKey.length).toBeLessThanOrEqual(256);
    expect(descriptor.linkKey.length).toBeLessThanOrEqual(256);
    expect(JSON.stringify(descriptor)).not.toContain(baseUrl);
    expect(JSON.stringify(descriptor)).not.toContain('managed-source');
    expect(JSON.stringify(descriptor)).not.toContain('/tmp/');
    expect(registration.managedEndpointRead).not.toHaveBeenCalled();

    registration.dispose();
  });

  it('keeps an explicitly configured external attach source unmarked and direct through observation', async () => {
    const baseUrl = 'http://127.0.0.1:49198';
    const directFetch = vi.fn(async () => new Response(JSON.stringify({
      'ses-external-attach': { type: 'busy' },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    const bypassFetch = vi.fn();
    vi.stubGlobal('fetch', bypassFetch);
    const registration = await registerCredential(
      baseUrl,
      'external-attach',
      directFetch,
      'externalAttach',
    );
    const externalSessions = createOpenCodeExternalSessionsContribution({ env: {} });
    const invocation = {
      signal: new AbortController().signal,
      deadlineAtMs: Date.now() + 10_000,
      maxSerializedBytes: 100_000,
      managedEndpointRead: registration.managedEndpointRead,
    };

    const resolvedSource = await externalSessions.resolveSource({
      source: { kind: 'opencodeServer', baseUrl, directory: '/tmp/external-attach' },
      ...invocation,
    });
    expect(resolvedSource).toEqual({
      ok: true,
      value: {
        source: {
          kind: 'opencodeServer',
          baseUrl,
          directory: '/tmp/external-attach',
        },
      },
    });
    if (!resolvedSource.ok) throw new Error('Expected a configured external source');

    const resolvedLink = await externalSessions.resolveLinkedIdentity({
      source: resolvedSource.value.source,
      remoteSessionId: 'ses-external-attach',
      linkData: {},
      ...invocation,
    });
    if (!resolvedLink.ok) throw new Error('Expected a configured external link');
    const observation = createOpenCodeExternalSessionObservationContribution({
      env: {},
      now: () => 3_000,
    });
    const descriptor = observation.describeResource(resolvedLink.value);
    expect(descriptor.resourceKey).toMatch(/^opencode-resource-v2:external:/u);
    const links = [{
      linkKey: descriptor.linkKey,
      linkedSource: resolvedLink.value,
    }];
    await expect(observation.reconcileResource({
      purpose: 'resource_descriptors',
      resourceKey: descriptor.resourceKey,
      links,
      signal: invocation.signal,
      managedEndpointRead: registration.managedEndpointRead,
    })).resolves.toEqual({
      purpose: 'resource_descriptors',
      outcomes: [{
        kind: 'described',
        descriptor: {
          ...descriptor,
          changeObservation: 'observe_resource',
        },
      }],
    });
    await expect(observation.reconcileResource({
      purpose: 'observation_evidence',
      resourceKey: descriptor.resourceKey,
      links,
      signal: invocation.signal,
      managedEndpointRead: registration.managedEndpointRead,
    })).resolves.toEqual({
      purpose: 'observation_evidence',
      outcomes: [{
        linkKey: descriptor.linkKey,
        facts: [{
          kind: 'turn_phase',
          evidenceClass: 'reconciliation',
          observedAtMs: 3_000,
          expiresAtMs: 33_000,
          value: 'working',
        }],
      }],
    });
    // The attached server is read through the managed endpoint the host owns;
    // nothing bypasses it onto an ambient fetch.
    expect(directFetch).toHaveBeenCalledOnce();
    expect(registration.managedEndpointRead).toHaveBeenCalled();
    expect(bypassFetch).not.toHaveBeenCalled();

    registration.dispose();
  });

  it('adapts managed global-event observation to relative contextual reads without caller auth or global fetch', async () => {
    const directFetch = vi.fn();
    vi.stubGlobal('fetch', directFetch);
    const managedEndpointRead = vi.fn<AgentExternalSessionsManagedEndpointRead>(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'text/event-stream' },
      body: new Response(
        'data: {"payload":{"type":"server.connected","properties":{}}}\n\n',
      ).body,
    }));
    const requestReconcile = vi.fn();
    const contribution = createOpenCodeExternalSessionObservationContribution();
    const descriptor = contribution.describeResource(
      linkedManagedSource('ses-managed-observe'),
    );
    const disposable = await contribution.observeResource({
      resourceKey: descriptor.resourceKey,
      signal: new AbortController().signal,
      managedEndpointRead,
      emit() {},
      requestReconcile,
      requestTranscriptRefresh() {},
    });

    await vi.waitFor(() => expect(managedEndpointRead).toHaveBeenCalledOnce());
    expect(managedEndpointRead).toHaveBeenCalledWith({
      pathAndQuery: '/global/event',
    });
    await vi.waitFor(() => expect(requestReconcile).toHaveBeenCalled());
    expect(directFetch).not.toHaveBeenCalled();

    await disposable.dispose();
  });

  it('cancels an in-flight managed global-event read when observation is disposed', async () => {
    const managedEndpointRead = vi.fn<AgentExternalSessionsManagedEndpointRead>(
      async () => await new Promise<never>(() => undefined),
    );
    const adapterSettled = vi.fn();
    const requestReconcile = vi.fn();
    const contribution = createOpenCodeExternalSessionObservationContribution({
      subscribeGlobalEvents: async (params) => {
        if (!params.fetch) throw new Error('Expected a contextual managed fetch adapter');
        try {
          await params.fetch(new URL('/global/event', params.baseUrl), {
            method: 'GET',
            signal: params.signal,
          });
        } finally {
          adapterSettled();
        }
      },
    });
    const descriptor = contribution.describeResource(
      linkedManagedSource('ses-managed-cancel'),
    );
    const disposable = await contribution.observeResource({
      resourceKey: descriptor.resourceKey,
      signal: new AbortController().signal,
      managedEndpointRead,
      emit() {},
      requestReconcile,
      requestTranscriptRefresh() {},
    });
    await vi.waitFor(() => expect(managedEndpointRead).toHaveBeenCalledOnce());

    await disposable.dispose();

    await vi.waitFor(() => expect(adapterSettled).toHaveBeenCalledOnce());
    expect(requestReconcile).not.toHaveBeenCalled();
  });

  it('reconciles managed links through the invocation-scoped endpoint reader only', async () => {
    const directFetch = vi.fn();
    vi.stubGlobal('fetch', directFetch);
    const managedEndpointRead = vi.fn<AgentExternalSessionsManagedEndpointRead>(
      async ({ pathAndQuery }) => {
        expect(pathAndQuery).toBe(
          '/session/status?directory=%2Ftmp%2Fmanaged-project',
        );
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          headers: { 'content-type': 'application/json' },
          body: new Response(JSON.stringify({
            'ses-managed-reconcile': { type: 'busy' },
          })).body,
        };
      },
    );
    const contribution = createOpenCodeExternalSessionObservationContribution({
      now: () => 4_000,
    });
    const linked = linkedManagedSource(
      'ses-managed-reconcile',
      '/tmp/managed-project',
    );
    const descriptor = contribution.describeResource(linked);
    const links = [{
      linkKey: descriptor.linkKey,
      linkedSource: linked,
    }];

    await expect(contribution.reconcileResource({
      purpose: 'resource_descriptors',
      resourceKey: descriptor.resourceKey,
      links,
      signal: new AbortController().signal,
      managedEndpointRead,
    })).resolves.toEqual({
      purpose: 'resource_descriptors',
      outcomes: [{
        kind: 'described',
        descriptor: {
          ...descriptor,
          changeObservation: 'observe_resource',
        },
      }],
    });
    await expect(contribution.reconcileResource({
      purpose: 'observation_evidence',
      resourceKey: descriptor.resourceKey,
      links,
      signal: new AbortController().signal,
      managedEndpointRead,
    })).resolves.toEqual({
      purpose: 'observation_evidence',
      outcomes: [{
        linkKey: descriptor.linkKey,
        facts: [{
          kind: 'turn_phase',
          evidenceClass: 'reconciliation',
          observedAtMs: 4_000,
          expiresAtMs: 34_000,
          value: 'working',
        }],
      }],
    });
    expect(managedEndpointRead).toHaveBeenCalledOnce();
    expect(directFetch).not.toHaveBeenCalled();
  });

  it('fails managed observation honestly when its contextual reader is unavailable or stale', async () => {
    const directFetch = vi.fn();
    vi.stubGlobal('fetch', directFetch);
    const requestReconcile = vi.fn();
    const contribution = createOpenCodeExternalSessionObservationContribution({
      now: () => 5_000,
    });
    const linked = linkedManagedSource('ses-stale');
    const descriptor = contribution.describeResource(linked);
    const disposable = await contribution.observeResource({
      resourceKey: descriptor.resourceKey,
      signal: new AbortController().signal,
      managedEndpointRead: unavailableManagedEndpointRead,
      emit() {},
      requestReconcile,
      requestTranscriptRefresh() {},
    });

    await vi.waitFor(() => expect(requestReconcile).toHaveBeenCalledOnce());
    await expect(contribution.reconcileResource({
      purpose: 'observation_evidence',
      resourceKey: descriptor.resourceKey,
      links: [{ linkKey: descriptor.linkKey, linkedSource: linked }],
      signal: new AbortController().signal,
      managedEndpointRead: unavailableManagedEndpointRead,
    })).resolves.toEqual({
      purpose: 'observation_evidence',
      outcomes: [{
        linkKey: descriptor.linkKey,
        facts: [{
          kind: 'retrieval_failed',
          evidenceClass: 'reconciliation',
          observedAtMs: 5_000,
          axis: 'turn_phase',
        }],
      }],
    });
    expect(directFetch).not.toHaveBeenCalled();

    await disposable.dispose();
  });

  it('groups stable base-URL resources and obtains exact access during reconciliation', async () => {
    const firstCredential = await registerCredential('http://127.0.0.1:49196', 'first-secret');
    const contribution = createOpenCodeExternalSessionObservationContribution({ env: {} });
    const first = contribution.describeResource(linkedSource('ses-shared'));
    const sameResource = contribution.describeResource(
      linkedSource('ses-shared', 'http://127.0.0.1:49196', '/tmp/other-project'),
    );
    firstCredential.dispose();
    const secondCredential = await registerCredential('http://127.0.0.1:49196/', 'second-secret');
    const replacement = contribution.describeResource(linkedSource('ses-shared'));

    expect(first.resourceKey).toBe(sameResource.resourceKey);
    expect(first.linkKey).not.toBe(sameResource.linkKey);
    expect(Object.keys(first).sort()).toEqual(['linkKey', 'resourceKey']);
    await expect(contribution.reconcileResource({
      purpose: 'resource_descriptors',
      resourceKey: replacement.resourceKey,
      links: [{
        linkKey: replacement.linkKey,
        linkedSource: linkedSource('ses-shared'),
      }],
      signal: new AbortController().signal,
      managedEndpointRead: secondCredential.managedEndpointRead,
    })).resolves.toEqual({
      purpose: 'resource_descriptors',
      outcomes: [{
        kind: 'described',
        descriptor: {
          ...replacement,
          changeObservation: 'observe_resource',
        },
      }],
    });
    expect(replacement.resourceKey).toBe(first.resourceKey);
    expect(replacement.linkKey).toBe(first.linkKey);
    expect(first.resourceKey).toMatch(
      /^opencode-resource-v2:external:[A-Za-z0-9_-]{43}$/u,
    );
    expect(first.resourceKey.length).toBeLessThanOrEqual(256);
    expect(first.linkKey.length).toBeLessThanOrEqual(256);
    expect(JSON.stringify([first, sameResource, replacement])).not.toContain('secret');
    expect(JSON.stringify([first, sameResource, replacement])).not.toContain('/tmp/');
    await expect(contribution.observeResource({
      resourceKey: first.resourceKey.replace(
        /^opencode-resource-v2:external:/u,
        'opencode-resource-v2:external:invalid-',
      ),
      signal: new AbortController().signal,
      managedEndpointRead: secondCredential.managedEndpointRead,
      emit() {},
      requestReconcile() {},
      requestTranscriptRefresh() {},
    })).rejects.toThrow(/resource key is invalid|resource identity is unavailable/u);

    secondCredential.dispose();
  });

  it('rejects ambiguous sources and isolates resource/link mode mismatches', async () => {
    const baseUrl = 'http://127.0.0.1:49196';
    const contribution = createOpenCodeExternalSessionObservationContribution({
      env: { HAPPIER_OPENCODE_SERVER_URL: baseUrl },
    });
    expect(() => contribution.describeResource({
      source: {
        kind: 'opencodeServer',
        baseUrl,
        managedEndpoint: true,
      },
      remoteSessionId: 'ses-ambiguous',
      linkData: {},
    })).toThrow(/ambiguous|baseUrl.*managed|managed.*baseUrl|source mode/u);

    const managed = linkedManagedSource('ses-mode');
    const managedDescriptor = contribution.describeResource(managed);
    const external = linkedSource('ses-mode', baseUrl);
    const externalDescriptor = contribution.describeResource(external);
    const signal = new AbortController().signal;

    await expect(contribution.reconcileResource({
      purpose: 'resource_descriptors',
      resourceKey: managedDescriptor.resourceKey,
      links: [{
        linkKey: externalDescriptor.linkKey,
        linkedSource: external,
      }],
      signal,
      managedEndpointRead: unavailableManagedEndpointRead,
    })).resolves.toEqual({
      purpose: 'resource_descriptors',
      outcomes: [{
        kind: 'unavailable',
        linkKey: externalDescriptor.linkKey,
      }],
    });
    await expect(contribution.reconcileResource({
      purpose: 'resource_descriptors',
      resourceKey: externalDescriptor.resourceKey,
      links: [{
        linkKey: managedDescriptor.linkKey,
        linkedSource: managed,
      }],
      signal,
      managedEndpointRead: unavailableManagedEndpointRead,
    })).resolves.toEqual({
      purpose: 'resource_descriptors',
      outcomes: [{
        kind: 'unavailable',
        linkKey: managedDescriptor.linkKey,
      }],
    });
  });

  it('routes correlated transcript events and reconciles untrusted global status events', async () => {
    const credential = await registerCredential('http://127.0.0.1:49196', 'observer-secret');
    let onEvent:
      | ((event: OpenCodeGlobalEvent, delivery: OpenCodeGlobalEventDelivery) => void)
      | undefined;
    let onUnavailable: ((error: unknown) => void) | undefined;
    let subscribedSignal: AbortSignal | undefined;
    const subscribeGlobalEvents = vi.fn(async (params: Readonly<{
      baseUrl: string;
      headers?: Readonly<Record<string, string>>;
      signal: AbortSignal;
      onEvent: (event: OpenCodeGlobalEvent, delivery: OpenCodeGlobalEventDelivery) => void;
      onUnavailable?: (error: unknown) => void;
    }>) => {
      onEvent = params.onEvent;
      onUnavailable = params.onUnavailable;
      subscribedSignal = params.signal;
      await new Promise<void>(() => undefined);
    });
    const contribution = createOpenCodeExternalSessionObservationContribution({
      env: { HAPPIER_OPENCODE_SERVER_URL: 'http://127.0.0.1:49196' },
      now: () => 1_000,
      subscribeGlobalEvents,
    });
    const first = contribution.describeResource(linkedSource('ses-shared'));
    const otherDirectory = contribution.describeResource(
      linkedSource('ses-shared', 'http://127.0.0.1:49196', '/tmp/other-project'),
    );
    const emit = vi.fn<(batch: AgentExternalSessionObservationLinkEvidenceBatchV1) => void>();
    const requestReconcile = vi.fn();
    const requestTranscriptRefresh = vi.fn();
    const disposable = await contribution.observeResource({
      resourceKey: first.resourceKey,
      signal: new AbortController().signal,
      managedEndpointRead: credential.managedEndpointRead,
      emit,
      requestReconcile,
      requestTranscriptRefresh,
    });
    await vi.waitFor(() => expect(subscribeGlobalEvents).toHaveBeenCalledOnce());

    // Global-event streaming rides the same host managed endpoint as every
    // other read, so the transport carries the sentinel origin rather than the
    // server address.
    expect(subscribeGlobalEvents).toHaveBeenCalledWith(expect.objectContaining({
      baseUrl: 'http://opencode-managed.invalid',
      fetch: expect.any(Function),
    }));
    onEvent?.(
      { payload: { type: 'server.connected', properties: {} } },
      { provenance: 'connection-boundary', connectionGeneration: 1 },
    );
    onEvent?.(
      {
        directory: '/tmp/project',
        payload: {
          type: 'message.updated',
          properties: { info: { sessionID: 'ses-shared' } },
        },
      },
      { provenance: 'untrusted-observation', connectionGeneration: 1 },
    );
    onEvent?.(
      {
        directory: '/tmp/other-project',
        payload: {
          type: 'message.part.updated',
          properties: { part: { sessionID: 'ses-shared' } },
        },
      },
      { provenance: 'untrusted-observation', connectionGeneration: 1 },
    );
    expect(requestTranscriptRefresh.mock.calls).toEqual([
      [first.linkKey],
      [otherDirectory.linkKey],
    ]);
    onEvent?.(
      {
        payload: {
          type: 'message.updated',
          properties: { info: { sessionID: 'ses-shared' } },
        },
      },
      { provenance: 'untrusted-observation', connectionGeneration: 1 },
    );
    expect(requestReconcile).toHaveBeenCalledTimes(2);
    expect(requestTranscriptRefresh).toHaveBeenCalledTimes(2);
    onEvent?.(
      {
        directory: '/tmp/project',
        payload: {
          type: 'session.status',
          properties: { sessionID: 'ses-shared', status: { type: 'busy' } },
        },
      },
      { provenance: 'untrusted-observation', connectionGeneration: 1 },
    );
    expect(requestReconcile).toHaveBeenCalledTimes(3);
    onEvent?.(
      {
        directory: '/tmp/project',
        payload: {
          type: 'session.error',
          properties: { sessionID: 'ses-shared' },
        },
      },
      { provenance: 'untrusted-observation', connectionGeneration: 1 },
    );
    expect(requestReconcile).toHaveBeenCalledTimes(4);
    onUnavailable?.(new TypeError('stream unavailable'));
    expect(requestReconcile).toHaveBeenCalledTimes(5);
    expect(emit).not.toHaveBeenCalled();
    expect(JSON.stringify(emit.mock.calls)).not.toContain('ses-shared');
    expect(JSON.stringify(emit.mock.calls)).not.toContain('observer-secret');

    await disposable.dispose();
    expect(subscribedSignal?.aborted).toBe(true);
    await disposable.dispose();
    expect(subscribedSignal?.aborted).toBe(true);
    credential.dispose();
  });

  it('keeps external observation independent from managed endpoint reader replacement', async () => {
    const baseUrl = 'http://127.0.0.1:49196';
    const firstNetworkFetch = vi.fn(async () => new Response('{}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    const firstRegistration = await registerCredential(
      baseUrl,
      'first-observer-secret',
      firstNetworkFetch,
    );
    const subscribeGlobalEvents = vi.fn(async () => undefined);
    const contribution = createOpenCodeExternalSessionObservationContribution({
      env: { HAPPIER_OPENCODE_SERVER_URL: baseUrl },
      subscribeGlobalEvents: subscribeGlobalEvents as never,
    });
    const descriptor = contribution.describeResource(
      linkedSource('same-port-session', baseUrl),
    );

    const secondNetworkFetch = vi.fn(async () => new Response('{}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    const secondRegistration = await registerCredential(
      baseUrl,
      'second-observer-secret',
      secondNetworkFetch,
    );
    firstRegistration.dispose();

    const disposable = await contribution.observeResource({
      resourceKey: descriptor.resourceKey,
      signal: new AbortController().signal,
      managedEndpointRead: secondRegistration.managedEndpointRead,
      emit() {},
      requestReconcile() {},
      requestTranscriptRefresh() {},
    });
    await vi.waitFor(() => expect(subscribeGlobalEvents).toHaveBeenCalledOnce());

    expect(firstNetworkFetch).not.toHaveBeenCalled();
    expect(secondNetworkFetch).not.toHaveBeenCalled();
    expect(secondRegistration.managedEndpointRead).not.toHaveBeenCalled();

    await disposable.dispose();
    secondRegistration.dispose();
  });

  it('canonicalizes a default link directory while reconciling its untrusted status event', async () => {
    const baseUrl = 'http://127.0.0.1:49196';
    const managedFetch = vi.fn(async (input: string | URL) => {
      const url = new URL(input);
      if (url.pathname === '/session/status') {
        return new Response('{}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      expect(url.pathname).toBe('/session/ses-default');
      expect(url.searchParams.has('directory')).toBe(false);
      return new Response(JSON.stringify({
        id: 'ses-default',
        directory: '/tmp/default-project',
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const credential = await registerCredential(
      baseUrl,
      'default-link-secret',
      managedFetch,
    );
    vi.stubGlobal('fetch', managedFetch);
    const externalSessions = createOpenCodeExternalSessionsContribution({
      env: { HAPPIER_OPENCODE_SERVER_URL: baseUrl },
    });
    const linked = await externalSessions.resolveLinkIdentity({
      source: {
        kind: 'opencodeServer',
        baseUrl,
      },
      remoteSessionId: 'ses-default',
      signal: new AbortController().signal,
      deadlineAtMs: Date.now() + 10_000,
      maxSerializedBytes: 100_000,
      managedEndpointRead: credential.managedEndpointRead,
    });
    expect(linked).toMatchObject({
      ok: true,
      value: {
        source: {
          kind: 'opencodeServer',
          baseUrl,
          directory: '/tmp/default-project',
        },
        remoteSessionId: 'ses-default',
      },
    });
    if (!linked.ok) throw new Error('Expected a canonical default OpenCode link');

    let onEvent:
      | ((event: OpenCodeGlobalEvent, delivery: OpenCodeGlobalEventDelivery) => void)
      | undefined;
    const observation = createOpenCodeExternalSessionObservationContribution({
      env: { HAPPIER_OPENCODE_SERVER_URL: baseUrl },
      now: () => 1_000,
      subscribeGlobalEvents: async (params) => {
        onEvent = params.onEvent;
        await new Promise<void>(() => undefined);
      },
    });
    const descriptor = observation.describeResource(linked.value);
    const otherDirectory = observation.describeResource({
      ...linked.value,
      source: {
        ...linked.value.source,
        directory: '/tmp/other-project',
      },
    });
    const emit = vi.fn<(batch: AgentExternalSessionObservationLinkEvidenceBatchV1) => void>();
    const requestReconcile = vi.fn();
    const disposable = await observation.observeResource({
      resourceKey: descriptor.resourceKey,
      signal: new AbortController().signal,
      managedEndpointRead: credential.managedEndpointRead,
      emit,
      requestReconcile,
      requestTranscriptRefresh() {},
    });
    await vi.waitFor(() => expect(onEvent).toBeTypeOf('function'));

    onEvent?.({
      directory: '/tmp/default-project',
      payload: {
        type: 'session.status',
        properties: {
          sessionID: 'ses-default',
          status: { type: 'busy' },
        },
      },
    }, {
      provenance: 'untrusted-observation',
      connectionGeneration: 1,
    });

    expect(descriptor.linkKey).not.toBe(otherDirectory.linkKey);
    expect(requestReconcile).toHaveBeenCalledOnce();
    expect(emit).not.toHaveBeenCalled();

    await disposable.dispose();
    credential.dispose();
  });

  it('keeps long configured endpoint identities compact without a plugin-side resource registry', async () => {
    const baseUrl = `https://opencode.example.test/${'long-endpoint-segment/'.repeat(40)}`;
    let observedBaseUrl: string | undefined;
    const contribution = createOpenCodeExternalSessionObservationContribution({
      env: { HAPPIER_OPENCODE_SERVER_URL: baseUrl },
      subscribeGlobalEvents: async (params) => {
        observedBaseUrl = params.baseUrl;
        await new Promise<void>(() => undefined);
      },
    });
    const descriptor = contribution.describeResource(
      linkedSource('ses-long-endpoint', baseUrl, '/tmp/project'),
    );

    expect(baseUrl.length).toBeGreaterThan(256);
    expect(descriptor.resourceKey.length).toBeLessThanOrEqual(256);
    expect(descriptor.resourceKey).not.toContain(baseUrl);

    const disposable = await contribution.observeResource({
      resourceKey: descriptor.resourceKey,
      signal: new AbortController().signal,
      managedEndpointRead: unavailableManagedEndpointRead,
      emit() {},
      requestReconcile() {},
      requestTranscriptRefresh() {},
    });
    // The long configured address never reaches the transport: the managed
    // endpoint holds it, and observation streams through the sentinel origin.
    await vi.waitFor(() => expect(observedBaseUrl).toBe('http://opencode-managed.invalid'));
    await disposable.dispose();
  });

  it('reconciles each unique directory once with exact ordered outcomes and isolated failures', async () => {
    const fetchFn = vi.fn(async (input: string | URL) => {
      const directory = new URL(input).searchParams.get('directory');
      if (directory === null) {
        return new Response('{}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (directory === '/tmp/project-a') {
        return new Response(JSON.stringify({
          'ses-shared': { type: 'busy' },
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (directory === '/tmp/project-b') {
        throw new Error('project-b status unavailable');
      }
      throw new Error(`unexpected directory: ${directory ?? '<default>'}`);
    });
    const credential = await registerCredential(
      'http://127.0.0.1:49196',
      'status-secret',
      fetchFn,
    );
    const contribution = createOpenCodeExternalSessionObservationContribution({
      env: { HAPPIER_OPENCODE_SERVER_URL: 'http://127.0.0.1:49196' },
      now: () => 2_000,
    });
    const projectABusySource = linkedSource(
      'ses-shared',
      'http://127.0.0.1:49196',
      '/tmp/project-a',
    );
    const projectBBusySource = linkedSource(
      'ses-shared',
      'http://127.0.0.1:49196',
      '/tmp/project-b',
    );
    const projectAAbsentSource = linkedSource(
      'ses-absent',
      'http://127.0.0.1:49196',
      '/tmp/project-a',
    );
    const projectABusy = contribution.describeResource(projectABusySource);
    const projectBBusy = contribution.describeResource(projectBBusySource);
    const projectAAbsent = contribution.describeResource(projectAAbsentSource);

    await expect(contribution.reconcileResource({
      purpose: 'resource_descriptors',
      resourceKey: projectABusy.resourceKey,
      links: [
        { linkKey: projectBBusy.linkKey, linkedSource: projectBBusySource },
        { linkKey: projectABusy.linkKey, linkedSource: projectABusySource },
        { linkKey: projectAAbsent.linkKey, linkedSource: projectAAbsentSource },
      ],
      signal: new AbortController().signal,
      managedEndpointRead: credential.managedEndpointRead,
    })).resolves.toEqual({
      purpose: 'resource_descriptors',
      outcomes: [
        {
          kind: 'described',
          descriptor: {
            ...projectBBusy,
            changeObservation: 'observe_resource',
          },
        },
        {
          kind: 'described',
          descriptor: {
            ...projectABusy,
            changeObservation: 'observe_resource',
          },
        },
        {
          kind: 'described',
          descriptor: {
            ...projectAAbsent,
            changeObservation: 'observe_resource',
          },
        },
      ],
    });
    expect(fetchFn).not.toHaveBeenCalled();

    await expect(contribution.reconcileResource({
      purpose: 'observation_evidence',
      resourceKey: projectABusy.resourceKey,
      links: [
        { linkKey: projectABusy.linkKey, linkedSource: projectABusySource },
        { linkKey: projectBBusy.linkKey, linkedSource: projectBBusySource },
        { linkKey: projectAAbsent.linkKey, linkedSource: projectAAbsentSource },
      ],
      signal: new AbortController().signal,
      managedEndpointRead: credential.managedEndpointRead,
    })).resolves.toEqual({
      purpose: 'observation_evidence',
      outcomes: [
        {
          linkKey: projectABusy.linkKey,
          facts: [{
            kind: 'turn_phase',
            evidenceClass: 'reconciliation',
            observedAtMs: 2_000,
            expiresAtMs: 32_000,
            value: 'working',
          }],
        },
        {
          linkKey: projectBBusy.linkKey,
          facts: [{
            kind: 'retrieval_failed',
            evidenceClass: 'reconciliation',
            observedAtMs: 2_000,
            axis: 'turn_phase',
          }],
        },
        {
          linkKey: projectAAbsent.linkKey,
          facts: [{
            kind: 'successful_empty',
            evidenceClass: 'reconciliation',
            observedAtMs: 2_000,
            expiresAtMs: 32_000,
            emptyTurnPhase: 'idle',
          }],
        },
      ],
    });

    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(fetchFn.mock.calls.map(([input]) => String(input)).sort()).toEqual([
      'http://127.0.0.1:49196/session/status?directory=%2Ftmp%2Fproject-a',
      'http://127.0.0.1:49196/session/status?directory=%2Ftmp%2Fproject-b',
    ]);
    for (const [, init] of fetchFn.mock.calls) {
      expect(init).toEqual(expect.objectContaining({
        method: 'GET',
      }));
      expect(new Headers(init?.headers).get('authorization')).toBeNull();
    }
    await expect(contribution.reconcileResource({
      purpose: 'observation_evidence',
      resourceKey: projectABusy.resourceKey,
      links: [],
      signal: new AbortController().signal,
      managedEndpointRead: credential.managedEndpointRead,
    })).rejects.toThrow(/requires at least one current link/u);
    credential.dispose();
  });
});
