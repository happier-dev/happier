import { describe, expect, it, vi } from 'vitest';

import type { PluginProjectionEntry } from '@/agents/backendCatalog/daemonContributionRegistryProjectionAdapters';
import type {
    PluginUiTargetedContributionOperationV1,
    PluginUiTargetedContributionsV1,
} from '@happier-dev/protocol/plugins/ui';

import { createPluginActionInputSelectionHostApiHandler } from './pluginActionInputSelectionHostApi';

const accountLifetime = Object.freeze({
    scope: Object.freeze({ serverId: 'server-a', accountId: 'account-a' }),
    isCurrent: () => true,
    onRetire: () => Object.freeze({ dispose() {} }),
});

const operation: PluginUiTargetedContributionOperationV1 = {
    point: { pointId: 'connection', protocol: { id: 'provider', version: 1 } },
    contributor: {
        pluginId: 'acme.setup',
        contributionId: 'provider',
        immutableGenerationId: 'setup-generation-a',
    },
    role: 'setup',
    action: { pluginId: 'acme.setup', localId: 'connection/prepare-v1' },
};

const serverStartDraft = {
    executionTarget: { serverId: 'server-a', machineId: 'machine-a' },
    directory: '/workspace',
    agentTarget: {
        kind: 'agent' as const,
        identity: { pluginId: 'happier.agent.claude', localId: 'claude' },
    },
};

function targetedContributions(): PluginUiTargetedContributionsV1 {
    return {
        target: {
            pluginId: 'acme.caller',
            immutableGenerationId: 'caller-generation-a',
        },
        points: [{
            pointId: 'connection',
            protocols: [{
                protocol: { id: 'provider', version: 1 },
                contributions: [{
                    contributor: operation.contributor,
                    protocol: { id: 'provider', version: 1 },
                    operations: [operation],
                    surfaces: [],
                }],
            }],
        }],
    };
}

function projection(): Readonly<Record<string, PluginProjectionEntry>> {
    return {
        'acme.setup': {
            pluginId: 'acme.setup',
            immutableGenerationId: 'setup-generation-a',
            title: 'Setup',
            description: null,
            version: '1.0.0',
            enabled: true,
            generation: 7,
            generationLabel: '7',
            status: null,
            provenance: null,
            diagnostics: [],
            actions: [{
                id: 'connection/prepare-v1',
                title: 'Prepare connection',
                description: null,
                icon: null,
                scopes: ['settings'],
                surfaces: ['plugin'],
                placementBindings: [],
                inputSchema: {
                    type: 'object',
                    properties: { repository: { type: 'string', minLength: 1 } },
                    required: ['repository'],
                    additionalProperties: false,
                },
                inputHints: {
                    fields: [{ path: 'repository', title: 'Repository', widget: 'text', required: true }],
                },
                slash: null,
                priority: null,
                dangerLevel: 'safe',
                confirmation: null,
                available: true,
            }],
            resources: [],
            editableSettingsGroups: [],
        },
    };
}

function request() {
    return {
        version: 1 as const,
        requestId: 'request-1',
        surface: {
            pluginId: 'acme.caller',
            contributionId: 'settings',
            surfaceId: 'surface-1',
            placement: 'appSurface' as const,
            platform: 'web' as const,
            channel: 'internal' as const,
            resourceScope: [],
            diagnostics: [],
        },
        method: 'selectActionInput' as const,
        payload: {
            operation,
            draft: { repository: 'happier-dev/happier' },
        },
    };
}

