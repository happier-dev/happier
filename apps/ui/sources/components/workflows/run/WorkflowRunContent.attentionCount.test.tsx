import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createWorkflowDefinitionFixture, createWorkflowInvocationIndexFixture, createWorkflowRunSummaryFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { WorkflowRunContent } from './WorkflowRunContent';
import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';
import { ModalProvider } from '@/modal';

// These Run fixtures do not stream Markdown; keep its external web adapter at the boundary.
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({
    splitStreamingRevealTextParts: () => { throw new Error('Unexpected vendor Markdown reveal in attention-count test'); },
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
// Radix supplies the DOM portal primitives; modal custody and presentation stay real.
vi.mock('@/utils/web/radixCjs', async () => {
    const { createRadixCjsModuleMock } = await import('@/dev/testkit/mocks/radixCjs');
    return createRadixCjsModuleMock();
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
// Only the native recycler is substituted; list normalization and view navigation stay real.
vi.mock('@legendapp/list/react-native', async (importOriginal) => {
    const { createCapturingLegendListMock } = await import('@/dev/testkit/mocks/legendList');
    return createCapturingLegendListMock({ original: await importOriginal<Record<string, unknown>>(), renderItems: false }).module;
});

afterEach(async () => {
    await standardCleanup();
});

type ContentProps = React.ComponentProps<typeof WorkflowRunContent>;

const heldDefinition = createWorkflowDefinitionFixture({ blocks: ['first', 'second'].map(id => ({
    kind: 'wait', id, document: { text: id, references: [], attachments: [] },
})) });
const heldInvocations = () => [
    createWorkflowInvocationIndexFixture({ id: 'root', lifecycle: 'running' }),
    createWorkflowInvocationIndexFixture({ id: 'inv-a', parentRecordId: 'root', sequence: '1', memberOrdinal: '0', lifecycle: 'waiting_for_approval' }),
    createWorkflowInvocationIndexFixture({ id: 'inv-b', parentRecordId: 'root', sequence: '2', memberOrdinal: '1', lifecycle: 'needs_attention' }),
];

async function renderContent(overrides: Partial<ContentProps> = {}) {
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
        wrapper: ({ children }) => <ModalProvider><AppPaneProvider>{children}</AppPaneProvider></ModalProvider>,
    });
}

describe('attention partial count truth', () => {
    it('opens the child Session from an exact permission hold before invocation history loads', async () => {
        const onOpenSession = vi.fn();
        const onSelectInvocation = vi.fn();
        const screen = await renderContent({
            run: createWorkflowRunSummaryFixture({ id: 'run-1', state: 'running', heldStep: {
                kind: 'child_session_permission', invocationId: 'inv-a', label: 'Check the code', sessionId: 'child-session',
            } }),
            onOpenSession,
            onSelectInvocation,
        });
        expect(screen.getTextContent()).toContain('workflows.run.attentionWaitRow:{"step":"Check the code"}');
        await screen.pressByTestIdAsync('workflow-run-needs-you-inv-a');
        expect(onOpenSession).toHaveBeenCalledWith('child-session');
        expect(onSelectInvocation).not.toHaveBeenCalled();
    });

    it('labels a still-paged attention window as loaded, never exact remaining', async () => {
        const screen = await renderContent({
            run: createWorkflowRunSummaryFixture({ id: 'run-1', state: 'running' }),
            definition: heldDefinition,
            invocations: heldInvocations(),
            // More attention pages remain: the true total is not loaded.
            attentionHasMore: true,
        });

        const section = screen.findHostByTestId('workflow-run-needs-you');
        // Truthful partial copy uses the loaded sentence, never the exact remaining one.
        expect(section?.props.accessibilityLabel).toContain('needsYouLoaded');
        expect(section?.props.accessibilityLabel).not.toBe('workflows.a11y.needsYou:{"count":2}');
        expect(screen.getTextContent()).toContain('needsYouLoadedCount');
    });

    it('keeps the exact remaining sentence once the attention cursor is exhausted', async () => {
        const screen = await renderContent({
            run: createWorkflowRunSummaryFixture({ id: 'run-1', state: 'running' }),
            definition: heldDefinition,
            invocations: heldInvocations(),
            attentionHasMore: false,
        });

        const section = screen.findHostByTestId('workflow-run-needs-you');
        expect(section?.props.accessibilityLabel).toBe('workflows.a11y.needsYou:{"count":2}');
    });
});

describe('Needs-you index rows (DESIGN-15 R6)', () => {
    it('gives a For-each\'s held items one row, opening item 1 first, instead of one identical sentence per item', async () => {
        const item = (id: string, index: number) => [id, {
            invocationId: id, nodeId: 'check', blockId: 'check', isFrame: false, coverageKind: 'executable',
            occurrence: [{ kind: 'item', blockId: 'issues', index }],
        }] as const;
        const onSelectInvocation = vi.fn();
        const screen = await renderContent({
            invocations: [
                createWorkflowInvocationIndexFixture({ id: 'inv-item-3', sequence: '1', lifecycle: 'waiting_for_review' }),
                createWorkflowInvocationIndexFixture({ id: 'inv-item-2', sequence: '2', lifecycle: 'waiting_for_review' }),
                createWorkflowInvocationIndexFixture({ id: 'inv-item-1', sequence: '3', lifecycle: 'waiting_for_review' }),
            ],
            invocationStructure: new Map([item('inv-item-3', 2), item('inv-item-2', 1), item('inv-item-1', 0)]) as never,
            onSelectInvocation,
        } as never);

        // All three still count as needing the person...
        expect(screen.findByTestId('workflow-run-needs-you')?.props.accessibilityLabel).toBe('workflows.a11y.needsYou:{"count":3}');
        // ...in one row whose Review opens the first item.
        expect(screen.findByTestId('workflow-run-needs-you-inv-item-1')).not.toBeNull();
        expect(screen.findByTestId('workflow-run-needs-you-inv-item-2')).toBeNull();
        expect(screen.findByTestId('workflow-run-needs-you-inv-item-3')).toBeNull();
        expect(screen.getTextContent()).toContain('workflows.run.attentionItemCount:{"count":3}');
        await screen.pressByTestIdAsync('workflow-run-needs-you-inv-item-1');
        expect(onSelectInvocation).toHaveBeenCalledWith('inv-item-1');
    });
});
