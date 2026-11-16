import type { ActionExecutorContext } from '@happier-dev/protocol/actions/actionExecutor';
import { ActionSurfaceSchema } from '@happier-dev/protocol/actions/metadata';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { describe, expect, it, vi } from 'vitest';
import {
    createActionExecutor,
    createFeatureDecision,
    type ActionExecutorDeps,
    type PluginSessionHookInstallationStatusV1,
    type PluginSessionHookStatusInventoryRowV1,
} from '@happier-dev/protocol';

import {
    createPluginSessionHookManagementActionExecutor,
    type PluginSessionHookManagementHost,
} from '@/session/actions/externalSessions/pluginSessionHookManagementActionExecutor';

import { createPluginInvocationActionsService } from './actions';
import { createPluginActionCallerMaterializationFixture } from './actionCaller.testkit';

const previewId = `hook-install-preview:v1:${'1'.repeat(64)}`;
const callerAgent = { pluginId: 'acme.sessions', localId: 'codex' } as const;
const callerMaterialization = createPluginActionCallerMaterializationFixture(
    callerAgent.pluginId,
    {
        machineId: 'host-machine',
        materializationId: 'materialization-caller-agent-current',
    },
);

function createManagementVertical() {
    let status: PluginSessionHookInstallationStatusV1 = {
        state: 'not_installed',
    };
    const calls: Array<Readonly<{ operation: string; input: unknown; signal?: AbortSignal }>> = [];
    const host: PluginSessionHookManagementHost = {
        async status(input, options) {
            calls.push({ operation: 'status', input, ...(options?.signal ? { signal: options.signal } : {}) });
            const rows: PluginSessionHookStatusInventoryRowV1[] = [{ agent: callerAgent, status }];
            if (input.intent === 'passive_inventory' && !input.agent) {
                rows.push({
                    agent: { pluginId: 'other.plugin', localId: 'other' },
                    status: { state: 'installed_enabled', installationId: 'other-installation' },
                });
            }
            return { ok: true, rows, nextCursor: null, diagnostics: [] };
        },
        async install(input, options) {
            calls.push({ operation: 'install', input, ...(options?.signal ? { signal: options.signal } : {}) });
            status = { state: 'installed_enabled', installationId: 'installation-1' };
            return { ok: true, status };
        },
        async disable(input, options) {
            calls.push({ operation: 'disable', input, ...(options?.signal ? { signal: options.signal } : {}) });
            status = { state: 'installed_disabled', installationId: input.installationId };
            return { ok: true, status };
        },
        async enable(input, options) {
            calls.push({ operation: 'enable', input, ...(options?.signal ? { signal: options.signal } : {}) });
            status = { state: 'installed_enabled', installationId: input.installationId };
            return { ok: true, status };
        },
        async uninstall(input, options) {
            calls.push({ operation: 'uninstall', input, ...(options?.signal ? { signal: options.signal } : {}) });
            status = { state: 'not_installed' };
            return { ok: true, status };
        },
    };
    const manager = createPluginSessionHookManagementActionExecutor({
        machineId: 'host-machine',
        readFeatureDecision: () => createFeatureDecision({
            featureId: 'sessions.direct',
            state: 'enabled',
            blockedBy: null,
            blockerCode: 'none',
            diagnostics: [],
            evaluatedAt: 1,
            scope: { scopeKind: 'runtime', machineId: 'host-machine' },
        }),
        host,
    });
    const pluginSessionHookManagementAction: NonNullable<
        ActionExecutorDeps['pluginSessionHookManagementAction']
    > = async (args) => {
        const execution = await manager.execute(args.actionId, args.input, {
            surface: 'action',
            ...(args.signal ? { signal: args.signal } : {}),
        });
        return execution.ok ? execution.result : execution;
    };
    const executor = createActionExecutor({
    readActionsSettings: (context: ActionExecutorContext) => ActionsSettingsV1Schema.parse({ v: 1, ...context.actionsSettings, approvalWaivedSurfaces: {"plugins.sessionHooks.status.get": Object.keys(ActionSurfaceSchema.shape), "plugins.sessionHooks.install": Object.keys(ActionSurfaceSchema.shape), "plugins.sessionHooks.disable": Object.keys(ActionSurfaceSchema.shape), "plugins.sessionHooks.enable": Object.keys(ActionSurfaceSchema.shape), "plugins.sessionHooks.uninstall": Object.keys(ActionSurfaceSchema.shape), ...context.actionsSettings?.approvalWaivedSurfaces} }),
        pluginSessionHookManagementAction,

    } as unknown as ActionExecutorDeps);
    return { executor, calls };
}

