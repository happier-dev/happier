import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { findAllHostTestInstances } from '@/dev/testkit/render/renderScreen';
import { createInboxApprovalArtifactFixture } from '@/dev/testkit/fixtures/inboxFixtures';
import { seedAdmittedArtifactRows } from '@/dev/testkit/harness/artifactStoreBoundary';
import { INBOX_ARTIFACT_KINDS } from '@/sync/domains/artifacts/inboxArtifacts';
import { storage } from '@/sync/domains/state/storageStore';
import { removeServerProfile, setActiveServerId } from '@/sync/domains/server/serverProfiles';
import { getActiveServerSnapshot, upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The recycler is a renderer/platform boundary: this substitute draws what a measured viewport would,
// the first two virtual rows, and keeps the complete data it was given. Model, store and rows stay real.
vi.mock('@legendapp/list/react-native', async () =>
    (await import('@/dev/testkit/mocks/legendList')).createLegendListModuleMock({ renderItemLimit: 2 }));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({
    useWindowDimensions: () => ({ width: 1280, height: 844, scale: 1, fontScale: 1 }),
}));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock({ translate: key => key }));
vi.mock('expo-image', () => ({ Image: 'Image' }));
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('@/track/tracking', () => ({ tracking: null }));

const initialState = storage.getState();
const APPROVALS = 60;

describe('InboxView windowing', () => {
    let previousServerId = '';
    let homeId = '';
    beforeEach(async () => {
        storage.setState(initialState, true);
        // The Inbox belongs to a signed-in Home; a build without a default Home has none until one is added.
        previousServerId = getActiveServerSnapshot().serverId;
        homeId = (await upsertAndActivateServer({ serverUrl: 'https://inbox-windowing.test' })).id;
        const serverId = getActiveServerSnapshot().serverId;
        storage.setState({ isDataReady: true, artifactInventoryKindsLoaded: INBOX_ARTIFACT_KINDS,
            profileScope: { serverId, accountId: 'account-a' } });
        seedAdmittedArtifactRows(Array.from({ length: APPROVALS }, (_, index) => createInboxApprovalArtifactFixture({
            id: `approval-${index}`, title: `Approval ${index}`, serverId, createdAt: 1_000 + index,
        })), storage);
    });
    afterEach(async () => {
        standardCleanup();
        storage.setState(initialState, true);
        if (previousServerId) await setActiveServerId(previousServerId);
        await removeServerProfile(homeId);
    });

    it('mounts only the approval rows near the viewport, not every waiting approval', async () => {
        const { InboxView } = await import('./InboxView');
        const screen = await renderScreen(<InboxView />);
        await act(async () => {});
        const mountedApprovalRows = () => new Set(findAllHostTestInstances(screen.tree.root,
            node => typeof node.props.testID === 'string' && /^inbox\.approval\.approval-\d+$/.test(node.props.testID))
            .map(node => node.props.testID as string)).size;
        // The section says how many wait, while only the rows a viewport shows are built.
        expect(screen.getTextContent()).toContain(String(APPROVALS));
        expect(mountedApprovalRows()).toBeGreaterThan(0);
        expect(mountedApprovalRows()).toBeLessThan(APPROVALS / 2);
    });
});
