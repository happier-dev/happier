import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
    PluginUiArtifactDigestV1Schema,
    PLUGIN_UI_HOST_API_VERSION_V1,
    PLUGIN_UI_HOST_METHODS_V1,
    type ComposerContentHandleV1,
    type PluginUiHostApiRequestEnvelopeV1,
    type PluginUiJsonValueV1,
    type PluginUiSurfaceContextV1,
} from '@happier-dev/protocol/plugins/ui';
import type { PluginReference } from '@happier-dev/plugin-sdk';
import type { ResourceSubscriptionEvent, SurfaceContext } from '@happier-dev/plugin-sdk/ui';
import { describe, expect, it, vi } from 'vitest';

import { createPluginSurfaceContextFixture } from '@/dev/testkit/fixtures/pluginSurfaceContextFixture';
import {
    createPluginSurfaceHostApi,
    type PluginSurfaceHostApiHandlers,
} from '@/components/plugins/surfaces/createPluginSurfaceHostApi';
import {
    createPluginSurfaceOpenableContentHandlers,
    type PluginSurfaceOpenableContentBinding,
} from '@/components/plugins/surfaces/pluginSurfaceOpenableContent';

import {
    createCanonicalPluginReactNativeHostApiAdapter,
} from './hostApi';

const surface: PluginUiSurfaceContextV1 = {
    pluginId: 'acme.preview',
    contributionId: 'native-preview',
    surfaceId: 'surface_1',
    sessionId: 'session-1',
    placement: 'sessionPane',
    platform: 'ios',
    channel: 'internal',
    resourceScope: [],
    diagnostics: [],
};

const canonicalRightPaneMount = {
    kind: 'destination',
    destination: { pluginId: 'acme.preview', localId: 'native-preview' },
    container: 'rightPane',
} as const satisfies SurfaceContext['mount'];

function readProductionSource(relativePath: string): string {
    return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8');
}

