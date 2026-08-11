import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import type { Message } from '@/sync/domains/messages/messageTypes';
import type { SessionSubagent } from '@/sync/domains/session/subagents/types';

/**
 * S-2 — a run's structured outcome must be reachable from the Agents pane.
 *
 * These render the REAL structured registry: the envelope goes in as the tool-call message's
 * `meta.happier` (which is what the CLI writes, `finishExecutionRun` -> `{ meta: { happier } }`),
 * and the assertion is on the real card the `/runs/[runId]` route shows. Nothing about the
 * dispatch is stubbed, so an implementation that reads the wrong field, skips schema validation,
 * or hand-rolls its own card fails here.
 */

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const executionRunDetailsSpy = vi.hoisted(() => vi.fn());

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@expo/vector-icons', async () => {
    const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
    return createExpoVectorIconsMock();
});

vi.mock('@/components/ui/text/Text', async () => {
    const { createUiTextModuleMock } = await import('@/dev/testkit/mocks/uiText');
    return createUiTextModuleMock();
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock().module;
});

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
        useSession: () => sessionState.session,
        useResolvedSessionMessageRouteId: () => sessionState.resolvedMessageId,
        useMessage: () => sessionState.message,
    });
});

vi.mock('@/sync/store/hooks', () => ({
    useSessionMessages: () => ({ messages: [] }),
}));

// Boundaries, not internals: the sync orchestrator and the session RPC. Both are only reached by
// pressing a card action, which these tests never do — they are stubbed so importing a card does
// not drag the whole engine into the module graph.
vi.mock('@/sync/sync', () => ({
    sync: { submitMessage: vi.fn(async () => undefined) },
}));

vi.mock('@/components/markdown/MarkdownView', () => ({
    MarkdownView: ({ markdown }: Readonly<{ markdown?: string }>) =>
        React.createElement('MarkdownView', null, markdown ?? null),
}));

vi.mock('@/hooks/session/useSessionSubagents', () => ({
    useSessionSubagents: () => subagentsState,
}));

vi.mock('@/components/sessions/runs/details/SessionExecutionRunDetailsView', () => ({
    SessionExecutionRunDetailsView: (props: unknown) => {
        executionRunDetailsSpy(props);
        return React.createElement('SessionExecutionRunDetailsView');
    },
}));

vi.mock('@/components/sessions/transcript/details/SessionMessageDetailsView', () => ({
    SessionMessageDetailsView: () => React.createElement('SessionMessageDetailsView'),
}));

vi.mock('@/components/sessions/agents/details/SessionSubagentOverviewCard', () => ({
    SessionSubagentOverviewCard: () => React.createElement('SessionSubagentOverviewCard'),
}));

vi.mock('@/components/sessions/participants/composer/SessionParticipantComposer', () => ({
    SessionParticipantComposer: () => React.createElement('SessionParticipantComposer'),
}));

const sessionState: {
    session: {
        id: string;
        metadata: { flavor: string };
        accessLevel: 'view' | 'edit' | 'admin' | undefined;
        canApprovePermissions: boolean;
        active: boolean;
    };
    message: Message | null;
    resolvedMessageId: string;
} = {
    session: {
        id: 's1',
        metadata: { flavor: 'claude' },
        accessLevel: 'edit',
        canApprovePermissions: true,
        active: true,
    },
    message: null,
    resolvedMessageId: 'tool-msg-1',
};

const subagentsState: { subagents: readonly SessionSubagent[] } = { subagents: [] };

const EXECUTION_RUN_SUBAGENT: SessionSubagent = {
    id: 'execution_run:run_1',
    kind: 'execution_run',
    status: 'succeeded',
    display: { title: 'Code review' },
    transcript: { toolMessageRouteId: 'tool-msg-1', sidechainId: 'toolu_1', toolId: 'toolu_1' },
    runRef: { runId: 'run_1', backendId: 'codex' },
    recipient: { kind: 'execution_run', runId: 'run_1' },
    capabilities: {
        canOpen: true,
        canSend: true,
        canStop: false,
        canLaunchChild: false,
        canDelete: false,
        canOpenAdvancedRun: true,
    },
    timestamps: {},
};

function createToolCallMessage(happierMeta: unknown): Message {
    return {
        id: 'tool-msg-1',
        kind: 'tool-call',
        localId: null,
        tool: {
            id: 'toolu_1',
            name: 'SubAgentRun',
            state: 'completed',
            input: {},
            result: { ok: true },
            createdAt: 1,
            startedAt: 1,
            completedAt: 2,
            description: null,
        },
        children: [],
        createdAt: 1,
        ...(happierMeta === undefined ? {} : { meta: { happier: happierMeta } as never }),
    } as Message;
}

