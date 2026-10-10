import { describe, expect, it, vi } from 'vitest';

import {
    PluginAvailabilityActionHttpPathsV1,
    PluginAvailabilityIntentReadActionOutputV1Schema,
    PLUGIN_ACCOUNT_AVAILABILITY_INTENT_PAGE_SIZE,
} from '@happier-dev/protocol/plugins/availability';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';

import {
    createActivePluginAccountAvailabilityProjectionHydrator,
} from './pluginAvailabilityProjection';

const scope = { serverId: 'srv-a', accountId: 'account-a' } as const;
const pluginId = 'com.acme.fixture';

function jsonResponse(value: unknown): Response {
    return new Response(JSON.stringify(value), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
    });
}

function jsonErrorResponse(status: number, value: unknown): Response {
    return new Response(JSON.stringify(value), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

function releaseFacts() {
    return {
        ref: { pluginId, version: '1.2.3' },
        archiveDigestSha256: `sha256:${'a'.repeat(64)}`,
        normalizedManifest: {
            schemaVersion: 2,
            id: pluginId,
            version: '1.2.3',
            displayName: 'Fixture',
            engines: { happier: '^1.0.0' },
            runtime: { apiVersion: 1 },
            contributes: {},
        },
        collectionContracts: [],
        uiSlots: [],
        packageAssetArchive: {
            archiveDigestSha256: `sha256:${'d'.repeat(64)}`,
            resources: [],
        },
    };
}

function materializationSnapshot(cursor: number, pluginIds: readonly string[]) {
    return {
        availabilityCursor: cursor,
        snapshots: pluginIds.map((id) => ({
            serverIdentityId: 'srv_identity',
            machineId: 'machine-a',
            materializations: [{
                serverIdentityId: 'srv_identity',
                machineId: 'machine-a',
                materializationId: `installation-${id}`,
                pluginId: id,
                version: '1.2.3',
                sourceClass: 'registryPackage',
                portableRelease: true,
                uiArtifacts: [],
                enabled: true,
                trustState: 'trusted',
                observedAt: 1,
            }],
        })),
    };
}

function intentRead(cursor: number, id: string) {
    return PluginAvailabilityIntentReadActionOutputV1Schema.parse({
        availabilityCursor: cursor,
        packageAssets: [],
        hostingCapability: { enabled: false },
        intent: {
            pluginId: id,
            desiredVersion: '1.2.3',
            enabled: true,
            offlineUiHosting: 'disabled',
            writableCollections: [],
            revision: '1',
        },
        release: id === pluginId ? releaseFacts() : null,
        uiArtifacts: [],
    });
}

function intentList(cursor: number, ids: readonly string[], readCursor = cursor) {
    return { availabilityCursor: cursor, pluginIds: [...ids].sort(),
        intentReads: ids.map(pluginId => ({ pluginId, response: intentRead(readCursor, pluginId) })),
        failedPluginIds: [] };
}

describe('active Plugin Account Availability projection hydrator', () => {
    it('publishes incomplete installation evidence and immutable facts without needing selection intent', async () => {
        const release = releaseFacts();
        const hydrator = createActivePluginAccountAvailabilityProjectionHydrator({
            captureLifetime: () => ({ scope, isCurrent: () => true, onRetire: () => ({ dispose: () => {} }) }),
            getServerSnapshot: () => ({ serverId: scope.serverId, generation: 4 }),
            captureRequestAuthority: async () => ({ request: async path => {
                if (path === PluginAvailabilityActionHttpPathsV1['account.plugins.availability.materializations.read']) {
                    return jsonResponse({ ...materializationSnapshot(23, []), inventoryComplete: false, releases: [release] });
                }
                return jsonResponse({ availabilityCursor: 23, pluginIds: [], intentReads: [], failedPluginIds: [] });
            } }),
        });
        expect(await hydrator.refresh()).toMatchObject({ snapshot: {
            inventoryComplete: false, releases: [release], intentReads: [],
        } });
    });
    it('assembles every census page beyond 200 before returning complete intent facts', async () => {
        const ids = Array.from({ length: 401 }, (_, index) =>
            `com.acme.paged${index % 2 === 0 ? '-' : '.'}${String(index).padStart(3, '0')}`).sort();
        const requestKnownIds: string[][] = [];
        const hydrator = createActivePluginAccountAvailabilityProjectionHydrator({
            captureLifetime: () => ({ scope, isCurrent: () => true, onRetire: () => ({ dispose: () => {} }) }),
            getServerSnapshot: () => ({ serverId: scope.serverId, generation: 4 }),
            captureRequestAuthority: async () => ({ request: async (path, init) => {
                if (path === PluginAvailabilityActionHttpPathsV1['account.plugins.availability.materializations.read']) {
                    return jsonResponse(materializationSnapshot(23, ids));
                }
                const body = JSON.parse(String(init?.body)) as { cursor?: string; knownPluginIds: string[] };
                requestKnownIds.push(body.knownPluginIds);
                const offset = body.cursor ? ids.indexOf(body.cursor) + 1 : 0;
                const page = ids.slice(offset, offset + 200);
                return jsonResponse({ ...intentList(23, page), nextCursor: offset + page.length < ids.length ? page.at(-1) : null });
            } }),
        });
        const refreshed = await hydrator.refresh();
        expect(refreshed?.snapshot.intentReads.map(entry => entry.pluginId)).toEqual(ids);
        expect(refreshed?.failedPluginIds).toEqual([]);
        expect(requestKnownIds).toEqual([
            ids.slice(0, PLUGIN_ACCOUNT_AVAILABILITY_INTENT_PAGE_SIZE + 1),
            ids.slice(PLUGIN_ACCOUNT_AVAILABILITY_INTENT_PAGE_SIZE, 2 * PLUGIN_ACCOUNT_AVAILABILITY_INTENT_PAGE_SIZE + 1),
            ids.slice(2 * PLUGIN_ACCOUNT_AVAILABILITY_INTENT_PAGE_SIZE),
        ]);
    });

    it('retains completed pages and marks the census incomplete when a server repeats its cursor', async () => {
        const hydrator = createActivePluginAccountAvailabilityProjectionHydrator({
            captureLifetime: () => ({ scope, isCurrent: () => true, onRetire: () => ({ dispose: () => {} }) }),
            getServerSnapshot: () => ({ serverId: scope.serverId, generation: 4 }),
            captureRequestAuthority: async () => ({ request: async (path) => {
                if (path === PluginAvailabilityActionHttpPathsV1['account.plugins.availability.materializations.read']) {
                    return jsonResponse(materializationSnapshot(23, []));
                }
                return jsonResponse({ ...intentList(23, [pluginId]), nextCursor: pluginId });
            } }),
        });
        await expect(hydrator.refresh()).resolves.toMatchObject({ intentCensusIncomplete: true,
            snapshot: { intentReads: [{ pluginId }] },
        });
    });

    it('retains successful pages and machine facts when a later census page fails', async () => {
        const ids = ['com.acme.page-a', 'com.acme.page-b'];
        const hydrator = createActivePluginAccountAvailabilityProjectionHydrator({
            captureLifetime: () => ({ scope, isCurrent: () => true, onRetire: () => ({ dispose: () => {} }) }),
            getServerSnapshot: () => ({ serverId: scope.serverId, generation: 4 }),
            captureRequestAuthority: async () => ({ request: async (path, init) => {
                if (path === PluginAvailabilityActionHttpPathsV1['account.plugins.availability.materializations.read']) {
                    return jsonResponse(materializationSnapshot(23, [ids[1]!]));
                }
                const body = JSON.parse(String(init?.body)) as { cursor?: string };
                if (body.cursor) throw new Error('Connection lost on next page');
                return jsonResponse({ ...intentList(23, [ids[0]!]), nextCursor: ids[0] });
            } }),
        });
        const refreshed = await hydrator.refresh();
        expect(refreshed).toMatchObject({ intentCensusIncomplete: true, failedPluginIds: [ids[1]],
            snapshot: { intentReads: [{ pluginId: ids[0] }], materializations: [{ pluginId: ids[1] }] } });
    });

    it('retires the Account occurrence while a later census page is pending', async () => {
        const secondPage = createDeferred<Response>();
        const secondPageStarted = createDeferred<void>();
        let current = true;
        let retire = () => {};
        let pageSignal: AbortSignal | null = null;
        const hydrator = createActivePluginAccountAvailabilityProjectionHydrator({
            captureLifetime: () => ({ scope, isCurrent: () => current, onRetire: callback => {
                retire = callback;
                return { dispose: () => {} };
            } }),
            getServerSnapshot: () => ({ serverId: scope.serverId, generation: 4 }),
            captureRequestAuthority: async () => ({ request: async (path, init) => {
                if (path === PluginAvailabilityActionHttpPathsV1['account.plugins.availability.materializations.read']) {
                    return jsonResponse(materializationSnapshot(23, []));
                }
                const body = JSON.parse(String(init?.body)) as { cursor?: string };
                if (!body.cursor) return jsonResponse({ ...intentList(23, ['com.acme.page-a']), nextCursor: 'com.acme.page-a' });
                pageSignal = init?.signal ?? null;
                secondPageStarted.resolve();
                return await secondPage.promise;
            } }),
        });
        const refresh = hydrator.refresh();
        await secondPageStarted.promise;
        current = false;
        retire();
        secondPage.resolve(jsonResponse({ ...intentList(23, ['com.acme.page-b']), nextCursor: null }));
        expect((pageSignal as AbortSignal | null)?.aborted).toBe(true);
        await expect(refresh).resolves.toBeNull();
    });

    it('hydrates every intent from one list response without per-plugin HTTP reads', async () => {
        const removedPluginId = 'com.acme.removed';
        const ids = Array.from({ length: 38 }, (_, index) => `com.acme.plugin${index}`);
        const reads = [pluginId, ...ids, removedPluginId].map((id) => ({
            pluginId: id,
            response: id === removedPluginId
                ? { ...intentRead(17, id), intent: null }
                : intentRead(17, id),
        }));
        const request = vi.fn(async (path: string, init?: RequestInit) => {
            if (path === PluginAvailabilityActionHttpPathsV1['account.plugins.availability.materializations.read']) {
                return jsonResponse(materializationSnapshot(17, [pluginId]));
            }
            if (path === PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intents.list']) {
                return jsonResponse({ availabilityCursor: 17, pluginIds: [...ids, pluginId].sort(),
                    intentReads: reads, failedPluginIds: [] });
            }
            if (path === PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intent.read']) {
                const id = (JSON.parse(String(init?.body)) as { pluginId: string }).pluginId;
                return jsonResponse(reads.find(entry => entry.pluginId === id)?.response);
            }
            throw new Error(`Unexpected Availability path: ${path}`);
        });
        const hydrator = createActivePluginAccountAvailabilityProjectionHydrator({
            captureLifetime: () => ({ scope, isCurrent: () => true, onRetire: () => ({ dispose: () => {} }) }),
            getServerSnapshot: () => ({ serverId: scope.serverId, generation: 4 }),
            captureRequestAuthority: async () => ({ request }),
        });
        hydrator.invalidate([{ cursor: 17, kind: 'pluginDomain',
            entityId: `pluginDomain/${removedPluginId}/availability`, changedAt: 1,
            hint: { pluginDomain: 'availability', pluginId: removedPluginId } }]);

        const result = await hydrator.refresh();
        expect(request.mock.calls.map(([path]) => path)).toEqual([
            PluginAvailabilityActionHttpPathsV1['account.plugins.availability.materializations.read'],
            PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intents.list'],
        ]);
        expect(JSON.parse(String(request.mock.calls[1]?.[1]?.body))).toEqual({ knownPluginIds: [pluginId, removedPluginId].sort() });
        expect(result).toMatchObject({
            failedPluginIds: [], snapshot: { intentReads: expect.arrayContaining(reads),
                materializations: [expect.objectContaining({ pluginId })] },
        });
    });

    it('waits for materialization IDs before requesting their complete intent projection', async () => {
        const materializations = createDeferred<Response>();
        const request = vi.fn(async (path: string) => {
            if (path === PluginAvailabilityActionHttpPathsV1['account.plugins.availability.materializations.read']) {
                return await materializations.promise;
            }
            if (path === PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intents.list']) {
                return jsonResponse(intentList(17, [pluginId]));
            }
            throw new Error(`Unexpected Availability path: ${path}`);
        });
        const hydrator = createActivePluginAccountAvailabilityProjectionHydrator({
            captureLifetime: () => ({
                scope,
                isCurrent: () => true,
                onRetire: () => ({ dispose: () => {} }),
            }),
            getServerSnapshot: () => ({ serverId: scope.serverId, generation: 4 }),
            captureRequestAuthority: async () => ({ request }),
        });

        const refresh = hydrator.refresh();
        let committed = false;
        void refresh.then(() => { committed = true; });
        try {
            await vi.waitFor(() => expect(request).toHaveBeenCalled());
            expect(committed).toBe(false);
            expect(request.mock.calls.map(([path]) => path)).toEqual([
                PluginAvailabilityActionHttpPathsV1['account.plugins.availability.materializations.read'],
            ]);
        } finally {
            materializations.resolve(jsonResponse(materializationSnapshot(17, [pluginId])));
            await refresh;
        }
        await expect(refresh).resolves.toMatchObject({ snapshot: { availabilityCursor: 17 } });
    });

    it('returns only the distinct plugin IDs named by valid availability hints', () => {
        const hydrator = createActivePluginAccountAvailabilityProjectionHydrator({
            captureLifetime: () => ({
                scope,
                isCurrent: () => true,
                onRetire: () => ({ dispose: () => {} }),
            }),
        });
        const hint = {
            cursor: 23,
            kind: 'pluginDomain',
            entityId: `pluginDomain/${pluginId}/availability`,
            changedAt: 1,
            hint: { pluginDomain: 'availability', pluginId },
        };

        expect(hydrator.invalidate([hint, hint, { ...hint, hint: { pluginDomain: 'unknown', pluginId } }]))
            .toEqual([pluginId]);
        expect(hydrator.invalidate([])).toEqual([]);
    });

    it('hydrates one coherent initial projection from the canonical materialization and intent reads', async () => {
        let current = true;
        const request = vi.fn(async (path: string, init?: RequestInit) => {
            if (path === PluginAvailabilityActionHttpPathsV1['account.plugins.availability.materializations.read']) {
                return jsonResponse(materializationSnapshot(17, [pluginId]));
            }
            if (path === PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intents.list']) {
                return jsonResponse(intentList(17, [pluginId]));
            }
            throw new Error(`Unexpected Availability path: ${path}`);
        });
        const hydrator = createActivePluginAccountAvailabilityProjectionHydrator({
            captureLifetime: () => ({
                scope,
                isCurrent: () => current,
                onRetire: () => ({ dispose: () => {} }),
            }),
            getServerSnapshot: () => ({ serverId: scope.serverId, generation: 4 }),
            captureRequestAuthority: async () => ({ request }),
        });

        const result = await hydrator.refresh();

        expect(result).toMatchObject({
            scope,
            snapshot: {
                availabilityCursor: 17,
                intentReads: [{ pluginId, response: expect.objectContaining({ availabilityCursor: 17 }) }],
                materializations: [expect.objectContaining({ pluginId })],
                snapshots: [{
                    serverIdentityId: 'srv_identity',
                    machineId: 'machine-a',
                    materializations: [expect.objectContaining({ pluginId })],
                }],
            },
        });
        expect(request.mock.calls.map(([path]) => path)).toEqual([
            PluginAvailabilityActionHttpPathsV1['account.plugins.availability.materializations.read'],
            PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intents.list'],
        ]);
        current = false;
    });

    it('rehydrates an existing Account intent and release after reset even when no machine materializes it', async () => {
        const requestedPluginIds: string[] = [];
        const requestedPaths: string[] = [];
        const hydrator = createActivePluginAccountAvailabilityProjectionHydrator({
            captureLifetime: () => ({
                scope,
                isCurrent: () => true,
                onRetire: () => ({ dispose: () => {} }),
            }),
            getServerSnapshot: () => ({ serverId: scope.serverId, generation: 4 }),
            captureRequestAuthority: async () => ({
                request: async (path, init) => {
                    requestedPaths.push(path);
                    if (path === PluginAvailabilityActionHttpPathsV1['account.plugins.availability.materializations.read']) {
                        return jsonResponse({
                            availabilityCursor: 23,
                            snapshots: [{
                                serverIdentityId: 'srv_identity',
                                machineId: 'machine-empty',
                                materializations: [],
                            }],
                        });
                    }
                    if (path === PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intents.list']) {
                        requestedPluginIds.push(...(JSON.parse(String(init?.body)) as { knownPluginIds: string[] }).knownPluginIds);
                        return jsonResponse(intentList(23, [pluginId]));
                    }
                    throw new Error(`Unexpected Availability path: ${path}`);
                },
            }),
        });
        expect(hydrator.invalidate([{
            cursor: 23,
            kind: 'pluginDomain',
            entityId: `pluginDomain/${pluginId}/availability`,
            changedAt: 1,
            hint: { pluginDomain: 'availability', pluginId },
        }])).toEqual([pluginId]);

        await expect(hydrator.refresh()).resolves.toMatchObject({
            snapshot: {
                intentReads: [expect.objectContaining({ pluginId })],
                materializations: [],
                snapshots: [{
                    serverIdentityId: 'srv_identity',
                    machineId: 'machine-empty',
                    materializations: [],
                }],
            },
        });
        expect(requestedPluginIds).toEqual([pluginId]);

        hydrator.reset();
        await expect(hydrator.refresh()).resolves.toMatchObject({
            snapshot: {
                intentReads: [expect.objectContaining({ pluginId })],
                snapshots: [expect.objectContaining({ machineId: 'machine-empty' })],
            },
        });
        expect(requestedPluginIds).toEqual([pluginId]);
        expect(requestedPaths).toContain(
            PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intents.list'],
        );
    });

    it('commits per-plugin reads without requiring Account-wide cursor agreement', async () => {
        let attempt = 0;
        const hydrator = createActivePluginAccountAvailabilityProjectionHydrator({
            captureLifetime: () => ({
                scope,
                isCurrent: () => true,
                onRetire: () => ({ dispose: () => {} }),
            }),
            getServerSnapshot: () => ({ serverId: scope.serverId, generation: 4 }),
            captureRequestAuthority: async () => ({
                request: async (path, init) => {
                    if (path === PluginAvailabilityActionHttpPathsV1['account.plugins.availability.materializations.read']) {
                        attempt += 1;
                        return jsonResponse(materializationSnapshot(23, []));
                    }
                    if (path === PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intents.list']) {
                        return jsonResponse(intentList(24, [pluginId], 25));
                    }
                    throw new Error(`Unexpected Availability path: ${path}`);
                },
            }),
        });

        await expect(hydrator.refresh()).resolves.toMatchObject({
            snapshot: {
                availabilityCursor: 23,
                intentReads: [expect.objectContaining({
                    pluginId,
                    response: expect.objectContaining({ availabilityCursor: 25 }),
                })],
            },
        });
        expect(attempt).toBe(1);
    });

    it('returns successful reads and failed plugin IDs independently', async () => {
        const failedPluginId = 'com.acme.failed';
        const hydrator = createActivePluginAccountAvailabilityProjectionHydrator({
            captureLifetime: () => ({
                scope,
                isCurrent: () => true,
                onRetire: () => ({ dispose: () => {} }),
            }),
            getServerSnapshot: () => ({ serverId: scope.serverId, generation: 4 }),
            captureRequestAuthority: async () => ({
                request: async (path, init) => {
                    if (path === PluginAvailabilityActionHttpPathsV1['account.plugins.availability.materializations.read']) {
                        return jsonResponse(materializationSnapshot(23, []));
                    }
                    if (path === PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intents.list']) {
                        return jsonResponse({ ...intentList(24, [pluginId], 25),
                            pluginIds: [failedPluginId, pluginId], failedPluginIds: [failedPluginId] });
                    }
                    throw new Error(`Unexpected Availability path: ${path}`);
                },
            }),
        });

        await expect(hydrator.refresh()).resolves.toMatchObject({
            failedPluginIds: [failedPluginId],
            snapshot: {
                availabilityCursor: 23,
                intentReads: [expect.objectContaining({
                    pluginId,
                    response: expect.objectContaining({ availabilityCursor: 25 }),
                })],
            },
        });
    });

    it('retains admitted materializations with an incomplete census when intent discovery is unavailable', async () => {
        const hydrator = createActivePluginAccountAvailabilityProjectionHydrator({
            captureLifetime: () => ({
                scope,
                isCurrent: () => true,
                onRetire: () => ({ dispose: () => {} }),
            }),
            getServerSnapshot: () => ({ serverId: scope.serverId, generation: 4 }),
            captureRequestAuthority: async () => ({
                request: async (path, init) => {
                    if (path === PluginAvailabilityActionHttpPathsV1['account.plugins.availability.materializations.read']) {
                        return jsonResponse(materializationSnapshot(23, [pluginId]));
                    }
                    if (path === PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intents.list']) {
                        return jsonErrorResponse(404, {
                            error: 'Not found',
                            path,
                            method: 'POST',
                        });
                    }
                    throw new Error(`Unexpected Availability path: ${path}`);
                },
            }),
        });

        await expect(hydrator.refresh()).resolves.toMatchObject({
            intentCensusIncomplete: true,
            failedPluginIds: [pluginId],
            snapshot: { intentReads: [], materializations: [{ pluginId }] },
        });
    });

    it('does not admit a missing-route response as an empty census', async () => {
        const hydrator = createActivePluginAccountAvailabilityProjectionHydrator({
            captureLifetime: () => ({
                scope,
                isCurrent: () => true,
                onRetire: () => ({ dispose: () => {} }),
            }),
            getServerSnapshot: () => ({ serverId: scope.serverId, generation: 4 }),
            captureRequestAuthority: async () => ({
                request: async (path) => {
                    if (path === PluginAvailabilityActionHttpPathsV1['account.plugins.availability.materializations.read']) {
                        return jsonResponse(materializationSnapshot(23, [pluginId]));
                    }
                    if (path === PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intents.list']) {
                        return jsonErrorResponse(404, {
                            error: 'Not found',
                            path,
                            method: 'POST',
                            detail: 'proxy route miss',
                        });
                    }
                    throw new Error(`Unexpected Availability path: ${path}`);
                },
            }),
        });

        await expect(hydrator.refresh()).resolves.toMatchObject({
            intentCensusIncomplete: true,
            failedPluginIds: [pluginId],
            snapshot: { intentReads: [], materializations: [{ pluginId }] },
        });
    });

    it.each([
        ['a non-404 status', 503, {
            error: 'Not found',
            path: PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intents.list'],
            method: 'POST',
        }],
        ['an authentication failure', 401, {
            error: 'Not found',
            path: PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intents.list'],
            method: 'POST',
        }],
        ['a wrong error body', 404, {
            error: 'not found',
            path: PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intents.list'],
            method: 'POST',
        }],
        ['a wrong path', 404, {
            error: 'Not found',
            path: '/v1/plugins/availability/intents/other',
            method: 'POST',
        }],
        ['a wrong method', 404, {
            error: 'Not found',
            path: PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intents.list'],
            method: 'GET',
        }],
        ['a missing path', 404, {
            error: 'Not found',
            method: 'POST',
        }],
        ['a missing method', 404, {
            error: 'Not found',
            path: PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intents.list'],
        }],
        ['a bare JSON value', 404, null],
        ['an extra field', 404, {
            error: 'Not found',
            path: PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intents.list'],
            method: 'POST',
            detail: 'proxy route miss',
        }],
    ])('does not fall back to per-ID reads for %s', async (_label, status, body) => {
        const requestedPaths: string[] = [];
        const hydrator = createActivePluginAccountAvailabilityProjectionHydrator({
            captureLifetime: () => ({
                scope,
                isCurrent: () => true,
                onRetire: () => ({ dispose: () => {} }),
            }),
            getServerSnapshot: () => ({ serverId: scope.serverId, generation: 4 }),
            captureRequestAuthority: async () => ({
                request: async (path) => {
                    requestedPaths.push(path);
                    if (path === PluginAvailabilityActionHttpPathsV1['account.plugins.availability.materializations.read']) {
                        return jsonResponse(materializationSnapshot(23, [pluginId]));
                    }
                    if (path === PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intents.list']) {
                        return jsonErrorResponse(status, body);
                    }
                    throw new Error(`Unexpected Availability path: ${path}`);
                },
            }),
        });

        await expect(hydrator.refresh()).resolves.toMatchObject({
            intentCensusIncomplete: true,
            failedPluginIds: [pluginId],
            snapshot: { intentReads: [], materializations: [{ pluginId }] },
        });
        expect(requestedPaths).toEqual([
            PluginAvailabilityActionHttpPathsV1['account.plugins.availability.materializations.read'],
            PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intents.list'],
        ]);
    });

    it.each([
        ['a bare route-missing response', () => new Response(null, { status: 404 })],
        ['a malformed route-missing response', () => new Response('not JSON', { status: 404 })],
        ['a request transport failure', () => {
            throw new Error('Availability discovery transport failed');
        }],
        ['a malformed successful discovery response', () => jsonResponse({
            availabilityCursor: 23,
            pluginIds: [pluginId],
            unexpected: true,
        })],
    ] as const)('does not fall back to per-ID reads for %s', async (_label, responseFactory) => {
        const requestedPaths: string[] = [];
        const hydrator = createActivePluginAccountAvailabilityProjectionHydrator({
            captureLifetime: () => ({
                scope,
                isCurrent: () => true,
                onRetire: () => ({ dispose: () => {} }),
            }),
            getServerSnapshot: () => ({ serverId: scope.serverId, generation: 4 }),
            captureRequestAuthority: async () => ({
                request: async (path) => {
                    requestedPaths.push(path);
                    if (path === PluginAvailabilityActionHttpPathsV1['account.plugins.availability.materializations.read']) {
                        return jsonResponse(materializationSnapshot(23, [pluginId]));
                    }
                    if (path === PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intents.list']) {
                        return responseFactory();
                    }
                    throw new Error(`Unexpected Availability path: ${path}`);
                },
            }),
        });

        await expect(hydrator.refresh()).resolves.toMatchObject({
            intentCensusIncomplete: true,
            failedPluginIds: [pluginId],
            snapshot: { intentReads: [], materializations: [{ pluginId }] },
        });
        expect(requestedPaths).toEqual([
            PluginAvailabilityActionHttpPathsV1['account.plugins.availability.materializations.read'],
            PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intents.list'],
        ]);
    });

    it('does not treat a current Account-not-found response as old-route compatibility', async () => {
        const hydrator = createActivePluginAccountAvailabilityProjectionHydrator({
            captureLifetime: () => ({
                scope,
                isCurrent: () => true,
                onRetire: () => ({ dispose: () => {} }),
            }),
            getServerSnapshot: () => ({ serverId: scope.serverId, generation: 4 }),
            captureRequestAuthority: async () => ({
                request: async (path) => {
                    if (path === PluginAvailabilityActionHttpPathsV1['account.plugins.availability.materializations.read']) {
                        return jsonResponse(materializationSnapshot(23, []));
                    }
                    if (path === PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intents.list']) {
                        return jsonErrorResponse(404, {
                            error: 'plugin_account_not_found',
                        });
                    }
                    throw new Error(`Unexpected Availability path: ${path}`);
                },
            }),
        });

        await expect(hydrator.refresh()).resolves.toMatchObject({
            intentCensusIncomplete: true,
            snapshot: { intentReads: [], materializations: [] },
        });
    });

    it('does not infer an empty census when intent discovery returns a non-404 failure', async () => {
        const hydrator = createActivePluginAccountAvailabilityProjectionHydrator({
            captureLifetime: () => ({
                scope,
                isCurrent: () => true,
                onRetire: () => ({ dispose: () => {} }),
            }),
            getServerSnapshot: () => ({ serverId: scope.serverId, generation: 4 }),
            captureRequestAuthority: async () => ({
                request: async (path) => {
                    if (path === PluginAvailabilityActionHttpPathsV1['account.plugins.availability.materializations.read']) {
                        return jsonResponse(materializationSnapshot(23, []));
                    }
                    if (path === PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intents.list']) {
                        return new Response(null, { status: 503 });
                    }
                    throw new Error(`Unexpected Availability path: ${path}`);
                },
            }),
        });

        await expect(hydrator.refresh()).resolves.toMatchObject({
            intentCensusIncomplete: true,
            snapshot: { intentReads: [], materializations: [] },
        });
    });

    it('does not publish a response after the captured Account lifetime retires', async () => {
        let current = true;
        let resolveResponse!: (response: Response) => void;
        const pendingResponse = new Promise<Response>((resolve) => {
            resolveResponse = resolve;
        });
        const hydrator = createActivePluginAccountAvailabilityProjectionHydrator({
            captureLifetime: () => ({
                scope,
                isCurrent: () => current,
                onRetire: () => ({ dispose: () => {} }),
            }),
            getServerSnapshot: () => ({ serverId: scope.serverId, generation: 4 }),
            captureRequestAuthority: async () => ({
                request: async (path) => {
                    if (path === PluginAvailabilityActionHttpPathsV1['account.plugins.availability.materializations.read']) {
                        return pendingResponse;
                    }
                    if (path === PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intents.list']) {
                        return jsonResponse(intentList(17, [pluginId]));
                    }
                    throw new Error(`Unexpected Availability path: ${path}`);
                },
            }),
        });

        const pending = hydrator.refresh();
        await Promise.resolve();
        current = false;
        resolveResponse(jsonResponse(materializationSnapshot(17, [pluginId])));

        await expect(pending).resolves.toBeNull();
    });

    it.each([
        ['reset', 'intent discovery'],
        ['Availability invalidation', 'intent discovery'],
        ['reset', 'materializations'],
        ['Availability invalidation', 'materializations'],
    ] as const)(
        'does not publish a projection when a %s supersedes an in-flight %s',
        async (supersession, pendingStage) => {
            let resolvePendingResponse!: (response: Response) => void;
            let pendingReadStarted = false;
            const pendingResponse = new Promise<Response>((resolve) => {
                resolvePendingResponse = resolve;
            });
            const hydrator = createActivePluginAccountAvailabilityProjectionHydrator({
                captureLifetime: () => ({
                    scope,
                    isCurrent: () => true,
                    onRetire: () => ({ dispose: () => {} }),
                }),
                getServerSnapshot: () => ({ serverId: scope.serverId, generation: 4 }),
                captureRequestAuthority: async () => ({
                    request: async (path) => {
                        if (path === PluginAvailabilityActionHttpPathsV1['account.plugins.availability.materializations.read']) {
                            if (pendingStage === 'materializations') {
                                pendingReadStarted = true;
                                return pendingResponse;
                            }
                            return jsonResponse(materializationSnapshot(23, [pluginId]));
                        }
                        if (path === PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intents.list']) {
                            if (pendingStage === 'intent discovery') {
                                pendingReadStarted = true;
                                return pendingResponse;
                            }
                            return jsonResponse(intentList(23, [pluginId]));
                        }
                        throw new Error(`Unexpected Availability path: ${path}`);
                    },
                }),
            });

            const pending = hydrator.refresh();
            await vi.waitFor(() => expect(pendingReadStarted).toBe(true));
            if (supersession === 'reset') {
                hydrator.reset();
            } else {
                expect(hydrator.invalidate([{
                    cursor: 24,
                    kind: 'pluginDomain',
                    entityId: `pluginDomain/${pluginId}/availability`,
                    changedAt: 1,
                    hint: { pluginDomain: 'availability', pluginId },
                }])).toEqual([pluginId]);
            }
            resolvePendingResponse(
                pendingStage === 'intent discovery'
                    ? jsonResponse(intentList(23, [pluginId]))
                    : jsonResponse(materializationSnapshot(23, [pluginId])),
            );

            await expect(pending).resolves.toBeNull();
        },
    );

    it('keeps an Account-switch late response from replacing the new Account projection', async () => {
        const nextScope = { serverId: 'srv-b', accountId: 'account-b' } as const;
        let activeScope: typeof scope | typeof nextScope = scope;
        let resolveFirstMaterializations!: (response: Response) => void;
        const firstMaterializations = new Promise<Response>((resolve) => {
            resolveFirstMaterializations = resolve;
        });
        const hydrator = createActivePluginAccountAvailabilityProjectionHydrator({
            captureLifetime: () => {
                const capturedScope = activeScope;
                return {
                    scope: capturedScope,
                    isCurrent: () => activeScope === capturedScope,
                    onRetire: () => ({ dispose: () => {} }),
                };
            },
            getServerSnapshot: () => ({ serverId: activeScope.serverId, generation: 4 }),
            captureRequestAuthority: async (capturedScope) => ({
                request: async (path, init) => {
                    if (
                        capturedScope.accountId === scope.accountId
                        && path === PluginAvailabilityActionHttpPathsV1['account.plugins.availability.materializations.read']
                    ) {
                        return firstMaterializations;
                    }
                    if (path === PluginAvailabilityActionHttpPathsV1['account.plugins.availability.materializations.read']) {
                        return jsonResponse(materializationSnapshot(31, [pluginId]));
                    }
                    if (path === PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intents.list']) {
                        return jsonResponse(intentList(31, [pluginId]));
                    }
                    throw new Error(`Unexpected Availability path: ${path}`);
                },
            }),
        });

        const staleRefresh = hydrator.refresh();
        await Promise.resolve();
        activeScope = nextScope;

        await expect(hydrator.refresh()).resolves.toMatchObject({
            scope: nextScope,
            snapshot: { availabilityCursor: 31 },
        });
        resolveFirstMaterializations(jsonResponse(materializationSnapshot(23, [pluginId])));

        await expect(staleRefresh).resolves.toBeNull();
    });
});
