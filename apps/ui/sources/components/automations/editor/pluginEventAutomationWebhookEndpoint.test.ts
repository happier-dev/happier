import { describe, expect, it, vi } from 'vitest';

import type { PluginWebhookEndpointUiActionExecutor } from '@/sync/api/plugins/webhooks/endpointActions';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';

import {
    applyRefreshedPluginEventAutomationWebhookEndpoint,
    readPluginEventAutomationWebhookEndpoint,
    type PluginEventAutomationWebhookEndpoint,
} from './pluginEventAutomationWebhookEndpoint';

const PLUGIN_ID = 'acme.github';
const ENDPOINT_ID = 'wh_ep_AAAAAAAAAAAAAAAAAAAAAQ';
const SOURCE_INSTANCE_ID = 'github:installation:2200';
const PUBLIC_URL = 'https://example.test/v1/plugins/webhooks/opaque-route';

function accountLifetime(isCurrent = true): ActiveServerAccountScopeLifetime {
    return Object.freeze({
        scope: Object.freeze({ serverId: 'server-a', accountId: 'account-a' }),
        isCurrent: () => isCurrent,
        onRetire: () => Object.freeze({ dispose() {} }),
    });
}

function readResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        webhookEndpointId: ENDPOINT_ID,
        revision: 3,
        contribution: { pluginId: PLUGIN_ID, localId: 'webhooks/repository' },
        targetMaterialization: {
            machineId: 'watcher-machine',
            materializationId: 'github-materialization-a',
            pluginId: PLUGIN_ID,
        },
        sourceInstanceId: SOURCE_INSTANCE_ID,
        routing: 'accountEndpoint',
        readiness: 'ready',
        publicUrl: PUBLIC_URL,
        createdAt: 1_700_000_000_000,
        ...overrides,
    };
}

function executorReturning(result: unknown): PluginWebhookEndpointUiActionExecutor {
    return vi.fn(async () => result) as unknown as PluginWebhookEndpointUiActionExecutor;
}

async function read(params: Readonly<{
    result?: unknown;
    expectedSourceInstanceId?: string;
    expectedPluginId?: string;
    lifetime?: ActiveServerAccountScopeLifetime;
    executeAction?: PluginWebhookEndpointUiActionExecutor;
}> = {}) {
    return await readPluginEventAutomationWebhookEndpoint({
        webhookEndpointId: ENDPOINT_ID,
        expectedPluginId: params.expectedPluginId ?? PLUGIN_ID,
        expectedSourceInstanceId: params.expectedSourceInstanceId ?? SOURCE_INSTANCE_ID,
        accountLifetime: params.lifetime ?? accountLifetime(),
        executeAction: params.executeAction ?? executorReturning(params.result ?? readResult()),
    });
}

