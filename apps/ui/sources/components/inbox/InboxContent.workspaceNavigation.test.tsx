import * as React from 'react';
import { expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { chooseDropdownMenuItem } from '@/dev/testkit/harness/dropdownMenuHarness';
import { DestinationInstanceHost, type DestinationNavigation } from '@/components/appShell/workspace/DestinationInstanceHost';
import { Text } from '@/components/ui/text/Text';
import type { InboxModel } from '@/hooks/inbox/useInboxModel';
import { createInboxAttentionFixture, createInboxApprovalArtifactFixture } from '@/dev/testkit/fixtures/inboxFixtures';
import { readOpenApprovalInboxEntry } from '@/sync/domains/artifacts/approvalArtifactAdmission';
import { createUsageNoticeArtifactFixture } from '@/dev/testkit/fixtures/usageNoticeFixtures';
import { UsageNoticeArtifactHeaderV1Schema } from '@happier-dev/protocol/activity/usageNoticeArtifactV1';
import { buildInboxWorkGroups } from '@/activity/presentation/buildInboxWorkGroups';
import { buildInboxItems } from './inboxItems';
import type { InboxView } from './InboxContent';

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ pathname: () => '/inbox' }).module;
});

function createModel(includeApproval = true): InboxModel {
    const openApprovals = includeApproval ? [createInboxApprovalArtifactFixture({ id: 'voice-start', title: 'Start Voice',
        actionId: 'ui.voice_global.start', serverIdentityId: 'voice-home' })] : [];
    const workGroups = buildInboxWorkGroups({ sessionEntries: [], workflowRuns: [], automationRuns: [],
        automationServerId: null, openApprovals: openApprovals.map(artifact => readOpenApprovalInboxEntry(artifact)!),
        stalledSessions: [], landings: [], snoozed: [], resolveSession: () => null, resolveOriginRunId: () => null });
    const sessionPresentation = { sessionsNeedingAttention: [], readySessions: [], markAllReadTargets: [], pendingRequestHydrationTargets: [] };
    return {
        invokePluginSessionControl: async () => ({ kind: 'unavailable' }),
        source: { isDataReady: true, sessionsById: {}, sessionListRowsByServerId: {},
            ordinarySessionListMembershipByServerId: {}, sessionListIndexByServerId: {}, concurrentSessionListCacheByServerId: {} },
        openApprovals,
        friendRequests: [], sessionPresentation,
        targetBySessionAddress: new Map(), actionOperationEntries: [], pendingReadKeys: new Set(),
        readUnavailableReasonBySessionAddress: new Map(), markAllReadUnavailableReason: null,
        markAllPending: false, isLoading: false, hasPrimaryAttention: true, hasContent: true, showCaughtUp: false,
        workGroups,
        spansHomes: false, ...createInboxAttentionFixture(),
        items: buildInboxItems({ workGroups, sessionPresentation, workflowServerId: null, accountServerId: null, notices: [] }),
        openUsageNotices: [], dismissUsageNotice: async () => {},
        markRead: async () => {}, resolveActionOperation: () => {}, settle: async () => {}, setReminder: async () => {},
    };
}

async function renderHostedInbox(model: InboxModel, view?: InboxView) {
    const { InboxContent } = await import('./InboxContent');
    function HostedInbox() {
        const [route, setRoute] = React.useState('/inbox');
        const navigation = React.useMemo<DestinationNavigation>(() => ({
            push: href => setRoute(String(href)), replace: href => setRoute(String(href)), back: () => setRoute('/inbox'),
        }), []);
        return <DestinationInstanceHost tabId="inbox-qa" ref={{ kind: 'inbox', params: {} }} pathname={route} focused visible navigation={navigation}>
            {route === '/inbox' ? <InboxContent model={model} view={view} /> : <Text testID="opened-destination">{route}</Text>}
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
    const model = { ...createModel(false),
        openUsageNotices: [{ artifact, header: UsageNoticeArtifactHeaderV1Schema.parse(artifact.rawHeader) }], dismissUsageNotice: dismiss,
    };
    const screen = await renderHostedInbox(model, 'updates');
    await chooseDropdownMenuItem(screen, `inbox.usage-notice.dismiss.${artifact.id}`, 'inbox.dismiss');
    expect(dismiss.mock.calls[0]?.[0]).toEqual(model.openUsageNotices[0]);
    expect(screen.findByTestId(`inbox.usage-notice.${artifact.id}`)).not.toBeNull();
    await screen.pressByTestIdAsync(`inbox.usage-notice.${artifact.id}`);
    expect(screen.findByTestId('opened-destination')?.props.children).toBe('/settings/usage');
});

it('files a machine alert under Machines, opens the tab its push would, and dismisses through the notice owner', async () => {
    const notice = {
        topic: 'resource_limit', phase: 'started', kind: 'memory_pressure', machineId: 'edge-1-id', machineName: 'edge-1',
        at: 2_000_000, since: 1_700_000, guardEnabled: false,
        evidence: { level: 'critical', sustainMs: 300_000, swapUsedBytes: 1.8 * 2 ** 30, swapTotalBytes: 2 * 2 ** 30 },
    } as const;
    const header = { v: 1, kind: 'usage_notice.v1', title: 'edge-1 is short on memory', status: 'open', notice } as const;
    const artifact = createUsageNoticeArtifactFixture({ id: 'notice-machine', header, rawHeader: header,
        body: JSON.stringify({ v: 1, notice }) });
    const dismiss = vi.fn(async (_entry: InboxModel['openUsageNotices'][number]) => {});
    const model = { ...createModel(false),
        openUsageNotices: [{ artifact, header: UsageNoticeArtifactHeaderV1Schema.parse(artifact.rawHeader) }], dismissUsageNotice: dismiss,
    };
    const screen = await renderHostedInbox(model, 'updates');
    expect(screen.findByTestId('inbox.section.machines')).not.toBeNull();
    expect(screen.findByTestId('inbox.section.usage')).toBeNull();
    expect(screen.getTextContent()).toContain('edge-1 is short on memory');
    expect(screen.getTextContent()).toContain('Critical for 5 min · swap 1.8 of 2 GB');
    await chooseDropdownMenuItem(screen, 'inbox.machine-notice.dismiss.notice-machine', 'inbox.dismiss');
    expect(dismiss.mock.calls[0]?.[0]).toEqual(model.openUsageNotices[0]);
    await screen.pressByTestIdAsync('inbox.machine-notice.notice-machine');
    expect(screen.findByTestId('opened-destination')?.props.children).toBe('/machines/edge-1-id?tab=processes&sort=memory');
});

