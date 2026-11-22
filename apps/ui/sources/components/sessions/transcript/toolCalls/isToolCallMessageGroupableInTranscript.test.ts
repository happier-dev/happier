import { describe, expect, it } from 'vitest';
import { createToolCallMessageFixture } from '@/dev/testkit';
import { resolveTranscriptSessionBoardItemReferenceV1 } from '@happier-dev/protocol/sessions/board';
import { ScmDiffSummaryGenerateSuccessSchema } from '@happier-dev/protocol/scm/diffSummary';
import { isToolCallMessageGroupableInTranscript } from './isToolCallMessageGroupableInTranscript';
import { buildChatListItems } from '@/components/sessions/chatListItems';
import { buildTranscriptTurns } from '@/components/sessions/transcript/turnGrouping/buildTranscriptTurns';
import { DEPLOYMENT_SUGGESTIONS_CHECK_ACTION_ID_V1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import { DeploymentSuggestionActionInputSchemasV1 } from '@happier-dev/protocol/deployments/suggestions/actionsV1';
import { DeploySuggestionCatalogV1Schema, checkDeploySuggestionV1 } from '@happier-dev/protocol/deployments/suggestions/deploySuggestionsV1';

describe('transcript tool group admission', () => {
    const runRef = { runId: 'run', callId: 'call', backendId: 'b1' };
    it.each([
        ['review_comments.v1', { sessionId: 's1', comments: [] }],
        ['review_findings.v1', { runRef, summary: 'Review ready', findings: [], generatedAtMs: 1 }],
        ['review_findings.v2', { runRef, summary: 'Review ready', overviewMarkdown: 'Overview', findings: [], generatedAtMs: 1 }],
        ['review_follow_up.v1', { parentRunRef: runRef, threadId: 'thread', requestMarkdown: 'Why?', answerMarkdown: 'Because.', generatedAtMs: 1 }],
        ['plan_output.v1', { runRef, summary: 'Plan ready', sections: [], generatedAtMs: 1 }],
        ['delegate_output.v1', { runRef, summary: 'Delegated work complete', deliverables: [], generatedAtMs: 1 }],
        ['execution_run_completion.v1', { v: 1, runId: 'run', status: 'succeeded', finishedAtMs: 1, canInspect: true }],
    ])('keeps a tool-carried %s result card outside collapsed groups', (kind, payload) => {
        const before = createToolCallMessageFixture({ id: 'before', createdAt: 1 });
        const message = createToolCallMessageFixture({ id: 'card', createdAt: 2, meta: { happier: { kind, payload } } });
        const input = { messageIdsOldestFirst: [before.id, message.id], messagesById: { [before.id]: before, [message.id]: message } };
        expect(isToolCallMessageGroupableInTranscript(message)).toBe(false);
        const linear = buildChatListItems({ ...input, pendingMessages: [], groupConsecutiveToolCalls: true });
        expect(linear.map(item => item.kind === 'tool-calls-group' ? item.toolMessageIds : item.kind === 'message' ? item.messageId : item.kind))
            .toEqual([['before'], 'card']);
        for (const strategy of ['consecutive_tools', 'all_tools_in_turn'] as const) {
            const turns = buildTranscriptTurns({ ...input, groupToolCalls: true, toolCallsGroupStrategy: strategy });
            expect(turns.flatMap(turn => turn.content.map(item => item.kind === 'tool_calls' ? item.toolMessageIds : item.messageId)))
                .toEqual([['before'], 'card']);
        }
    });

    // AUTO-FIX-W16 live 11-22 (Session cmwr5kh5…): a Session agent's checked setup cards sat inside a collapsed Tool calls
    // group, so the person saw a one-line row while the agent said "choose the card above". A check call is a result
    // card: it stays in the reply column from the call onward.
    it('keeps a Session agent’s deploy suggestion check outside collapsed groups', () => {
        const catalog = DeploySuggestionCatalogV1Schema.parse({ starters: [{ id: 'static', title: 'Static website', deploy: { framework: 'html', output: 'static' } }],
            apps: [], machines: [], stores: [], forges: [], targets: [{ id: 'own', title: 'Own server', targetClass: 'ownServer', availability: 'available',
                accepts: ['static'], needs: [] }] });
        const suggestion = { recommendations: [{ source: { kind: 'starter', starterId: 'static' }, targetId: 'own', title: 'Static invoice page',
            why: 'A static page needs no server code.', whatToBuild: 'A tiny invoice page', stack: { framework: 'html', output: 'static' },
            data: { kind: 'none' }, variables: [] }] };
        const input = { actionId: DEPLOYMENT_SUGGESTIONS_CHECK_ACTION_ID_V1, input: DeploymentSuggestionActionInputSchemasV1[DEPLOYMENT_SUGGESTIONS_CHECK_ACTION_ID_V1]
            .parse({ description: 'make me a tiny invoice app', suggestion }) };
        const before = createToolCallMessageFixture({ id: 'before', createdAt: 1 });
        const check = createToolCallMessageFixture({ id: 'check', createdAt: 2, tool: { name: 'mcp__happier__action_execute', state: 'completed',
            input, result: { ok: true, result: checkDeploySuggestionV1(suggestion, catalog) }, createdAt: 2, startedAt: 2, completedAt: 3, description: null } });
        const running = createToolCallMessageFixture({ id: 'running', createdAt: 2, tool: { name: 'mcp__happier__action_execute', state: 'running',
            input, createdAt: 2, startedAt: 2, completedAt: null, description: null } });
        expect(isToolCallMessageGroupableInTranscript(check)).toBe(false);
        expect(isToolCallMessageGroupableInTranscript(running), 'the call keeps its place while its result arrives').toBe(false);
        const turns = buildTranscriptTurns({ messageIdsOldestFirst: [before.id, check.id], messagesById: { [before.id]: before, [check.id]: check },
            groupToolCalls: true, toolCallsGroupStrategy: 'all_tools_in_turn' });
        expect(turns.flatMap(turn => turn.content.map(item => item.kind === 'tool_calls' ? item.toolMessageIds : item.messageId)))
            .toEqual([['before'], 'check']);
    });

    it('keeps malformed card metadata and an unsaved SCM result in ordinary tool disclosure', () => {
        expect(isToolCallMessageGroupableInTranscript(createToolCallMessageFixture({
            meta: { happier: { kind: 'plan_output.v1', payload: {} } },
        }))).toBe(true);
        expect(isToolCallMessageGroupableInTranscript(createToolCallMessageFixture({
            meta: { happier: { kind: 'scm_diff_summary.v1', payload: { success: true, sourceKey: 'comparison' } } },
        }))).toBe(true);
    });

    it.each(['historical', 'single'] as const)('places a retained published SCM receipt beside tool chrome, but leaves an unsaved result in details (%s)', shape => {
        const payload = ScmDiffSummaryGenerateSuccessSchema.parse({ success: true, sourceKey: 'comparison', resultId: 'saved', revision: 2,
            metadata: { source: { kind: 'workingTree' }, sourceKey: 'comparison' },
            comparison: { id: 'comparison', source: { kind: 'workingTree' }, repository: { rootPath: '/repo' }, endpoints: {},
                inventory: { state: 'complete', reasons: [], files: [] } },
            requestedOutputs: ['walkthrough'], outputs: { walkthrough: { state: 'complete', value: {
                title: 'Saved explanation', intro: '', stops: [], otherChangeRefs: [],
            } } }, analysis: { suppliedChangeRefs: [], analysedChangeRefs: [], remainingChangeRefs: [] },
        });
        const retainedPayload = { ...payload, retiredPayloadField: true };
        const base = createToolCallMessageFixture();
        const published = createToolCallMessageFixture({ tool: { ...base.tool, result: retainedPayload },
            meta: { happier: shape === 'historical' ? { kind: 'scm_diff_summary.v1', payload: retainedPayload } : { kind: 'scm_diff_summary.v1' },
            scmResultUpdate: { status: 'published', canUndo: true, outputs: [{ kind: 'walkthrough', change: 'created' }] } } });
        expect(isToolCallMessageGroupableInTranscript(published)).toBe(false);
        expect(isToolCallMessageGroupableInTranscript({ ...published, meta: { happier: { kind: 'scm_diff_summary.v1', payload: retainedPayload } } })).toBe(true);
    });

    it('keeps ordinary tool media inside the tool disclosure', () => {
        const message = createToolCallMessageFixture({ meta: { happierMedia: { kind: 'session_media.v1', payload: { media: [] } } } });
        expect(isToolCallMessageGroupableInTranscript(message)).toBe(true);
    });

    it.each([
        ['skills.create', { ok: true, skillId: 'review', revision: '1:1', summary: { name: 'Review' } }],
        ['template.draft', { draftArtifactId: '1f34ad50-41b4-470c-bdb0-adbbbd6b2bcb', revision: { headerVersion: 1, bodyVersion: 1 },
            sourceSessionRef: { serverId: 'home', sessionId: 'source' }, summary: { identity: { name: 'Garden', description: '' },
                includes: { memoryRules: 0, skills: 0, software: 0, connectedAccounts: 0, mcpServers: 0 }, leftOut: { memoryRules: 0, skills: 0 } } }],
    ])('keeps an acknowledged %s result visible outside collapsed tool groups in every layout', (actionId, result) => {
        const base = createToolCallMessageFixture();
        const card = createToolCallMessageFixture({ id: 'card', createdAt: 3, tool: { ...base.tool,
            name: 'mcp__happier__action_execute', state: 'completed', input: { actionId, input: {} }, result: { ok: true, result } } });
        const messages = [createToolCallMessageFixture({ id: 'before-1', createdAt: 1 }),
            createToolCallMessageFixture({ id: 'before-2', createdAt: 2 }), card];
        const input = { messageIdsOldestFirst: messages.map(message => message.id),
            messagesById: Object.fromEntries(messages.map(message => [message.id, message])) };
        expect(isToolCallMessageGroupableInTranscript(card)).toBe(false);
        const linear = buildChatListItems({ ...input, pendingMessages: [], groupConsecutiveToolCalls: true });
        expect(linear.map(item => item.kind === 'tool-calls-group' ? item.toolMessageIds
            : item.kind === 'message' ? item.messageId : item.kind)).toEqual([['before-1', 'before-2'], 'card']);
        for (const strategy of ['consecutive_tools', 'all_tools_in_turn'] as const) {
            const turns = buildTranscriptTurns({ ...input, groupToolCalls: true, toolCallsGroupStrategy: strategy });
            expect(turns.flatMap(turn => turn.content.map(item => item.kind === 'tool_calls'
                ? item.toolMessageIds : item.messageId))).toEqual([['before-1', 'before-2'], 'card']);
        }
        // Keep the same row placement while a deferred approval later supplies its result card.
        expect(isToolCallMessageGroupableInTranscript({ ...card, tool: { ...card.tool, state: 'running', result: undefined } })).toBe(false);
        expect(isToolCallMessageGroupableInTranscript({ ...card, tool: { ...card.tool,
            result: { ok: false, errorCode: 'permission_denied' } } })).toBe(false);
    });
    it.each([
        { actionId: 'workflow.run.start', input: {}, result: null },
        { actionId: 'workflow.definition.edit', input: {}, result: null },
        { actionId: 'browser.context.captureScreenshot', input: { browserSessionId: 'browser', viewId: 'view' }, result: null },
        { actionId: 'computer.capture', input: { machineId: 'machine' }, result: {
            status: 'target_selection_required', approvalDisplay: { machineDisplayName: 'Studio', requiresTargetSelection: true } } },
    ])('uses the same standalone placement for sibling $actionId cards', ({ actionId, input, result }) => {
        const base = createToolCallMessageFixture();
        const message = createToolCallMessageFixture({ tool: { ...base.tool,
            name: 'mcp__happier__action_execute', state: 'completed', input: { actionId, input }, result } });
        expect(isToolCallMessageGroupableInTranscript(message)).toBe(false);
        expect(isToolCallMessageGroupableInTranscript({ ...message, tool: { ...message.tool,
            name: 'mcp__foreign__action_execute' } })).toBe(true);
    });
    it('keeps an unanswered permission outside disclosure without excluding ordinary tools', () => {
        const ordinary = createToolCallMessageFixture();
        const approval = createToolCallMessageFixture({ tool: { ...ordinary.tool,
            permission: { id: 'approval', status: 'pending', kind: 'permission' },
        } });
        expect(isToolCallMessageGroupableInTranscript(ordinary)).toBe(true);
        expect(isToolCallMessageGroupableInTranscript(approval)).toBe(false);
    });

    it.each(['running', 'completed', 'error'] as const)('keeps a %s review standalone in linear and turn layouts while ordinary runs remain grouped', (state) => {
        const base = createToolCallMessageFixture();
        const ordinary = (id: string, createdAt: number) => createToolCallMessageFixture({ id, createdAt,
            tool: { ...base.tool, name: 'SubAgentRun', input: { runId: id, intent: 'delegate' } } });
        const review = createToolCallMessageFixture({ id: 'review', createdAt: 3,
            tool: { ...base.tool, name: 'SubAgentRun', state, input: { runId: 'review-run', intent: 'review' } } });
        const messages = [ordinary('before-1', 1), ordinary('before-2', 2), review,
            ordinary('after-1', 4), ordinary('after-2', 5)];
        const input = { messageIdsOldestFirst: messages.map((message) => message.id),
            messagesById: Object.fromEntries(messages.map((message) => [message.id, message])) };

        const linear = buildChatListItems({ ...input, pendingMessages: [], groupConsecutiveToolCalls: true });
        expect(linear.map((item) => item.kind === 'tool-calls-group' ? item.toolMessageIds
            : item.kind === 'message' ? item.messageId : item.kind)).toEqual([
            ['before-1', 'before-2'], 'review', ['after-1', 'after-2'],
        ]);
        for (const strategy of ['consecutive_tools', 'all_tools_in_turn'] as const) {
            const turns = buildTranscriptTurns({ ...input, groupToolCalls: true, toolCallsGroupStrategy: strategy });
            expect(turns.flatMap((turn) => turn.content.map((item) => item.kind === 'tool_calls'
                ? item.toolMessageIds : item.messageId))).toEqual(strategy === 'consecutive_tools'
                ? [['before-1', 'before-2'], 'review', ['after-1', 'after-2']]
                : [['before-1', 'before-2', 'after-1', 'after-2'], 'review']);
        }
    });
});

describe('transcript visual replies', () => {
    const visualCall = (itemDestination: 'transcript' | 'board' | 'both', state = 'completed') => {
        const base = createToolCallMessageFixture();
        const input = { itemId: 'chart', expectedItemRevision: null, destination: itemDestination,
            ...(itemDestination === 'transcript' ? {} : { placement: {} }),
            item: { v: 1, title: 'Chart', frame: 'frameless', height: { mode: 'auto', fallback: 'regular' },
                source: { kind: 'declarative', document: { version: 1, root: { kind: 'markdown', text: 'Chart' } } } } };
        const result = { v: 1, serverId: 'home', sessionId: 'session', itemDestination,
            destination: itemDestination === 'transcript' ? null : { tabId: 'main', width: 'full' },
            result: { operation: 'upsert_item', itemId: 'chart', itemRevision: 'ssr1.AAAACHN5c3JlY18xAAAAAQ', outcome: 'created',
                ...(itemDestination === 'transcript' ? {} : { layoutRevision: 'ssr1.AAAACHN5c3JlY18xAAAAAg' }) } };
        return createToolCallMessageFixture({ tool: { ...base.tool, name: 'session_board_item_upsert', state, input, result } as typeof base.tool });
    };

    it('stands a call that answered with a transcript visual on its own, so the visual is the reply and not group content', () => {
        expect(isToolCallMessageGroupableInTranscript(visualCall('transcript'))).toBe(false);
        expect(isToolCallMessageGroupableInTranscript(visualCall('both'))).toBe(false);
    });

    it('keeps Board-only and unfinished visual calls in the ordinary tool group', () => {
        const board = visualCall('board');
        // The Board-only call is a real acknowledgement, so it stays grouped for its destination, not for a bad shape.
        expect(resolveTranscriptSessionBoardItemReferenceV1({ toolName: board.tool.name, state: board.tool.state, input: board.tool.input,
            result: board.tool.result, address: { serverId: 'home', sessionId: 'session' } })?.itemDestination).toBe('board');
        expect(isToolCallMessageGroupableInTranscript(board)).toBe(true);
        expect(isToolCallMessageGroupableInTranscript(visualCall('transcript', 'running'))).toBe(true);
    });
});

describe('transcript visuals at Ask', () => {
    const askedVisualCall = (destination: 'transcript' | 'board' | 'both', state = 'completed') => {
        const base = createToolCallMessageFixture();
        const input = { itemId: 'chart', expectedItemRevision: null, destination,
            ...(destination === 'transcript' ? {} : { placement: {} }),
            item: { v: 1, title: 'Chart', frame: 'frameless', height: { mode: 'auto', fallback: 'regular' },
                source: { kind: 'declarative', document: { version: 1, root: { kind: 'markdown', text: 'Chart' } } } } };
        const result = { ok: true, result: { kind: 'approval_request_created', artifactId: 'approval-1', actionId: 'session.board.item.upsert' } };
        return createToolCallMessageFixture({ tool: { ...base.tool, name: 'session_board_item_upsert', state, input, result } as typeof base.tool });
    };

    it('stands an asked transcript visual on its own: its approval becomes the visual at the call, never group content', () => {
        expect(isToolCallMessageGroupableInTranscript(askedVisualCall('transcript'))).toBe(false);
        expect(isToolCallMessageGroupableInTranscript(askedVisualCall('both'))).toBe(false);
    });

    it('stands an asked visual alone when the agent reached it through action_execute with the bare outcome text', () => {
        const base = createToolCallMessageFixture();
        const visualInput = { itemId: 'chart', expectedItemRevision: null, destination: 'transcript',
            item: { v: 1, title: 'Chart', frame: 'frameless', height: { mode: 'auto', fallback: 'regular' },
                source: { kind: 'declarative', document: { version: 1, root: { kind: 'markdown', text: 'Chart' } } } } };
        const outcome = { kind: 'approval_request_created', artifactId: 'approval-1', actionId: 'session.board.item.upsert' };
        const tool = { ...base.tool, name: 'mcp__happier__action_execute', state: 'completed',
            input: { actionId: 'session.board.item.upsert', input: visualInput },
            result: { content: [{ type: 'text', text: JSON.stringify(outcome) }], structuredContent: null } };
        expect(isToolCallMessageGroupableInTranscript(createToolCallMessageFixture({ tool } as Parameters<typeof createToolCallMessageFixture>[0]))).toBe(false);
    });

    it('keeps an asked Board-only visual and an unfinished call in the ordinary tool group', () => {
        expect(isToolCallMessageGroupableInTranscript(askedVisualCall('board'))).toBe(true);
        expect(isToolCallMessageGroupableInTranscript(askedVisualCall('transcript', 'running'))).toBe(true);
    });
});

describe('Ask record rows', () => {
    const sendCall = (name: string, actionId: string | null) => {
        const base = createToolCallMessageFixture();
        return createToolCallMessageFixture({ tool: { ...base.tool, name,
            input: actionId ? { actionId, input: { sessionId: 'receiver', message: 'Question', reply: 'wait' } } : { sessionId: 'receiver' },
            result: { ok: true, result: { status: 'accepted', localId: 'request' } } } });
    };

    it('stands an agent’s message send on its own, so who it asked and how it ended stay visible, and groups other Actions', () => {
        expect(isToolCallMessageGroupableInTranscript(sendCall('mcp__happier__action_execute', 'session.message.send'))).toBe(false);
        expect(isToolCallMessageGroupableInTranscript(sendCall('mcp__happier__action_execute', 'session.status.get'))).toBe(true);
        expect(isToolCallMessageGroupableInTranscript(sendCall('exec', null))).toBe(true);
    });
});
