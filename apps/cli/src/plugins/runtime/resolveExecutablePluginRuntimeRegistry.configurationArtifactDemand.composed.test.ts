import axios, { AxiosHeaders, type AxiosResponse } from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { definePlugin } from '@happier-dev/plugin-sdk';
import { TRIAGE_PLUGIN } from '../../../../../packages/plugins/triage/src/definition';
import { deriveArtifactStoredKindV1, REVIEW_ARTIFACT_KIND_V1 } from '@happier-dev/protocol/artifacts/artifactKindV1';
import { PLUGIN_COLLECTION_PRESENCE_HTTP_PATH_V1, PluginCollectionPresenceRequestV1Schema } from '@happier-dev/protocol/plugins/data/collectionPresenceV1';

import * as persistence from '@/persistence';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { loadInstalledPlugins } from '@/plugins/discovery/load/installed';
import { projectLoadedPluginContributes } from '@/plugins/projection/registry/fullProjection';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { createStablePluginEventsBroker } from './invocation/services/events';

const pluginId = 'example.review-demand';
const credentials = { token: 'fixture.' + Buffer.from(JSON.stringify({ sub: 'review-demand-account' })).toString('base64url') + '.signature', encryption: null } as const;
function response<T>(data: T): AxiosResponse<T> {
    return { data, status: 200, statusText: 'OK', headers: new AxiosHeaders(), config: { headers: new AxiosHeaders() } };
}

async function fixtureWithReviews(present: () => boolean, hasUnclassified = false) {
    const observed = { starts: 0, census: [] as URL[], collectionPosts: [] as string[] };
    const broker = createStablePluginEventsBroker();
    // Only filesystem credentials and authenticated HTTP are substituted. The
    // actual Triage activation declaration, runtime adoption and service run stay real.
    vi.spyOn(persistence, 'readSettings').mockResolvedValue({ schemaVersion: 6, onboardingCompleted: true, machineId: 'review-demand-machine' });
    vi.spyOn(persistence, 'readStoredCredentials').mockResolvedValue(credentials);
    vi.spyOn(axios, 'get').mockImplementation(async raw => {
        const url = new URL(String(raw));
        if (url.pathname === '/v1/account/profile') return response({ id: 'review-demand-account' });
        if (url.pathname === '/v1/account/encryption/currentness') return response({ mode: 'plain', version: 1,
            signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
            recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' } });
        if (url.pathname === '/v1/artifacts') {
            observed.census.push(url);
            // No readable header, body or Account content key: presence must not open content.
            return response({ items: present() ? [{ id: 'review', updatedAt: 1 }] : [], hasUnclassified });
        }
        throw new Error(`Unexpected GET ${url.pathname}`);
    });
    vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
        if (!String(url).endsWith(PLUGIN_COLLECTION_PRESENCE_HTTP_PATH_V1)) throw new Error(`Unexpected POST ${String(url)}`);
        const request = PluginCollectionPresenceRequestV1Schema.parse(body);
        return response({ collections: request.collections.map(ref => ({ ...ref, present: false })), changeCursor: 0 });
    });
    const plugin = definePlugin({ id: pluginId, version: '1.0.0', entrypoints: { daemon: './daemon.mjs' },
        activation: TRIAGE_PLUGIN.manifest.activation,
        backgroundServices: [{ declaration: { id: 'attention' }, runner: async context => {
            observed.starts += 1;
            await new Promise<void>(resolve => {
                if (context.signal.aborted) resolve();
                else context.signal.addEventListener('abort', () => resolve(), { once: true });
            });
        } }],
    });
    const fixture = await createAuthoredAdmittedPluginRuntimeFixture({ coldStart: true,
        plugins: [{ manifest: plugin.manifest, includeAvailability: true, files: { 'daemon.mjs': 'export function activate() {}' },
            instantiateCommittedModule: () => ({ activate: plugin.activate }) }],
        async resolveContributes(happyHomeDir) {
            return createResolvedContributionRegistry(projectLoadedPluginContributes({
                loadResult: await loadInstalledPlugins({ happyHomeDir }), provenance: 'first_party',
            }));
        },
        runtimeOptions: { stableEventsBroker: broker, resolveCurrentMachineId: () => 'review-demand-machine',
            resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: 'server-review-demand', machineId: 'review-demand-machine' }),
            accountStorageDependencies: {
                readCredentials: async () => credentials, isCurrentAccount: () => true,
                resolveAccountScopeKey: () => 'review-demand-account', resolveBaseUrl: () => 'https://data.example.test',
                http: { get: async () => { throw new Error('Unexpected Collection GET'); },
                    post: async (url, encoded) => {
                        observed.collectionPosts.push(url);
                        if (!url.endsWith(PLUGIN_COLLECTION_PRESENCE_HTTP_PATH_V1)) throw new Error(`Unexpected Collection POST ${url}`);
                        const request = PluginCollectionPresenceRequestV1Schema.parse(JSON.parse(encoded));
                        return { status: 200, data: { collections: request.collections.map(ref => ({ ...ref, present: false })), changeCursor: 0 } };
                    } },
            },
        },
    });
    await fixture.registry.startConfiguredActivation();
    return { fixture, observed, broker };
}

