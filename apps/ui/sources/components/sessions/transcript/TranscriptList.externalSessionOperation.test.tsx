import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    ExternalSessionOperationSharedPresentationV1Schema,
} from '@happier-dev/protocol';

import { createTestSessionTranscriptSource, renderWithSessionTranscriptSource } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import type { Message } from '@happier-dev/session-core/messages';
import {
    installTranscriptCommonModuleMocks,
    resetTranscriptCommonModuleMockState,
} from './transcriptTestHelpers';

const platformState = vi.hoisted(() => ({ os: 'ios' }));

function renderSlot(candidate: React.ReactNode | React.ElementType): React.ReactNode {
    if (!candidate) return null;
    if (React.isValidElement(candidate)) return candidate;
    return React.createElement(candidate as React.ElementType);
}

vi.mock('@legendapp/list/react-native', () => ({
    LegendList: (props: Readonly<{
        data?: readonly unknown[];
        ListFooterComponent?: React.ReactNode | React.ElementType;
        ListHeaderComponent?: React.ReactNode | React.ElementType;
        renderItem?: (params: Readonly<{
            item: unknown;
            index: number;
        }>) => React.ReactNode;
    }>) => React.createElement(
        'LegendList',
        { testID: 'captured-visual-list' },
        React.createElement(
            'View',
            { testID: 'captured-visual-top-slot' },
            renderSlot(props.ListHeaderComponent ?? null),
        ),
        React.createElement(
            'View',
            { testID: 'captured-transcript-items' },
            props.data?.map((item, index) => (
                <React.Fragment key={index}>
                    {props.renderItem?.({ item, index })}
                </React.Fragment>
            )),
        ),
        React.createElement(
            'View',
            { testID: 'captured-visual-bottom-slot' },
            renderSlot(props.ListFooterComponent ?? null),
        ),
    ),
}));

installTranscriptCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                get OS() {
                    return platformState.os;
                },
                select: (values: Record<string, unknown>) =>
                    values[platformState.os] ?? values.default,
            },
            View: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
                React.createElement('View', props, props.children),
        });
    },
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({});
    },
});

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: Record<string, unknown>) => React.createElement('Item', props),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: (
        props: Record<string, unknown> & { children?: React.ReactNode },
    ) => React.createElement('ItemGroup', props, props.children),
}));

vi.mock('./MessageView', () => ({
    MessageView: (props: Record<string, unknown>) =>
        React.createElement('MessageView', props),
    MessageViewWithSessionCommon: (props: Record<string, unknown>) =>
        React.createElement('MessageView', {
            ...props,
            testID: 'captured-transcript-message',
        }),
}));

installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();

