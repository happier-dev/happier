import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  AgentExternalSessionsResolvedIdentity,
  ExternalAgentObservationLinkEvidenceBatchV1,
} from '@happier-dev/plugin-sdk/experimental/sessions';

import {
  OPENCODE_SERVER_PASSWORD_ENV_KEY,
  readOpenCodeManagedServerTransport,
  registerOpenCodeManagedServerEndpoint,
} from '../../../runtime/server/endpoint.js';
import type {
  OpenCodeGlobalEvent,
  OpenCodeGlobalEventDelivery,
} from '../../../runtime/server/openCodeServerClient.js';
import { createOpenCodeServerTransport } from '../../../runtime/server/transport.js';
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

function registerCredential(
  baseUrl: string,
  secret: string,
  fetchImpl: (input: string | URL, init?: RequestInit) => Promise<Response> =
    async () => new Response('{}'),
) {
  const credential = {
    envKey: OPENCODE_SERVER_PASSWORD_ENV_KEY,
    value: secret,
    headers: {
      authorization: `Basic ${secret}`,
    },
  } as const;
  return registerOpenCodeManagedServerEndpoint({
    baseUrl,
    credential,
    transport: createOpenCodeServerTransport({
      baseUrl,
      instanceId: `instance-${secret}`,
      headers: credential.headers,
      readManagedServerSnapshot: () => ({
        instanceId: `instance-${secret}`,
        state: 'healthy',
        baseUrl,
      }),
      fetchImpl,
    }),
  });
}

