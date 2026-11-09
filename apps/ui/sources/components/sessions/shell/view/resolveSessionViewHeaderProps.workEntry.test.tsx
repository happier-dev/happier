import * as React from 'react';
import { describe, expect, it } from 'vitest';

import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { SessionHeaderActionMenu } from '@/components/sessions/actions/SessionHeaderActionMenu';
import type { WorkSummary } from '@/components/sessions/work/workProjection';

import { resolveSessionViewHeaderProps } from './resolveSessionViewHeaderProps';

function rightElementChildren(props: ReturnType<typeof resolveSessionViewHeaderProps>): React.ReactNode[] {
    return React.Children.toArray(
        (props.rightElement as React.ReactElement<{ children?: React.ReactNode }>).props.children,
    );
}

function findByType(props: ReturnType<typeof resolveSessionViewHeaderProps>, type: unknown): React.ReactElement<any> | undefined {
    return rightElementChildren(props).find((child) => React.isValidElement(child) && child.type === type) as
        React.ReactElement<any> | undefined;
}

function summary(overrides: Partial<WorkSummary> = {}): WorkSummary {
    return { outstanding: 0, needsYou: 0, stalled: 0, sessions: 0, runs: 0, ...overrides };
}

function input(sessionId: string, workSummary: WorkSummary, subagentActiveCount = 0) {
    const session = createSessionFixture({
        id: sessionId,
        metadata: { path: '/tmp/project', host: 'test-host' },
    });
    return {
        isDataReady: true,
        session,
        sessionId: session.id,
        sessionInfoHref: `/session/${sessionId}/info`,
        sessionRunsHref: `/session/${sessionId}/runs`,
        sessionAutomationsHref: `/session/${sessionId}/automations`,
        paneScopeId: 'pane-1',
        windowWidth: 1200,
        sessionAutomationsEnabledCount: 0,
        sessionExecutionRunsSupported: false,
        showAutomations: false,
        shouldShowSubagentsButton: false,
        subagentActiveCount,
        workSummary,
        navigateWithBlurOnWeb: (action: () => void) => action(),
        handleHeaderExtraItemSelect: () => false,
        router: { push: () => {}, navigate: () => {} },
        actionIconColor: '#000',
        headerTintColor: '#000',
        statusErrorColor: '#f00',
        externalSessionRuntime: null,
    } as const;
}

function menuItems(props: ReturnType<typeof resolveSessionViewHeaderProps>): ReadonlyArray<{ id: string; title: string }> {
    return findByType(props, SessionHeaderActionMenu)?.props.extraItems ?? [];
}

describe('resolveSessionViewHeaderProps Work entry', () => {
    it('leaves the Work count to the rail, and carries the same count in ⋯ when the rail is not on screen', () => {
        const work = summary({ outstanding: 3, needsYou: 1, sessions: 2, runs: 2 });
        const withRail = resolveSessionViewHeaderProps({ ...input('work-lead', work, 2), actionRailVisible: true });
        expect(menuItems(withRail).map((item) => item.id)).not.toContain('header.openSubagents');

        const withoutRail = resolveSessionViewHeaderProps({ ...input('work-lead', work, 2), actionRailVisible: false });
        const entry = menuItems(withoutRail).find((item) => item.id === 'header.openSubagents');
        expect(entry?.title).toContain('3');
        // A settled lead with no outstanding work and no subagents has no Work entry to offer.
        const settled = resolveSessionViewHeaderProps({ ...input('work-settled', summary()), actionRailVisible: false });
        expect(menuItems(settled).map((item) => item.id)).not.toContain('header.openSubagents');
    });
});
