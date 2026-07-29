import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { MAX_PLUGIN_TRANSCRIPT_SOURCES_PER_CONTRIBUTION, type PluginAgentContributionV2 } from '@happier-dev/protocol';
import type { ExternalSessionProviderOps } from './providerOps';

import {
  createConfiguredPluginExternalSessionsAdapter,
  createLiveConfiguredPluginExternalSessionsAdapter,
  materializeConfiguredExternalSessionSourceCandidates,
  resolveConfiguredExternalSessionFollowTarget,
  type ConfiguredExternalSessionSourceAccountProjection,
} from './configuredSourceMaterializer';

const codexContribution = {
  id: 'codex',
  title: 'Codex',
  runtime: { kind: 'custom' },
  primary: 'sessions',
  capabilities: {
    sessions: { open: ['create'], delivery: ['newTurn'], cancel: true },
  },
  surfaces: {
    externalSession: {
      sources: [{
        sourceKind: 'codexHome',
        schema: {
          fields: [
            { name: 'kind', kind: 'literal', value: 'codexHome' },
            { name: 'home', kind: 'enum', values: ['user', 'connectedService'] },
            { name: 'connectedServiceId', kind: 'string', optional: true },
            { name: 'connectedServiceProfileId', kind: 'string', optional: true },
            { name: 'connectedServiceGroupId', kind: 'string', optional: true },
            { name: 'homePath', kind: 'string', optional: true },
          ],
        },
        key: {
          segments: [
            { kind: 'literal', value: 'codexHome' },
            { kind: 'homeMode', field: 'home' },
            {
              kind: 'conditionalField',
              field: 'connectedServiceId',
              when: { field: 'home', equals: 'connectedService' },
            },
            {
              kind: 'connectedServiceScope',
              groupField: 'connectedServiceGroupId',
              profileField: 'connectedServiceProfileId',
              when: { field: 'home', equals: 'connectedService' },
            },
            { kind: 'field', field: 'homePath' },
          ],
        },
        instances: [
          { kind: 'default', constants: { home: 'user' } },
          {
            kind: 'connectedServiceProfiles',
            serviceId: 'openai-codex',
            constants: { home: 'connectedService' },
            fields: { serviceId: 'connectedServiceId', profileId: 'connectedServiceProfileId' },
          },
        ],
      }],
    },
  },
} satisfies PluginAgentContributionV2;

function agent(contribution: PluginAgentContributionV2 = codexContribution) {
  return {
    id: contribution.id,
    identity: { pluginId: 'happier.codex', localId: contribution.id },
    richDefinition: { provenance: 'first_party' as const, definition: contribution },
  };
}