describe('TranscriptList external session operation presentation', () => {
    beforeEach(() => {
        resetTranscriptCommonModuleMockState();
    });

    it.each([
        ['native newest-first', 'ios'],
        ['web oldest-first', 'web'],
    ] as const)('renders the strict public presentation after the newest row at the visual bottom on %s', async (
        _label,
        platformOS,
    ) => {
        platformState.os = platformOS;
        const presentation = ExternalSessionOperationSharedPresentationV1Schema.parse({
            v: 1,
            operationId: 'operation-public-1',
            revision: 4,
            kind: 'materialize',
            status: 'running',
            phase: 'importing',
        });
        const { TranscriptList } = await import('./TranscriptList');
        const metadata = {
            path: '/repo', host: 'public-host',
            externalSessionOperationPresentationV1: presentation,
        };
        const messages: Message[] = [{
            kind: 'user-text', id: 'message-1', localId: null, createdAt: 1, text: 'hello',
        }];
        const source = createTestSessionTranscriptSource({
            sessionId: 'session-public-1', metadata, messages,
            interaction: { canSendMessages: false, canApprovePermissions: false, permissionDisabledReason: 'public' },
        });
        const screen = await renderWithSessionTranscriptSource(
            <TranscriptList
                datasetKey="public:session-public-1:1"
                metadata={metadata}
                messages={messages}
            />,
            source,
        );

        expect(
            screen.findByTestId('captured-visual-bottom-slot')?.findAll((node) => (
                node.props.testID === 'external-session-operation-shared-card'
            )).length ?? 0,
        ).toBeGreaterThan(0);
        expect(
            screen.findByTestId('captured-visual-top-slot')?.findAll((node) => (
                node.props.testID === 'external-session-operation-shared-card'
            )) ?? [],
        ).toHaveLength(0);
        const visualList = screen.findByTestId('captured-visual-list');
        const directSlotOrder = visualList?.children.flatMap((child) => (
            typeof child === 'object' && child !== null && 'props' in child
                ? [String(child.props.testID)]
                : []
        ));
        expect(directSlotOrder).toEqual([
            'captured-visual-top-slot',
            'captured-transcript-items',
            'captured-visual-bottom-slot',
        ]);
        expect(
            screen.findByTestId('captured-transcript-items')?.findAll((node) => (
                node.props.testID === 'captured-transcript-message'
            )).length ?? 0,
        ).toBeGreaterThan(0);
        expect(
            screen.findAll((node) => (
                typeof node.props.testID === 'string'
                && node.props.testID.startsWith(
                    'external-session-operation-action-',
                )
            )),
        ).toEqual([]);
    });

    it('dismisses only the exact terminal presentation for the mounted public transcript', async () => {
        platformState.os = 'web';
        const completedPresentation =
            ExternalSessionOperationSharedPresentationV1Schema.parse({
                v: 1,
                operationId: 'operation-public-1',
                revision: 4,
                kind: 'materialize',
                status: 'completed',
                phase: 'publishing',
            });
        const { TranscriptList } = await import('./TranscriptList');
        const renderTranscript = (
            presentation: typeof completedPresentation,
        ) => (
            <TranscriptList
                datasetKey="public:session-public-1:1"
                metadata={{
                    path: '/repo',
                    host: 'public-host',
                    externalSessionOperationPresentationV1: presentation,
                }}
                messages={[]}
            />
        );
        const source = createTestSessionTranscriptSource({
            sessionId: 'session-public-1', messages: [],
            metadata: { path: '/repo', host: 'public-host', externalSessionOperationPresentationV1: completedPresentation },
            interaction: { canSendMessages: false, canApprovePermissions: false, permissionDisabledReason: 'public' },
        });
        const screen = await renderWithSessionTranscriptSource(
            renderTranscript(completedPresentation),
            source,
        );
        const updateTranscript = async (presentation: typeof completedPresentation) => {
            await act(async () => {
                source.update({
                    metadata: { path: '/repo', host: 'public-host', externalSessionOperationPresentationV1: presentation },
                    messages: [], reducerState: null, agentState: null,
                });
            });
            await screen.update(renderTranscript(presentation));
        };

        expect(
            screen.findByTestId('external-session-operation-action-dismiss'),
        ).not.toBeNull();
        await screen.pressByTestIdAsync(
            'external-session-operation-action-dismiss',
        );
        expect(
            screen.findByTestId('external-session-operation-shared-card'),
        ).toBeNull();

        await updateTranscript({
            ...completedPresentation,
            revision: completedPresentation.revision + 1,
        });
        expect(
            screen.findByTestId('external-session-operation-action-dismiss'),
        ).not.toBeNull();

        await updateTranscript({
            ...completedPresentation,
            operationId: 'operation-public-2',
            revision: 1,
        });
        expect(
            screen.findByTestId('external-session-operation-action-dismiss'),
        ).not.toBeNull();

        await updateTranscript({
            ...completedPresentation,
            operationId: 'operation-public-running',
            revision: 1,
            status: 'running',
            phase: 'importing',
        });
        expect(
            screen.findByTestId('external-session-operation-shared-card'),
        ).not.toBeNull();
        expect(
            screen.findByTestId('external-session-operation-action-dismiss'),
        ).toBeNull();
    });
});
