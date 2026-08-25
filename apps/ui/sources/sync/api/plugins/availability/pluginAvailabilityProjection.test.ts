import { describe, expect, it, vi } from 'vitest';

import {
    PluginAvailabilityActionHttpPathsV1,
} from '@happier-dev/protocol/plugins/availability';

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
            revision: 1,
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
    return {
        availabilityCursor: cursor,
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
    };
}

describe('active Plugin Account Availability projection hydrator', () => {
    it('hydrates one coherent initial projection from the canonical materialization and intent reads', async () => {
        let current = true;
        const request = vi.fn(async (path: string, init?: RequestInit) => {
            if (path === PluginAvailabilityActionHttpPathsV1['account.plugins.availability.materializations.read']) {
                return jsonResponse(materializationSnapshot(17, [pluginId]));
            }
            if (path === PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intents.list']) {
                return jsonResponse({ availabilityCursor: 17, pluginIds: [pluginId] });
            }
            const body = JSON.parse(String(init?.body ?? '{}')) as { pluginId: string };
            return jsonResponse(intentRead(17, body.pluginId));
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
                    revision: 1,
                    materializations: [expect.objectContaining({ pluginId })],
                }],
            },
        });
        expect(request.mock.calls.map(([path]) => path)).toEqual([
            PluginAvailabilityActionHttpPathsV1['account.plugins.availability.materializations.read'],
            PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intents.list'],
            PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intent.read'],
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
                                revision: 9,
                                materializations: [],
                            }],
                        });
                    }
                    if (path === PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intents.list']) {
                        return jsonResponse({
                            availabilityCursor: 23,
                            pluginIds: [pluginId],
                        });
                    }
                    const body = JSON.parse(String(init?.body ?? '{}')) as { pluginId: string };
                    requestedPluginIds.push(body.pluginId);
                    return jsonResponse(intentRead(23, body.pluginId));
                },
            }),
        });
        expect(hydrator.invalidate([{
            cursor: 23,
            kind: 'pluginDomain',
            entityId: `pluginDomain/${pluginId}/availability`,
            changedAt: 1,
            hint: { pluginDomain: 'availability', pluginId },
        }])).toBe(true);

        await expect(hydrator.refresh()).resolves.toMatchObject({
            snapshot: {
                intentReads: [expect.objectContaining({ pluginId })],
                materializations: [],
                snapshots: [{
                    serverIdentityId: 'srv_identity',
                    machineId: 'machine-empty',
                    revision: 9,
                    materializations: [],
                }],
            },
        });
        expect(requestedPluginIds).toEqual([pluginId]);

        hydrator.reset();
        await expect(hydrator.refresh()).resolves.toMatchObject({
            snapshot: {
                intentReads: [expect.objectContaining({ pluginId })],
                snapshots: [expect.objectContaining({ machineId: 'machine-empty', revision: 9 })],
            },
        });
        expect(requestedPluginIds).toEqual([pluginId, pluginId]);
        expect(requestedPaths).toContain(
            PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intents.list'],
        );
    });

    it('retries rather than committing when intent discovery has a different Account cursor', async () => {
        let attempt = 0;
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
                        attempt += 1;
                        return jsonResponse(materializationSnapshot(attempt === 1 ? 23 : 25, []));
                    }
                    if (path === PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intents.list']) {
                        return jsonResponse({
                            availabilityCursor: attempt === 1 ? 24 : 25,
                            pluginIds: [pluginId],
                        });
                    }
                    return jsonResponse(intentRead(attempt === 1 ? 23 : 25, pluginId));
                },
            }),
        });

        await expect(hydrator.refresh()).resolves.toMatchObject({
            snapshot: {
                availabilityCursor: 25,
                intentReads: [expect.objectContaining({
                    pluginId,
                    response: expect.objectContaining({ availabilityCursor: 25 }),
                })],
            },
        });
        expect(attempt).toBe(2);
    });

    it('retries rather than committing when a per-intent read has a different Account cursor', async () => {
        let attempt = 0;
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
                        attempt += 1;
                        return jsonResponse(materializationSnapshot(attempt === 1 ? 23 : 25, []));
                    }
                    if (path === PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intents.list']) {
                        return jsonResponse({
                            availabilityCursor: attempt === 1 ? 23 : 25,
                            pluginIds: [pluginId],
                        });
                    }
                    return jsonResponse(intentRead(attempt === 1 ? 24 : 25, pluginId));
                },
            }),
        });

        await expect(hydrator.refresh()).resolves.toMatchObject({
            snapshot: {
                availabilityCursor: 25,
                intentReads: [expect.objectContaining({
                    pluginId,
                    response: expect.objectContaining({ availabilityCursor: 25 }),
                })],
            },
        });
        expect(attempt).toBe(2);
    });

    it('keeps the incumbent materialization discovery when an older server does not support intent discovery', async () => {
        let intentDiscoveryRequests = 0;
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
                        intentDiscoveryRequests += 1;
                        return jsonErrorResponse(404, {
                            error: 'Not found',
                            path,
                            method: 'POST',
                        });
                    }
                    const body = JSON.parse(String(init?.body ?? '{}')) as { pluginId: string };
                    return jsonResponse(intentRead(23, body.pluginId));
                },
            }),
        });

        await expect(hydrator.refresh()).resolves.toMatchObject({
            snapshot: { intentReads: [expect.objectContaining({ pluginId })] },
        });
        expect(intentDiscoveryRequests).toBe(1);
    });

    it('fails closed on a 404 that only resembles the exact older Fastify route-missing envelope', async () => {
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

        await expect(hydrator.refresh()).rejects.toThrow('status 404');
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

        await expect(hydrator.refresh()).rejects.toThrow(`status ${status}`);
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

        await expect(hydrator.refresh()).rejects.toThrow();
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

        await expect(hydrator.refresh()).rejects.toThrow('status 404');
    });

    it('fails closed when supported intent discovery returns a non-404 failure', async () => {
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

        await expect(hydrator.refresh()).rejects.toThrow('status 503');
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
                        return jsonResponse({ availabilityCursor: 17, pluginIds: [pluginId] });
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
        ['reset', 'per-intent read'],
        ['Availability invalidation', 'per-intent read'],
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
                            return jsonResponse(materializationSnapshot(23, [pluginId]));
                        }
                        if (path === PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intents.list']) {
                            if (pendingStage === 'intent discovery') {
                                pendingReadStarted = true;
                                return pendingResponse;
                            }
                            return jsonResponse({ availabilityCursor: 23, pluginIds: [pluginId] });
                        }
                        if (pendingStage === 'per-intent read') {
                            pendingReadStarted = true;
                            return pendingResponse;
                        }
                        return jsonResponse(intentRead(23, pluginId));
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
                }])).toBe(true);
            }
            resolvePendingResponse(
                pendingStage === 'intent discovery'
                    ? jsonResponse({ availabilityCursor: 23, pluginIds: [pluginId] })
                    : jsonResponse(intentRead(23, pluginId)),
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
                        return jsonResponse({ availabilityCursor: 31, pluginIds: [pluginId] });
                    }
                    const body = JSON.parse(String(init?.body ?? '{}')) as { pluginId: string };
                    return jsonResponse(intentRead(31, body.pluginId));
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
