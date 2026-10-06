import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSessionFixture, renderScreen, standardCleanup } from '@/dev/testkit';
import { createTestSessionTranscriptSource, wrapWithSessionTranscriptSource } from '@/dev/testkit/sessionTranscriptSource';
import type { UserTextMessage } from "@happier-dev/session-core/messages";
import { upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import { storage } from '@/sync/domains/state/storage';
import type { PendingMessage } from '@/sync/domains/state/storageTypes';
import { t } from '@/text';
import { useSessionMessageAuthorshipScope } from './useSessionMessageAuthorshipScope';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/sync/sync', () => ({
    sync: {
        getSyncTuning: () => ({
            transcriptEstimatedItemSizePx: 120,
            transcriptBackwardPrefetchThresholdPx: 800,
        }),
    },
}));

vi.mock('@legendapp/list/react-native', async () => {
    const { createCapturingLegendListMock } = await import('@/dev/testkit/mocks/legendList');
    return createCapturingLegendListMock().module;
});

/**
 * The pending block is replaced by a leaf that applies the REAL canonical recipient
 * predicate. A sidechain host that paints the block without the exact target recipient
 * therefore paints nothing — which is precisely the cross-target defect this covers,
 * and is also what the real block does with its own filter.
 */
vi.mock('@/components/sessions/pending/PendingMessagesTranscriptBlock', async () => {
    const { isPendingMessageForRecipient } = await import('@/sync/domains/pending/pendingMessageRecipient');
    return {
        PendingMessagesTranscriptBlock: (props: any) => React.createElement(
            'View',
            { testID: 'pending-block', serverId: props.serverId },
            ...(props.pendingMessages as PendingMessage[])
                .filter((message) => isPendingMessageForRecipient(message, props.recipient))
                .map((message) => React.createElement('View', {
                    key: message.id,
                    testID: `pending-block-row:${message.id}`,
                })),
        ),
    };
});

function createRunPendingMessage(overrides: Partial<PendingMessage>): PendingMessage {
    return {
        id: 'p1',
        localId: 'p1',
        text: 'queued for the run',
        displayText: undefined,
        createdAt: 1,
        updatedAt: 1,
        rawRecord: {},
        source: 'server_pending',
        ...overrides,
    } as PendingMessage;
}


function createChainTestRoot(Content: typeof import('./ChainTranscriptList')['ChainTranscriptList']) {
    return function ChainTestRoot(props: React.ComponentProps<typeof Content>) {
        const authorship = useSessionMessageAuthorshipScope(props.sessionId, props.serverId);
        const source = React.useMemo(() => createTestSessionTranscriptSource({
            sessionId: props.sessionId, serverId: props.serverId, messages: props.messages,
            metadata: props.metadata, interaction: props.interaction,
            authorship,
            loadSidechain: async () => 'not_ready',
            history: { loadOlder: props.loadOlder ?? (async () => ({ loaded: 0, hasMore: false, status: 'not_ready' })) },
        }), [props.sessionId, props.serverId, props.messages, props.metadata, props.interaction, props.loadOlder, authorship]);
        return wrapWithSessionTranscriptSource(React.createElement(Content, props), source);
    };
}

const { ChainTranscriptList: ChainContent } = await import('./ChainTranscriptList');

