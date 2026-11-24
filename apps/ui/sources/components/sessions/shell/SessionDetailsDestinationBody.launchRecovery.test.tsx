import * as React from 'react';
import { act } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';

import { DestinationInstanceHost } from '@/components/appShell/workspace/DestinationInstanceHost';
import { installSessionPaneRuntimeTestHarness } from '@/components/sessions/panes/sessionPaneRuntimeTestHarness';
import { PaneLoadingFallback } from '@/components/ui/panels/PaneLoadingFallback';
import { createDeferred, renderScreen } from '@/dev/testkit';
import { createPlainSessionByIdResponseFixture, createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { CurtainProbe, startTestLaunchCurtain } from '@/dev/testkit/harness/launchCurtainHarness';
import { storage } from '@/sync/domains/state/storageStore';

vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('@react-navigation/native', async () => (await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock());

const id = 'stale-curtain-details';
const requestStarted = createDeferred<void>();
const staleResponse = createDeferred<void>();
const replacementResponse = createDeferred<void>();
let readCount = 0;
const runtime = installSessionPaneRuntimeTestHarness({
    request: async (input) => {
        if (new URL(String(input)).pathname !== `/v2/sessions/${id}`) return null;
        readCount += 1;
        if (readCount > 1) {
            await replacementResponse.promise;
            return Response.json({ error: 'unavailable' }, { status: 503 });
        }
        requestStarted.resolve();
        await staleResponse.promise;
        return Response.json(createPlainSessionByIdResponseFixture(createSessionFixture({ id, metadataVersion: 1 })));
    },
});
const { SessionDetailsDestinationBody } = await import('./SessionDetailsDestinationBody');

it('reveals cold Details recovery when the exact read is stale and no new Session arrives', async () => {
    expect(storage.getState().sessions[id]).toBeUndefined();

    const { sync } = await import('@/sync/sync');
    const read = vi.spyOn(sync, 'ensureSessionVisibleForMessageRoute');
    const launch = startTestLaunchCurtain();
    const screen = await renderScreen(<runtime.Wrapper>
        <DestinationInstanceHost tabId={id} ref={{ kind: 'sessionDetails', params: { id, serverId: runtime.serverId } }}
            pathname={`/session/${id}/details`} focused visible
            navigation={{ push: () => {}, replace: () => {}, back: () => {} }}>
            <SessionDetailsDestinationBody />
        </DestinationInstanceHost>
        <CurtainProbe />
    </runtime.Wrapper>);
    const curtain = () => screen.root.findByType('CurtainProbe').props.state;
    let replacement: ReturnType<typeof sync.ensureSessionVisibleForMessageRoute> | undefined;
    try {
        await requestStarted.promise;
        expect(screen.findAllByType(PaneLoadingFallback)).toHaveLength(1);
        launch.releaseShell();
        await launch.paint();
        expect(curtain()).toBe('up');

        const readIndex = read.mock.calls.findIndex(([sessionId]) => sessionId === id);
        expect(readIndex).toBeGreaterThanOrEqual(0);
        await act(async () => {
            // A fresh demand retires the first exact read. Hold its replacement so neither
            // that read nor a push can supply the missing Session during the recovery.
            replacement = sync.ensureSessionVisibleForMessageRoute(id, { ...read.mock.calls[readIndex]?.[1], fresh: true });
            staleResponse.resolve();
            await expect(read.mock.results[readIndex]?.value).resolves.toMatchObject({
                kind: 'awaiting_push', errorCode: 'stale_response',
            });
        });
        await launch.paint();
        expect(curtain()).toBe('leaving');
        expect(screen.findAllByType(PaneLoadingFallback)).toHaveLength(1);
        await act(async () => { launch.finish(); });
        expect(curtain()).toBe('gone');
        expect(screen.findAllByType(PaneLoadingFallback)).toHaveLength(1);
        expect(storage.getState().sessions[id]).toBeUndefined();
    } finally {
        staleResponse.resolve();
        await screen.unmount();
        replacementResponse.resolve();
        await replacement;
        launch.dispose();
        read.mockRestore();
    }
});