describe('canonical React Native plugin Host API adapter', () => {
    it('has no predecessor public adapter or render-context branch', () => {
        // This is an API/removal contract, not a type-only assertion: keeping
        // any one of these paths would let a mounted RN bundle bypass the
        // canonical RenderContext owner. The host-private Protocol request
        // envelope remains intentionally outside this census.
        const hostApiSource = readProductionSource('./hostApi.ts');
        const surfaceSource = readProductionSource('./PluginReactNativeSurface.tsx');
        const hostSource = readProductionSource('../surfaces/PluginSurfaceHost.tsx');

        expect(hostApiSource).not.toContain('PluginReactNativeHostApiV1');
        expect(hostApiSource).not.toContain('createPluginReactNativeHostApiAdapter');
        expect(hostApiSource).not.toContain('createPluginReactNativeSurfaceRenderContext');
        expect(hostApiSource).not.toContain('legacySurface');
        expect(surfaceSource).not.toContain('PluginReactNativeSurfaceRenderContext');
        expect(surfaceSource).not.toContain('isPluginReactNativeHostApi');
        expect(surfaceSource).not.toContain('legacyRenderContext');
        expect(hostSource).not.toContain('createPluginReactNativeHostApiAdapter');
        expect(hostSource).not.toContain('legacyHostApiAdapter');
    });

    it('preserves settled one-shot side effects when generation retirement races result delivery', async () => {
        const canonicalSurface = createPluginSurfaceContextFixture({
            mount: canonicalRightPaneMount,
            target: { kind: 'session', sessionId: 'session-1' },
        });
        const operations = [
            {
                expected: { token: 'known-success' },
                invoke: (adapter: ReturnType<typeof createCanonicalPluginReactNativeHostApiAdapter>) =>
                    adapter.api.executeAction('plugin.preview.open', null),
            },
            {
                expected: undefined,
                invoke: (adapter: ReturnType<typeof createCanonicalPluginReactNativeHostApiAdapter>) =>
                    adapter.api.openSurface('plugin.preview.details'),
            },
            {
                expected: undefined,
                invoke: (adapter: ReturnType<typeof createCanonicalPluginReactNativeHostApiAdapter>) =>
                    adapter.api.writeClipboard('known output'),
            },
            {
                expected: undefined,
                invoke: (adapter: ReturnType<typeof createCanonicalPluginReactNativeHostApiAdapter>) =>
                    adapter.api.openExternalLink('https://docs.example.test/plugin'),
            },
        ];

        for (const operation of operations) {
            let adapter: ReturnType<typeof createCanonicalPluginReactNativeHostApiAdapter>;
            adapter = createCanonicalPluginReactNativeHostApiAdapter({
                surface: canonicalSurface,
                requestSurface: surface,
                requestIdPrefix: 'rn-v2',
                handleRequest: async () => {
                    adapter.dispose();
                    return { token: 'known-success' };
                },
                installedMethods: PLUGIN_UI_HOST_METHODS_V1,
            });

            await expect(operation.invoke(adapter)).resolves.toEqual(operation.expected);
        }
    });

    it('serializes openSurface with its canonical destination identity', async () => {
        const requests: PluginUiHostApiRequestEnvelopeV1[] = [];
        const adapter = createCanonicalPluginReactNativeHostApiAdapter({
            surface: createPluginSurfaceContextFixture({
                mount: canonicalRightPaneMount,
                target: { kind: 'session', sessionId: 'session-1' },
            }),
            requestSurface: surface,
            requestIdPrefix: 'rn-open-surface',
            handleRequest: async (request) => {
                requests.push(request);
                return {};
            },
            installedMethods: ['openSurface'],
        });

        await adapter.api.openSurface(
            { pluginId: 'acme.preview', localId: 'details' },
            { itemId: 'item-7' },
            { subPath: 'review/item-7', instanceKey: 'review-7' },
        );

        // `view` was the retired local transport spelling. This must prove the
        // actual mounted request carries the one Protocol-owned destination
        // identity, including every supported launch selector.
        expect(requests).toHaveLength(1);
        expect(requests[0]?.method).toBe('openSurface');
        expect(requests[0]?.payload).toEqual({
            destination: { pluginId: 'acme.preview', localId: 'details' },
            input: { itemId: 'item-7' },
            subPath: 'review/item-7',
            instanceKey: 'review-7',
        });
    });

    it('forwards Composer media through the one bounded host request transport', async () => {
        const requests: PluginUiHostApiRequestEnvelopeV1[] = [];
        const handle = {
            v: 1,
            id: 'stage-1',
            executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
            owner: { pluginId: 'acme.preview', localId: 'issue' },
            mediaKind: 'image' as const,
            mimeType: 'image/png' as const,
            name: 'issue.png',
            sizeBytes: 3,
            sha256: 'a'.repeat(64),
        } satisfies ComposerContentHandleV1;
        const adapter = createCanonicalPluginReactNativeHostApiAdapter({
            surface: createPluginSurfaceContextFixture({
                mount: canonicalRightPaneMount,
                target: { kind: 'session', sessionId: 'session-1' },
            }),
            requestSurface: surface,
            requestIdPrefix: 'rn-composer-media',
            handleRequest: async (request) => {
                requests.push(request);
                if (request.method === 'pickComposerMedia') return handle;
                if (request.method === 'inspectComposerContent') {
                    return { offset: 0, bytesBase64: 'AQID', eof: true };
                }
                return null;
            },
            installedMethods: [
                'pickComposerMedia',
                'inspectComposerContent',
                'releaseComposerContent',
            ],
        });

        await expect(adapter.api.pickComposerMedia(
            { kind: 'session', sessionId: 'session-1' },
            { attachmentLocalId: 'issue', kinds: ['image'] },
        )).resolves.toEqual(handle);
        await expect(adapter.api.inspectComposerContent(handle, {
            offset: 0,
            maxBytes: 3,
        })).resolves.toEqual({
            offset: 0,
            bytes: new Uint8Array([1, 2, 3]),
            eof: true,
        });
        await expect(adapter.api.releaseComposerContent(handle)).resolves.toBeUndefined();

        expect(requests.map((request) => ({ method: request.method, payload: request.payload }))).toEqual([
            {
                method: 'pickComposerMedia',
                payload: {
                    ref: { kind: 'session', sessionId: 'session-1' },
                    request: { attachmentLocalId: 'issue', kinds: ['image'] },
                },
            },
            {
                method: 'inspectComposerContent',
                payload: {
                    handle,
                    request: { offset: 0, maxBytes: 3 },
                },
            },
            {
                method: 'releaseComposerContent',
                payload: { handle },
            },
        ]);
    });

    it('delivers an exact Composer snapshot through the mounted subscription transport', async () => {
        const requests: PluginUiHostApiRequestEnvelopeV1[] = [];
        const adapter = createCanonicalPluginReactNativeHostApiAdapter({
            surface: createPluginSurfaceContextFixture({
                mount: canonicalRightPaneMount,
                target: { kind: 'session', sessionId: 'session-1' },
            }),
            requestSurface: surface,
            requestIdPrefix: 'rn-composer-watch',
            handleRequest: async (request) => {
                requests.push(request);
                return null;
            },
            installedMethods: ['watchComposer'],
        });
        const observed = vi.fn();
        const subscription = await adapter.api.watchComposer(
            { kind: 'session', sessionId: 'session-1' },
            observed,
        );
        const subscriptionId = (requests[0]?.payload as { subscriptionId?: string })?.subscriptionId;

        expect(subscriptionId).toEqual(expect.any(String));
        expect(adapter.publishComposerSubscriptionEvent({
            subscriptionId: subscriptionId!,
            snapshot: {
                revision: 4,
                ref: { kind: 'session', sessionId: 'session-1' },
                text: 'changed',
                references: [],
                attachments: [],
                layout: 'wrap',
                capabilities: { text: true, references: true, attachments: true, submit: true },
                state: { focused: true, editable: true, submittable: true, submitting: false, running: false },
            },
        })).toBe(true);
        expect(observed).toHaveBeenCalledWith(expect.objectContaining({ text: 'changed', revision: 4 }));
        subscription.dispose();
    });

    it.each([
        {
            name: 'Composer watch',
            method: 'watchComposer' as const,
            establish: (
                adapter: ReturnType<typeof createCanonicalPluginReactNativeHostApiAdapter>,
                signal: AbortSignal,
            ) => adapter.api.watchComposer(
                { kind: 'session', sessionId: 'session-1' },
                () => undefined,
                { signal },
            ),
        },
        {
            name: 'Composer input lock',
            method: 'acquireComposerInputLock' as const,
            establish: (
                adapter: ReturnType<typeof createCanonicalPluginReactNativeHostApiAdapter>,
                signal: AbortSignal,
            ) => adapter.api.acquireComposerInputLock(
                { kind: 'session', sessionId: 'session-1' },
                { reason: 'Saving attachment', mode: 'submit' },
                { signal },
            ),
        },
    ])('cancels a parked $name establishment and retires its late acknowledgement', async ({ method, establish }) => {
        const controller = new AbortController();
        let subscriptionId: string | undefined;
        let requestSignal: AbortSignal | undefined;
        let resolveEstablishment: ((value: PluginUiJsonValueV1) => void) | undefined;
        const disposedSubscriptionIds: string[] = [];
        const adapter = createCanonicalPluginReactNativeHostApiAdapter({
            surface: createPluginSurfaceContextFixture({
                mount: canonicalRightPaneMount,
                target: { kind: 'session', sessionId: 'session-1' },
            }),
            requestSurface: surface,
            requestIdPrefix: `rn-${method}-abort`,
            handleRequest: async (request, options) => {
                if (request.method === method) {
                    const candidate = (request.payload as Readonly<{ subscriptionId?: unknown }> | undefined)
                        ?.subscriptionId;
                    if (typeof candidate !== 'string') throw new Error('expected_composer_subscription_id');
                    subscriptionId = candidate;
                    requestSignal = options?.signal;
                    return await new Promise<PluginUiJsonValueV1>((resolve) => {
                        resolveEstablishment = resolve;
                    });
                }
                if (request.method === 'disposeHostResource') {
                    const candidate = (request.payload as Readonly<{ subscriptionId?: unknown }> | undefined)
                        ?.subscriptionId;
                    if (typeof candidate !== 'string') throw new Error('expected_composer_subscription_id');
                    disposedSubscriptionIds.push(candidate);
                }
                return null;
            },
            installedMethods: [method],
        });
        const establishment = establish(adapter, controller.signal);

        try {
            await vi.waitFor(() => {
                expect(subscriptionId).toEqual(expect.any(String));
                expect(requestSignal).toBe(controller.signal);
            });

            controller.abort();

            await expect(establishment).rejects.toMatchObject({
                code: 'unavailable',
                diagnostics: ['aborted'],
            });
            resolveEstablishment?.(null);
            await vi.waitFor(() => {
                expect(disposedSubscriptionIds).toContain(subscriptionId);
            });
        } finally {
            controller.abort();
            resolveEstablishment?.(null);
            await establishment.catch(() => undefined);
            adapter.dispose();
        }
    });

    it('retires an established Composer input lock when the mounted adapter disposes', async () => {
        const requests: PluginUiHostApiRequestEnvelopeV1[] = [];
        const adapter = createCanonicalPluginReactNativeHostApiAdapter({
            surface: createPluginSurfaceContextFixture({
                mount: canonicalRightPaneMount,
                target: { kind: 'session', sessionId: 'session-1' },
            }),
            requestSurface: surface,
            requestIdPrefix: 'rn-composer-lock-retire',
            handleRequest: async (request) => {
                requests.push(request);
                return null;
            },
            installedMethods: ['acquireComposerInputLock'],
        });

        await adapter.api.acquireComposerInputLock(
            { kind: 'session', sessionId: 'session-1' },
            { reason: 'Saving attachment', mode: 'submit' },
        );
        const subscriptionId = (requests[0]?.payload as Readonly<{ subscriptionId?: unknown }> | undefined)
            ?.subscriptionId;
        if (typeof subscriptionId !== 'string') throw new Error('expected_composer_lock_subscription_id');

        adapter.dispose();

        await vi.waitFor(() => {
            expect(requests).toContainEqual(expect.objectContaining({
                method: 'disposeHostResource',
                payload: { subscriptionId },
            }));
        });
    });

    it('binds bare openSurface destinations to the caller and preserves qualified foreign targets', async () => {
        const requests: PluginUiHostApiRequestEnvelopeV1[] = [];
        const adapter = createCanonicalPluginReactNativeHostApiAdapter({
            surface: createPluginSurfaceContextFixture({
                mount: canonicalRightPaneMount,
                target: { kind: 'session', sessionId: 'session-1' },
            }),
            requestSurface: surface,
            requestIdPrefix: 'rn-open-surface-qualified',
            handleRequest: async (request) => {
                requests.push(request);
                return {};
            },
            installedMethods: ['openSurface'],
        });

        await adapter.api.openSurface('details');
        await adapter.api.openSurface({ pluginId: 'acme.provider', localId: 'repair-account' });

        expect(requests.map((request) => request.payload)).toEqual([
            { destination: { pluginId: surface.pluginId, localId: 'details' } },
            { destination: { pluginId: 'acme.provider', localId: 'repair-account' } },
        ]);
    });

    it('rejects settled reads when generation retirement races result delivery', async () => {
        const canonicalSurface = createPluginSurfaceContextFixture({
            mount: canonicalRightPaneMount,
            target: { kind: 'session', sessionId: 'session-1' },
        });
        const operations: readonly Readonly<{
            result: PluginUiJsonValueV1;
            invoke: (
                adapter: ReturnType<typeof createCanonicalPluginReactNativeHostApiAdapter>,
            ) => Promise<unknown>;
        }>[] = [
            {
                result: {
                    contentType: 'text/plain',
                    digest: 'sha256:resource',
                    bytesBase64: 'aGVsbG8=',
                },
                invoke: (adapter: ReturnType<typeof createCanonicalPluginReactNativeHostApiAdapter>) =>
                    adapter.api.readResource('plugin.preview.resource'),
            },
            {
                result: {
                    status: 'ready',
                    contentClass: 'text',
                    mimeType: 'text/plain',
                    sizeBytes: 5,
                    revision: 'workspace-file:5:1',
                },
                invoke: (adapter: ReturnType<typeof createCanonicalPluginReactNativeHostApiAdapter>) =>
                    adapter.api.statOpenableContent({ kind: 'workspaceFile', handle: 'workspaceFile_retired' }),
            },
            {
                result: {
                    status: 'ready',
                    content: { kind: 'utf8', text: 'hello' },
                    revision: 'workspace-file:5:1',
                },
                invoke: (adapter: ReturnType<typeof createCanonicalPluginReactNativeHostApiAdapter>) =>
                    adapter.api.readOpenableContent({
                        ref: { kind: 'workspaceFile', handle: 'workspaceFile_retired' },
                        expectedRevision: 'workspace-file:5:1',
                        maxBytes: 1024,
                    }),
            },
            {
                result: { value: 'stale clipboard' },
                invoke: (adapter: ReturnType<typeof createCanonicalPluginReactNativeHostApiAdapter>) =>
                    adapter.api.readClipboard(),
            },
        ];

        for (const operation of operations) {
            let adapter: ReturnType<typeof createCanonicalPluginReactNativeHostApiAdapter>;
            adapter = createCanonicalPluginReactNativeHostApiAdapter({
                surface: canonicalSurface,
                requestSurface: surface,
                requestIdPrefix: 'rn-v2',
                handleRequest: async () => {
                    adapter.dispose();
                    return operation.result;
                },
                installedMethods: PLUGIN_UI_HOST_METHODS_V1,
            });

            await expect(operation.invoke(adapter)).rejects.toMatchObject({ code: 'stale_surface' });
        }
    });

    it('rejects a deferred active Composer result after the mounted surface retires', async () => {
        let settleActiveComposer: ((value: PluginUiJsonValueV1) => void) | undefined;
        const adapter = createCanonicalPluginReactNativeHostApiAdapter({
            surface: createPluginSurfaceContextFixture({
                mount: canonicalRightPaneMount,
                target: { kind: 'session', sessionId: 'session-1' },
            }),
            requestSurface: surface,
            requestIdPrefix: 'rn-active-composer-retirement',
            handleRequest: async (request) => {
                if (request.method !== 'activeComposer') throw new Error('expected_active_composer_request');
                return await new Promise<PluginUiJsonValueV1>((resolve) => {
                    settleActiveComposer = resolve;
                });
            },
            installedMethods: ['activeComposer'],
        });

        const activeComposer = adapter.api.activeComposer();
        await vi.waitFor(() => {
            expect(settleActiveComposer).toEqual(expect.any(Function));
        });

        adapter.dispose();
        settleActiveComposer?.(null);

        await expect(activeComposer).rejects.toMatchObject({ code: 'stale_surface' });
    });

    it('retires a resource watch only after its in-flight subscribe settles', async () => {
        let settleSubscribe: (() => void) | undefined;
        let subscribeSettled = false;
        let hostSubscriptionActive = false;
        const adapter = createCanonicalPluginReactNativeHostApiAdapter({
            surface: createPluginSurfaceContextFixture({
                mount: canonicalRightPaneMount,
                target: { kind: 'session', sessionId: 'session-1' },
            }),
            requestSurface: surface,
            requestIdPrefix: 'rn',
            handleRequest: async (request) => {
                if (request.method === 'watchResource') {
                    await new Promise<void>((resolve) => {
                        settleSubscribe = resolve;
                    });
                    hostSubscriptionActive = true;
                    subscribeSettled = true;
                }
                if (request.method === 'disposeHostResource') {
                    hostSubscriptionActive = false;
                }
                return { accepted: true };
            },
            installedMethods: ['watchResource'],
        });

        void adapter.api.watchResource(
            { pluginId: 'acme.preview', localId: 'live-status' },
            () => undefined,
        ).catch(() => undefined);
        await vi.waitFor(() => {
            expect(settleSubscribe).toBeTypeOf('function');
        });
        adapter.dispose();
        settleSubscribe?.();

        await vi.waitFor(() => {
            expect(subscribeSettled).toBe(true);
        });
        await vi.waitFor(() => {
            expect(hostSubscriptionActive).toBe(false);
        });
    });

    it('cancels a parked resource watch establishment, retires its late acknowledgement, and keeps a successor live', async () => {
        const controller = new AbortController();
        const firstDigest = PluginUiArtifactDigestV1Schema.parse(`sha256:${'a'.repeat(64)}`);
        const successorDigest = PluginUiArtifactDigestV1Schema.parse(`sha256:${'b'.repeat(64)}`);
        const invalidatedDigest = PluginUiArtifactDigestV1Schema.parse(`sha256:${'c'.repeat(64)}`);
        const disposedSubscriptionIds: string[] = [];
        const successorEvents: ResourceSubscriptionEvent[] = [];
        let firstSubscriptionId: string | undefined;
        let successorSubscriptionId: string | undefined;
        let firstSignal: AbortSignal | undefined;
        let resolveFirstWatch: ((value: PluginUiJsonValueV1) => void) | undefined;
        let watchCount = 0;
        const adapter = createCanonicalPluginReactNativeHostApiAdapter({
            surface: createPluginSurfaceContextFixture({
                mount: canonicalRightPaneMount,
                target: { kind: 'session', sessionId: 'session-1' },
            }),
            requestSurface: surface,
            requestIdPrefix: 'rn-resource-abort',
            handleRequest: async (request, options) => {
                if (request.method === 'watchResource') {
                    const subscriptionId = (request.payload as Readonly<{ subscriptionId?: unknown }> | undefined)
                        ?.subscriptionId;
                    if (typeof subscriptionId !== 'string') throw new Error('expected_resource_subscription_id');
                    watchCount += 1;
                    if (watchCount === 1) {
                        firstSubscriptionId = subscriptionId;
                        firstSignal = options?.signal;
                        return await new Promise<PluginUiJsonValueV1>((resolve) => {
                            resolveFirstWatch = resolve;
                        });
                    }
                    successorSubscriptionId = subscriptionId;
                    return { subscriptionId, digest: successorDigest };
                }
                if (request.method === 'disposeHostResource') {
                    const subscriptionId = (request.payload as Readonly<{ subscriptionId?: unknown }> | undefined)
                        ?.subscriptionId;
                    if (typeof subscriptionId !== 'string') throw new Error('expected_resource_subscription_id');
                    disposedSubscriptionIds.push(subscriptionId);
                }
                return null;
            },
            installedMethods: ['watchResource'],
        });

        const firstEstablishment = adapter.api.watchResource(
            'live-status',
            () => undefined,
            { signal: controller.signal },
        );

        try {
            await vi.waitFor(() => {
                expect(firstSubscriptionId).toBeTypeOf('string');
                expect(firstSignal).toBe(controller.signal);
            });

            controller.abort();

            await expect(firstEstablishment).rejects.toMatchObject({
                code: 'unavailable',
                diagnostics: ['aborted'],
            });
            expect(adapter.publishResourceSubscriptionEvent({
                version: 1,
                subscriptionId: firstSubscriptionId!,
                kind: 'invalidated',
                digest: invalidatedDigest,
            })).toBe(false);

            const successor = await adapter.api.watchResource(
                'live-status',
                (event) => { successorEvents.push(event); },
            );
            expect(successorSubscriptionId).toBeTypeOf('string');
            expect(adapter.publishResourceSubscriptionEvent({
                version: 1,
                subscriptionId: successorSubscriptionId!,
                kind: 'invalidated',
                digest: successorDigest,
            })).toBe(true);

            resolveFirstWatch?.({ subscriptionId: firstSubscriptionId!, digest: firstDigest });
            await vi.waitFor(() => {
                expect(disposedSubscriptionIds).toContain(firstSubscriptionId!);
                expect(disposedSubscriptionIds).not.toContain(successorSubscriptionId!);
            });
            expect(adapter.publishResourceSubscriptionEvent({
                version: 1,
                subscriptionId: successorSubscriptionId!,
                kind: 'invalidated',
                digest: invalidatedDigest,
            })).toBe(true);
            expect(successorEvents).toEqual([
                expect.objectContaining({ digest: successorDigest }),
                expect.objectContaining({ digest: invalidatedDigest }),
            ]);

            successor.dispose();
        } finally {
            adapter.dispose();
            resolveFirstWatch?.({ subscriptionId: firstSubscriptionId ?? 'rn-resource-abort:resource:1', digest: firstDigest });
            await firstEstablishment.catch(() => undefined);
        }
    });

    it('preserves the mounted watch admission digest for the shared Resource owner', async () => {
        const digest = `sha256:${'a'.repeat(64)}`;
        const adapter = createCanonicalPluginReactNativeHostApiAdapter({
            surface: createPluginSurfaceContextFixture({
                mount: canonicalRightPaneMount,
                target: { kind: 'session', sessionId: 'session-1' },
            }),
            requestSurface: surface,
            requestIdPrefix: 'rn-resource-admission',
            handleRequest: async (request) => {
                if (request.method !== 'watchResource') return null;
                const subscriptionId = (request.payload as Readonly<{ subscriptionId?: unknown }> | undefined)
                    ?.subscriptionId;
                if (typeof subscriptionId !== 'string') throw new Error('expected_resource_subscription_id');
                return { subscriptionId, digest };
            },
            installedMethods: ['watchResource'],
        });

        const subscription = await adapter.api.watchResource('live-status', () => undefined);

        // `admittedDigest` is host-private structural detail, deliberately not
        // published through the SDK Disposable type. The Resource store uses it
        // only to prove its first canonical read already converged.
        expect(Object.assign({}, subscription)).toMatchObject({ admittedDigest: digest });
        subscription.dispose();
    });

    it('delivers an invalidation published before watch establishment returns', async () => {
        const admittedDigest = `sha256:${'a'.repeat(64)}`;
        const invalidatedDigest = PluginUiArtifactDigestV1Schema.parse(`sha256:${'b'.repeat(64)}`);
        const events: Array<Readonly<{ kind: string; digest?: string }>> = [];
        let deliveredDuringEstablishment: boolean | undefined;
        let adapter!: ReturnType<typeof createCanonicalPluginReactNativeHostApiAdapter>;
        adapter = createCanonicalPluginReactNativeHostApiAdapter({
            surface: createPluginSurfaceContextFixture({
                mount: canonicalRightPaneMount,
                target: { kind: 'session', sessionId: 'session-1' },
            }),
            requestSurface: surface,
            requestIdPrefix: 'rn-resource-establishment',
            handleRequest: async (request) => {
                if (request.method !== 'watchResource') return null;
                const subscriptionId = (request.payload as Readonly<{ subscriptionId?: unknown }> | undefined)
                    ?.subscriptionId;
                if (typeof subscriptionId !== 'string') throw new Error('expected_resource_subscription_id');
                deliveredDuringEstablishment = adapter.publishResourceSubscriptionEvent({
                    version: 1,
                    subscriptionId,
                    kind: 'invalidated',
                    digest: invalidatedDigest,
                });
                return { subscriptionId, digest: admittedDigest };
            },
            installedMethods: ['watchResource'],
        });

        const subscription = await adapter.api.watchResource(
            'live-status',
            (event) => { events.push(event); },
        );

        await vi.waitFor(() => {
            expect(deliveredDuringEstablishment).toBe(true);
            expect(events).toEqual([
                expect.objectContaining({ kind: 'invalidated', digest: invalidatedDigest }),
            ]);
        });
        subscription.dispose();
    });
});