describe('configured external-session source materializer', () => {
  it('materializes declared defaults and connected profiles using identifiers only', () => {
    const candidates = materializeConfiguredExternalSessionSourceCandidates({
      agents: [agent()],
      account: {
        connectedServicesV2: [{
          serviceId: 'openai-codex',
          profiles: [
            {
              profileId: 'work', status: 'connected', kind: 'oauth', providerEmail: 'private@example.com',
              providerAccountId: 'acct-secret', expiresAt: null, lastUsedAt: null, health: null,
            },
            {
              profileId: 'reauth', status: 'needs_reauth', kind: 'oauth', providerEmail: null,
              providerAccountId: null, expiresAt: null, lastUsedAt: null, health: null,
            },
          ],
          groups: [],
        }],
      },
    });

    expect(candidates).toEqual([
      { agentId: 'codex', source: { kind: 'codexHome', home: 'user' } },
      {
        agentId: 'codex',
        source: {
          kind: 'codexHome', home: 'connectedService',
          connectedServiceId: 'openai-codex', connectedServiceProfileId: 'work',
        },
      },
    ]);
    expect(JSON.stringify(candidates)).not.toMatch(/private@example|acct-secret|oauth/);
  });

  it('fails closed on malformed account profile identifiers', () => {
    expect(() => materializeConfiguredExternalSessionSourceCandidates({
      agents: [agent()],
      account: {
        connectedServicesV2: [{
          serviceId: 'openai-codex',
          profiles: [{
            profileId: '../secret', status: 'connected', kind: null, providerEmail: null,
            providerAccountId: null, expiresAt: null, lastUsedAt: null, health: null,
          }],
          groups: [],
        }],
      },
    })).toThrow(/profile identifier/i);
  });

  it('fails closed before connected-profile expansion exceeds the canonical source ceiling', () => {
    const profiles = Array.from(
      { length: MAX_PLUGIN_TRANSCRIPT_SOURCES_PER_CONTRIBUTION + 1 },
      (_, index) => ({
        profileId: `profile-${index}`, status: 'connected' as const, kind: 'oauth' as const,
        providerEmail: null, providerAccountId: null, expiresAt: null, lastUsedAt: null, health: null,
      }),
    );
    expect(() => materializeConfiguredExternalSessionSourceCandidates({
      agents: [agent()],
      account: {
        connectedServicesV2: [{ serviceId: 'openai-codex', profiles, groups: [] }],
      },
    })).toThrow(/source capacity/i);
  });

  it('fails closed when static instances across Agent contributions exceed the canonical source ceiling', () => {
    const agents = Array.from(
      { length: MAX_PLUGIN_TRANSCRIPT_SOURCES_PER_CONTRIBUTION + 1 },
      (_, index) => ({ ...agent(), id: `codex-${index}` }),
    );

    expect(() => materializeConfiguredExternalSessionSourceCandidates({
      agents,
      account: { connectedServicesV2: [] },
    })).toThrow(/source capacity/i);
  });

  it('does not infer source instances when the Agent contribution omits declarations', () => {
    const withoutInstances: PluginAgentContributionV2 = {
      ...codexContribution,
      surfaces: {
        externalSession: {
          sources: codexContribution.surfaces.externalSession.sources.map(({ instances: _instances, ...source }) => source),
        },
      },
    };

    expect(materializeConfiguredExternalSessionSourceCandidates({
      agents: [agent(withoutInstances)],
      account: { connectedServicesV2: [] },
    })).toEqual([]);
  });

  it('resolves one configured provider-session follow target without listing candidates', async () => {
    const listCandidates = vi.fn<ExternalSessionProviderOps['listCandidates']>();
    const ops: ExternalSessionProviderOps = {
      validateSource: async ({ source }) => ({ ok: true, source }),
      resolveLinkIdentity: async ({ source, remoteSessionId }) => ({
        source: { ...source, homePath: '/canonical/codex' },
        remoteSessionId,
        linkData: {},
      }),
      listCandidates,
      pageTranscript: async () => ({
        items: [], nextCursor: null, tailCursor: null, hasMore: false, truncated: false,
      }),
      readAfterTranscript: async () => ({ outcome: 'already_current' }),
    };
    const basis = {
      contributionGenerationId: 'registry:g1',
      accountSettingsRevision: 'account:1',
    };

    await expect(resolveConfiguredExternalSessionFollowTarget({
      agents: [agent()],
      account: { connectedServicesV2: [] },
      basis,
      readCurrentBasis: () => basis,
      isCurrent: () => true,
      agentId: 'codex',
      remoteSessionId: 'remote-1',
      resolveProviderOps: async () => ops,
    })).resolves.toEqual({
      status: 'resolved',
      ref: {
        agentId: 'codex',
        sourceId: 'codexHome:user:::',
        remoteSessionId: 'remote-1',
      },
      source: {
        kind: 'codexHome',
        home: 'user',
        homePath: '/canonical/codex',
      },
    });
    expect(listCandidates).not.toHaveBeenCalled();
  });

  it('composes opaque configured sources into the native adapter and retires on account drift', async () => {
    let currentBasis = {
      contributionGenerationId: 'registry:g1',
      accountSettingsRevision: 'account:1',
    };
    const listCandidates = vi.fn<ExternalSessionProviderOps['listCandidates']>(async (_params) => ({
      candidates: [{ remoteSessionId: 'remote-1', title: 'Remote', updatedAtMs: 1 }],
      nextCursor: null,
    }));
    const ops: ExternalSessionProviderOps = {
      validateSource: async ({ source }) => ({ ok: true, source }),
      listCandidates,
      pageTranscript: async () => ({
        items: [], nextCursor: null, tailCursor: null, hasMore: false, truncated: false,
      }),
      readAfterTranscript: async () => ({ outcome: 'already_current' }),
    };
    const adapter = await createConfiguredPluginExternalSessionsAdapter({
      agents: [agent()],
      account: { connectedServicesV2: [] },
      basis: currentBasis,
      readCurrentBasis: () => currentBasis,
      isCurrent: () => true,
      resolveProviderOps: async () => ops,
    });

    const listed = await adapter.list();
    expect(listed.items[0]?.ref).toMatchObject({
      agentId: 'codex',
      sourceId: 'codexHome:user:::',
      remoteSessionId: 'remote-1',
    });
    expect(listCandidates).toHaveBeenCalledOnce();

    currentBasis = { ...currentBasis, accountSettingsRevision: 'account:2' };
    expect(adapter.capabilities().list).toEqual({ status: 'unavailable', code: 'plugin_generation_retired' });
    await expect(adapter.list()).rejects.toMatchObject({ code: 'plugin_generation_retired' });
  });

  it('routes preparation chunks through the canonical candidate-index owner before publishing candidates', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-configured-candidate-index-'));
    try {
      const listCandidates = vi.fn<ExternalSessionProviderOps['listCandidates']>(async ({ cursor, searchTerm }) => (
        searchTerm
          ? {
              candidates: [{
                remoteSessionId: searchTerm,
                title: `Hydrated ${searchTerm}`,
                updatedAtMs: searchTerm === 'newest' ? 2 : 1,
              }],
              nextCursor: null,
            }
          : cursor
          ? {
              candidates: [{ remoteSessionId: 'newest', title: 'Private title', updatedAtMs: 2 }],
              nextCursor: null,
              preparation: { kind: 'building_candidate_index', scanned: 2 },
            }
          : {
              candidates: [{ remoteSessionId: 'oldest', title: 'Private title', updatedAtMs: 1 }],
              nextCursor: 'scan:2',
              preparation: { kind: 'building_candidate_index', scanned: 1 },
            }
      ));
      const ops: ExternalSessionProviderOps = {
        validateSource: async ({ source }) => ({ ok: true, source }),
        listCandidates,
        resolveLinkIdentity: async ({ source, remoteSessionId }) => ({
          source,
          remoteSessionId,
        }),
        pageTranscript: async () => ({
          items: [], nextCursor: null, tailCursor: null, hasMore: false, truncated: false,
        }),
        readAfterTranscript: async () => ({ outcome: 'already_current' }),
      };
      const adapter = await createConfiguredPluginExternalSessionsAdapter({
        agents: [agent()],
        account: { connectedServicesV2: [] },
        basis: { contributionGenerationId: 'registry:g1', accountSettingsRevision: 'account:1' },
        readCurrentBasis: () => ({
          contributionGenerationId: 'registry:g1',
          accountSettingsRevision: 'account:1',
        }),
        isCurrent: () => true,
        activeServerDir,
        resolveProviderOps: async () => ops,
      });

      await expect(adapter.list()).resolves.toMatchObject({ items: [] });
      await expect(adapter.list()).resolves.toMatchObject({ items: [] });
      await expect(adapter.list()).resolves.toMatchObject({
        items: [
          { ref: { remoteSessionId: 'newest' }, title: 'Hydrated newest' },
          { ref: { remoteSessionId: 'oldest' }, title: 'Hydrated oldest' },
        ],
      });
      expect(listCandidates.mock.calls
        .filter(([request]) => request.searchTerm === undefined)
        .map(([request]) => request.cursor ?? null)).toEqual([
        null,
        null,
        'scan:2',
        null,
        'scan:2',
      ]);
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it('projects follow through the canonical host owner without accepting the deprecated provider lease', async () => {
    const dispose = vi.fn();
    const followTranscript = vi.fn(async () => ({
      status: 'following' as const,
      startingCursor: 'cursor-tail',
      subscription: { dispose },
    }));
    const ops: ExternalSessionProviderOps = {
      validateSource: async ({ source }) => ({ ok: true, source }),
      listCandidates: async () => ({
        candidates: [{ remoteSessionId: 'remote-1', updatedAtMs: 1 }],
        nextCursor: null,
      }),
      pageTranscript: async () => ({ items: [], nextCursor: null, tailCursor: null, hasMore: false, truncated: false }),
      readAfterTranscript: async () => ({ outcome: 'already_current' }),
    };
    const adapter = await createConfiguredPluginExternalSessionsAdapter({
      agents: [agent()],
      account: { connectedServicesV2: [] },
      basis: { contributionGenerationId: 'registry:g1', accountSettingsRevision: 'account:1' },
      readCurrentBasis: () => ({ contributionGenerationId: 'registry:g1', accountSettingsRevision: 'account:1' }),
      isCurrent: () => true,
      resolveProviderOps: async () => ops,
      followTranscript,
    });

    expect(adapter.capabilities().follow).toEqual({ status: 'available' });
    const listed = await adapter.list();
    expect(listed.items[0]?.capabilities).toContain('follow');
    const result = await adapter.followTranscript({
      ref: listed.items[0]!.ref,
      source: { kind: 'codexHome', home: 'user' },
    }, {}, vi.fn());
    expect(result.status).toBe('following');
    if (result.status === 'following') await result.subscription.dispose();
    expect(followTranscript).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
    expect(ops).not.toHaveProperty('acquireFollowLease');
  });

  it('retires old operations immediately and publishes a new immutable snapshot after account revision changes', async () => {
    let revision = 'settings:1';
    let notifyRevision: ((next: string) => void) | null = null;
    let resolveSecondRead!: (account: ConfiguredExternalSessionSourceAccountProjection) => void;
    const secondRead = new Promise<ConfiguredExternalSessionSourceAccountProjection>((resolve) => {
      resolveSecondRead = resolve;
    });
    const accounts: ConfiguredExternalSessionSourceAccountProjection[] = [
      { connectedServicesV2: [] },
    ];
    const readAccount = vi.fn(async () => accounts.shift() ?? await secondRead);
    let releaseList!: () => void;
    const delayedList = new Promise<void>((resolve) => {
      releaseList = resolve;
    });
    const listCandidates = vi.fn<ExternalSessionProviderOps['listCandidates']>(async ({ source }) => {
      if ((source as { connectedServiceProfileId?: string }).connectedServiceProfileId !== 'work') {
        await delayedList;
      }
      return {
        candidates: [{
          remoteSessionId: (source as { connectedServiceProfileId?: string }).connectedServiceProfileId ?? 'default',
          updatedAtMs: 1,
        }],
        nextCursor: null,
      };
    });
    const ops: ExternalSessionProviderOps = {
      validateSource: async ({ source }) => ({ ok: true, source }),
      listCandidates,
      pageTranscript: async () => ({ items: [], nextCursor: null, tailCursor: null, hasMore: false, truncated: false }),
      readAfterTranscript: async () => ({ outcome: 'already_current' }),
    };
    const lifecycle = await createLiveConfiguredPluginExternalSessionsAdapter({
      agents: [agent()],
      contributionGenerationId: 'registry:g1',
      readAccount,
      readAccountRevision: () => revision,
      subscribeAccountRevision: (listener) => {
        notifyRevision = listener;
        return () => {
          notifyRevision = null;
        };
      },
      isCurrent: () => true,
      resolveProviderOps: async () => ops,
    });

    const staleList = lifecycle.service.list();
    revision = 'settings:2';
    (notifyRevision as ((next: string) => void) | null)?.(revision);
    expect(lifecycle.service.capabilities().list).toEqual({
      status: 'unavailable',
      code: 'plugin_external_sources_reconfiguring',
    });
    releaseList();
    await expect(staleList).rejects.toMatchObject({ code: 'plugin_generation_retired' });

    resolveSecondRead({
      connectedServicesV2: [{
        serviceId: 'openai-codex',
        profiles: [{
          profileId: 'work', status: 'connected', kind: 'oauth', providerEmail: null,
          providerAccountId: null, expiresAt: null, lastUsedAt: null, health: null,
        }],
        groups: [],
      }],
    });
    await vi.waitFor(() => {
      expect(lifecycle.service.capabilities().list).toEqual({ status: 'available' });
    });
    const current = await lifecycle.service.list({ sourceId: 'codexHome:connectedService:openai-codex:work:' });
    expect(current.items[0]?.ref.remoteSessionId).toBe('work');
    expect(Object.isFrozen(current.items[0]?.ref)).toBe(true);

    lifecycle.dispose();
    expect(lifecycle.service.capabilities().list).toEqual({
      status: 'unavailable',
      code: 'plugin_generation_retired',
    });
  });

  it('rebuilds configured sources across account removal, reconnect, and profile switch', async () => {
    let revision = 'settings:1';
    let notifyRevision: ((next: string) => void) | null = null;
    const connectedAccount = (profileId: string): ConfiguredExternalSessionSourceAccountProjection => ({
      connectedServicesV2: [{
        serviceId: 'openai-codex',
        profiles: [{
          profileId, status: 'connected', kind: 'oauth', providerEmail: null,
          providerAccountId: null, expiresAt: null, lastUsedAt: null, health: null,
        }],
        groups: [],
      }],
    });
    let account = connectedAccount('work');
    const ops: ExternalSessionProviderOps = {
      validateSource: async ({ source }) => ({ ok: true, source }),
      listCandidates: async ({ source }) => ({
        candidates: [{
          remoteSessionId: (source as { connectedServiceProfileId?: string }).connectedServiceProfileId ?? 'default',
          updatedAtMs: 1,
        }],
        nextCursor: null,
      }),
      pageTranscript: async () => ({ items: [], nextCursor: null, tailCursor: null, hasMore: false, truncated: false }),
      readAfterTranscript: async () => ({ outcome: 'already_current' }),
    };
    const lifecycle = await createLiveConfiguredPluginExternalSessionsAdapter({
      agents: [agent()],
      contributionGenerationId: 'registry:g1',
      readAccount: async () => account,
      readAccountRevision: () => revision,
      subscribeAccountRevision: (listener) => {
        notifyRevision = listener;
        return () => { notifyRevision = null; };
      },
      isCurrent: () => true,
      resolveProviderOps: async () => ops,
    });

    await expect(lifecycle.service.list({ sourceId: 'codexHome:connectedService:openai-codex:work:' }))
      .resolves.toMatchObject({ items: [{ ref: { remoteSessionId: 'work' } }] });

    account = { connectedServicesV2: [] };
    revision = 'settings:2';
    (notifyRevision as ((next: string) => void) | null)?.(revision);
    await vi.waitFor(() => expect(lifecycle.service.capabilities().list).toEqual({ status: 'available' }));
    await expect(lifecycle.service.list({ sourceId: 'codexHome:connectedService:openai-codex:work:' }))
      .rejects.toMatchObject({ code: 'plugin_external_source_unavailable' });

    account = connectedAccount('backup');
    revision = 'settings:3';
    (notifyRevision as ((next: string) => void) | null)?.(revision);
    await vi.waitFor(() => expect(lifecycle.service.capabilities().list).toEqual({ status: 'available' }));
    await expect(lifecycle.service.list({ sourceId: 'codexHome:connectedService:openai-codex:backup:' }))
      .resolves.toMatchObject({ items: [{ ref: { remoteSessionId: 'backup' } }] });
    lifecycle.dispose();
  });

  it('coalesces rapid revisions and repairs a missed account notification from the canonical revision reader', async () => {
    let revision = 'settings:1';
    let account: ConfiguredExternalSessionSourceAccountProjection = { connectedServicesV2: [] };
    let notifyRevision: ((next: string) => void) | null = null;
    let releaseBlockedRead!: () => void;
    let blockNextRead = false;
    let readsInFlight = 0;
    let maxReadsInFlight = 0;
    const readAccount = vi.fn(async () => {
      readsInFlight += 1;
      maxReadsInFlight = Math.max(maxReadsInFlight, readsInFlight);
      if (blockNextRead) {
        blockNextRead = false;
        await new Promise<void>((resolve) => {
          releaseBlockedRead = resolve;
        });
      }
      readsInFlight -= 1;
      return account;
    });
    const ops: ExternalSessionProviderOps = {
      validateSource: async ({ source }) => ({ ok: true, source }),
      listCandidates: async () => ({ candidates: [], nextCursor: null }),
      pageTranscript: async () => ({ items: [], nextCursor: null, tailCursor: null, hasMore: false, truncated: false }),
      readAfterTranscript: async () => ({ outcome: 'already_current' }),
    };
    const lifecycle = await createLiveConfiguredPluginExternalSessionsAdapter({
      agents: [agent()],
      contributionGenerationId: 'registry:g1',
      readAccount,
      readAccountRevision: () => revision,
      subscribeAccountRevision: (listener) => {
        notifyRevision = listener;
        return () => { notifyRevision = null; };
      },
      isCurrent: () => true,
      resolveProviderOps: async () => ops,
    });

    blockNextRead = true;
    revision = 'settings:2';
    (notifyRevision as ((next: string) => void) | null)?.(revision);
    await vi.waitFor(() => expect(readAccount).toHaveBeenCalledTimes(2));
    revision = 'settings:3';
    (notifyRevision as ((next: string) => void) | null)?.(revision);
    revision = 'settings:4';
    (notifyRevision as ((next: string) => void) | null)?.(revision);
    expect(readAccount).toHaveBeenCalledTimes(2);
    releaseBlockedRead();
    await vi.waitFor(() => expect(lifecycle.service.capabilities().list).toEqual({ status: 'available' }));
    expect(readAccount).toHaveBeenCalledTimes(3);
    expect(maxReadsInFlight).toBe(1);

    // A throwing earlier listener in the snapshot owner can prevent this listener from
    // observing an emission. The canonical revision reader must still retire the stale
    // snapshot on the next public operation and schedule the replacement.
    account = { connectedServicesV2: [] };
    revision = 'settings:5';
    expect(lifecycle.service.capabilities().list).toEqual({
      status: 'unavailable',
      code: 'plugin_external_sources_reconfiguring',
    });
    await vi.waitFor(() => expect(lifecycle.service.capabilities().list).toEqual({ status: 'available' }));
    expect(readAccount).toHaveBeenCalledTimes(4);
    lifecycle.dispose();
  });

  it('finishes initialization on the newest revision and unsubscribes exactly once', async () => {
    let revision = 'settings:1';
    let notifyRevision: ((next: string) => void) | null = null;
    let releaseInitialRead!: () => void;
    const initialRead = new Promise<void>((resolve) => {
      releaseInitialRead = resolve;
    });
    const readAccount = vi.fn(async () => {
      if (readAccount.mock.calls.length === 1) await initialRead;
      return { connectedServicesV2: [] };
    });
    const unsubscribe = vi.fn();
    const ops: ExternalSessionProviderOps = {
      validateSource: async ({ source }) => ({ ok: true, source }),
      listCandidates: async () => ({ candidates: [], nextCursor: null }),
      pageTranscript: async () => ({ items: [], nextCursor: null, tailCursor: null, hasMore: false, truncated: false }),
      readAfterTranscript: async () => ({ outcome: 'already_current' }),
    };
    const lifecyclePromise = createLiveConfiguredPluginExternalSessionsAdapter({
      agents: [agent()],
      contributionGenerationId: 'registry:g1',
      readAccount,
      readAccountRevision: () => revision,
      subscribeAccountRevision: (listener) => {
        notifyRevision = listener;
        return unsubscribe;
      },
      isCurrent: () => true,
      resolveProviderOps: async () => ops,
    });
    await vi.waitFor(() => expect(readAccount).toHaveBeenCalledOnce());
    revision = 'settings:2';
    (notifyRevision as ((next: string) => void) | null)?.(revision);
    releaseInitialRead();

    const lifecycle = await lifecyclePromise;
    expect(readAccount).toHaveBeenCalledTimes(2);
    expect(lifecycle.service.capabilities().list).toEqual({ status: 'available' });
    lifecycle.dispose();
    lifecycle.dispose();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('recreates the live adapter from the current account revision after disposal', async () => {
    let revision = 'settings:1';
    const listeners = new Set<(next: string) => void>();
    const followReleases = [vi.fn(async () => undefined), vi.fn(async () => undefined)];
    let followLeaseIndex = 0;
    const followTranscript = vi.fn(async (input: Readonly<{
      options: Readonly<{ signal?: AbortSignal }>;
    }>) => {
      const dispose = followReleases[followLeaseIndex++]!;
      input.options.signal?.addEventListener('abort', () => {
        void dispose();
      }, { once: true });
      return {
        status: 'following' as const,
        startingCursor: revision,
        subscription: { dispose },
      };
    });
    const ops: ExternalSessionProviderOps = {
      validateSource: async ({ source }) => ({ ok: true, source }),
      listCandidates: async () => ({ candidates: [{ remoteSessionId: revision, updatedAtMs: 1 }], nextCursor: null }),
      pageTranscript: async () => ({ items: [], nextCursor: null, tailCursor: null, hasMore: false, truncated: false }),
      readAfterTranscript: async () => ({ outcome: 'already_current' }),
    };
    const create = async () => await createLiveConfiguredPluginExternalSessionsAdapter({
      agents: [agent()],
      contributionGenerationId: 'registry:g1',
      readAccount: async () => ({ connectedServicesV2: [] }),
      readAccountRevision: () => revision,
      subscribeAccountRevision: (listener) => {
        listeners.add(listener);
        return () => { listeners.delete(listener); };
      },
      isCurrent: () => true,
      resolveProviderOps: async () => ops,
      followTranscript,
    });

    const first = await create();
    const firstList = await first.service.list();
    expect(firstList).toMatchObject({
      items: [{ ref: { remoteSessionId: 'settings:1' } }],
    });
    const firstFollow = await first.service.followTranscript({
      ref: firstList.items[0]!.ref,
      source: { kind: 'codexHome', home: 'user' },
    }, {}, vi.fn());
    expect(firstFollow.status).toBe('following');
    first.dispose();
    await vi.waitFor(() => expect(followReleases[0]).toHaveBeenCalledOnce());
    expect(listeners).toHaveLength(0);

    revision = 'settings:2';
    const second = await create();
    const secondList = await second.service.list();
    expect(secondList).toMatchObject({
      items: [{ ref: { remoteSessionId: 'settings:2' } }],
    });
    const secondFollow = await second.service.followTranscript({
      ref: secondList.items[0]!.ref,
      source: { kind: 'codexHome', home: 'user' },
    }, {}, vi.fn());
    expect(secondFollow.status).toBe('following');
    expect(listeners).toHaveLength(1);
    second.dispose();
    await vi.waitFor(() => expect(followReleases[1]).toHaveBeenCalledOnce());
    expect(listeners).toHaveLength(0);
  });
});