describe('plugin Action input selection Host API producer', () => {
    it('presents the incumbent form and returns normalized input without invocation', async () => {
        const present = vi.fn(({ form }) => {
            void form.submit();
        });
        const handler = createPluginActionInputSelectionHostApiHandler({
            pluginProjectionById: projection(),
            targetedContributions: targetedContributions(),
            host: {
                machineId: 'machine-a',
                serverId: 'server-a',
                expectedGeneration: 7,
                targetPluginId: 'acme.caller',
                accountLifetime,
            },
            isCurrent: () => true,
            present,
        });

        await expect(handler(request())).resolves.toEqual({
            kind: 'submitted',
            action: { pluginId: 'acme.setup', localId: 'connection/prepare-v1' },
            input: { repository: 'happier-dev/happier' },
            selection: {
                target: targetedContributions().target,
                point: operation.point,
                contributor: operation.contributor,
            },
            connectedAccount: { kind: 'none' },
        });
        expect(present).toHaveBeenCalledOnce();
    });

    it('settles explicit dismissal as cancellation', async () => {
        const handler = createPluginActionInputSelectionHostApiHandler({
            pluginProjectionById: projection(),
            targetedContributions: targetedContributions(),
            host: {
                machineId: 'machine-a',
                expectedGeneration: 7,
                targetPluginId: 'acme.caller',
                accountLifetime,
            },
            isCurrent: () => true,
            present: ({ form }) => form.cancel(),
        });
        await expect(handler(request())).resolves.toEqual({ kind: 'cancelled' });
    });

    it('retires the form and returns a typed failure when the caller aborts', async () => {
        const abort = new AbortController();
        let capturedForm: { getInput(): Readonly<Record<string, unknown>> } | undefined;
        const handler = createPluginActionInputSelectionHostApiHandler({
            pluginProjectionById: projection(),
            targetedContributions: targetedContributions(),
            host: {
                machineId: 'machine-a',
                expectedGeneration: 7,
                targetPluginId: 'acme.caller',
                accountLifetime,
            },
            isCurrent: () => true,
            present: ({ form }) => {
                capturedForm = form;
                abort.abort();
            },
        });
        await expect(handler(request(), { signal: abort.signal })).resolves.toEqual({
            code: 'unavailable',
            diagnostics: ['select_action_input_aborted'],
        });
        expect(capturedForm?.getInput()).toEqual({});
    });

    it('settles typed-stale when the exact bound target retires before submission', async () => {
        let current = true;
        const handler = createPluginActionInputSelectionHostApiHandler({
            pluginProjectionById: projection(),
            targetedContributions: targetedContributions(),
            host: {
                machineId: 'machine-a',
                expectedGeneration: 7,
                targetPluginId: 'acme.caller',
                accountLifetime,
            },
            isCurrent: () => current,
            present: ({ form }) => {
                current = false;
                void form.submit();
            },
        });

        const outcome = await Promise.race([
            handler(request()),
            new Promise<Readonly<{ timedOut: true }>>((resolve) => {
                setTimeout(() => resolve({ timedOut: true }), 50);
            }),
        ]);
        expect(outcome).toEqual({ code: 'stale_surface', diagnostics: ['host_retired'] });
    });

    it('rejects a submitted value outside the canonical host-input bound', async () => {
        const handler = createPluginActionInputSelectionHostApiHandler({
            pluginProjectionById: projection(),
            targetedContributions: targetedContributions(),
            host: {
                machineId: 'machine-a',
                expectedGeneration: 7,
                targetPluginId: 'acme.caller',
                accountLifetime,
            },
            isCurrent: () => true,
            present: ({ form }) => {
                form.replaceInput({ repository: 'a'.repeat(8_192) });
                void form.submit();
            },
        });

        await expect(handler({
            ...request(),
            payload: {
                operation,
            },
        })).resolves.toEqual({
            code: 'invalid_payload',
            diagnostics: ['select_action_input_result_invalid'],
        });
    });

    it('routes the one literal Session host request to the no-invoke Session composer', async () => {
        const composeSessionServerStartDraft = vi.fn(async () => ({
            kind: 'submitted' as const,
            draft: serverStartDraft,
        }));
        const handler = createPluginActionInputSelectionHostApiHandler({
            // There is deliberately no targeted projection/snapshot here: this
            // request must not enter the contributed-Action selector.
            host: {
                machineId: 'machine-a',
                serverId: 'server-a',
                expectedGeneration: 7,
                targetPluginId: 'acme.caller',
                accountLifetime,
            },
            isCurrent: () => true,
            composeSessionServerStartDraft,
        });

        await expect(handler({
            ...request(),
            payload: {
                hostAction: { action: 'session.spawn_new', projection: 'serverStartDraft' },
                draft: { directory: '/workspace', agentId: 'claude' },
            },
        })).resolves.toEqual({ kind: 'serverStartDraft', draft: serverStartDraft });
        expect(composeSessionServerStartDraft).toHaveBeenCalledOnce();
    });

    it('refuses a literal Session draft whose server disagrees with the captured Account scope', async () => {
        const composeSessionServerStartDraft = vi.fn(async () => ({
            kind: 'submitted' as const,
            draft: serverStartDraft,
        }));
        const handler = createPluginActionInputSelectionHostApiHandler({
            host: {
                machineId: 'machine-a',
                serverId: 'server-b',
                expectedGeneration: 7,
                targetPluginId: 'acme.caller',
                accountLifetime,
            },
            isCurrent: () => true,
            composeSessionServerStartDraft,
        });

        await expect(handler({
            ...request(),
            payload: {
                hostAction: { action: 'session.spawn_new', projection: 'serverStartDraft' },
            },
        })).resolves.toEqual({
            code: 'unavailable',
            diagnostics: ['host_unavailable'],
        });
        expect(composeSessionServerStartDraft).not.toHaveBeenCalled();
    });
});
