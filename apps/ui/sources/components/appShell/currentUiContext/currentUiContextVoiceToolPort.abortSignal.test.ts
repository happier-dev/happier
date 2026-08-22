import { describe, expect, it, vi } from 'vitest';

import type { PluginProjectedActionV2 } from '@happier-dev/protocol';
import type { PluginUiActionProjection, PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import { EMPTY_PLUGIN_UI_PROJECTION } from '@/sync/domains/plugins/ui/projection';
import { PLUGIN_UI_CONTRIBUTION_ORIGIN_KEY } from '@/sync/domains/plugins/ui/projectionUnion';

const machineRpcWithServerScopeMock = vi.hoisted(() => vi.fn());

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: machineRpcWithServerScopeMock,
}));

import type { CurrentUiContextResolvedCommand } from './CurrentUiContextProvider';
import { createCurrentUiContextVoiceToolPort } from './currentUiContextVoiceToolPort';

const COMMAND_ID = 'current-ui-command:native-abort';
const ACTION_ID = Object.freeze({ pluginId: 'acme.current-ui', localId: 'retiring-action' });
const ACTION_ORIGIN = Object.freeze({
    machineId: 'machine-current-ui',
    serverId: 'server-current-ui',
    generation: 41,
    interactionEnabled: true,
    phase: 'current' as const,
    executionOrigin: {
        serverIdentityId: 'srv_current_ui',
        materializationRef: {
            pluginId: ACTION_ID.pluginId,
            machineId: 'machine-current-ui',
            materializationId: 'current-ui-materialization',
        },
    },
});

function createDaemonActionProjection(): PluginUiProjectionModel {
    const action: PluginUiActionProjection = Object.freeze({
        id: ACTION_ID.localId,
        pluginId: ACTION_ID.pluginId,
        title: 'Retiring action',
        scopes: ['global'],
        surfaces: ['voice'],
        execution: { target: 'daemon' },
        dangerLevel: 'safe',
        available: true,
        [PLUGIN_UI_CONTRIBUTION_ORIGIN_KEY]: ACTION_ORIGIN,
    } satisfies PluginProjectedActionV2 & Record<typeof PLUGIN_UI_CONTRIBUTION_ORIGIN_KEY, typeof ACTION_ORIGIN>);
    return Object.freeze({
        ...EMPTY_PLUGIN_UI_PROJECTION,
        generation: ACTION_ORIGIN.generation,
        actionsById: Object.freeze({
            [`${ACTION_ID.pluginId}/${ACTION_ID.localId}`]: action,
        }),
    });
}

function withoutAbortSignalAny(): () => void {
    const original = Object.getOwnPropertyDescriptor(AbortSignal, 'any');
    Object.defineProperty(AbortSignal, 'any', {
        configurable: true,
        writable: true,
        value: undefined,
    });
    return () => {
        if (original) {
            Object.defineProperty(AbortSignal, 'any', original);
        } else {
            Reflect.deleteProperty(AbortSignal, 'any');
        }
    };
}

describe('current UI context Voice command retirement signal', () => {
    it('does not issue a daemon Action when an exact current command is already retired without AbortSignal.any', async () => {
        const retirement = new AbortController();
        const attempt = new AbortController();
        const current: CurrentUiContextResolvedCommand = {
            id: COMMAND_ID,
            command: {
                kind: 'executeAction',
                action: ACTION_ID,
            },
            retirementSignal: retirement.signal,
        };
        machineRpcWithServerScopeMock.mockReset();
        machineRpcWithServerScopeMock.mockResolvedValue({ ok: true, result: { shouldNotIssue: true } });
        const port = createCurrentUiContextVoiceToolPort({
            reader: {
                readCurrentUiContext: () => null,
                resolveCurrentUiCommand: (id) => id === COMMAND_ID ? current : null,
                subscribe: () => () => {},
            },
            readProjection: createDaemonActionProjection,
            readNavigationBinding: () => null,
        });
        if (!port.invokeCurrentUiCommand) throw new Error('missing current UI command invoker');

        retirement.abort(new Error('the exact command was retired before dispatch'));
        const restoreAbortSignalAny = withoutAbortSignalAny();
        try {
            await expect(port.invokeCurrentUiCommand({
                commandId: COMMAND_ID,
                signal: attempt.signal,
            })).resolves.toEqual({ ok: false, code: 'unavailable' });
        } finally {
            restoreAbortSignalAny();
        }
        expect(machineRpcWithServerScopeMock).not.toHaveBeenCalled();
    });
});
