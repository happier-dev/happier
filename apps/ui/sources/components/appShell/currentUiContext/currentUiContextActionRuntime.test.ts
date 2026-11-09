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
import { createActionExecutorBoundaryFixture } from '@/dev/testkit';

let unregister: (() => void) | null = null;

afterEach(() => {
    unregister?.();
    unregister = null;
});

describe('current UI context Action adapter', () => {
    it('passes a parameterized host-local command its admitted JSON payload while preserving payload-free calls', async () => {
        const received: unknown[] = [];
        const command: CurrentUiContextResolvedCommand = {
            id: 'current-ui:edit-listing', retirementSignal: new AbortController().signal,
            command: { kind: 'hostLocal', invoke: async invocation => {
                received.push(invocation.input);
                return { ok: true, result: invocation.input ?? null };
            } },
        };
        unregister = registerCurrentUiContextActionPort(surface => createCurrentUiContextVoiceToolPort({
            invocationSurface: surface,
            reader: { readCurrentUiContext: () => ({ navigation: { area: 'settings', screen: 'plugin-publication' },
                commands: [{ id: command.id, title: 'Edit listing', description: 'Provide title and keywords.' }] }),
                resolveCurrentUiCommand: id => id === command.id ? command : null, subscribe: () => () => {} },
            readProjection: () => EMPTY_PLUGIN_UI_PROJECTION, readNavigationBinding: () => null,
        }));
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({
            uiCurrentContextAction: request => executeCurrentUiContextAction(request),
        }));
        const input = { title: 'Reviewed title', keywords: ['automation'] };
        expect(await executor.execute('ui.current_context.command.invoke', { commandId: command.id, input },
            { surface: 'agent', authority: 'account_automation' })).toEqual({ ok: true, result: input });
        expect(await executor.execute('ui.current_context.command.invoke', { commandId: command.id },
            { surface: 'agent', authority: 'account_automation' })).toEqual({ ok: true, result: null });
        expect(received).toEqual([input, undefined]);
    });

    it('admits declared plugin Dictation effects without granting generic current-UI reads', async () => {
        const account = { serverId: 'dictation-home', accountId: 'dictation-account' };
        const command: CurrentUiContextResolvedCommand = {
            id: 'current-ui:cancel-dictation', retirementSignal: new AbortController().signal,
            command: { kind: 'voiceDictation', operation: 'cancel',
                account: { scope: account, isCurrent: () => true, onRetire: () => ({ dispose() {} }) },
                invoke: async () => ({ status: 'completed', dictationStatus: 'idle', inserted: false }) },
        };
        unregister = registerCurrentUiContextActionPort((surface, hostAction) => createCurrentUiContextVoiceToolPort({
            invocationSurface: surface, hostAction,
            reader: { readCurrentUiContext: () => ({ navigation: { area: 'session', screen: 'session' },
                commands: [{ id: command.id, title: 'Cancel Dictation' }] }),
                resolveCurrentUiCommand: id => id === command.id ? command : null, subscribe: () => () => {} },
            readProjection: () => EMPTY_PLUGIN_UI_PROJECTION, readNavigationBinding: () => null,
        }));
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({
            uiCurrentContextAction: request => executeCurrentUiContextAction(request),
            voiceConversationAction: async request => {
                const result = await executeCurrentUiContextAction(request);
                return result.ok ? result.result : result;
            },
        }));
        const context = { surface: 'plugin', authority: 'account_automation', serverId: account.serverId,
            expectedAccountId: account.accountId,
            actionCaller: { kind: 'plugin', pluginId: 'fixture.dictation', contributionLocalId: 'field',
                occurrenceId: 'field-occurrence', sourceCustody: { kind: 'development', registeredRootId: 'dictation-root' } } } as const;
        expect(await executor.execute('ui.voice_global.dictation.cancel', { commandId: command.id }, context))
            .toEqual({ ok: true, result: { status: 'completed', dictationStatus: 'idle', inserted: false } });
        expect(await executor.execute('ui.current_context.read', {}, context)).toMatchObject({ ok: false });
    });

    it('runs the person\'s own mounted Dictation command directly, keeps automated callers on approval and rejects retired fields', async () => {
        let captures = 0;
        let requestedMicrophoneConsent = false;
        const retirement = new AbortController();
        const scope = { serverId: 'dictation-home', accountId: 'dictation-account' };
        const command: CurrentUiContextResolvedCommand = {
            id: 'current-ui:dictation-field', retirementSignal: retirement.signal,
            command: { kind: 'voiceDictation', operation: 'start',
                account: { scope, isCurrent: () => !retirement.signal.aborted, onRetire: () => ({ dispose() {} }) },
                invoke: async () => { captures += 1; return { status: 'completed', dictationStatus: 'listening', inserted: false }; } },
        };
        unregister = registerCurrentUiContextActionPort((surface, hostAction) => createCurrentUiContextVoiceToolPort({
            invocationSurface: surface, hostAction,
            reader: { readCurrentUiContext: () => ({ navigation: { area: 'session', screen: 'session' },
                commands: [{ id: command.id, title: 'Dictate' }] }),
                resolveCurrentUiCommand: id => id === command.id && !retirement.signal.aborted ? command : null,
                subscribe: () => () => {} },
            readProjection: () => EMPTY_PLUGIN_UI_PROJECTION, readNavigationBinding: () => null,
        }));
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({
            uiCurrentContextAction: request => executeCurrentUiContextAction(request, { execute: executor.execute, context: request.context }),
            presentUserActionConfirmation: async request => {
                expect(request.actionId).toBe('ui.voice_global.dictation.start');
                expect(request.input).toEqual({ commandId: command.id });
                requestedMicrophoneConsent = true;
                return false;
            },
            voiceConversationAction: async request => {
                const result = await executeCurrentUiContextAction(request);
                return result.ok ? result.result : result;
            },
        }));
        expect(await executor.execute('ui.current_context.command.invoke', { commandId: command.id },
            { surface: 'agent', authority: 'account_automation', ...scope, expectedAccountId: scope.accountId }))
            .toMatchObject({ ok: false });
        expect(captures).toBe(0);
        // The person's own Dictation control is direct (`uiConfirmation: 'direct'`): their press is the
        // consent, so no dialog is raised and the mounted command runs once.
        expect(await executor.execute('ui.current_context.command.invoke', { commandId: command.id },
            { surface: 'ui', authority: 'present_user', serverId: scope.serverId, expectedAccountId: scope.accountId }))
            .toEqual({ ok: true, result: { status: 'completed', dictationStatus: 'listening', inserted: false } });
        expect(requestedMicrophoneConsent).toBe(false);
        expect(captures).toBe(1);
        expect(await executor.execute('ui.voice_global.dictation.finish', { commandId: command.id },
            { surface: 'agent', authority: 'account_automation', serverId: scope.serverId, expectedAccountId: scope.accountId }))
            .toMatchObject({ ok: true, result: { status: 'unavailable', code: 'dictation_field_unmounted' } });
        expect(await executor.execute('ui.voice_global.dictation.start', { commandId: command.id },
            { surface: 'ui', authority: 'present_user', serverId: scope.serverId, expectedAccountId: 'other-account' }))
            .toMatchObject({ ok: true, result: { status: 'unavailable', code: 'dictation_field_unmounted' } });
        expect(captures).toBe(1);
        retirement.abort();
        expect(await executor.execute('ui.voice_global.dictation.start', { commandId: command.id },
            { surface: 'ui', authority: 'present_user', serverId: scope.serverId, expectedAccountId: scope.accountId }))
            .toMatchObject({ ok: true, result: { status: 'unavailable', code: 'dictation_field_unmounted' } });
        expect(captures).toBe(1);
    });

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
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({
            uiCurrentContextAction: request => executeCurrentUiContextAction(request, { execute: executor.execute, context: request.context }),
            accountHomeContinuationAction: request => executeCurrentUiContextAction(request),
        }));
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
            resolveCurrentUiCommand: () => null,
            subscribe: () => () => {},
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
