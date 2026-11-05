import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createUsageNoticeArtifactFixture } from '@/dev/testkit/fixtures/usageNoticeFixtures';
import { seedAdmittedArtifactRows } from '@/dev/testkit/harness/artifactStoreBoundary';
import { storage } from '@/sync/domains/state/storageStore';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { InboxSummaryProvider, useSharedInboxSummary } from '@/hooks/inbox/useInboxSummary';

import { createInboxApprovalArtifactFixture } from '@/dev/testkit/fixtures/inboxFixtures';
import { upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { removeServerProfile, setActiveServerId } from '@/sync/domains/server/serverProfiles';
import { InboxModelBoundary, useInboxModel } from '@/hooks/inbox/useInboxModel';
import { InboxContentList } from './InboxContent';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const navigation = vi.hoisted(() => ({ order: [] as string[] }));
const viewport = vi.hoisted(() => ({ list: null as import('@/dev/testkit/mocks/legendList').CapturingLegendListMockState | null }));
// External recycler/viewport boundary: one visible segment; Inbox grouping and row owners stay real.
vi.mock('@legendapp/list/react-native', async () => (await import('@/dev/testkit/mocks/legendList'))
    .createLegendListModuleMock({ renderItemLimit: 1 }, state => { viewport.list = state; }));
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
    router: { push: route => navigation.order.push(String(route)) },
}).module);
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock({ translate: key => key }));

const initialState = storage.getState();
let summaryCount: number | null = 0;
function SummaryProbe() {
    summaryCount = useSharedInboxSummary().count;
    return null;
}

describe('InboxPopoverContent (lab inbox-I2)', () => {
    beforeEach(() => {
        navigation.order = [];
        storage.setState(initialState, true);
        storage.setState({ isDataReady: true, artifactsLoaded: true, profileScope: {
            serverId: getActiveServerSnapshot().serverId, accountId: 'account-a',
        } });
    });
    afterEach(() => {
        standardCleanup();
        storage.setState(initialState, true);
    });

    it('names itself, offers Open Inbox as its one header action, and closes before every navigation', async () => {
        const notice = createUsageNoticeArtifactFixture();
        seedAdmittedArtifactRows([notice], storage);
        const { InboxPopoverContent } = await import('./InboxPopover');
        const screen = await renderScreen(<InboxPopoverContent
            close={() => navigation.order.push('close')} onOpenInbox={() => navigation.order.push('open')} />);

        expect(screen.getTextContent()).toContain('tabs.inbox');
        expect(screen.findByTestId('inbox.popover.mark_all_read')).toBeNull();
        expect(screen.findByTestId('inbox.popover.open')).not.toBeNull();
        expect(screen.findByTestId('inbox.popover.count')?.props.children).toBe('1');

        await screen.pressByTestIdAsync('inbox.popover.open');
        expect(navigation.order).toEqual(['close', 'open']);
        // A notice is an Update: the popover offers one line to the Inbox rather than its row.
        expect(screen.findByTestId(`inbox.usage-notice.${notice.id}`)).toBeNull();
        await screen.pressByTestIdAsync('inbox.popover.updates');
        expect(navigation.order).toEqual(['close', 'open', 'close', 'open']);
    });

    it('shows the same real Account-notice count as the rail summary that opened it', async () => {
        const notices = Array.from({ length: 4 }, (_, index) => createUsageNoticeArtifactFixture({ id: `notice-${index}` }));
        seedAdmittedArtifactRows(notices, storage);
        const { InboxPopoverContent } = await import('./InboxPopover');
        const screen = await renderScreen(<InboxSummaryProvider><SummaryProbe />
            <InboxPopoverContent close={() => {}} onOpenInbox={() => {}} />
        </InboxSummaryProvider>);
        expect(summaryCount).toBe(4);
        expect(screen.findByTestId('inbox.popover.count')?.props.children).toBe(String(summaryCount));
        await act(async () => seedAdmittedArtifactRows([], storage));
        expect(summaryCount).toBe(0);
        expect(screen.findByTestId('inbox.popover.count')).toBeNull();
    });

    it.each(['popover', 'page'] as const)('mounts a viewport of approvals while retaining the entire Needs you backlog (%s)', async (presentation) => {
        const previousServerId = getActiveServerSnapshot().serverId;
        const home = await upsertAndActivateServer({ serverUrl: 'https://inbox-popover-viewport.test' });
        storage.setState({ isDataReady: true, artifactsLoaded: true,
            profileScope: { serverId: home.id, accountId: 'account-a' } });
        try {
            const approvals = (count: number) => Array.from({ length: count }, (_, index) => createInboxApprovalArtifactFixture({
                id: `approval-${index}`, serverId: home.id,
            }));
            seedAdmittedArtifactRows(approvals(48), storage);
            expect(Object.keys(storage.getState().artifacts)).toHaveLength(48);
            const { InboxPopoverContent } = await import('./InboxPopover');
            function PageList() {
                const model = useInboxModel();
                return <InboxContentList model={model} testID="inbox.page.list" header={null} />;
            }
            let commits = 0;
            const content = presentation === 'popover'
                ? <InboxPopoverContent close={() => {}} onOpenInbox={() => {}} />
                : <InboxModelBoundary><PageList /></InboxModelBoundary>;
            const screen = await renderScreen(<React.Profiler id="inbox" onRender={() => { commits += 1; }}>{content}</React.Profiler>);
            const mounted = () => screen.tree.root.findAll(node => typeof node.type === 'string'
                && /^inbox\.approval\.approval-\d+$/.test(String(node.props.testID ?? node.props['data-testid']))).length;
            const firstViewport = mounted();
            expect(firstViewport).toBeGreaterThan(0);
            expect(firstViewport).toBeLessThan(48);
            const openCommits = commits;
            await act(async () => seedAdmittedArtifactRows(approvals(96), storage));
            const smallBatchCommits = commits - openCommits;
            const beforeLargeBatch = commits;

            // The observed incident had 1,485 Needs you items. Growing the backlog must not grow mounts.
            await act(async () => seedAdmittedArtifactRows(approvals(1485), storage));
            expect(mounted()).toBe(firstViewport);
            // Initial source settlement may add a commit to the first batch; backlog growth adds none.
            expect(commits - beforeLargeBatch).toBeLessThanOrEqual(smallBatchCommits);
            if (presentation === 'popover') expect(screen.findByTestId('inbox.popover.count')?.props.children).toBe('1485');
            const segments: readonly Readonly<{ items: readonly Readonly<{ id: string }>[] }>[] = viewport.list?.props?.data ?? [];
            expect(segments.flatMap(segment => segment.items)).toHaveLength(1485);
        } finally {
            standardCleanup();
            if (previousServerId) await setActiveServerId(previousServerId);
            await removeServerProfile(home.id);
        }
    });
});
