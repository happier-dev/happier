import * as React from 'react';
import { expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { DestinationInstanceHost, type DestinationNavigation } from '@/components/appShell/workspace/DestinationInstanceHost';
import { Text } from '@/components/ui/text/Text';
import type { InboxModel } from '@/hooks/inbox/useInboxModel';
import { EMPTY_WORKFLOW_ATTENTION_SOURCE } from '@/hooks/inbox/useWorkflowAttentionSource';
import { createUsageNoticeArtifactFixture } from '@/dev/testkit/fixtures/usageNoticeFixtures';
import { UsageNoticeArtifactHeaderV1Schema } from '@happier-dev/protocol/activity/usageNoticeArtifactV1';

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ pathname: () => '/inbox' }).module;
});

function createModel(): InboxModel {
    return {
        source: { isDataReady: true, sessionsById: {}, sessionListRowsByServerId: {},
            ordinarySessionListMembershipByServerId: {}, sessionListIndexByServerId: {}, concurrentSessionListCacheByServerId: {} },
        openApprovals: [{ id: 'voice-start', title: 'Start Voice', isDecrypted: true,
            header: { title: 'Start Voice', actionId: 'ui.voice_global.start', serverIdentityId: 'voice-home' },
            headerVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 }],
        friendRequests: [], sessionPresentation: { sessionsNeedingAttention: [], readySessions: [], markAllReadTargets: [] },
        targetBySessionAddress: new Map(), actionOperationEntries: [], pendingReadKeys: new Set(),
        markAllPending: false, isLoading: false, hasPrimaryAttention: true, hasContent: true, showCaughtUp: false,
        workGroups: [], spansHomes: false, workflowAttention: EMPTY_WORKFLOW_ATTENTION_SOURCE,
        automationAttention: EMPTY_WORKFLOW_ATTENTION_SOURCE, automationAttentionItems: [],
        openUsageNotices: [], dismissUsageNotice: async () => {},
        markRead: async () => {}, resolveActionOperation: () => {}, settle: async () => {}, setReminder: async () => {},
    };
}

async function renderHostedInbox(model: InboxModel) {
    const { InboxContent } = await import('./InboxContent');
    function HostedInbox() {
        const [route, setRoute] = React.useState('/inbox');
        const navigation = React.useMemo<DestinationNavigation>(() => ({
            push: href => setRoute(String(href)), replace: href => setRoute(String(href)), back: () => setRoute('/inbox'),
        }), []);
        return <DestinationInstanceHost tabId="inbox-qa" ref={{ kind: 'inbox', params: {} }} pathname={route} focused visible navigation={navigation}>
            {route === '/inbox' ? <InboxContent model={model} /> : <Text testID="opened-destination">{route}</Text>}
        </DestinationInstanceHost>;
    }
    return renderScreen(<HostedInbox />);
}

it('opens an approval in the workspace hosting the Inbox, retaining its exact Home', async () => {
    const screen = await renderHostedInbox(createModel());
    await screen.pressByTestIdAsync('inbox.approval.voice-start');
    expect(screen.findByTestId('opened-destination')?.props.children).toBe('/inbox/approvals/voice-start?serverId=voice-home');
});

it('opens Usage in the Inbox workspace and dismisses a notice without opening another destination', async () => {
    const artifact = createUsageNoticeArtifactFixture();
    const dismiss = vi.fn(async (_entry: InboxModel['openUsageNotices'][number]) => {});
    const model = { ...createModel(), openApprovals: [],
        openUsageNotices: [{ artifact, header: UsageNoticeArtifactHeaderV1Schema.parse(artifact.rawHeader) }], dismissUsageNotice: dismiss,
    };
    const screen = await renderHostedInbox(model);
    await screen.pressByTestIdAsync(`inbox.usage-notice.dismiss.${artifact.id}`);
    expect(dismiss.mock.calls[0]?.[0]).toEqual(model.openUsageNotices[0]);
    expect(screen.findByTestId(`inbox.usage-notice.${artifact.id}`)).not.toBeNull();
    await screen.pressByTestIdAsync(`inbox.usage-notice.${artifact.id}`);
    expect(screen.findByTestId('opened-destination')?.props.children).toBe('/settings/usage');
});