describe('plugin invocation ActionsService session-hook management vertical', () => {
    it('reads its own hook status with host-stamped identity and refuses background lifecycle mutations', async () => {
        const vertical = createManagementVertical();
        const retirement = new AbortController();
        const service = createPluginInvocationActionsService({
            seed: {
                plugin: { id: callerAgent.pluginId, version: '1.0.0' },
                resolveCurrentPluginMaterializationRef:
                    callerMaterialization.resolveCurrentPluginMaterializationRef,
                occurrenceId: 'occurrenceId-1',
                surface: 'background',
                signal: retirement.signal,
                isOccurrenceCurrent: () => true,
            },
            actionExecutor: vertical.executor,
            invokeContributedAction: vi.fn(),
        });

        await expect(service.execute('plugins.sessionHooks.status.get', {
            intent: 'passive_inventory',
        })).resolves.toMatchObject({
            ok: true,
            rows: [{ agent: callerAgent }],
        });
        await expect(service.execute('plugins.sessionHooks.install', {
            agent: { localId: callerAgent.localId },
            expectedPreviewId: previewId,
        })).rejects.toMatchObject({ code: 'present_user_required' });
        await expect(service.execute('plugins.sessionHooks.disable', {
            agent: { localId: callerAgent.localId },
            installationId: 'installation-1',
        })).rejects.toMatchObject({ code: 'present_user_required' });
        await expect(service.execute('plugins.sessionHooks.enable', {
            agent: { localId: callerAgent.localId },
            installationId: 'installation-1',
        })).rejects.toMatchObject({ code: 'present_user_required' });
        await expect(service.execute('plugins.sessionHooks.uninstall', {
            agent: { localId: callerAgent.localId },
            installationId: 'installation-1',
        })).rejects.toMatchObject({ code: 'present_user_required' });

        const effectCalls = vertical.calls.filter((call) => call.operation !== 'status');
        expect(effectCalls).toEqual([]);
        for (const call of vertical.calls) {
            expect(call.input).toMatchObject({
                machineId: 'host-machine',
            });
            expect(call.signal).toBe(retirement.signal);
        }
    });

    it('rejects plugin-authored machine and plugin identities before lifecycle dispatch', async () => {
        const vertical = createManagementVertical();
        const service = createPluginInvocationActionsService({
            seed: {
                plugin: { id: callerAgent.pluginId, version: '1.0.0' },
                resolveCurrentPluginMaterializationRef:
                    callerMaterialization.resolveCurrentPluginMaterializationRef,
                occurrenceId: 'occurrenceId-1',
                surface: 'background',
                signal: new AbortController().signal,
                isOccurrenceCurrent: () => true,
            },
            actionExecutor: vertical.executor,
            invokeContributedAction: vi.fn(),
        });

        await expect(service.execute('plugins.sessionHooks.install', {
            machineId: 'attacker-machine',
            agent: { pluginId: 'other.plugin', localId: callerAgent.localId },
            expectedPreviewId: previewId,
        } as never)).rejects.toMatchObject({ code: 'plugin_action_input_schema_invalid' });
        expect(vertical.calls).toHaveLength(0);
    });
});