afterEach(() => vi.restoreAllMocks());

describe('Triage built-in Review activation demand', () => {
    it('starts attention for a fresh Review-only Account without a persisted source or content read', async () => {
        const { fixture, observed } = await fixtureWithReviews(() => true);
        try {
            await vi.waitFor(() => expect(observed.starts).toBe(1));
            expect(fixture.registry.activatedPluginIds.has(pluginId)).toBe(true);
            expect(observed.census).toHaveLength(1);
            expect(JSON.parse(observed.census[0]!.searchParams.get('kinds')!)).toEqual([REVIEW_ARTIFACT_KIND_V1]);
            expect(observed.census[0]!.searchParams.get('limit')).toBe('1');
            expect(observed.census[0]!.searchParams.has('includeBody')).toBe(false);
        } finally { await fixture.dispose(); }
    });

    it('keeps an Account with only ordinary or unclassified Artifacts dormant', async () => {
        // Exact-kind census excludes known ordinary Artifacts and reports retained
        // unclassified rows separately; neither is positive Review presence.
        const { fixture, observed } = await fixtureWithReviews(() => false, true);
        try {
            expect(observed.starts).toBe(0);
            expect(observed.census).toHaveLength(1);
        } finally { await fixture.dispose(); }
    });

    it.each(['matching', 'coarse', 'reconnect'] as const)('keeps never-Review Accounts dormant and wakes once on %s invalidation', async wake => {
        let present = false;
        const { fixture, observed, broker } = await fixtureWithReviews(() => present);
        try {
            expect(observed.starts).toBe(0);
            expect(observed.census).toHaveLength(1);
            broker.publishHostEventEnvelope({ eventId: '@happier/account/entities-invalidated', scope: { kind: 'account' }, payload: { entityIds: ['session'] } });
            broker.publishHostEventEnvelope({ eventId: '@happier/account/entities-invalidated', scope: { kind: 'account' }, payload: {
                entityIds: ['other'], artifactKinds: [deriveArtifactStoredKindV1({ kind: 'bot_template.v1' })],
            } });
            await new Promise<void>(resolve => setImmediate(resolve));
            expect(observed.census).toHaveLength(1);
            expect(observed.starts).toBe(0);
            present = true;
            const invalidate = () => {
                if (wake === 'reconnect') broker.publishHostEventEnvelope({ eventId: '@happier/automation/event-sources-invalidated', scope: { kind: 'account' }, payload: { reason: 'reconnect' } });
                else broker.publishHostEventEnvelope({ eventId: '@happier/account/entities-invalidated', scope: { kind: 'account' }, payload: {
                    entityIds: ['review'], artifactKinds: wake === 'coarse' ? null : [deriveArtifactStoredKindV1({ kind: REVIEW_ARTIFACT_KIND_V1 })],
                } });
            };
            invalidate();
            await vi.waitFor(() => expect(observed.starts).toBe(1));
            invalidate();
            await new Promise<void>(resolve => setImmediate(resolve));
            expect(observed.census).toHaveLength(2);
            expect(observed.starts).toBe(1);
        } finally { await fixture.dispose(); }
    });
});
