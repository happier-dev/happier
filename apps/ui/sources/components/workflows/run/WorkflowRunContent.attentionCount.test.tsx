import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createWorkflowInvocationIndexFixture, createWorkflowRunSummaryFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { WorkflowRunContent } from './WorkflowRunContent';
import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';

// These Run fixtures do not stream Markdown; keep its external web adapter at the boundary.
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({
    splitStreamingRevealTextParts: () => { throw new Error('Unexpected vendor Markdown reveal in attention-count test'); },
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({}).module;
});
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key, params) => (params ? `${key}:${JSON.stringify(params)}` : key) });
});
vi.mock('@/components/ui/navigation/SegmentedTabBar', () => ({
    SegmentedTabBar: () => null,
}));
vi.mock('@/components/ui/lists/virtualized', () => ({
    VirtualizedList: (props: Record<string, any>) => {
        const ReactInner = require('react');
        const header = ReactInner.isValidElement(props.ListHeaderComponent)
            ? props.ListHeaderComponent
            : props.ListHeaderComponent ? ReactInner.createElement(props.ListHeaderComponent as never) : null;
        return ReactInner.createElement('VirtualizedList', props, header);
    },
}));

afterEach(async () => {
    await standardCleanup();
});

type ContentProps = React.ComponentProps<typeof WorkflowRunContent>;

async function renderContent(overrides: Partial<ContentProps> = {}) {
    const { createWorkflowDefinitionFixture } = await import('@/dev/testkit/fixtures/workflowRunFixtures');
    const props: ContentProps = {
        run: createWorkflowRunSummaryFixture({ id: 'run-1', state: 'running' }),
        definition: createWorkflowDefinitionFixture(),
        invocations: [],
        invocationsLoaded: true,
        invocationHistoryComplete: true,
        firstFailedInvocationId: null,
        firstFailedInvocationResolution: 'resolved',
        selectedInvocationId: null,
        onSelectInvocation: () => {},
        view: 'activity' as const,
        onChangeView: () => {},
        ...overrides,
    };
    return renderScreen(React.createElement(WorkflowRunContent, props), {
        wrapper: ({ children }) => <AppPaneProvider>{children}</AppPaneProvider>,
    });
}

describe('attention partial count truth', () => {
    it('labels a still-paged attention window as loaded, never exact remaining', async () => {
        const screen = await renderContent({
            run: createWorkflowRunSummaryFixture({ id: 'run-1', state: 'running' }),
            invocations: [
                createWorkflowInvocationIndexFixture({ id: 'inv-a', lifecycle: 'waiting_for_approval' }),
                createWorkflowInvocationIndexFixture({ id: 'inv-b', sequence: '1', lifecycle: 'needs_attention' }),
            ],
            // More attention pages remain: the true total is not loaded.
            attentionHasMore: true,
        } as never);

        const section = screen.findByTestId('workflow-run-needs-you');
        // Truthful partial copy uses the loaded sentence, never the exact remaining one.
        expect(section?.props.accessibilityLabel).toContain('needsYouLoaded');
        expect(section?.props.accessibilityLabel).not.toBe('workflows.a11y.needsYou:{"count":2}');
        expect(screen.getTextContent()).toContain('needsYouLoadedCount');
    });

    it('keeps the exact remaining sentence once the attention cursor is exhausted', async () => {
        const screen = await renderContent({
            run: createWorkflowRunSummaryFixture({ id: 'run-1', state: 'running' }),
            invocations: [
                createWorkflowInvocationIndexFixture({ id: 'inv-a', lifecycle: 'waiting_for_approval' }),
                createWorkflowInvocationIndexFixture({ id: 'inv-b', sequence: '1', lifecycle: 'needs_attention' }),
            ],
            attentionHasMore: false,
        } as never);

        const section = screen.findByTestId('workflow-run-needs-you');
        expect(section?.props.accessibilityLabel).toBe('workflows.a11y.needsYou:{"count":2}');
    });
});