describe('ChainTranscriptList target-scoped pending queue', () => {
    type ChainTranscriptListTestProps =
        Omit<React.ComponentProps<typeof import('./ChainTranscriptList')['ChainTranscriptList']>, 'datasetKey'>
        & { datasetKey?: string };

    async function renderChainTranscriptList(props: ChainTranscriptListTestProps) {
        const ChainTranscriptList = createChainTestRoot(ChainContent);
        return renderScreen(React.createElement(ChainTranscriptList, {
            ...props,
            datasetKey: props.datasetKey ?? JSON.stringify([props.sessionId, 'test-sidechain']),
        }));
    }

    const interaction = {
        canSendMessages: true,
        canApprovePermissions: true,
    } as const;

    afterEach(() => {
        standardCleanup();
        storage.setState(storage.getInitialState(), true);
    });

    it('paints the exact run target queue inside the sidechain transcript', async () => {
        const screen = await renderChainTranscriptList({
            sessionId: 's1',
            serverId: 'home-b',
            messages: [],
            metadata: null,
            interaction,
            isInitialLoadInFlight: false,
            pendingMessages: [createRunPendingMessage({
                id: 'p_run',
                localId: 'p_run',
                recipient: { kind: 'execution_run', runId: 'run_1' },
            } as Partial<PendingMessage>)],
            discardedMessages: [],
            pendingRecipient: { kind: 'execution_run', runId: 'run_1' },
        });

        expect(screen.findByTestId('pending-block')).toBeTruthy();
        expect(screen.findByTestId('pending-block')?.props.serverId).toBe('home-b');
        expect(screen.findByTestId('pending-block-row:p_run')).toBeTruthy();
    });

    it('refreshes the pending-row callback when only the exact Home changes', async () => {
        const ChainTranscriptList = createChainTestRoot(ChainContent);
        const pendingMessages = [createRunPendingMessage({
            id: 'p_run',
            localId: 'p_run',
            recipient: { kind: 'execution_run', runId: 'run_1' },
        } as Partial<PendingMessage>)];
        const buildElement = (serverId: string) => React.createElement(ChainTranscriptList, {
            sessionId: 's1',
            serverId,
            datasetKey: 'same-mounted-sidechain',
            messages: [],
            metadata: null,
            interaction,
            isInitialLoadInFlight: false,
            pendingMessages,
            discardedMessages: [],
            pendingRecipient: { kind: 'execution_run' as const, runId: 'run_1' },
        });
        const screen = await renderScreen(buildElement('home-a'));
        expect(screen.findByTestId('pending-block')?.props.serverId).toBe('home-a');

        await screen.update(buildElement('home-b'));

        expect(screen.findByTestId('pending-block')?.props.serverId).toBe('home-b');
    });

    it('keeps committed and pending authorship on the same exact Home when Session ids collide', async () => {
        const homeA = await upsertServerProfile({ serverUrl: 'https://chain-home-a.example.test' });
        const homeB = await upsertServerProfile({ serverUrl: 'https://chain-home-b.example.test' });
        storage.setState({
            profileScope: { serverId: homeB.id, accountId: 'viewer-b' },
            sessions: {
                transcript: createSessionFixture({
                    id: 'transcript',
                    serverId: homeA.id,
                    hasOtherNamedCollaborator: false,
                }),
            },
            sessionListRowsByServerId: {
                [homeA.id]: {
                    transcript: createSessionFixture({
                        id: 'transcript',
                        serverId: homeA.id,
                        hasOtherNamedCollaborator: false,
                    }),
                },
                [homeB.id]: {
                    transcript: createSessionFixture({
                        id: 'transcript',
                        serverId: homeB.id,
                        hasOtherNamedCollaborator: true,
                    }),
                },
            },
            sessionListIndexByServerId: {
                [homeA.id]: [{ type: 'session', sessionId: 'transcript', serverId: homeA.id }],
                [homeB.id]: [{ type: 'session', sessionId: 'transcript', serverId: homeB.id }],
            },
        });
        const committedMessage: UserTextMessage = {
            kind: 'user-text',
            id: 'committed-home-b',
            localId: null,
            createdAt: 1,
            text: 'Committed on Home B',
            accountActor: {
                v: 1,
                serverId: homeB.id,
                accountId: 'viewer-b',
                profile: { firstName: 'Viewer', lastName: null, username: null, avatarUrl: null },
            },
        };

        const screen = await renderChainTranscriptList({
            sessionId: 'transcript',
            serverId: homeB.id,
            messages: [committedMessage],
            metadata: null,
            interaction,
            isInitialLoadInFlight: false,
            pendingMessages: [createRunPendingMessage({
                id: 'pending-home-b',
                localId: 'pending-home-b',
                recipient: { kind: 'execution_run', runId: 'run_1' },
            } as Partial<PendingMessage>)],
            discardedMessages: [],
            pendingRecipient: { kind: 'execution_run', runId: 'run_1' },
        });

        expect(screen.findHostByTestId('transcript-account-attribution:committed-home-b')?.props.accessibilityLabel)
            .toBe(t('message.accountActorSentBy', { name: t('message.accountActorYou') }));
        expect(screen.findByTestId('pending-block')?.props.serverId).toBe(homeB.id);
    });

    it('keeps a main-Session sidechain queue on the main target', async () => {
        const screen = await renderChainTranscriptList({
            sessionId: 's1',
            messages: [],
            metadata: null,
            interaction,
            isInitialLoadInFlight: false,
            pendingMessages: [createRunPendingMessage({ id: 'p_main', localId: 'p_main' })],
            discardedMessages: [],
        });

        expect(screen.findByTestId('pending-block-row:p_main')).toBeTruthy();
    });

    it('renders no queue row when the sidechain has no pending input for its target', async () => {
        const screen = await renderChainTranscriptList({
            sessionId: 's1',
            messages: [],
            metadata: null,
            interaction,
            isInitialLoadInFlight: false,
            pendingMessages: [],
            discardedMessages: [],
            pendingRecipient: { kind: 'execution_run', runId: 'run_1' },
        });

        expect(screen.findByTestId('pending-block')).toBeNull();
    });
});