/**
 * Advertised method set vs. what the mounted host can actually serve (UI-D02).
 *
 * Both ends are production: the real canonical RN adapter over the real
 * `createPluginSurfaceHostApi` — the exact shape of the app-shell mount at
 * `PluginSurfaceHost.tsx`. Nothing here hand-builds the neighbour's envelope.
 */
describe('canonical React Native Host API advertised methods (UI-D02)', () => {
    const canonicalSurface = createPluginSurfaceContextFixture({
        mount: canonicalRightPaneMount,
        target: { kind: 'session', sessionId: 'session-1' },
    });
    const targetedSurface: SurfaceContext = {
        ...canonicalSurface,
        targetedContributions: {
            target: {
                pluginId: 'acme.preview',
                immutableGenerationId: 'target-generation-a',
            },
            points: [],
        },
    };

    function createAdapterOverHost(handlers: PluginSurfaceHostApiHandlers) {
        const host = createPluginSurfaceHostApi({
            surfaceContext: surface,
            handlers,
        });
        return createCanonicalPluginReactNativeHostApiAdapter({
            surface: canonicalSurface,
            requestSurface: surface,
            requestIdPrefix: 'rn-advertised',
            handleRequest: host.handleRequest,
            installedMethods: host.installedMethods,
        });
    }

    it('routes target-scoped selection through the sole 1.0 contract', async () => {
        const selectActionInput = vi.fn(async () => ({ kind: 'cancelled' as const }));
        const host = createPluginSurfaceHostApi({
            surfaceContext: surface,
            handlers: { selectActionInput },
        });
        const adapter = createCanonicalPluginReactNativeHostApiAdapter({
            surface: targetedSurface,
            requestSurface: surface,
            requestIdPrefix: 'rn-1.0',
            handleRequest: host.handleRequest,
            installedMethods: host.installedMethods,
        });

        const version = adapter.api.version();
        expect(version).toMatchObject({
            apiVersion: PLUGIN_UI_HOST_API_VERSION_V1,
            methods: ['context', 'watchContext', 'selectActionInput'],
        });
        // The RN direct consumer observes the one Protocol-owned semantic version.
        expect(version.apiVersion).toBe(PLUGIN_UI_HOST_API_VERSION_V1);
        await expect(adapter.api.selectActionInput({
            operation: {
                point: { pointId: 'connection', protocol: { id: 'provider', version: 1 } },
                contributor: {
                    pluginId: 'acme.provider',
                    contributionId: 'provider',
                    immutableGenerationId: 'provider-generation-a',
                },
                role: 'setup',
                action: { pluginId: 'acme.provider', localId: 'connection/prepare-v1' },
            },
        })).resolves.toEqual({ kind: 'cancelled' });
        expect(selectActionInput).toHaveBeenCalledOnce();
    });

    it('projects the literal no-invoke Session draft without an Action result', async () => {
        const serverStartDraft = {
            executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
            directory: '/workspace',
            agentTarget: {
                kind: 'agent' as const,
                identity: { pluginId: 'happier.agent.claude', localId: 'claude' },
            },
        };
        const adapter = createAdapterOverHost({
            selectActionInput: async () => ({ kind: 'serverStartDraft', draft: serverStartDraft }),
        });

        const selected = await adapter.api.selectActionInput({
            hostAction: { action: 'session.spawn_new', projection: 'serverStartDraft' },
            draft: { directory: '/workspace' },
        });

        expect(selected).toEqual({ kind: 'serverStartDraft', draft: serverStartDraft });
        expect('action' in selected).toBe(false);
    });

    it('never carries immediate-execute provenance from a host request', async () => {
        const operation = {
            point: { pointId: 'connection', protocol: { id: 'provider', version: 1 } },
            contributor: {
                pluginId: 'acme.provider',
                contributionId: 'provider',
                immutableGenerationId: 'provider-generation-a',
            },
            role: 'setup',
            action: { pluginId: 'acme.provider', localId: 'connection/prepare-v1' },
        } as const;
        let seenTargetedOperation: unknown;
        let seenSelectedActionInput: unknown;
        const adapter = createAdapterOverHost({
            // This result is structurally valid but mismatched with its request.
            // The RN adapter must use the request arm, not just the result kind,
            // when deciding whether an immediate Action association is allowed.
            selectActionInput: async () => ({
                kind: 'submitted',
                action: operation.action,
                input: { repository: 'happier-dev/happier' },
                selection: {
                    target: targetedSurface.targetedContributions!.target,
                    point: operation.point,
                    contributor: operation.contributor,
                },
                connectedAccount: { kind: 'none' },
            }),
            executeAction: async (_request, options) => {
                seenTargetedOperation = options?.targetedOperation;
                seenSelectedActionInput = options?.selectedActionInput;
                return null;
            },
        });

        const selected = await adapter.api.selectActionInput({
            hostAction: { action: 'session.spawn_new', projection: 'serverStartDraft' },
        });
        if (selected.kind !== 'submitted') throw new Error('expected structurally submitted result');
        await adapter.api.executeAction(selected.action, selected.input);

        expect(seenTargetedOperation).toBeUndefined();
        expect(seenSelectedActionInput).toBeUndefined();
    });

    it('projects target-scoped context through the sole 1.0 React Native surface', async () => {
        const host = createPluginSurfaceHostApi({
            surfaceContext: surface,
        });
        const adapter = createCanonicalPluginReactNativeHostApiAdapter({
            surface: targetedSurface,
            requestSurface: surface,
            requestIdPrefix: 'rn-context-1.0',
            handleRequest: host.handleRequest,
            installedMethods: host.installedMethods,
        });
        await expect(adapter.api.context()).resolves.toMatchObject({
            targetedContributions: targetedSurface.targetedContributions,
        });
    });

    it('preserves a selected operation only for executeAction with the exact returned Action object', async () => {
        const operation = {
            point: { pointId: 'connection', protocol: { id: 'provider', version: 1 } },
            contributor: {
                pluginId: 'acme.provider',
                contributionId: 'provider',
                immutableGenerationId: 'provider-generation-a',
            },
            role: 'setup',
            action: { pluginId: 'acme.provider', localId: 'connection/prepare-v1' },
        } as const;
        const retainedOperation = {
            point: {
                pointId: operation.point.pointId,
                protocol: { ...operation.point.protocol },
            },
            contributor: { ...operation.contributor },
            role: operation.role,
            action: { ...operation.action },
        } as const;
        let seenTargetedOperation: unknown;
        let seenSelectedActionInput: unknown;
        const host = createPluginSurfaceHostApi({
            surfaceContext: surface,
            handlers: {
                selectActionInput: async () => ({
                    kind: 'submitted',
                    action: retainedOperation.action,
                    input: { repository: 'happier-dev/happier' },
                    selection: {
                        target: targetedSurface.targetedContributions!.target,
                        point: retainedOperation.point,
                        contributor: retainedOperation.contributor,
                    },
                    connectedAccount: { kind: 'none' },
                }),
                executeAction: async (_request, options) => {
                    seenTargetedOperation = options?.targetedOperation;
                    seenSelectedActionInput = options?.selectedActionInput;
                    return null;
                },
            },
        });
        const adapter = createCanonicalPluginReactNativeHostApiAdapter({
            surface: targetedSurface,
            requestSurface: surface,
            requestIdPrefix: 'rn-selection-carrier',
            handleRequest: host.handleRequest,
            installedMethods: host.installedMethods,
        });

        const requestedOperation = structuredClone(operation);
        const selected = await adapter.api.selectActionInput({
            operation: requestedOperation,
        });
        if (selected.kind !== 'submitted') throw new Error('expected submitted selection');
        await adapter.api.executeAction(selected.action, selected.input);
        expect(seenTargetedOperation).toEqual(retainedOperation);
        expect(seenSelectedActionInput).toMatchObject({
            input: { repository: 'happier-dev/happier' },
        });

        // `Readonly` is a TypeScript affordance, not a runtime ownership
        // boundary. A plugin can mutate the returned JSON object, but that
        // must not mutate the host-private selection retained for immediate
        // execution.
        const guestSelected = structuredClone(selected);
        const preservedInput: PluginUiJsonValueV1 = { ...guestSelected.input };
        const mutableSelectedInput = guestSelected.input as { repository: string };
        mutableSelectedInput.repository = 'mutated-after-selection';
        const mutableRequestedContributor = requestedOperation.contributor as {
            immutableGenerationId: string;
        };
        mutableRequestedContributor.immutableGenerationId = 'mutated-after-selection';
        await adapter.api.executeAction(selected.action, preservedInput);
        expect(seenTargetedOperation).toEqual(retainedOperation);
        expect(seenSelectedActionInput).toMatchObject({
            input: { repository: 'happier-dev/happier' },
        });

        await adapter.api.executeAction({ ...selected.action }, selected.input);
        expect(seenTargetedOperation).toBeUndefined();
    });

    it('refuses a superseded selected Action even when its replacement has equal settlement values', async () => {
        const operation = {
            point: { pointId: 'connection', protocol: { id: 'provider', version: 1 } },
            contributor: {
                pluginId: 'acme.provider',
                contributionId: 'provider',
                immutableGenerationId: 'provider-generation-a',
            },
            role: 'setup',
            action: { pluginId: 'acme.provider', localId: 'connection/prepare-v1' },
        } as const;
        const requestHandler = vi.fn(async (request: PluginUiHostApiRequestEnvelopeV1): Promise<PluginUiJsonValueV1> => {
            if (request.method === 'selectActionInput') {
                // Each answer deliberately has a new Action identity while all
                // semantic selection values remain equal.
                return {
                    kind: 'submitted',
                    action: { ...operation.action },
                    input: { repository: 'happier-dev/happier' },
                    selection: {
                        target: targetedSurface.targetedContributions!.target,
                        point: operation.point,
                        contributor: operation.contributor,
                    },
                    connectedAccount: { kind: 'none' },
                };
            }
            if (request.method === 'executeAction') return { applied: true };
            throw new Error('unexpected_request');
        });
        const adapter = createCanonicalPluginReactNativeHostApiAdapter({
            surface: targetedSurface,
            requestSurface: surface,
            requestIdPrefix: 'rn-selection-replacement',
            handleRequest: requestHandler,
            installedMethods: ['selectActionInput', 'executeAction'],
        });

        const first = await adapter.api.selectActionInput({ operation });
        const replacement = await adapter.api.selectActionInput({ operation });
        if (first.kind !== 'submitted' || replacement.kind !== 'submitted') {
            throw new Error('expected submitted selections');
        }
        expect(first.action).not.toBe(replacement.action);

        await expect(adapter.api.executeAction(first.action, first.input)).rejects.toMatchObject({
            code: 'invalid_payload',
        });
        expect(requestHandler).toHaveBeenCalledTimes(2);

        await expect(adapter.api.executeAction(replacement.action, replacement.input)).resolves.toEqual({ applied: true });
        expect(requestHandler).toHaveBeenCalledTimes(3);
    });

    it('retires exact selected settlements before terminal dispatch, without letting stale cancellation retire a replacement', async () => {
        const operation = {
            point: { pointId: 'connection', protocol: { id: 'provider', version: 1 } },
            contributor: {
                pluginId: 'acme.provider',
                contributionId: 'provider',
                immutableGenerationId: 'provider-generation-a',
            },
            role: 'setup',
            action: { pluginId: 'acme.provider', localId: 'connection/prepare-v1' },
        } as const;
        let selectionOrdinal = 0;
        let executionOutcome: 'success' | 'failure' | 'cancelled' = 'success';
        let cancellationSeen: AbortSignal | undefined;
        const executeAction = vi.fn(async (
            request: PluginUiHostApiRequestEnvelopeV1,
            options?: Readonly<{ signal?: AbortSignal }>,
        ): Promise<PluginUiJsonValueV1> => {
            if (request.method === 'selectActionInput') {
                selectionOrdinal += 1;
                return {
                    kind: 'submitted',
                    action: operation.action,
                    input: { repository: `happier-${selectionOrdinal}` },
                    selection: {
                        target: targetedSurface.targetedContributions!.target,
                        point: operation.point,
                        contributor: operation.contributor,
                    },
                    connectedAccount: { kind: 'none' },
                };
            }
            if (request.method !== 'executeAction') throw new Error('unexpected_request');
            if (executionOutcome === 'failure') throw new Error('terminal_dispatch_failed');
            if (executionOutcome === 'cancelled') {
                return await new Promise((resolve) => {
                    options?.signal?.addEventListener('abort', () => {
                        cancellationSeen = options.signal;
                        resolve({ cancelled: true });
                    }, { once: true });
                });
            }
            return { applied: true };
        });
        const adapter = createCanonicalPluginReactNativeHostApiAdapter({
            surface: targetedSurface,
            requestSurface: surface,
            requestIdPrefix: 'rn-terminal-selected-settlement',
            handleRequest: executeAction,
            installedMethods: ['selectActionInput', 'executeAction'],
        });
        const outerAction = { pluginId: 'acme.preview', localId: 'connection/create' } as const;
        const outerInput = { providerSetupInput: { repository: 'safe' } } as const;
        const select = async (signal?: AbortSignal) => {
            const selected = await adapter.api.selectActionInput(
                { operation },
                signal === undefined ? undefined : { signal },
            );
            if (selected.kind !== 'submitted') throw new Error('expected submitted selection');
            return selected;
        };
        const carrier = (selected: Awaited<ReturnType<typeof select>>) => ({ operation, result: selected });
        const terminalOptions = (
            selected: Awaited<ReturnType<typeof select>>,
            signal?: AbortSignal,
        ) => ({
            ...(signal === undefined ? {} : { signal }),
            selectedActionInput: carrier(selected),
            // This closed mounted execution fact is intentionally absent from
            // PluginUiActionExecutionOptions: it is not a plugin author API.
            consumeSelectedActionInput: true as const,
        });

        const supersededLifetime = new AbortController();
        const superseded = await select(supersededLifetime.signal);
        const current = await select();
        supersededLifetime.abort('superseded_selection_retired');

        // An old selection signal cannot retire the newer exact settlement.
        await expect(adapter.api.executeAction(outerAction, outerInput, {
            selectedActionInput: carrier(current),
        })).resolves.toEqual({ applied: true });
        expect(executeAction).toHaveBeenCalledTimes(3);

        // Terminal success consumes before the external dispatcher sees the
        // request, so an exact raw replay has no second dispatch.
        await expect(adapter.api.executeAction(
            outerAction,
            outerInput,
            terminalOptions(current),
        )).resolves.toEqual({ applied: true });
        await expect(adapter.api.executeAction(outerAction, outerInput, {
            selectedActionInput: carrier(current),
        })).rejects.toMatchObject({ code: 'invalid_payload' });
        expect(executeAction).toHaveBeenCalledTimes(4);

        // The deletion precedes both an error and a caller cancellation; neither
        // outcome leaves a usable settlement behind.
        const failed = await select();
        executionOutcome = 'failure';
        await expect(adapter.api.executeAction(
            outerAction,
            outerInput,
            terminalOptions(failed),
        )).rejects.toMatchObject({ code: 'internal_error' });
        await expect(adapter.api.executeAction(outerAction, outerInput, {
            selectedActionInput: carrier(failed),
        })).rejects.toMatchObject({ code: 'invalid_payload' });
        expect(executeAction).toHaveBeenCalledTimes(6);

        const cancelled = await select();
        executionOutcome = 'cancelled';
        const terminalLifetime = new AbortController();
        const pending = adapter.api.executeAction(
            outerAction,
            outerInput,
            terminalOptions(cancelled, terminalLifetime.signal),
        );
        await vi.waitFor(() => expect(executeAction).toHaveBeenCalledTimes(8));
        terminalLifetime.abort('terminal_dispatch_abandoned');
        await expect(pending).resolves.toEqual({ cancelled: true });
        expect(cancellationSeen).toBe(terminalLifetime.signal);
        await expect(adapter.api.executeAction(outerAction, outerInput, {
            selectedActionInput: carrier(cancelled),
        })).rejects.toMatchObject({ code: 'invalid_payload' });
        expect(executeAction).toHaveBeenCalledTimes(8);

        const selectionLifetime = new AbortController();
        const abandoned = await select(selectionLifetime.signal);
        selectionLifetime.abort('selection_lifetime_retired');
        await expect(adapter.api.executeAction(outerAction, outerInput, {
            selectedActionInput: carrier(abandoned),
        })).rejects.toMatchObject({ code: 'invalid_payload' });
        expect(executeAction).toHaveBeenCalledTimes(9);
    });

    it('advertises only what the mounted host installs', () => {
        // A handlerless mount serves exactly the two methods answered from its
        // own validated surface snapshot — `context` (the read) and
        // `watchContext` (the push producer, UI-D03) — and advertises nothing
        // else. A constant full-vocabulary advertisement, or any hand-written
        // list, fails here.
        expect(createAdapterOverHost({}).api.version()).toEqual({
            apiVersion: PLUGIN_UI_HOST_API_VERSION_V1,
            wireVersion: 1,
            methods: ['context', 'watchContext'],
        });

        // Negative control against "advertise everything the adapter can call":
        // a mount installing one side-effecting handler grows the set by exactly
        // that method, in canonical order.
        expect(createAdapterOverHost({
            executeAction: async () => ({ accepted: true }),
        }).api.version().methods).toEqual(['context', 'watchContext', 'executeAction']);
    });

    it('derives the advertised set from the canonical vocabulary, not a local list', () => {
        // Closure, not membership: a mount installing every canonical method
        // advertises exactly the sole `PLUGIN_UI_HOST_METHODS_V1` tuple.
        // Adding a member to the canonical owner therefore flows through without
        // editing this adapter, and a stale local copy diverges immediately.
        const handlers = Object.fromEntries(
            PLUGIN_UI_HOST_METHODS_V1
                .filter((method) => method !== 'context')
                .map((method) => [method, async () => ({ accepted: true })]),
        ) as PluginSurfaceHostApiHandlers;

        expect(createAdapterOverHost(handlers).api.version().methods)
            .toEqual([...PLUGIN_UI_HOST_METHODS_V1]);
        // `watchResource` is part of the initial semantic tuple, so a mount
        // that installed the handler advertises it without a second projection.
        expect(createAdapterOverHost(handlers).api.version().methods)
            .toContain('watchResource');
        // Negative control: a mount that installed NO watch handler still does
        // not advertise it, so the claim stays factual rather than constant.
        expect(createAdapterOverHost({ executeAction: async () => ({ accepted: true }) })
            .api.version().methods).not.toContain('watchResource');
    });

    it('never answers a confirmation the author withdrew, even from a host that ignored the cancellation', async () => {
        // The mount is told to cancel, but this one answers anyway. The adapter
        // still owes the author a typed failure: resolving the boolean would be
        // a user decision delivered for a question that was withdrawn, and a
        // `false` would read as a decline nobody made.
        const controller = new AbortController();
        const adapter = createAdapterOverHost({
            confirm: async () => {
                controller.abort();
                return { confirmed: true };
            },
        });

        await expect(adapter.api.confirm('Delete the preview?', { signal: controller.signal }))
            .rejects.toMatchObject({ code: 'unavailable', diagnostics: ['aborted'] });
    });

    it('refuses an uninstalled method with a typed diagnostic instead of dispatching it', async () => {
        const adapter = createAdapterOverHost({});

        await expect(adapter.api.executeAction('plugin.preview.open', null)).rejects.toMatchObject({
            code: 'unsupported_method',
            diagnostics: ['host_api_method_not_installed:executeAction'],
        });
        await expect(adapter.api.readClipboard()).rejects.toMatchObject({
            code: 'unsupported_method',
            diagnostics: ['host_api_method_not_installed:readClipboard'],
        });
        // UI-D03: a mount with no valid surface fact installs nothing, so
        // `watchContext` cannot pretend to be a live subscription that delivers
        // one snapshot and retires nothing.
        const withoutSurfaceFact = createCanonicalPluginReactNativeHostApiAdapter({
            surface: canonicalSurface,
            requestSurface: surface,
            requestIdPrefix: 'rn-no-context',
            handleRequest: async () => ({ accepted: true }),
            installedMethods: [],
        });
        await expect(withoutSurfaceFact.api.watchContext(() => undefined)).rejects.toMatchObject({
            code: 'unsupported_method',
        });
    });

    it('serves an installed method through the real host handler', async () => {
        const seen: PluginUiHostApiRequestEnvelopeV1[] = [];
        const adapter = createAdapterOverHost({
            executeAction: async (request) => {
                seen.push(request);
                return { actionId: 'opened' };
            },
        });

        await expect(adapter.api.executeAction('plugin.preview.open', null))
            .resolves.toEqual({ actionId: 'opened' });
        expect(seen.map((request) => request.method)).toEqual(['executeAction']);
    });

    it('forwards the selected opaque openable-content binding through the real mounted host', async () => {
        const seen: PluginUiHostApiRequestEnvelopeV1[] = [];
        const signals: Array<AbortSignal | undefined> = [];
        const ref = { kind: 'workspaceFile' as const, handle: 'workspaceFile_opaque' };
        const revision = 'workspace-file:5:1';
        const controller = new AbortController();
        const adapter = createAdapterOverHost({
            statOpenableContent: async (request, options) => {
                seen.push(request);
                signals.push(options?.signal);
                return {
                    status: 'ready',
                    contentClass: 'text',
                    mimeType: 'text/plain',
                    extension: '.md',
                    sizeBytes: 5,
                    revision,
                };
            },
            readOpenableContent: async (request, options) => {
                seen.push(request);
                signals.push(options?.signal);
                return {
                    status: 'ready',
                    content: { kind: 'utf8', text: 'hello' },
                    revision,
                };
            },
        });

        await expect(adapter.api.statOpenableContent(ref, { signal: controller.signal })).resolves.toEqual({
            status: 'ready',
            contentClass: 'text',
            mimeType: 'text/plain',
            extension: '.md',
            sizeBytes: 5,
            revision,
        });
        await expect(adapter.api.readOpenableContent({
            ref,
            expectedRevision: revision,
            maxBytes: 1024,
        }, { signal: controller.signal })).resolves.toEqual({
            status: 'ready',
            content: { kind: 'utf8', text: 'hello' },
            revision,
        });

        expect(seen.map((request) => ({ method: request.method, payload: request.payload }))).toEqual([
            { method: 'statOpenableContent', payload: { ref } },
            {
                method: 'readOpenableContent',
                payload: { ref, expectedRevision: revision, maxBytes: 1024 },
            },
        ]);
        expect(signals).toEqual([controller.signal, controller.signal]);
    });

    it('composes the public stat envelope through the mounted openable-content binding', async () => {
        const ref = { kind: 'workspaceFile' as const, handle: 'workspaceFile_composed' };
        const stat = vi.fn(async () => ({
            status: 'ready' as const,
            contentClass: 'text' as const,
            mimeType: 'text/plain',
            extension: '.txt',
            sizeBytes: 4,
            revision: 'workspace-file:4:1',
        }));
        const binding = {
            ref,
            stat,
            read: async () => ({ status: 'unsupported' as const }),
        } satisfies PluginSurfaceOpenableContentBinding;
        const adapter = createAdapterOverHost(createPluginSurfaceOpenableContentHandlers({ binding }));

        await expect(adapter.api.statOpenableContent(ref)).resolves.toEqual({
            status: 'ready',
            contentClass: 'text',
            mimeType: 'text/plain',
            extension: '.txt',
            sizeBytes: 4,
            revision: 'workspace-file:4:1',
        });
        expect(stat).toHaveBeenCalledTimes(1);
    });

    it('rejects an openable-content read settled after author cancellation', async () => {
        const ref = { kind: 'workspaceFile' as const, handle: 'workspaceFile_cancelled' };
        const controller = new AbortController();
        const adapter = createAdapterOverHost({
            readOpenableContent: async (_request, options) => {
                expect(options?.signal).toBe(controller.signal);
                controller.abort();
                return { status: 'unavailable' };
            },
        });

        await expect(adapter.api.readOpenableContent({
            ref,
            expectedRevision: 'workspace-file:5:1',
            maxBytes: 1024,
        }, { signal: controller.signal }))
            .rejects.toMatchObject({ code: 'unavailable', diagnostics: ['aborted'] });
    });

    it('refuses a runtime Action reference outside the Protocol raw request grammar before forwarding', async () => {
        const handleRequest = vi.fn(async () => ({ accepted: true }));
        const adapter = createCanonicalPluginReactNativeHostApiAdapter({
            surface: canonicalSurface,
            requestSurface: surface,
            requestIdPrefix: 'rn-action-schema',
            handleRequest,
            installedMethods: ['executeAction'],
        });
        // Plugin code crosses a runtime boundary; this deliberately malformed
        // value proves the adapter does not silently strip unknown action fields.
        const malformedAction = {
            pluginId: 'acme.preview',
            localId: 'refresh',
            unexpected: true,
        } as unknown as PluginReference;

        await expect(adapter.api.executeAction(malformedAction, null)).rejects.toMatchObject({
            code: 'invalid_payload',
        });
        expect(handleRequest).not.toHaveBeenCalled();
    });
});

