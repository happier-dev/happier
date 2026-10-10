import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    executeCurrentUiContextAction,
    registerCurrentUiContextActionPort,
} from './currentUiContextActionRuntime';
import type { CurrentUiContextVoiceToolPort } from './currentUiContextVoiceToolPort';
import { createCurrentUiContextVoiceToolPort } from './currentUiContextVoiceToolPort';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { EMPTY_PLUGIN_UI_PROJECTION } from '@/sync/domains/plugins/ui/projection';
import type { CurrentUiContextResolvedCommand } from './CurrentUiContextProvider';

let unregister: (() => void) | null = null;

afterEach(() => {
    unregister?.();
    unregister = null;
});

describe('current UI context Action adapter', () => {
    it('admits an exact authenticated Home continuation through human authority, not a local callback bypass', async () => {
        let completed = 0;
        const retirement = new AbortController();
        const scope = { serverId: 'home', accountId: 'account' };
        const command: CurrentUiContextResolvedCommand = {
            id: 'current-ui:home-continuation', retirementSignal: retirement.signal,
            command: { kind: 'accountHomeContinuation', operation: 'choose', homeServerIdentityId: 'next-home',
                account: { scope, isCurrent: () => !retirement.signal.aborted, onRetire: () => ({ dispose() {} }) },
                invoke: async () => { completed += 1; return { status: 'completed' }; } },
        };
        unregister = registerCurrentUiContextActionPort((surface, hostAction) => createCurrentUiContextVoiceToolPort({
            invocationSurface: surface, hostAction,
            reader: { readCurrentUiContext: () => ({ navigation: { area: 'account', screen: 'continuation' },
                commands: [{ id: command.id, title: 'Choose next Home' }] }),
                resolveCurrentUiCommand: id => id === command.id && !retirement.signal.aborted ? command : null,
                subscribe: () => () => {} },
            readProjection: () => EMPTY_PLUGIN_UI_PROJECTION, readNavigationBinding: () => null,
        }));
        const executor = createActionExecutor({
            uiCurrentContextAction: request => executeCurrentUiContextAction(request, { execute: executor.execute, context: request.context }),
            accountHomeContinuationAction: request => executeCurrentUiContextAction(request),
        });
        const input = { commandId: command.id };
        const automated = await executor.execute('ui.current_context.command.invoke', input,
            { surface: 'agent', authority: 'account_automation', serverId: scope.serverId, expectedAccountId: scope.accountId });
        expect(automated).toMatchObject({ ok: false });
        expect(completed).toBe(0);
        await expect(executor.execute('ui.current_context.command.invoke', input,
            { surface: 'ui', authority: 'present_user', serverId: scope.serverId, expectedAccountId: scope.accountId }))
            .resolves.toEqual({ ok: true, result: { status: 'completed' } });
        expect(completed).toBe(1);
        await expect(executor.execute('account.home_continuation.invoke', {
            operation: 'choose', commandId: command.id, homeServerIdentityId: 'another-home',
        }, { surface: 'ui', authority: 'present_user', serverId: scope.serverId, expectedAccountId: scope.accountId }))
            .resolves.toMatchObject({ ok: false });
        await expect(executor.execute('account.home_continuation.invoke', {
            operation: 'choose', commandId: command.id, homeServerIdentityId: 'next-home',
        }, { surface: 'ui', authority: 'present_user', serverId: scope.serverId, expectedAccountId: 'another-account' }))
            .resolves.toMatchObject({ ok: false });
        retirement.abort();
        await expect(executor.execute('account.home_continuation.invoke', {
            operation: 'choose', commandId: command.id, homeServerIdentityId: 'next-home',
        }, { surface: 'ui', authority: 'present_user', serverId: scope.serverId, expectedAccountId: scope.accountId }))
            .resolves.toMatchObject({ ok: false });
        expect(completed).toBe(1);
    });

    it('preserves an issued mounted-command acknowledgement loss', async () => {
        const port = {
            readCurrentUiContext: () => null,
            invokeCurrentUiCommand: vi.fn(async () => ({ ok: false as const, code: 'outcome_unknown' as const })),
        } satisfies CurrentUiContextVoiceToolPort;
        unregister = registerCurrentUiContextActionPort((surface) => surface === 'agent' ? port : null);

        await expect(executeCurrentUiContextAction({
            actionId: 'ui.current_context.command.invoke',
            input: { commandId: 'current-ui-command:1' },
            context: { surface: 'agent' },
        })).resolves.toMatchObject({
            ok: false,
            errorCode: 'plugin_action_outcome_unknown',
        });
    });
});
