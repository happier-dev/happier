import { describe, expect, it, vi } from 'vitest';

import { createPermissionHandlerSessionStub } from '../utils/permissionHandler.testkit';
import type { SessionHookData } from '../utils/startHookServer';
import { routeClaudePermissionHook } from './routeClaudePermissionHook';
import { ClaudeLocalPermissionBridge } from './localPermissionBridge';

describe('Claude permission hook delivery', () => {
    it('keeps app-only questions on the existing bridge despite a legacy bridge opt-out', async () => {
        const { session, client } = createPermissionHandlerSessionStub('app-only-question');
        session.onClaudeSessionHook = () => {};
        const bridge = new ClaudeLocalPermissionBridge(session);
        bridge.activate();
        const pending = routeClaudePermissionHook({
            data: { hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_use_id: 'app-only',
                tool_input: { questions: [{ question: 'Which color?', header: 'Color', options: [{ label: 'Blue' }], multiSelect: false }] },
            },
            session, bridge, unifiedTerminalActive: true,
            settings: { claudeLocalPermissionBridgeEnabled: false, claudeUnifiedTerminalQuestionResponseLocation: 'app_only' },
        });
        await vi.waitFor(() => expect(client.agentState.requests['app-only']).toBeDefined());
        await expect(client.rpcHandlerManager.getHandler('permission')!({
            id: 'app-only', approved: true, structuredAnswersV1: { 'Which color?': ['Blue'] },
        })).resolves.toEqual({ ok: true });
        await expect(pending).resolves.toMatchObject({ hookSpecificOutput: {
            hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { answers: { 'Which color?': 'Blue' } },
        } });
        bridge.dispose();
    });

    it('lets a native question render without publishing a blocking app-hook request', async () => {
        const { session, client } = createPermissionHandlerSessionStub('native-question-ingress');
        const hooks: SessionHookData[] = [];
        session.onClaudeSessionHook = (data) => { hooks.push(data); };
        const data = {
            hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_use_id: 'toolu_native_question',
            tool_input: { questions: [{ question: 'Which color?', header: 'Color', options: [
                { label: 'Amber', description: 'Warm' }, { label: 'Blue', description: 'Cool' },
            ], multiSelect: false }] },
        };

        const response = await routeClaudePermissionHook({
            data, session, bridge: null, settings: {}, unifiedTerminalActive: true,
        });

        expect(response.hookSpecificOutput).toEqual({ hookEventName: 'PreToolUse' });
        expect(hooks).toEqual([expect.objectContaining({
            hook_event_name: 'ClaudeNativePrompt', tool_use_id: 'toolu_native_question',
            tool_input: data.tool_input, happierResponseLocation: 'app_and_terminal',
        })]);
        expect(client.getAgentStateSnapshot().requests).toEqual({});
    });

    it('does not publish the second PermissionRequest hook as another native question', async () => {
        const { session } = createPermissionHandlerSessionStub('native-question-second-hook');
        const hooks: SessionHookData[] = [];
        session.onClaudeSessionHook = (data) => { hooks.push(data); };
        await routeClaudePermissionHook({
            data: { hook_event_name: 'PermissionRequest', tool_name: 'AskUserQuestion', tool_input: {} },
            session, bridge: null, settings: {}, unifiedTerminalActive: true,
        });
        expect(hooks).toEqual([]);
    });

    it('respects the independent permission preference over the old bridge opt-out', async () => {
        const { session } = createPermissionHandlerSessionStub('native-permission-ingress');
        const hooks: SessionHookData[] = [];
        session.onClaudeSessionHook = (data) => { hooks.push(data); };
        await routeClaudePermissionHook({
            data: { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'probe' } },
            session, bridge: null, unifiedTerminalActive: true,
            settings: {
                claudeLocalPermissionBridgeEnabled: false,
                claudeUnifiedTerminalQuestionResponseLocation: 'terminal_only',
                claudeUnifiedTerminalPermissionResponseLocation: 'app_and_terminal',
            },
        });
        expect(hooks).toEqual([expect.objectContaining({
            hook_event_name: 'ClaudeNativePrompt', tool_name: 'Bash',
            happierResponseLocation: 'app_and_terminal',
        })]);
    });
});