describe('OpenCode External Session observation', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('groups endpoint/auth-generation resources and obtains observation authority from reconciliation', async () => {
    const firstCredential = registerCredential('http://127.0.0.1:49196', 'first-secret');
    const contribution = createOpenCodeExternalSessionObservationContribution();
    const first = contribution.describeResource(linkedSource('ses-shared'));
    const sameResource = contribution.describeResource(
      linkedSource('ses-shared', 'http://127.0.0.1:49196', '/tmp/other-project'),
    );
    firstCredential.dispose();
    const secondCredential = registerCredential('http://127.0.0.1:49196/', 'second-secret');
    const nextGeneration = contribution.describeResource(linkedSource('ses-shared'));

    expect(first.resourceKey).toBe(sameResource.resourceKey);
    expect(first.linkKey).not.toBe(sameResource.linkKey);
    expect(Object.keys(first).sort()).toEqual(['linkKey', 'resourceKey']);
    await expect(contribution.reconcileResource({
      purpose: 'resource_descriptors',
      resourceKey: nextGeneration.resourceKey,
      links: [{
        linkKey: nextGeneration.linkKey,
        linkedSource: linkedSource('ses-shared'),
      }],
      signal: new AbortController().signal,
    })).resolves.toEqual({
      purpose: 'resource_descriptors',
      outcomes: [{
        kind: 'described',
        descriptor: {
          ...nextGeneration,
          changeObservation: 'observe_resource',
        },
      }],
    });
    expect(nextGeneration.resourceKey).not.toBe(first.resourceKey);
    expect(nextGeneration.linkKey).toBe(first.linkKey);
    expect(first.resourceKey.length).toBeLessThanOrEqual(256);
    expect(first.linkKey.length).toBeLessThanOrEqual(256);
    expect(JSON.stringify([first, sameResource, nextGeneration])).not.toContain('secret');
    expect(JSON.stringify([first, sameResource, nextGeneration])).not.toContain('/tmp/');
    expect(() => contribution.observeResource({
      resourceKey: first.resourceKey,
      signal: new AbortController().signal,
      emit() {},
      requestReconcile() {},
      requestTranscriptRefresh() {},
    })).toThrow(/stale endpoint generation/u);
    expect(() => contribution.observeResource({
      resourceKey: first.resourceKey.replace(
        /^opencode-resource-v1:[^:]+:/u,
        'opencode-resource-v1:unknown-generation:',
      ),
      signal: new AbortController().signal,
      emit() {},
      requestReconcile() {},
      requestTranscriptRefresh() {},
    })).toThrow(/stale endpoint generation/u);

    secondCredential.dispose();
  });

  it('routes only correlated native status events and requests reconciliation at connection boundaries', async () => {
    const credential = registerCredential('http://127.0.0.1:49196', 'observer-secret');
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
      now: () => 1_000,
      subscribeGlobalEvents,
    });
    const first = contribution.describeResource(linkedSource('ses-shared'));
    const otherDirectory = contribution.describeResource(
      linkedSource('ses-shared', 'http://127.0.0.1:49196', '/tmp/other-project'),
    );
    const emit = vi.fn<(batch: ExternalAgentObservationLinkEvidenceBatchV1) => void>();
    const requestReconcile = vi.fn();
    const requestTranscriptRefresh = vi.fn();
    const disposable = await contribution.observeResource({
      resourceKey: first.resourceKey,
      signal: new AbortController().signal,
      emit,
      requestReconcile,
      requestTranscriptRefresh,
    });
    await vi.waitFor(() => expect(subscribeGlobalEvents).toHaveBeenCalledOnce());

    expect(subscribeGlobalEvents).toHaveBeenCalledWith(expect.objectContaining({
      baseUrl: 'http://127.0.0.1:49196',
      fetch: readOpenCodeManagedServerTransport('http://127.0.0.1:49196')?.fetch,
      headers: { authorization: 'Basic observer-secret' },
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
        payload: {
          type: 'session.status',
          properties: { sessionID: 'ses-shared', status: { type: 'busy' } },
        },
      },
      { provenance: 'accepted-live', connectionGeneration: 1 },
    );
    expect(requestReconcile).toHaveBeenCalledTimes(4);
    onEvent?.(
      {
        directory: '/tmp/project',
        payload: {
          type: 'session.status',
          properties: { sessionID: 'ses-shared', status: { type: 'busy' } },
        },
      },
      { provenance: 'accepted-live', connectionGeneration: 1 },
    );
    onEvent?.(
      {
        directory: '/tmp/other-project',
        payload: {
          type: 'session.idle',
          properties: { sessionID: 'ses-shared' },
        },
      },
      { provenance: 'accepted-live', connectionGeneration: 1 },
    );
    onEvent?.(
      {
        directory: '/tmp/project',
        payload: {
          type: 'session.status',
          properties: { sessionID: 'ses-shared', status: { type: 'mystery' } },
        },
      },
      { provenance: 'accepted-live', connectionGeneration: 1 },
    );
    expect(requestReconcile).toHaveBeenCalledTimes(5);
    onEvent?.(
      {
        directory: '/tmp/project',
        payload: {
          type: 'session.error',
          properties: { sessionID: 'ses-shared' },
        },
      },
      { provenance: 'accepted-live', connectionGeneration: 1 },
    );
    expect(requestReconcile).toHaveBeenCalledTimes(6);
    onUnavailable?.(new TypeError('stream unavailable'));
    expect(requestReconcile).toHaveBeenCalledTimes(7);
    expect(emit.mock.calls.map(([batch]) => batch)).toEqual([
      {
        items: [{
          linkKey: first.linkKey,
          facts: [{
            kind: 'turn_phase',
            evidenceClass: 'agent_native',
            observedAtMs: 1_000,
            expiresAtMs: 31_000,
            value: 'working',
          }],
        }],
      },
      {
        items: [{
          linkKey: otherDirectory.linkKey,
          facts: [{
            kind: 'turn_phase',
            evidenceClass: 'agent_native',
            observedAtMs: 1_000,
            expiresAtMs: 31_000,
            value: 'idle',
          }],
        }],
      },
    ]);
    expect(JSON.stringify(emit.mock.calls)).not.toContain('ses-shared');
    expect(JSON.stringify(emit.mock.calls)).not.toContain('observer-secret');

    await disposable.dispose();
    expect(subscribedSignal?.aborted).toBe(true);
    await disposable.dispose();
    expect(subscribedSignal?.aborted).toBe(true);
    credential.dispose();
  });

  it('keeps an observation resource bound to its exact registration across same-base replacement', async () => {
    const baseUrl = 'http://127.0.0.1:49196';
    let firstState = 'healthy';
    const firstNetworkFetch = vi.fn(async () => new Response('{}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    const firstTransport = createOpenCodeServerTransport({
      baseUrl,
      instanceId: 'first-observer-instance',
      headers: { authorization: 'Basic first-observer-secret' },
      readManagedServerSnapshot: () => ({
        instanceId: 'first-observer-instance',
        state: firstState,
        baseUrl,
      }),
      fetchImpl: firstNetworkFetch,
    });
    const firstRegistration = registerOpenCodeManagedServerEndpoint({
      baseUrl,
      credential: {
        envKey: OPENCODE_SERVER_PASSWORD_ENV_KEY,
        value: 'first-observer-secret',
        headers: { authorization: 'Basic first-observer-secret' },
      },
      transport: firstTransport,
    });
    const subscribeGlobalEvents = vi.fn(async (params: Readonly<{
      fetch?: (input: string | URL, init?: RequestInit) => Promise<Response>;
    }>) => {
      await params.fetch?.(`${baseUrl}/global/event`, { method: 'GET' });
    });
    const fallbackFetch = vi.fn(async () => new Response('{}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    const contribution = createOpenCodeExternalSessionObservationContribution({
      fetchFn: fallbackFetch,
      subscribeGlobalEvents: subscribeGlobalEvents as never,
    });
    const descriptor = contribution.describeResource(
      linkedSource('same-port-session', baseUrl),
    );

    const secondNetworkFetch = vi.fn(async () => new Response('{}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    const secondRegistration = registerOpenCodeManagedServerEndpoint({
      baseUrl,
      credential: {
        envKey: OPENCODE_SERVER_PASSWORD_ENV_KEY,
        value: 'second-observer-secret',
        headers: { authorization: 'Basic second-observer-secret' },
      },
      transport: createOpenCodeServerTransport({
        baseUrl,
        instanceId: 'second-observer-instance',
        headers: { authorization: 'Basic second-observer-secret' },
        readManagedServerSnapshot: () => ({
          instanceId: 'second-observer-instance',
          state: 'healthy',
          baseUrl,
        }),
        fetchImpl: secondNetworkFetch,
      }),
    });
    firstState = 'stopped';

    const disposable = contribution.observeResource({
      resourceKey: descriptor.resourceKey,
      signal: new AbortController().signal,
      emit() {},
      requestReconcile() {},
      requestTranscriptRefresh() {},
    });
    await vi.waitFor(() => expect(subscribeGlobalEvents).toHaveBeenCalledOnce());
    expect(subscribeGlobalEvents.mock.calls[0]?.[0]?.fetch).toBe(firstTransport.fetch);

    await expect(contribution.reconcileResource({
      purpose: 'observation_evidence',
      resourceKey: descriptor.resourceKey,
      links: [{
        linkKey: descriptor.linkKey,
        linkedSource: linkedSource('same-port-session', baseUrl),
      }],
      signal: new AbortController().signal,
    })).resolves.toMatchObject({
      purpose: 'observation_evidence',
      outcomes: [{
        linkKey: descriptor.linkKey,
        facts: [{ kind: 'retrieval_failed' }],
      }],
    });
    expect(firstNetworkFetch).not.toHaveBeenCalled();
    expect(secondNetworkFetch).not.toHaveBeenCalled();
    expect(fallbackFetch).not.toHaveBeenCalled();

    await disposable.dispose();
    secondRegistration.dispose();
    firstRegistration.dispose();
  });

  it('canonicalizes a default link directory before admitting its accepted live event', async () => {
    const baseUrl = 'http://127.0.0.1:49196';
    const managedFetch = vi.fn(async (input: string | URL) => {
      const url = new URL(input);
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
    const credential = registerCredential(
      baseUrl,
      'default-link-secret',
      managedFetch,
    );
    const externalSessions = createOpenCodeExternalSessionsContribution({
      env: { HAPPIER_OPENCODE_SERVER_URL: baseUrl },
    });
    const linked = await externalSessions.resolveLinkIdentity({
      source: { kind: 'opencodeServer', baseUrl },
      remoteSessionId: 'ses-default',
      signal: new AbortController().signal,
      deadlineAtMs: Date.now() + 10_000,
      maxSerializedBytes: 100_000,
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
    const emit = vi.fn<(batch: ExternalAgentObservationLinkEvidenceBatchV1) => void>();
    const disposable = await observation.observeResource({
      resourceKey: descriptor.resourceKey,
      signal: new AbortController().signal,
      emit,
      requestReconcile() {},
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
      provenance: 'accepted-live',
      connectionGeneration: 1,
    });

    expect(descriptor.linkKey).not.toBe(otherDirectory.linkKey);
    expect(emit).toHaveBeenCalledWith({
      items: [{
        linkKey: descriptor.linkKey,
        facts: [{
          kind: 'turn_phase',
          evidenceClass: 'agent_native',
          observedAtMs: 1_000,
          expiresAtMs: 31_000,
          value: 'working',
        }],
      }],
    });

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
      linkedSource('ses-long-endpoint', baseUrl),
    );

    expect(baseUrl.length).toBeGreaterThan(256);
    expect(descriptor.resourceKey.length).toBeLessThanOrEqual(256);
    expect(descriptor.resourceKey).not.toContain(baseUrl);

    const disposable = await contribution.observeResource({
      resourceKey: descriptor.resourceKey,
      signal: new AbortController().signal,
      emit() {},
      requestReconcile() {},
      requestTranscriptRefresh() {},
    });
    await vi.waitFor(() => expect(observedBaseUrl).toBe(baseUrl.replace(/\/+$/u, '')));
    await disposable.dispose();
  });

  it('reconciles each unique directory once with exact ordered outcomes and isolated failures', async () => {
    const fetchFn = vi.fn(async (input: string | URL) => {
      const directory = new URL(input).searchParams.get('directory');
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
    const credential = registerCredential(
      'http://127.0.0.1:49196',
      'status-secret',
      fetchFn,
    );
    const contribution = createOpenCodeExternalSessionObservationContribution({
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
    expect(fetchFn.mock.calls.map(([input]) => input).sort()).toEqual([
      'http://127.0.0.1:49196/session/status?directory=%2Ftmp%2Fproject-a',
      'http://127.0.0.1:49196/session/status?directory=%2Ftmp%2Fproject-b',
    ]);
    for (const [, init] of fetchFn.mock.calls) {
      expect(init).toEqual(expect.objectContaining({
        method: 'GET',
      }));
      expect(new Headers(init?.headers).get('authorization')).toBe(
        'Basic status-secret',
      );
    }
    await expect(contribution.reconcileResource({
      purpose: 'observation_evidence',
      resourceKey: projectABusy.resourceKey,
      links: [],
      signal: new AbortController().signal,
    })).rejects.toThrow(/requires at least one current link/u);
    credential.dispose();
  });
});
