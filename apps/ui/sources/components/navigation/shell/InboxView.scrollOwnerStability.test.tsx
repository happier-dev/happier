import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { findAllHostTestInstances } from '@/dev/testkit/render/renderScreen';
import { createUsageNoticeArtifactFixture } from '@/dev/testkit/fixtures/usageNoticeFixtures';
import { seedAdmittedArtifactRows } from '@/dev/testkit/harness/artifactStoreBoundary';
import { INBOX_ARTIFACT_KINDS } from '@/sync/domains/artifacts/inboxArtifacts';
import { storage } from '@/sync/domains/state/storageStore';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The scroll instance is a renderer/platform boundary; the model and store remain real.
const scrollOwner = vi.hoisted(() => ({ mounts: 0, unmounts: 0, offset: 0 }));
const routeBoundary = vi.hoisted(() => ({ resetParams: () => {} }));
// The page's one scroll owner is the windowed recycler, a renderer/platform boundary; the model and store stay real.
vi.mock('@legendapp/list/react-native', async () => {
    const ReactModule = await import('react');
    const legend = await (await import('@/dev/testkit/mocks/legendList')).createLegendListModuleMock();
    const Recycler = legend.LegendList;
    return { ...legend, LegendList: ReactModule.forwardRef((props: Record<string, unknown>, ref) => {
        ReactModule.useEffect(() => {
            scrollOwner.mounts += 1;
            scrollOwner.offset = 0;
            return () => { scrollOwner.unmounts += 1; };
        }, []);
        return ReactModule.createElement(Recycler, { ...props, ref });
    }) };
});
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({
    useWindowDimensions: () => ({ width: 390, height: 844, scale: 1, fontScale: 1 }),
}));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () => {
    const boundary = (await import('@/dev/testkit/mocks/router')).createExpoRouterMock();
    routeBoundary.resetParams = boundary.resetParams;
    return boundary.module;
});
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock({ translate: key => key }));
vi.mock('expo-image', () => ({ Image: 'Image' }));
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('@/track/tracking', () => ({ tracking: null }));

const initialState = storage.getState();
const notice = createUsageNoticeArtifactFixture();
async function setContent(populated: boolean) {
    await act(async () => seedAdmittedArtifactRows(populated ? [notice] : [], storage));
}

describe('InboxView scroll owner stability', () => {
    beforeEach(() => {
        routeBoundary.resetParams();
        scrollOwner.mounts = 0;
        scrollOwner.unmounts = 0;
        scrollOwner.offset = 0;
        storage.setState(initialState, true);
        storage.setState({ isDataReady: true, artifactInventoryKindsLoaded: INBOX_ARTIFACT_KINDS,
            profileScope: { serverId: getActiveServerSnapshot().serverId, accountId: 'account-a' } });
        seedAdmittedArtifactRows([notice], storage);
    });
    afterEach(() => {
        standardCleanup();
        storage.setState(initialState, true);
    });

    it('keeps one scroll container across a populated -> caught-up -> populated cycle', async () => {
        const { InboxView } = await import('./InboxView');
        const screen = await renderScreen(<InboxView />);
        const scrollViews = () => findAllHostTestInstances(screen.tree.root, node => node.type === 'LegendList');
        expect(scrollViews()).toHaveLength(1);
        expect(scrollOwner.mounts).toBe(1);
        // Usage notices are updates; the Inbox opens on Needs you.
        await screen.pressByTestIdAsync('inbox.view:updates');
        expect(screen.findByTestId(`inbox.usage-notice.${notice.id}`)).not.toBeNull();
        scrollOwner.offset = 240;

        await setContent(false);
        expect(scrollViews()).toHaveLength(1);
        expect(screen.findByTestId('inbox.empty')).not.toBeNull();
        await setContent(true);
        expect(screen.findByTestId(`inbox.usage-notice.${notice.id}`)).not.toBeNull();
        expect(scrollOwner.mounts).toBe(1);
        expect(scrollOwner.unmounts).toBe(0);
        expect(scrollOwner.offset).toBe(240);
    });

    it('renders the caught-up state as content inside the scroll container', async () => {
        seedAdmittedArtifactRows([], storage);
        const { InboxView } = await import('./InboxView');
        const screen = await renderScreen(<InboxView />);
        const scrollView = findAllHostTestInstances(screen.tree.root, node => node.type === 'LegendList')[0];
        expect(scrollView).toBeDefined();
        expect(scrollView!.findAll(node => node.props.testID === 'inbox.empty')).not.toHaveLength(0);
        expect(screen.getTextContent()).toContain('inbox.emptyTitle');
        expect(screen.getTextContent()).toContain('inbox.emptyDescription');
    });
});