/**
 * UI-D03: context subscriptions on the canonical React Native transport.
 *
 * The producer is the real mount fact — the adapter's own `pushSurfaceContext`,
 * which `PluginSurfaceHost` calls when locale/theme/accessibility change. No
 * stub stands in for it.
 */
describe('canonical React Native context subscriptions (UI-D03)', () => {
    const canonicalSurface = createPluginSurfaceContextFixture({
        mount: canonicalRightPaneMount,
        target: { kind: 'session', sessionId: 'session-1' },
    });

    function createAdapter() {
        const host = createPluginSurfaceHostApi({
            surfaceContext: surface,
            handlers: {},
        });
        return createCanonicalPluginReactNativeHostApiAdapter({
            surface: canonicalSurface,
            requestSurface: surface,
            requestIdPrefix: 'rn-context',
            handleRequest: host.handleRequest,
            installedMethods: host.installedMethods,
        });
    }

    it('advertises watchContext exactly when the mount owns a surface fact', () => {
        expect(createAdapter().api.version().methods).toEqual(['context', 'watchContext']);
        // Negative control: an invalid surface snapshot installs nothing at all,
        // so the transport must not advertise a subscription it cannot serve.
        const invalid = createPluginSurfaceHostApi({
            surfaceContext: { ...surface, pluginId: '' },
            handlers: {},
        });
        expect(createCanonicalPluginReactNativeHostApiAdapter({
            surface: canonicalSurface,
            requestSurface: surface,
            requestIdPrefix: 'rn-context-invalid',
            handleRequest: invalid.handleRequest,
            installedMethods: invalid.installedMethods,
        }).api.version().methods).toEqual([]);
    });

    it('establishes asynchronously, delivers pushed updates in order, and reads the current context', async () => {
        const adapter = createAdapter();
        const contexts: Array<Pick<SurfaceContext, 'locale' | 'accountEncryptionMode'>> = [];
        const establishing = adapter.api.watchContext((context) => contexts.push({
            locale: context.locale,
            accountEncryptionMode: context.accountEncryptionMode,
        }));
        expect(typeof (establishing as { then?: unknown }).then).toBe('function');
        const subscription = await establishing;

        adapter.pushSurfaceContext({ ...canonicalSurface, locale: 'fr' });
        adapter.pushSurfaceContext({
            ...canonicalSurface,
            locale: 'de',
            accountEncryptionMode: 'plain',
        });

        expect(contexts).toEqual([
            { locale: 'fr', accountEncryptionMode: 'e2ee' },
            { locale: 'de', accountEncryptionMode: 'plain' },
        ]);
        // `context()` answers the CURRENT fact, not the snapshot the adapter was
        // constructed with.
        await expect(adapter.api.context()).resolves.toMatchObject({
            locale: 'de',
            accountEncryptionMode: 'plain',
        });

        subscription.dispose();
        subscription.dispose();
        adapter.pushSurfaceContext({ ...canonicalSurface, locale: 'es' });
        expect(contexts).toHaveLength(2);
    });

    it('stops delivery when the surface generation is retired', async () => {
        const adapter = createAdapter();
        const locales: string[] = [];
        await adapter.api.watchContext((context) => locales.push(context.locale));
        adapter.pushSurfaceContext({ ...canonicalSurface, locale: 'fr' });
        adapter.dispose();
        adapter.pushSurfaceContext({ ...canonicalSurface, locale: 'de' });

        expect(locales).toEqual(['fr']);
        await expect(adapter.api.watchContext(() => undefined)).rejects.toMatchObject({
            code: 'stale_surface',
        });
    });

    it('isolates a listener that throws and keeps the other subscribers serialized', async () => {
        const adapter = createAdapter();
        const delivered: string[] = [];
        await adapter.api.watchContext(() => { throw new Error('author listener failed'); });
        await adapter.api.watchContext((context) => delivered.push(context.locale));

        expect(() => adapter.pushSurfaceContext({ ...canonicalSurface, locale: 'fr' })).not.toThrow();
        expect(delivered).toEqual(['fr']);
    });

    it('retires a subscription abandoned during establishment', async () => {
        const adapter = createAdapter();
        const controller = new AbortController();
        controller.abort();
        const locales: string[] = [];

        await expect(adapter.api.watchContext(
            (context) => locales.push(context.locale),
            { signal: controller.signal },
        )).rejects.toMatchObject({ code: 'unavailable' });
        adapter.pushSurfaceContext({ ...canonicalSurface, locale: 'fr' });
        expect(locales).toEqual([]);
    });
});