describe('readPluginEventAutomationWebhookEndpoint', () => {
    /**
     * The positive twin. Without it every rejection case below could also be
     * satisfied by an adapter that returns `unavailable` unconditionally.
     */
    it('rebinds an Event edit to the endpoint its definition already names', async () => {
        const executeAction = vi.fn(async () => readResult()) as unknown as PluginWebhookEndpointUiActionExecutor;
        const result = await read({ executeAction });

        expect(result).toEqual({
            kind: 'available',
            binding: {
                endpoint: {
                    webhookEndpointId: ENDPOINT_ID,
                    publicUrl: PUBLIC_URL,
                    readiness: 'ready',
                    // A read never re-discloses the one-time secret, so an
                    // ordinary edit cannot re-run credential setup.
                    oneTimeGeneratedSecret: null,
                },
                targetMaterialization: {
                    machineId: 'watcher-machine',
                    materializationId: 'github-materialization-a',
                    pluginId: PLUGIN_ID,
                },
                sourceInstanceId: SOURCE_INSTANCE_ID,
            },
        });
        expect(executeAction).toHaveBeenCalledWith(
            'plugin.webhook.endpoint.read',
            { webhookEndpointId: ENDPOINT_ID },
        );
    });

    /**
     * `available` states only that the endpoint exists. The endpoint owner is
     * the single authority on provider confirmation, so a still-unconfirmed
     * endpoint must reach the composer with that readiness intact rather than
     * being collapsed into a working delivery path or dropped entirely.
     */
    it('preserves a non-ready readiness instead of collapsing it', async () => {
        const result = await read({ result: readResult({ readiness: 'providerConfirmationRequired' }) });

        expect(result.kind).toBe('available');
        expect(result.kind === 'available' ? result.binding.endpoint.readiness : null)
            .toBe('providerConfirmationRequired');
    });

    const rejections: readonly (readonly [string, Record<string, unknown>])[] = [
        ['an endpoint routed through a provider installation', { routing: 'providerInstallation' }],
        ['a revoked endpoint', { revokedAt: 1_700_000_100_000 }],
        ['an endpoint whose target machine is gone', { readiness: 'targetUnavailable' }],
        ['an endpoint whose route is gone', { readiness: 'routeUnavailable' }],
        ['a contribution owned by another plugin', {
            contribution: { pluginId: 'acme.other', localId: 'webhooks/repository' },
        }],
        ['a target materialization owned by another plugin', {
            targetMaterialization: {
                machineId: 'watcher-machine',
                materializationId: 'github-materialization-a',
                pluginId: 'acme.other',
            },
        }],
    ];

    for (const [label, overrides] of rejections) {
        it(`refuses to rebind ${label}`, async () => {
            await expect(read({ result: readResult(overrides) })).resolves.toEqual({ kind: 'unavailable' });
        });
    }

    it('refuses to rebind an endpoint routing a different source instance', async () => {
        await expect(read({ expectedSourceInstanceId: 'github:installation:9999' }))
            .resolves.toEqual({ kind: 'unavailable' });
    });

    it('refuses to rebind once the Account scope it was captured for retires', async () => {
        const executeAction = vi.fn(async () => readResult()) as unknown as PluginWebhookEndpointUiActionExecutor;
        await expect(read({ lifetime: accountLifetime(false), executeAction }))
            .resolves.toEqual({ kind: 'unavailable' });
        expect(executeAction).not.toHaveBeenCalled();
    });

    it('refuses to rebind an endpoint the owner could not return', async () => {
        const executeAction = vi.fn(async () => {
            throw new Error('plugin_webhook_endpoint_request_failed');
        }) as unknown as PluginWebhookEndpointUiActionExecutor;
        await expect(read({ executeAction })).resolves.toEqual({ kind: 'unavailable' });
    });
});

describe('applyRefreshedPluginEventAutomationWebhookEndpoint', () => {
    const shown: PluginEventAutomationWebhookEndpoint = Object.freeze({
        webhookEndpointId: ENDPOINT_ID,
        publicUrl: PUBLIC_URL,
        readiness: 'providerConfirmationRequired',
        oneTimeGeneratedSecret: 'whsec-shown-once',
    });
    const reread: PluginEventAutomationWebhookEndpoint = Object.freeze({
        webhookEndpointId: ENDPOINT_ID,
        publicUrl: PUBLIC_URL,
        readiness: 'ready',
        // A read never re-discloses the creating response's secret.
        oneTimeGeneratedSecret: null,
    });

    it('adopts the reread readiness while keeping the one-time secret the server will not repeat', () => {
        expect(applyRefreshedPluginEventAutomationWebhookEndpoint(shown, reread)).toEqual({
            webhookEndpointId: ENDPOINT_ID,
            publicUrl: PUBLIC_URL,
            readiness: 'ready',
            oneTimeGeneratedSecret: 'whsec-shown-once',
        });
    });

    it('ignores a reread of a different endpoint and a reread with nothing shown', () => {
        expect(applyRefreshedPluginEventAutomationWebhookEndpoint(shown, {
            ...reread,
            webhookEndpointId: 'wh_ep_BBBBBBBBBBBBBBBBBBBBBQ',
        })).toBe(shown);
        expect(applyRefreshedPluginEventAutomationWebhookEndpoint(null, reread)).toBeNull();
    });
});
