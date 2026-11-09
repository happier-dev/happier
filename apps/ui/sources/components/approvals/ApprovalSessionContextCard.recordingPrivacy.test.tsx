import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { act, renderScreen, standardCleanup, createSessionListRenderableSessionFixture } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';
import { setScreenSharingPrivacyActive } from '@/desktop/capture/useNativeRecordingActive';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
const { ApprovalSessionContextCard } = await import('./ApprovalSessionContextCard');
const original = storage.getState();
afterEach(() => { standardCleanup(); setScreenSharingPrivacyActive(false); storage.setState(original, true); });

it('conceals a held approval requester name and endpoint while keeping the Session navigation target', async () => {
    const session = createSessionListRenderableSessionFixture({ id: 'private-requester', serverId: 'private-home',
        metadata: { name: 'Private requester', path: '/private-workspace', host: 'private-host' } });
    storage.getState().applySettingsLocal({ sessionListHiddenTagIdsWhileRecording: { 'private-home': ['private'] } });
    storage.getState().setSessionTagAssignmentsOptimistic('private-home', session.id, ['private']);
    const screen = await renderScreen(<ApprovalSessionContextCard session={session} sessionName="Private requester"
        machineLabel={null} serverId={null} context={null} requesterSessionId={session.id} requesterStatus="ready"
        requesterAgentId={null} requesterSurface="session" />);
    expect(screen.getTextContent()).toContain('Private requester');
    await act(async () => { setScreenSharingPrivacyActive(true); });
    expect(screen.getTextContent()).not.toContain('Private requester');
    expect(screen.getTextContent()).not.toContain('private-workspace');
    expect(screen.findByTestId('approvals.open-session')).not.toBeNull();
    await act(async () => { setScreenSharingPrivacyActive(false); });
    expect(screen.getTextContent()).toContain('Private requester');
});
