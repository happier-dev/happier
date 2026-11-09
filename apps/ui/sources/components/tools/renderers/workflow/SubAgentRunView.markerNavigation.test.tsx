import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import type { ToolCall } from '@happier-dev/session-core/messages';
import { createTestSessionTranscriptSource, renderWithSessionTranscriptSource } from '@/dev/testkit';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { installSessionPaneRuntimeTestHarness } from '@/components/sessions/panes/sessionPaneRuntimeTestHarness';
import { createSessionPaneScopeId } from '@/components/sessions/panes/sessionPaneScopeId';
import { storage } from '@/sync/domains/state/storageStore';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { AppPaneContext } from '@/components/appShell/panes/AppPaneContext';
import { ToolView } from '@/components/tools/shell/views/ToolView';
import { ToolTimelineRow } from '@/components/tools/shell/views/ToolTimelineRow';
import { ToolTimelineRowHeader } from '@/components/tools/shell/views/timeline/ToolTimelineRowHeader';

const runtime = installSessionPaneRuntimeTestHarness({ scopeId: ({ sessionId, serverId }) => createSessionPaneScopeId(sessionId, serverId) });

describe('accepted Run transcript marker', () => {
    it.each(['card', 'timeline'] as const)('opens the accepted Run Details from the %s marker without pane or unrelated Session commits', async presentation => {
        const tool: ToolCall = { id: 'marker-call', name: 'SubAgentRun', state: 'completed', input: {
            runId: 'run_7425823b-704c-445f-aa46-a2ceb57bcfa1', intent: 'agent', instructions: 'Inspect this change',
        }, result: { status: 'succeeded', summary: 'Initial result' }, description: null, createdAt: 1, startedAt: 1, completedAt: 2 };
        const navigate = vi.fn();
        const source = createTestSessionTranscriptSource({ sessionId: 's1', navigate });
        let commits = 0;
        let paneReads = 0;
        function ObservePaneReads({ children }: React.PropsWithChildren) {
            const owner = React.useContext(AppPaneContext)!;
            const observed = React.useMemo(() => ({ ...owner, getSnapshot: () => {
                paneReads += 1;
                return owner.getSnapshot();
            } }), [owner]);
            return <AppPaneContext.Provider value={observed}>{children}</AppPaneContext.Provider>;
        }
        const displaySettings = { ...settingsDefaults, toolViewDetailLevelDefault: 'title' as const, toolViewTapAction: 'open' as const };
        function Marker({ value }: Readonly<{ value: ToolCall }>) {
            const Component = presentation === 'card' ? ToolView : ToolTimelineRow;
            return <Component tool={value} metadata={null} sessionId="s1" serverId={runtime.serverId}
                messageId="marker-message" displaySettings={displaySettings} />;
        }
        const frame = (value: ToolCall) => <runtime.Wrapper><ObservePaneReads><React.Profiler id="marker" onRender={() => { commits += 1; }}>
            <Marker value={value} />
        </React.Profiler></ObservePaneReads></runtime.Wrapper>;
        const screen = await renderWithSessionTranscriptSource(frame(tool), source);
        const initialCommits = commits;
        await act(async () => {
            storage.getState().applySessions(Array.from({ length: 1000 }, (_, index) => createSessionFixture({
                id: `unrelated-${index}`, serverId: runtime.serverId,
            })));
        });
        expect(commits - initialCommits).toBe(0);
        const completed = { ...tool, input: { runId: 'run_8425823b-704c-445f-aa46-a2ceb57bcfa1', intent: 'agent' }, result: { status: 'succeeded', summary: 'Accepted result' } };
        await screen.update(frame(completed));
        expect(commits - initialCommits).toBe(1);
        const beforePaneChange = commits;
        await act(async () => runtime.pane.openRight({ tabId: 'work' }));
        expect(commits - beforePaneChange).toBe(0);
        expect(paneReads).toBe(0);
        await act(async () => {
            if (presentation === 'timeline') screen.tree.findByType(ToolTimelineRowHeader).props.onOpen();
            else screen.findByTestId('tool-view-header-primary')!.props.onPress();
        });
        expect(navigate).not.toHaveBeenCalled();
        expect(paneReads).toBe(1);
        expect(runtime.pane.scopeState?.details.tabs).toEqual([expect.objectContaining({
            resource: { kind: 'executionRun', runId: 'run_8425823b-704c-445f-aa46-a2ceb57bcfa1' },
        })]);
    });
});
