import {
    type PluginUiResourceSubscriptionEventV1,
    type PluginUiSurfaceContextV1,
} from '@happier-dev/protocol/plugins/ui';
import { describe, expect, it } from 'vitest';

import { createCanonicalPluginReactNativeHostApiAdapter } from '@/components/plugins/reactNative/hostApi';
import { createPluginSurfaceContextFixture } from '@/dev/testkit/fixtures/pluginSurfaceContextFixture';

import { createPluginSurfaceActionHostApi } from './pluginSurfaceActionDispatch';
import type { MachinePluginUiResourceReadResult } from '@/sync/ops/machineContributionRegistryProjection';

import {
    createPluginContextualResourceReadClient,
    type PluginSurfaceResourceReadTransport,
} from './pluginSurfaceResourceRead';

const surfaceContext: PluginUiSurfaceContextV1 = {
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

const canonicalSurface = createPluginSurfaceContextFixture({
    mount: {
        kind: 'destination',
        destination: { pluginId: 'acme.preview', localId: 'native-preview' },
        container: 'rightPane',
    },
    target: { kind: 'session', sessionId: 'session-1' },
});

const DIGEST: Extract<PluginUiResourceSubscriptionEventV1, { kind: 'invalidated' }>['digest'] =
    `sha256:${'a'.repeat(64)}`;

/**
 * Composed: the public SDK host API a generated RN surface holds, over the real
 * canonical adapter, over the real mounted host-API composition. Only the daemon
 * machine RPC — a genuine process boundary — is substituted, and it answers with
 * the exact `DaemonPluginUiResourceReadResponse` shape the daemon parses.
 */
function createMountedHostApi(read: PluginSurfaceResourceReadTransport) {
    const host = createPluginSurfaceActionHostApi({
        surfaceContext,
        resource: {
            machineId: 'machine-1',
            serverId: null,
            expectedGeneration: '7',
            read,
        },
    });
    return {
        host,
        adapter: createCanonicalPluginReactNativeHostApiAdapter({
            surface: canonicalSurface,
            requestSurface: surfaceContext,
            requestIdPrefix: 'rn-resource',
            handleRequest: host.handleRequest,
            installedMethods: host.installedMethods,
        }),
    };
}

describe('mounted plugin surface resource snapshot read (§3.6)', () => {
    it('binds an exact Session context without manufacturing a Surface envelope', async () => {
        const requests: unknown[] = [];
        const client = createPluginContextualResourceReadClient({
            pluginId: 'acme.preview',
            resource: {
                machineId: 'machine-1',
                serverId: null,
                expectedGeneration: '7',
                context: { kind: 'session', sessionId: 'session-a' },
                read: async (machineId, options) => {
                    requests.push({ machineId, ...options });
                    return {
                        supported: true,
                        result: {
                            ok: true,
                            resource: options.resource,
                            kind: 'config',
                            contentType: 'application/json',
                            digest: DIGEST,
                            bytesBase64: Buffer.from('{"session":"session-a"}').toString('base64'),
                        },
                    } satisfies MachinePluginUiResourceReadResult;
                },
            },
        });

        await expect(client.readResource('review-summary')).resolves.toMatchObject({
            contentType: 'application/json',
            digest: DIGEST,
            bytes: new Uint8Array(Buffer.from('{"session":"session-a"}')),
        });
        expect(requests).toEqual([expect.objectContaining({
            machineId: 'machine-1',
            callerPluginId: 'acme.preview',
            expectedGeneration: '7',
            resource: { pluginId: 'acme.preview', localId: 'review-summary' },
            context: { kind: 'session', sessionId: 'session-a' },
        })]);
    });

    it('reads a packaged resource through the daemon snapshot authority', async () => {
        const requests: unknown[] = [];
        const { host, adapter } = createMountedHostApi(async (machineId, options) => {
            requests.push({ machineId, ...options });
            return {
                supported: true,
                result: {
                    ok: true,
                    resource: options.resource,
                    kind: 'asset',
                    contentType: 'application/json',
                    digest: DIGEST,
                    bytesBase64: Buffer.from('{"status":"ready"}').toString('base64'),
                },
            } satisfies MachinePluginUiResourceReadResult;
        });

        expect(host.installedMethods).toContain('readResource');
        await expect(adapter.api.readResource('review-summary')).resolves.toMatchObject({
            contentType: 'application/json',
            digest: DIGEST,
        });
        // The caller plugin is host-stamped from the mounted surface, and a bare
        // local id binds to it.
        expect(requests).toEqual([expect.objectContaining({
            machineId: 'machine-1',
            callerPluginId: 'acme.preview',
            expectedGeneration: '7',
            resource: { pluginId: 'acme.preview', localId: 'review-summary' },
        })]);
        // Destination Resources retain their existing non-contextual daemon
        // contract; only a host-produced targeted context may add this field.
        expect(requests[0]).not.toHaveProperty('context');
    });

    it('rejects an unavailable resource as a typed public error, never as a value', async () => {
        const { adapter } = createMountedHostApi(async () => ({
            supported: true,
            result: { ok: false, code: 'plugin_resource_not_found', reason: 'not_found' },
        } satisfies MachinePluginUiResourceReadResult));

        await expect(adapter.api.readResource('missing')).rejects.toMatchObject({
            code: 'unavailable',
            diagnostics: ['plugin_resource_not_found'],
        });
    });

    it('maps one transient transport result consistently for contextual and mounted reads', async () => {
        const contextual = createPluginContextualResourceReadClient({
            pluginId: 'acme.preview',
            resource: {
                machineId: 'machine-1',
                serverId: null,
                expectedGeneration: '7',
                read: async () => ({ supported: false, reason: 'error' }),
            },
        });
        const { adapter } = createMountedHostApi(async () => ({
            supported: false,
            reason: 'error',
        }));

        await expect(contextual.readResource('review-summary')).rejects.toMatchObject({
            code: 'plugin_resource_transport_error',
        });
        await expect(adapter.api.readResource('review-summary')).rejects.toMatchObject({
            code: 'unavailable',
            diagnostics: ['plugin_resource_transport_error'],
        });
    });

    it('rejects a cross-plugin reference and admits the owning plugin (positive control)', async () => {
        const seen: unknown[] = [];
        const { adapter } = createMountedHostApi(async (_machineId, options) => {
            seen.push(options.resource);
            return {
                supported: true,
                result: {
                    ok: true,
                    resource: options.resource,
                    kind: 'asset',
                    contentType: 'text/plain',
                    digest: DIGEST,
                    bytesBase64: Buffer.from('ok').toString('base64'),
                },
            } satisfies MachinePluginUiResourceReadResult;
        });

        await expect(adapter.api.readResource({ pluginId: 'other.plugin', localId: 'review-summary' }))
            .rejects.toMatchObject({ code: 'unavailable' });
        // The rejection is not "resources are broken": the owning plugin's own
        // structured reference still reads.
        await expect(adapter.api.readResource({ pluginId: 'acme.preview', localId: 'review-summary' }))
            .resolves.toMatchObject({ digest: DIGEST });
        expect(seen).toEqual([{ pluginId: 'acme.preview', localId: 'review-summary' }]);
    });

    it('does not install readResource when the mount cannot address a daemon generation', () => {
        const host = createPluginSurfaceActionHostApi({
            surfaceContext,
        });
        expect(host.installedMethods).not.toContain('readResource');
    });
});
