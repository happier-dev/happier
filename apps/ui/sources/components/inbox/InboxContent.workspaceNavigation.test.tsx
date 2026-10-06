import * as React from 'react';
import { expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { DestinationInstanceHost, type DestinationNavigation } from '@/components/appShell/workspace/DestinationInstanceHost';
import { Text } from '@/components/ui/text/Text';
import type { InboxModel } from '@/hooks/inbox/useInboxModel';
import { EMPTY_WORKFLOW_ATTENTION_SOURCE } from '@/hooks/inbox/useWorkflowAttentionSource';

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ pathname: () => '/inbox' }).module;
});

it('opens an approval in the workspace hosting the Inbox, retaining its exact Home', async () => {
    const { InboxContent } = await import('./InboxContent');
    const model: InboxModel = {
        source: { isDataReady: true, sessionsById: {}, sessionListRowsByServerId: {},
            ordinarySessionListMembershipByServerId: {}, sessionListIndexByServerId: {}, concurrentSessionListCacheByServerId: {} },
        openApprovals: [{ id: 'voice-start', title: 'Start Voice', isDecrypted: true,
            header: { title: 'Start Voice', actionId: 'ui.voice_global.start', serverIdentityId: 'voice-home' },
            headerVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 }],
        friendRequests: [], sessionPresentation: { sessionsNeedingAttention: [], readySessions: [], markAllReadTargets: [] },
        targetBySessionAddress: new Map(), actionOperationEntries: [], pendingReadKeys: new Set(),
        markAllPending: false, isLoading: false, hasPrimaryAttention: true, hasContent: true, showCaughtUp: false,
        workGroups: [], workflowAttention: EMPTY_WORKFLOW_ATTENTION_SOURCE,
        automationAttention: EMPTY_WORKFLOW_ATTENTION_SOURCE, automationAttentionItems: [],
        markRead: async () => {}, resolveActionOperation: () => {}, settle: async () => {}, setReminder: async () => {},
    };
    function HostedInbox() {
        const [route, setRoute] = React.useState('/inbox');
        const navigation = React.useMemo<DestinationNavigation>(() => ({
            push: href => setRoute(String(href)), replace: href => setRoute(String(href)), back: () => setRoute('/inbox'),
        }), []);
        return <DestinationInstanceHost tabId="inbox-qa" ref={{ kind: 'inbox', params: {} }} pathname={route} focused visible navigation={navigation}>
            {route === '/inbox' ? <InboxContent model={model} /> : <Text testID="opened-approval">{route}</Text>}
        </DestinationInstanceHost>;
    }
    const screen = await renderScreen(<HostedInbox />);
    await screen.pressByTestIdAsync('inbox.approval.voice-start');
    expect(screen.findByTestId('opened-approval')?.props.children).toBe('/inbox/approvals/voice-start?serverId=voice-home');
});
