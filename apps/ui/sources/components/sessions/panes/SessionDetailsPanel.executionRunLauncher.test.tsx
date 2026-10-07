import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installSessionDetailsPanelCommonModuleMocks } from './sessionDetailsPanelTestHelpers';
import { installSessionPaneRuntimeTestHarness } from './sessionPaneRuntimeTestHarness';

installSessionDetailsPanelCommonModuleMocks();
const runtime = installSessionPaneRuntimeTestHarness();

describe('SessionDetailsPanel (execution run launcher resource)', () => {
    it('commits a Review composer immediately, without a launcher form or loading fallback', async () => {
        const { SessionDetailsPanel } = await import('./SessionDetailsPanel');
        const { SessionInteractiveExecutionRunDraftView } = await import('@/components/sessions/runs/launcher/SessionInteractiveExecutionRunDraftView');
        const { SessionParticipantComposer } = await import('@/components/sessions/participants/composer/SessionParticipantComposer');
        const { createExecutionRunLauncherDetailsTab } = await import('@/components/sessions/runs/launcher/executionRunLauncherModel');
        const { ActivitySpinner } = await import('@/components/ui/feedback/ActivitySpinner');
        const screen = await renderScreen(<runtime.Wrapper />);
        await act(async () => runtime.pane.openDetailsTab(createExecutionRunLauncherDetailsTab('review'), { intent: 'preview' }));
        // Synchronous commit distinguishes the eager composer destination from a lazy fallback.
        act(() => screen.tree.update(<runtime.Wrapper>
            <SessionDetailsPanel sessionId="s1" routeServerId={runtime.serverId} scopeId="session:s1" />
        </runtime.Wrapper>));
        const drafts = screen.tree.findAllByType(SessionInteractiveExecutionRunDraftView);
        expect(drafts).toHaveLength(1);
        expect(drafts[0].props).toMatchObject({ sessionId: 's1', serverId: runtime.serverId, intent: 'review' });
        const composers = screen.tree.findAllByType(SessionParticipantComposer);
        expect(composers).toHaveLength(1);
        expect(composers[0].props).toMatchObject({ sessionId: 's1', serverId: runtime.serverId, recipient: null });
        expect(screen.tree.findAllByType(ActivitySpinner)).toHaveLength(0);
        expect(screen.findHostByTestId('execution-run-start-lead')).not.toBeNull();
    });
});
