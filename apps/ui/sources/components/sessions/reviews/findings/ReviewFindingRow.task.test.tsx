import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { act, renderScreen, standardCleanup } from '@/dev/testkit';
import { reportPopoverContentLayout, withPopoverWebGlobals } from '@/dev/testkit/harness/popoverHarness';
import { ReviewFindingRow } from './ReviewFindingRow';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
afterEach(standardCleanup);

it.each(['card', 'page'] as const)('offers the selected saved finding to Tasks from an opened %s row', async density => {
    const selected: string[] = [];
    const props = {
        rowId: 'canonical-comment',
        finding: { id: 'engine-local-finding', title: 'A defect', summary: 'Private finding body', category: 'correctness' as const, severity: 'high' as const },
        density, attribution: null, reviewers: [], original: null, divided: false,
        decision: 'undecided' as const, decisionDisabled: false, decisionNote: null,
        onDecide: () => {}, followUp: null, threadEntries: [], pendingQuestion: null,
        expanded: true, onToggleExpanded: () => {},
        askContext: { sessionId: 'session', serverId: 'home', accountLifetime: null,
            draftRunId: 'run', recipient: { label: 'Reviewer', accessibilityLabel: 'Reviewer', backendIds: [] }, waitingLabel: 'Waiting' },
        onAsk: async () => false,
        onCreateTask: async (rowId: string) => { selected.push(rowId); },
    };
    const restoreGlobals = withPopoverWebGlobals();
    const screen = await renderScreen(<ReviewFindingRow {...props} />);
    try {
        // A page row keeps Create task in its decision area's "…", never under the conversation.
        if (density === 'page') {
            expect(screen.findHostByTestId('review-finding-task:canonical-comment')).toBeNull();
            await screen.pressByTestIdAsync('review-finding-actions:canonical-comment');
            await act(async () => { reportPopoverContentLayout(screen, { width: 260, height: 120 }); });
        }
        const create = screen.findAll(node => node.props.testID === 'review-finding-task:canonical-comment'
            && typeof node.props.onPress === 'function')[0];
        expect(create).toBeDefined();
        await act(async () => { await create!.props.onPress(); });
        expect(selected).toEqual(['canonical-comment']);
        if (density === 'card') {
            await screen.update(<ReviewFindingRow {...props} expanded={false} />);
            expect(screen.findHostByTestId('review-finding-task:canonical-comment')).not.toBeNull();
        }
        await screen.update(<ReviewFindingRow {...props} onCreateTask={undefined} />);
        expect(screen.findHostByTestId('review-finding-task:canonical-comment')).toBeNull();
    } finally { await screen.unmount(); restoreGlobals(); }
});
