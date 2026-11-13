import { describe, expect, it, vi } from 'vitest';
import { createTextModuleMock } from '@/dev/testkit/mocks/text';

vi.mock('@/text', () => createTextModuleMock());

import { resolveSessionPermissionChoices, selectSessionPermissionChoiceForDecision } from './sessionPermissionChoices';
import { answerSessionPermission, resolveSessionPermissionBehavior } from './sessionPermissionAnswers';
import { createClaudePermissionEngine, type ClaudePermissionContext } from '../../../../../packages/plugins/claude/src/agent/permissions/createClaudePermissionEngine';

describe('Session permission offered choices', () => {
    it('uses only native offers for Muse and never guesses a Claude grant for an offerless request', () => {
        const permissionBehavior = resolveSessionPermissionBehavior({ agentId: 'muse', metadata: { flavor: 'muse' }, accountScope: null });
        expect(resolveSessionPermissionChoices({ toolName: 'Bash', permissionBehavior }))
            .toEqual([{ id: 'deny', label: 'common.no', response: { approved: false, decision: 'denied' } }]);
        const nativeChoices = { requirementId: 'muse-approval', source: 'native-agent', choices: [
            { id: 'muse:once', label: 'Allow once', decision: 'approved' as const, scope: 'once' as const,
                response: { approved: true } },
        ] };
        expect(resolveSessionPermissionChoices({ toolName: 'Bash', permissionBehavior, nativeChoices }))
            .toEqual([{ id: 'muse:once', label: 'Allow once', decision: 'approved', scope: 'once',
                response: { nativeChoice: { requirementId: 'muse-approval', choiceId: 'muse:once' } } }]);
    });
    it('keeps the existing catalog consent reachable for a live external Claude MCP request', async () => {
        // The plugin's host permission service is the external SDK boundary.
        const requestDecision = vi.fn(async (_request: Parameters<ClaudePermissionContext['sessions']['current']['permissions']['requestDecision']>[0],
            _options?: Parameters<ClaudePermissionContext['sessions']['current']['permissions']['requestDecision']>[1]) => ({ decision: 'approved' as const }));
        const context = { sessions: { current: { permissions: { requestDecision } } } } as ClaudePermissionContext;
        await createClaudePermissionEngine(context).canCallTool('mcp__docs__mutate', { page: 'draft' }, { requestId: 'live-mcp' });
        const request = requestDecision.mock.calls[0]![0];
        if (!request.toolName) throw new Error('Expected the requested tool name');
        const mcpTool = { server: 'docs', tool: 'mutate', serverTitle: 'Docs', item: { serverId: 'docs-id' },
            decision: { exposed: true, approval: 'ask' as const, effectClass: 'write' as const, source: 'server_default' as const } };
        const nativeChoices = requestDecision.mock.calls[0]![1]?.buildNativeChoices?.({ mcpTool });
        const choices = resolveSessionPermissionChoices({ toolName: request.toolName, toolInput: request.input,
            nativeChoices, canWriteCatalog: true,
            permissionBehavior: resolveSessionPermissionBehavior({ agentId: 'claude', metadata: { flavor: 'claude' }, accountScope: null }),
            mcpTool,
        });
        expect(choices.some(choice => choice.id === 'mcp_always_allow')).toBe(true);
        expect(choices.find(choice => choice.id === 'mcp_always_allow')?.followUp).toEqual({
            actionId: 'mcp.servers.tools.set', input: { serverId: 'docs-id', tools: { mutate: 'allow' } },
        });
    });
    it.each([
        { label: 'available once', allowed: true, omitOnce: false, expected: 'opaque:once' },
        { label: 'unavailable once', allowed: false, omitOnce: false, expected: undefined },
        { label: 'only broader grants', allowed: true, omitOnce: true, expected: undefined },
    ])('maps Yes only to an available once grant ($label), and No to Deny rather than Stop', ({ allowed, omitOnce, expected }) => {
        const choices = resolveSessionPermissionChoices({ toolName: 'Shell', nativeChoices: {
            requirementId: 'spoken-occurrence', source: 'native-agent', choices: [
                { id: 'opaque:session', label: 'Grant session', decision: 'approved_for_session', scope: 'session',
                    response: { approved: true, decision: 'approved_for_session' } },
                { id: 'opaque:stop', label: 'Stop', decision: 'abort', scope: 'once', response: { approved: false, decision: 'abort' } },
                ...(!omitOnce ? [{ id: 'opaque:once', label: 'Grant once', decision: 'approved', scope: 'once',
                    response: { approved: true, decision: 'approved' } }] : []),
                { id: 'opaque:deny', label: 'Refuse', decision: 'denied', scope: 'once', response: { approved: false, decision: 'denied' } },
            ],
        }, nativeChoiceAvailability: [{ choiceId: 'opaque:once', allowed }] });
        expect(selectSessionPermissionChoiceForDecision(choices, 'approved')?.response.nativeChoice)
            .toEqual(expected ? { requirementId: 'spoken-occurrence', choiceId: expected } : undefined);
        expect(selectSessionPermissionChoiceForDecision(choices, 'denied')?.response.nativeChoice)
            .toEqual({ requirementId: 'spoken-occurrence', choiceId: 'opaque:deny' });
    });

    it.each([true, false])('maps No to the offered Stop only when available (%s), never to Yes', allowed => {
        const choices = resolveSessionPermissionChoices({ toolName: 'Shell', nativeChoices: {
            requirementId: 'stop-only', source: 'native-agent', choices: [
                { id: 'stop-only', label: 'Stop', decision: 'abort', scope: 'once', response: { approved: false, decision: 'abort' } },
            ],
        }, nativeChoiceAvailability: [{ choiceId: 'stop-only', allowed }] });
        expect(selectSessionPermissionChoiceForDecision(choices, 'approved')).toBeUndefined();
        // Voice ORCH RUN107 ruling: No selects Stop when no Deny was offered.
        expect(selectSessionPermissionChoiceForDecision(choices, 'denied')?.response.nativeChoice)
            .toEqual(allowed ? { requirementId: 'stop-only', choiceId: 'stop-only' } : undefined);
        expect(selectSessionPermissionChoiceForDecision([], 'approved')).toBeUndefined();
        expect(selectSessionPermissionChoiceForDecision([], 'denied')).toBeUndefined();
    });

    it.each(['claude', 'codex'])('keeps stored %s occurrences answerable after live descriptor policy removal', agentId => {
        const behavior = resolveSessionPermissionBehavior({ agentId, metadata: { flavor: agentId }, accountScope: null });
        const choices = resolveSessionPermissionChoices({ toolName: 'Bash', permissionBehavior: behavior });
        expect(choices.map(choice => choice.id)).toContain('allow');
        expect(choices.find(choice => choice.id === 'always_allow')?.response).toMatchObject(agentId === 'claude'
            ? { allowedTools: ['Bash'], updatedPermissions: [{ type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'allow', destination: 'session' }] }
            : { decision: 'approved_for_session' });
        expect(choices.find(choice => choice.id === 'stop')?.response).toEqual({ approved: false, decision: agentId === 'claude' ? 'abort' : 'denied' });
    });
    it.each(['opencode', 'pi', 'gemini', 'ohMyPi'])('keeps stored %s grant and stop semantics after live descriptor policy removal', agentId => {
        const behavior = resolveSessionPermissionBehavior({ agentId, metadata: { flavor: agentId }, accountScope: null });
        const choices = resolveSessionPermissionChoices({ toolName: 'Bash', permissionBehavior: behavior });
        expect(choices.find(choice => choice.id === 'allow')?.response).toEqual({ approved: true, decision: 'approved' });
        expect(choices.find(choice => choice.id === 'always_allow')?.response).toEqual({ approved: true, decision: 'approved_for_session' });
        expect(choices.find(choice => choice.id === 'stop')?.response).toEqual({ approved: false, decision: 'abort' });
    });
    it('submits the native selection without inventing normalized aliases', async () => {
        const respondToPermission = vi.fn(async () => {});
        await answerSessionPermission({ requestId: 'pending', turnId: 'turn',
            nativeChoice: { requirementId: 'occurrence', choiceId: 'opaque:stop', feedback: 'Stop here' },
            respondToPermission });
        expect(respondToPermission).toHaveBeenCalledWith({ id: 'pending', turnId: 'turn',
            nativeChoice: { requirementId: 'occurrence', choiceId: 'opaque:stop', feedback: 'Stop here' } });
    });
    it('projects only the offered opaque IDs and submits occurrence-bound selections', () => {
        const nativeChoices = {
            requirementId: 'requirement-child-2', source: 'native-test',
            origin: { sessionId: 'child-session', subagentId: 'worker' },
            choices: [
                { id: 'grant-workspace:opaque', label: 'Grant workspace', decision: 'approved_for_session' as const,
                    scope: 'session' as const, rulePreview: 'workspace edits',
                    response: { approved: true as const, mode: 'acceptEdits' as const } },
                { id: 'halt:opaque', label: 'Stop this turn', decision: 'abort' as const,
                    scope: 'once' as const, response: { approved: false as const, decision: 'abort' as const } },
            ],
        };
        const choices = resolveSessionPermissionChoices({ toolName: 'Write', nativeChoices,
            permissionBehavior: undefined, canWriteCatalog: true });
        expect(choices).toEqual(nativeChoices.choices.map(choice => ({
            id: choice.id, label: choice.label, decision: choice.decision, scope: choice.scope,
            ...(choice.rulePreview ? { rulePreview: choice.rulePreview } : {}),
            response: { nativeChoice: { requirementId: 'requirement-child-2', choiceId: choice.id } },
        })));
    });

    it('preserves the frozen stored-request reader when no offered choices were recorded', () => {
        const choices = resolveSessionPermissionChoices({ toolName: 'Bash', permissionBehavior: {
            promptProtocol: 'claude', footer: { usePermissionUpdates: true, stopHandling: 'denyOnly' },
        } });
        expect(choices.find(choice => choice.id === 'always_allow')?.response).toMatchObject({
            approved: true, allowedTools: ['Bash'],
            updatedPermissions: [{ type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'allow', destination: 'session' }],
        });
        expect(choices.find(choice => choice.id === 'stop')?.response).toEqual({ approved: false, decision: 'denied' });
    });

    it('preserves an empty offer and the authority owner\'s unavailable-choice result', () => {
        expect(resolveSessionPermissionChoices({ toolName: 'Bash', permissionBehavior: undefined,
            nativeChoices: { requirementId: 'empty', source: 'agent', choices: [] } })).toEqual([]);
        const availability = { choiceId: 'persistent', allowed: false, reason: 'owner_required' as const };
        expect(resolveSessionPermissionChoices({ toolName: 'Bash', permissionBehavior: undefined,
            nativeChoices: { requirementId: 'restricted', source: 'agent', choices: [{ id: 'persistent',
                label: 'Save policy', decision: 'approved', scope: 'localPersistent', allowsFeedback: true,
                response: { approved: true, mode: 'acceptEdits' } }] },
            nativeChoiceAvailability: [availability],
        })).toEqual([{ id: 'persistent', label: 'Save policy', decision: 'approved', scope: 'localPersistent',
            allowsFeedback: true, availability,
            response: { nativeChoice: { requirementId: 'restricted', choiceId: 'persistent' } } }]);
    });

    it.each([null, {}, { requirementId: 'broken', source: 'agent', choices: 'invalid' }])('never downgrades malformed native facts to generic grants (%j)', nativeChoices => {
        expect(resolveSessionPermissionChoices({ toolName: 'Bash', nativeChoices,
            permissionBehavior: { promptProtocol: 'claude', footer: { usePermissionUpdates: true } },
        })).toEqual([]);
    });
});