function reviewFindingsV2Payload() {
    return {
        runRef: { runId: 'run_1', callId: 'toolu_1', backendId: 'codex' },
        summary: 'Two problems worth fixing',
        overviewMarkdown: 'Overview',
        findings: [
            {
                id: 'f1',
                title: 'Null deref in resolveEntry',
                severity: 'high',
                category: 'correctness',
                filePath: 'src/a.ts',
                startLine: 10,
                summary: 'resolveEntry dereferences a value the caller may pass as null.',
            },
        ],
        generatedAtMs: 1700000000000,
    };
}

async function renderDetails() {
    const { SessionSubagentDetailsView } = await import('./SessionSubagentDetailsView');
    return renderScreen(
        <SessionSubagentDetailsView sessionId="s1" scopeId="session:s1" subagentId="execution_run:run_1" />,
    );
}

function collectRenderedText(root: { findAll: (predicate: (node: any) => boolean) => any[] }): string {
    return root
        .findAll((node: any) => typeof node.type === 'string')
        .flatMap((node: any) => (Array.isArray(node.children) ? node.children : []))
        .filter((child: unknown): child is string => typeof child === 'string')
        .join('\n');
}

describe('SessionSubagentDetailsView structured results (S-2)', () => {
    it('renders the review findings card for a review run opened from the Agents pane', async () => {
        subagentsState.subagents = [EXECUTION_RUN_SUBAGENT];
        sessionState.message = createToolCallMessage({
            kind: 'review_findings.v2',
            payload: reviewFindingsV2Payload(),
        });
        executionRunDetailsSpy.mockClear();

        const screen = await renderDetails();

        expect(screen.findByTestId('review-findings-header:f1')).not.toBeNull();
        // The card must not have arrived by way of the run-registry view: that path is the one
        // that already worked, and rendering both would show the outcome twice.
        expect(executionRunDetailsSpy).not.toHaveBeenCalled();
    });

    it('renders the plan output card for a plan run opened from the Agents pane', async () => {
        subagentsState.subagents = [EXECUTION_RUN_SUBAGENT];
        sessionState.message = createToolCallMessage({
            kind: 'plan_output.v1',
            payload: {
                runRef: { runId: 'run_1', callId: 'toolu_1', backendId: 'codex' },
                summary: 'Ship it in three steps',
                sections: [{ title: 'Steps', items: ['One', 'Two'] }],
                generatedAtMs: 1700000000000,
            },
        });

        const screen = await renderDetails();

        expect(screen.findByTestId('adopt-plan-button')).not.toBeNull();
        expect(collectRenderedText(screen.tree.root)).toContain('Ship it in three steps');
    });

    it('renders the delegate output card for a delegate run opened from the Agents pane', async () => {
        subagentsState.subagents = [EXECUTION_RUN_SUBAGENT];
        sessionState.message = createToolCallMessage({
            kind: 'delegate_output.v1',
            payload: {
                runRef: { runId: 'run_1', callId: 'toolu_1', backendId: 'codex' },
                summary: 'Lane finished, two deliverables',
                deliverables: [{ id: 'd1', title: 'Report' }],
                generatedAtMs: 1700000000000,
            },
        });

        const screen = await renderDetails();

        const text = collectRenderedText(screen.tree.root);
        expect(text).toContain('Lane finished, two deliverables');
        expect(text).toContain('Report');
    });

    it('renders no structured card when the run carries no structured outcome', async () => {
        subagentsState.subagents = [EXECUTION_RUN_SUBAGENT];
        sessionState.message = createToolCallMessage(undefined);

        const screen = await renderDetails();

        // Honest absence: the transcript body still renders, and nothing fabricates an empty
        // results card above it.
        expect(screen.tree.root.findAllByType('SessionMessageDetailsView' as never)).toHaveLength(1);
        expect(screen.findByTestId('adopt-plan-button')).toBeNull();
        expect(screen.findByTestId('review-findings-header:f1')).toBeNull();
    });

    it('renders no structured card when the envelope fails its schema', async () => {
        subagentsState.subagents = [EXECUTION_RUN_SUBAGENT];
        sessionState.message = createToolCallMessage({
            kind: 'review_findings.v2',
            payload: { summary: 'missing everything else' },
        });

        const screen = await renderDetails();

        expect(screen.findByTestId('review-findings-header:f1')).toBeNull();
    });

    it('leaves the run-registry path alone when there is no tool transcript message', async () => {
        subagentsState.subagents = [{ ...EXECUTION_RUN_SUBAGENT, transcript: {} }];
        sessionState.message = null;
        executionRunDetailsSpy.mockClear();

        const screen = await renderDetails();

        expect(screen.tree).toBeTruthy();
        expect(executionRunDetailsSpy).toHaveBeenCalledTimes(1);
        expect(screen.findByTestId('review-findings-header:f1')).toBeNull();
    });
});
