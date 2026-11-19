import React from 'react';
import { act } from 'react-test-renderer';
import type { NormalizedMessage } from '@happier-dev/session-core/raw';
import { buildToolCallMessageRouteId } from '@happier-dev/session-core/messages';
import { describe, expect, it, vi } from 'vitest';
import type { ToolCall } from "@happier-dev/session-core/messages";
import { createSessionFixture, makeToolCall, makeToolViewProps, pressTestInstanceAsync, renderScreen } from '@/dev/testkit';
import { createCommittedFiberRenderCounter, readTestRendererRoot } from '@/dev/testkit/performance/committedFiberCounts';
import { TranscriptFindProvider } from '@/components/sessions/transcript/find/TranscriptFindContext';
import { createTranscriptFindRowStore } from '@/components/sessions/transcript/find/transcriptFindRowStore';
import { initializeRealAppRuntimeForTests } from '@/dev/testkit/harness/realAppRuntimeHarness';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/components/ui/media/CodeView', () => ({
    CodeView: ({ code }: any) => React.createElement('Text', null, code),
}));

// Load the real renderer during collection; cold module transforms are setup, not an interaction timeout.
// The app entry initializes Sync before any theme result reads its Account-scoped Redo owner.
await initializeRealAppRuntimeForTests();
const { ToolView } = await import('../../shell/views/ToolView');
const { AppSessionTranscriptSourceProvider } = await import('@/components/sessions/transcript/source/appSessionTranscriptSource');
const { useSessionTranscriptSource } = await import('@/components/sessions/transcript/source/SessionTranscriptSourceContext');
const { storage } = await import('@/sync/domains/state/storage');
const { settingsDefaults } = await import('@/sync/domains/settings/settings');
const { ThemeActionResult } = await import('./ThemeActionResult');
const { ThemeActionResultView } = await import('./ThemeActionResultView');

