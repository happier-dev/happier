import { describe, expect, it } from 'vitest';
import { createReducer, reducer } from "../reducer.js";
import { runAgentStatePermissionsPhase } from "./agentStatePermissions.js";
import { AgentStateSchema } from '../../state/agentState.js';
import { ResolvedMcpToolIdentityV1Schema } from '@happier-dev/protocol/mcp/servers/tools/mcpToolIdentityV1';
import { listPendingPermissionRequests } from '../../pending/listPendingRequests.js';

describe('runAgentStatePermissionsPhase (permission suggestions)', () => {
    it('retains the exact native choice on a settled transcript permission even after tool execution starts', () => {
        const nativeChoices = { requirementId: 'native', source: 'native', choices: [
            { id: 'custom', label: 'Allow this exact command', decision: 'approved' as const, scope: 'once' as const, response: { approved: true as const } },
        ] };
        const request = { tool: 'Shell', arguments: {}, createdAt: 1, nativeChoices };
        const state = createReducer();
        reducer(state, [], AgentStateSchema.parse({ requests: { permission: request } }));
        const messageId = state.toolIdToMessageId.get('permission')!;
        const tool = state.messages.get(messageId)!.tool!;
        tool.startedAt = 2;
        tool.permission!.status = 'approved';
        const nativeChoice = { requirementId: 'native', choiceId: 'custom' };
        reducer(state, [], AgentStateSchema.parse({ completedRequests: { permission: {
            ...request, completedAt: 3, status: 'approved', nativeChoice,
        } } }));
        expect(state.messages.get(messageId)?.tool?.permission).toMatchObject({ nativeChoices, nativeChoice });
    });
    it('keeps replaced native offers current when pending requests are reconstructed from transcript', () => {
        const offer = (requirementId: string) => ({ requirementId, source: 'native', origin: { sessionId: 'parent', subagentId: 'child' },
            choices: [{ id: 'allow-custom', label: 'Allow native command', decision: 'approved' as const, scope: 'once' as const, response: { approved: true as const } }] });
        const makeState = (nativeChoices: ReturnType<typeof offer>) => AgentStateSchema.parse({ requests: { permission: {
            tool: 'Shell', arguments: { command: 'pwd' }, createdAt: 1, nativeChoices,
        } } });
        const state = createReducer();
        reducer(state, [], makeState(offer('first')));
        const current = offer('replacement');
        const messages = reducer(state, [], makeState(current)).messages;
        const facts = { sessionId: 'parent', active: true, agentState: null, actionConfirmations: null,
            presentationCompletedRequests: null, projected: null };
        expect(listPendingPermissionRequests(facts, messages)[0]?.nativeChoices).toEqual(current);
    });

    it('keeps validated MCP identity across stored AgentState, transcript projection and pending requests', () => {
        const identity = ResolvedMcpToolIdentityV1Schema.parse({ server: 'github', tool: 'delete_file', item: { serverId: 'catalog-github' },
            serverTitle: 'GitHub', toolTitle: 'Delete file', annotations: { destructiveHint: true },
            decision: { exposed: true, approval: 'ask', effectClass: 'unknown', source: 'server_default' } });
        const agentState = AgentStateSchema.parse({ requests: { permission: { tool: 'mcp__github__delete_file',
            arguments: { path: '/repo/file' }, createdAt: 1, mcpTool: identity } } });
        expect(agentState.requests?.permission).toHaveProperty('mcpTool', identity);
        const state = createReducer();
        const messages = reducer(state, [], agentState).messages;
        const message = messages[0];
        expect(message?.kind === 'tool-call' ? message.tool.permission : undefined).toHaveProperty('mcpTool', identity);
        const facts = { sessionId: 'session', active: true, agentState, actionConfirmations: null,
            presentationCompletedRequests: null, projected: null };
        expect(listPendingPermissionRequests(facts)[0]).toHaveProperty('mcpTool', identity);
        // A transcript-only reader must retain the same subject after AgentState unloads.
        expect(listPendingPermissionRequests({ ...facts, agentState: null }, messages)[0]).toHaveProperty('mcpTool', identity);
        expect(AgentStateSchema.parse({ requests: { broken: { tool: 'mcp__unknown__tool', arguments: {}, mcpTool: { server: 'github' } } } }).requests?.broken.mcpTool).toBeUndefined();
    });
    it('persists permission suggestions onto newly-created tool permission entries', () => {
        const state = createReducer();
        const changed = new Set<string>();

        const permId = 'perm-1';
        const messageId = 'msg-1';
        const suggestions = [{ type: 'setMode', mode: 'bypassPermissions', destination: 'session' }];

        runAgentStatePermissionsPhase({
            state,
            agentState: {
                controlledByUser: null,
                requests: {
                    [permId]: {
                        tool: 'ExitPlanMode',
                        arguments: { plan: 'do the thing' },
                        createdAt: 1,
                        permissionSuggestions: suggestions,
                    },
                },
                completedRequests: null,
            } as any,
            incomingToolIds: new Set<string>(),
            changed,
            allocateId: () => messageId,
            enableLogging: false,
        });

        const message = state.messages.get(messageId);
        expect((message?.tool?.permission as any)?.suggestions).toEqual(suggestions);
    });
});