describe('MCPToolView', () => {
    it('hosts four streamed theme proposals on the final tool and skips unrelated arrivals', async () => {
        const { THEME_ACTION_IDS } = await import('@happier-dev/protocol/actions/themeActionFamily');
        const { themeActionDocument } = await import('@/dev/testkit/harness/themeActionHarness');
        const { prepareThemeProfileCss } = await import('@/theme/css/prepareThemeCss');
        const serverId = 'theme-transcript-home';
        const session = createSessionFixture({ id: 'theme-transcript-group', serverId });
        const previous = storage.getState();
        const common = (id: string, seq: number) => ({ id, seq, createdAt: seq, isSidechain: false, localId: null });
        const candidate = (id: string, seq: number): NormalizedMessage[] => {
            const document = themeActionDocument(id);
            const input = { document, mode: 'dark', origin: { kind: 'agent' }, group: 'choices' };
            const output = { previewRef: id, coverage: prepareThemeProfileCss(document.profile).coverage, compatibility: document.compatibility };
            return [
                { ...common(`call-${id}`, seq), role: 'agent', content: [{
                    type: 'tool-call', id, name: 'mcp__happier__action_execute',
                    input: { _happier: { canonicalToolName: 'mcp__happier__action_execute' }, actionId: THEME_ACTION_IDS.tryOn, input },
                    description: null, uuid: `call-${id}`, parentUUID: null,
                }] },
                { ...common(`result-${id}`, seq + 1), role: 'agent', content: [{
                    type: 'tool-result', tool_use_id: id, content: { ok: true, result: output }, is_error: false,
                    uuid: `result-${id}`, parentUUID: null,
                }] },
            ];
        };
        // Mirrors the captured call/result pairs and the thinking row between the first two calls.
        const thinking: NormalizedMessage = { ...common('thinking', 80), role: 'agent', content: [
            { type: 'thinking', thinking: 'Considering a second option', uuid: 'thinking', parentUUID: null },
        ] };
        storage.getState().applySessions([session]);
        storage.getState().applyMessages(session.id, [
            ...candidate('Ink', 60), thinking, ...candidate('Pine', 90), ...candidate('Plum', 110), ...candidate('Geometry', 130),
        ]);
        storage.getState().applyMessagesLoaded(session.id);

        const displaySettings = { ...settingsDefaults, toolViewExpandedDetailLevelDefault: 'summary', toolViewTapAction: 'expand' } as const;
        const counter = createCommittedFiberRenderCounter();
        let readRoot: ReturnType<typeof readTestRendererRoot> | undefined;
        function TranscriptRows() {
            const source = useSessionTranscriptSource();
            const ids = source.useMessageIdsOldestFirst();
            const byId = source.useMessagesById();
            return ids.map(id => {
                const message = byId[id];
                if (message?.kind === 'user-text') return <React.Fragment key={id}>{message.text}</React.Fragment>;
                if (message?.kind !== 'tool-call') return null;
                return <ToolView key={id} tool={message.tool} metadata={null} messages={message.children}
                    sessionId={session.id} serverId={serverId} messageId={buildToolCallMessageRouteId({ toolId: message.tool.id, fallbackMessageId: id }) ?? undefined}
                    displaySettings={displaySettings} />;
            });
        }
        const screen = await renderScreen(
            <AppSessionTranscriptSourceProvider sessionId={session.id} serverId={serverId}>
                <React.Profiler id="theme-card-arrival" onRender={() => {
                    if (readRoot) counter.onCommitRoot(readRoot());
                }}><TranscriptRows /></React.Profiler>
            </AppSessionTranscriptSourceProvider>,
        );
        readRoot = readTestRendererRoot(screen.tree.root);
        const cardHosts = () => screen.findAllHostsByTestId('theme-action-result');
        const optionCount = () => screen.tree.findAll(node => typeof node.type === 'string'
            && typeof node.props.testID === 'string'
            && /^theme-action-result:option:[^:]+$/.test(node.props.testID)).length;
        const countRenders = () => {
            const result = counter.read();
            return { view: result.rendersFor(ThemeActionResultView), model: result.rendersFor(ThemeActionResult),
                mounts: result.mounts.get('ThemeActionResultView') ?? 0 };
        };
        try {
            const rows = screen.findAllByType(ToolView);
            expect(rows).toHaveLength(4);
            for (const row of rows) {
                await pressTestInstanceAsync(row.findAll(node => node.props.testID === 'tool-view-header-primary'
                    && typeof node.props.onPress === 'function')[0]);
            }
            expect(cardHosts()).toHaveLength(1);
            await act(async () => {
                for (const group of screen.tree.findAll(node => typeof node.type === 'string'
                    && node.props.role === 'radiogroup' && typeof node.props.onLayout === 'function')) {
                    group.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 960, height: 600 } } });
                }
            });
            expect(optionCount()).toBe(4);
            expect(rows.map(row => row.findAll(node => typeof node.type === 'string'
                && node.props.testID === 'theme-action-result').length)).toEqual([0, 0, 0, 1]);

            counter.start();
            await act(async () => storage.getState().applyMessages(session.id, [{
                ...common('unrelated', 150), role: 'user', content: { type: 'text', text: 'Unrelated arrival' },
            }]));
            expect(screen.getTextContent()).toContain('Unrelated arrival');
            const unrelatedRenders = countRenders();

            counter.start();
            await act(async () => storage.getState().applyMessages(session.id, candidate('Linen', 120)));
            expect(cardHosts()).toHaveLength(1);
            expect(optionCount()).toBe(5);
            const candidateRenders = countRenders();
            console.info('theme-transcript-card-renders', { unrelatedRenders, candidateRenders });
            expect(unrelatedRenders).toEqual({ view: 0, model: 0, mounts: 0 });
            expect(candidateRenders).toEqual({ view: 1, model: 1, mounts: 0 });
        } finally {
            counter.stop();
            await screen.unmount();
            storage.setState(previous, true);
        }
    });
    it('previews canonical MCP content and historical text aliases equally', async () => {
        for (const result of [
            { content: [{ type: 'text', text: 'Kept result body' }] },
            { content: 'Kept result body' },
            { stdout: 'Kept result body' },
            { text: 'Kept result body' },
        ]) {
            const tool = makeToolCall({ name: 'mcp__example__read', state: 'completed', result });
            expect((await renderView(tool, 'summary')).getTextContent()).toContain('Kept result body');
        }
    });
    it('indexes its decoded preview and exact full JSON, and reveals a preview match beyond the summary clamp', async () => {
        const { MCPToolView, projectMCPDisplayText } = await import('./MCPToolView');
        const text = 'x'.repeat(850) + 'needle\nnext line';
        const tool = makeMcpTool({ result: { text, nested: { value: 'visible in full JSON' } } });
        const blocks = projectMCPDisplayText(tool);
        expect(blocks.find((block) => block.id === 'tool-output-preview')?.text).toBe(text);
        expect(blocks.find((block) => block.id === 'tool-output')?.text).toBe(JSON.stringify(tool.result, null, 2));
        const store = createTranscriptFindRowStore();
        store.publish(new Map([['find-mcp', { blocks: [{ id: 'tool-output-preview', sourceRanges: [{ start: 850, end: 856, current: true }] }], reveal: { blockId: 'tool-output-preview', requestId: 1 } }]]));
        const screen = await renderScreen(<TranscriptFindProvider store={store}><MCPToolView {...makeToolViewProps(tool, { detailLevel: 'summary', messageId: 'find-mcp' })} /></TranscriptFindProvider>);
        expect(screen.getTextContent()).toContain(text);
    });
    function makeMcpTool(overrides: Partial<ToolCall> = {}): ToolCall {
        return makeToolCall({
            name: 'mcp__linear__create_issue',
            state: 'completed',
            input: { title: 'Bug: MCP tool rendering summary' },
            result: { text: 'Created issue LIN-42' },
            ...overrides,
        });
    }

    async function renderView(tool: ToolCall, detailLevel?: 'title' | 'summary' | 'full') {
        const { MCPToolView } = await import('./MCPToolView');
        return renderScreen(React.createElement(
            MCPToolView,
            makeToolViewProps(tool, detailLevel ? { detailLevel } : {}),
        ));
    }

    it('renders only the call outcome in summary mode: the row header owns the title and line', async () => {
        const tool = makeMcpTool({
            input: {
                title: 'Bug: MCP tool rendering summary',
                _mcp: { display: { subtitle: 'Bug: MCP tool rendering summary' } },
            },
        });
        const screen = await renderView(tool, 'summary');
        const rendered = screen.getTextContent();

        expect(rendered).not.toContain('Bug: MCP tool rendering summary');
        expect(rendered).toContain('Created issue LIN-42');
    });

    it('omits non-string output previews in summary mode and renders nothing when there is no outcome', async () => {
        const tool = makeMcpTool({
            input: { path: '/repo/src/file.ts' },
            result: { output: { status: 'ok' } },
        });
        const screen = await renderView(tool, 'summary');
        expect(screen.getTextContent().replace(/\s+/g, ' ')).not.toContain('ok');
        expect(screen.findAllByType('Text' as any)).toHaveLength(0);
    });

    it('keeps a refused Action call\'s typed code in the summary body without repeating the row line', async () => {
        const text = JSON.stringify({ errorCode: 'unsupported_action', error: 'unsupported_action:session.stop', details: { cause: 'target_outside_led_subtree' } });
        const tool = makeToolCall({
            name: 'mcp__happier__action_execute',
            state: 'completed',
            input: { actionId: 'session.stop', input: {} },
            result: { content: [{ type: 'text', text }], structuredContent: null, text, _mcp: { serverId: 'happier', toolId: 'action_execute' } },
        });
        const rendered = (await renderView(tool, 'summary')).getTextContent();

        expect(rendered).toContain('unsupported_action · target_outside_led_subtree');
        expect(rendered).not.toContain('Stop a running session');
    });

    it('says an acknowledged section move in words instead of its JSON (lab clsections:agent)', async () => {
        const result = { ok: true, result: { sessionId: 'session_1', sectionId: null, previousSectionId: 'launch' } };
        const text = JSON.stringify(result);
        const tool = makeToolCall({
            name: 'mcp__happier__action_execute',
            state: 'completed',
            input: { actionId: 'session.section.set', input: { sessionId: 'session_1', sectionId: null } },
            result: { content: [{ type: 'text', text }], structuredContent: null, text, _mcp: { serverId: 'happier', toolId: 'action_execute' } },
        });
        const rendered = (await renderView(tool, 'summary')).getTextContent();
        expect(rendered).toContain('Moved this session back to its project');
        expect(rendered).not.toContain('previousSectionId');
    });

    it('exports subtitle precedence for subtitle, title, path, and query', async () => {
        const { formatMCPSubtitle } = await import('./MCPToolView');

        expect(formatMCPSubtitle({ _mcp: { display: { subtitle: '  subtitle  ' } }, title: 'Title' })).toBe('subtitle');
        expect(formatMCPSubtitle({ title: '  Hello title  ' })).toBe('Hello title');
        expect(formatMCPSubtitle({ path: '/tmp/a.ts', query: 'x' })).toBe('/tmp/a.ts');
        expect(formatMCPSubtitle({ query: 'find me' })).toBe('find me');
    });

    it('renders input + output blocks in full mode', async () => {
        const screen = await renderView(makeMcpTool(), 'full');
        const rendered = screen.getTextContent();

        expect(rendered).toContain('MCP: Linear Create Issue');
        expect(rendered).toContain('Input');
        expect(rendered).toContain('Output');
        expect(rendered).toContain('Created issue LIN-42');
    });

    it('titles a Happier Action call by the Action it runs, through action_execute or its own binding', async () => {
        const { formatMCPTitle } = await import('./MCPToolView');
        const input = { actionId: 'workspace.sync.relationship.terminate', input: { relationshipId: 'relationship_1' } };
        expect(formatMCPTitle('mcp__happier__action_execute', undefined, input)).toBe('Stop workspace sync');
        expect(formatMCPTitle('mcp__happier__workspace_sync_relationship_terminate', undefined, { relationshipId: 'r' }))
            .toBe('Stop workspace sync');
        expect(formatMCPTitle('mcp__happier__action_execute', undefined, { actionId: 'not.an.action' }))
            .toBe('MCP: Happier Action Execute');
        expect(formatMCPTitle('mcp__linear__create_issue', undefined, input)).toBe('MCP: Linear Create Issue');
    });

    it('says what a Happier Action call does, never its raw actionId and input', async () => {
        const { formatMCPToolSubtitle } = await import('./MCPToolView');
        const unarchive = { actionId: 'session.unarchive', input: { sessionId: 'cmvfqvl9c00qomc8of6kuw4lz' } };
        // The CLI's MCP normalizer stores its generic key=value line as every call's display subtitle.
        const recorded = { ...unarchive, _mcp: { serverId: 'happier', toolId: 'action_execute', display: {
            title: 'MCP: happier action execute', subtitle: 'actionId=session.unarchive input={"sessionId":"cmvfqvl9c00qomc8of6kuw4lz"}',
        } } };
        for (const subtitle of [
            formatMCPToolSubtitle('mcp__happier__action_execute', unarchive),
            formatMCPToolSubtitle('mcp__happier__action_execute', recorded),
            formatMCPToolSubtitle('mcp__happier__session_unarchive', unarchive.input),
            formatMCPToolSubtitle('mcp__happier__action_execute', {
                actionId: 'workspace.sync.relationship.terminate', input: { relationshipId: 'relationship_1' },
            }),
        ]) {
            expect(subtitle).not.toBe('');
            expect(subtitle).not.toMatch(/actionId|input=|relationship_1|cmvfqvl9c00qomc8of6kuw4lz|[{}]/);
        }
        // Other MCP servers keep their key=value fallback.
        expect(formatMCPToolSubtitle('mcp__linear__create_issue', unarchive)).toContain('actionId=session.unarchive');
    });

    it('renders nothing in title mode', async () => {
        const screen = await renderView(makeMcpTool(), 'title');
        expect(screen.findAllByType('Text' as any)).toHaveLength(0);
    });
});
