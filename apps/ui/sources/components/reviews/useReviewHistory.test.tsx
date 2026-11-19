import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useReviewHistory } from './useReviewHistory';
import '@/sync/ops/actions/defaultActionExecutor';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { setActiveServerId } from '@/sync/domains/server/serverProfiles';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { deriveArtifactStoredKindV1, REVIEW_ARTIFACT_KIND_V1 } from '@happier-dev/protocol/artifacts/artifactKindV1';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { Text } from '@/components/ui/text/Text';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { useActiveServerAccountScopeLifetime } from '@/sync/store/hooks';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('socket.io-client', async original => (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));
installDisconnectedServerSocketBoundary();

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
afterEach(async () => { await homes.reset(); });

function OpenedHistory({ scope, workflowId = 'hunt', id }: Readonly<{ scope: ServerAccountScope | null; workflowId?: string | null; id: string }>) {
    const history = useReviewHistory({ workflowId, reviewId: 'current' }, { scope });
    return <>
        <Text testID={id}>{history.data ? history.data.items.map(item => `${item.priorRunCount}:${item.newSincePrevious}`).join(',') || 'empty' : history.status}</Text>
        <Text testID={`${id}-status`}>{history.status}</Text>
        <Text testID={`${id}-home`}>{history.scope?.accountId ?? 'none'}</Text>
        <Text testID={`${id}-retry`} onPress={history.refresh}>Retry</Text>
    </>;
}

function ActiveHomeControl() {
    const lifetime = useActiveServerAccountScopeLifetime();
    return <Text testID="active-home">{lifetime?.scope.accountId ?? 'none'}</Text>;
}

describe('demanded Hunt history through the real Action transport', () => {
    it('keeps a pending read distinct from answered empty and exposes a failed refresh with retry', async () => {
        const serverId = await homes.addHome({ serverUrl: 'https://hunt-history-states.example', name: 'History', accountId: 'alice' });
        const scope = { serverId, accountId: 'alice' };
        let release = () => {};
        const respondAfter = new Promise<void>(resolve => { release = resolve; });
        homes.answer(serverId, 'POST /v1/reviews/history/list', { respondAfter, body: { previousReviewId: null, items: [] } });
        const screen = await renderScreen(<OpenedHistory scope={scope} id="history" />);
        try {
            await waitForHomeGovernance(() => expect(screen.findHostByTestId('history')?.props.children).toBe('loading'));
            await act(async () => { release(); });
            await waitForHomeGovernance(() => expect(screen.findHostByTestId('history')?.props.children).toBe('empty'));
            expect(screen.findHostByTestId('history-status')?.props.children).toBe('ready');
            homes.answer(serverId, 'POST /v1/reviews/history/list', { status: 503, body: { error: 'home_temporarily_unavailable' } });
            await screen.pressByTestIdAsync('history-retry');
            await waitForHomeGovernance(() => expect(screen.findHostByTestId('history-status')?.props.children).toBe('error'));
            expect(screen.findHostByTestId('history')?.props.children).toBe('empty');
            homes.answer(serverId, 'POST /v1/reviews/history/list', { body: { previousReviewId: null, items: [{
                findingIdentity: 'first-finding', priorReviewCount: 0, priorRunCount: 0, firstObservedAt: 1,
                inCurrentReview: true, inPreviousReview: false, currentAppearances: [], previousAppearances: [],
                newSincePrevious: null, openReviewCount: 1,
            }] } });
            await screen.pressByTestIdAsync('history-retry');
            await waitForHomeGovernance(() => expect(screen.findHostByTestId('history-status')?.props.children).toBe('ready'));
            expect(screen.findHostByTestId('history')?.props.children).toBe('0:null');
        } finally { release(); await screen.unmount(); }
    });

    it('shares one read, distinguishes unknown novelty, and refreshes only while presented', async () => {
        const serverId = await homes.addHome({ serverUrl: 'https://hunt-history.example', name: 'History', accountId: 'alice' });
        const otherHome = await homes.addHome({ serverUrl: 'https://hunt-active.example', name: 'Active', accountId: 'bob' });
        await setActiveServerId(otherHome, { scope: 'device' });
        const scope = { serverId, accountId: 'alice' };
        const requests: unknown[] = [];
        const unrelatedRequests: unknown[] = [];
        let runs = 2;
        homes.answer(otherHome, 'POST /v1/reviews/history/list', { select: input => {
            unrelatedRequests.push(input);
            return { body: { previousReviewId: null, items: [] } };
        } });
        homes.answer(serverId, 'POST /v1/reviews/history/list', { select: input => {
            requests.push(input);
            return { body: { previousReviewId: 'previous', items: [{ findingIdentity: 'same-finding', priorReviewCount: 2,
                priorRunCount: runs, firstObservedAt: 1, inCurrentReview: true, inPreviousReview: false,
                currentAppearances: [], previousAppearances: [], newSincePrevious: true, openReviewCount: 1 }] } };
        } });
        const connection = await restoreServerAccountForTest({ serverUrl: 'https://hunt-active.example', accountId: 'bob',
            additionalRequestOrigins: ['https://hunt-history.example'], request: homes.request });
        const page = (active: boolean, accountId = 'alice') =>
            <PluginSurfaceFocusEligibilityProvider active={active} presentationActive={active}>
                <OpenedHistory scope={{ ...scope, accountId }} id="first" />
                <OpenedHistory scope={{ ...scope, accountId }} id="second" />
                <OpenedHistory scope={{ ...scope, accountId }} workflowId={null} id="direct" />
                <OpenedHistory scope={null} id="unbound" />
                <ActiveHomeControl />
            </PluginSurfaceFocusEligibilityProvider>;
        const screen = await renderScreen(page(true));
        try {
            await waitForHomeGovernance(() => expect(screen.findHostByTestId('first')?.props.children).toBe('2:true'));
            expect(screen.findHostByTestId('second')?.props.children).toBe('2:true');
            expect(screen.findHostByTestId('direct')?.props.children).toBe('idle');
            expect(screen.findHostByTestId('active-home')?.props.children).toBe('bob');
            expect(screen.findHostByTestId('unbound-home')?.props.children).toBe('none');
            expect(screen.findHostByTestId('unbound')?.props.children).toBe('idle');
            expect(unrelatedRequests).toEqual([]);
            expect(requests).toEqual([{ workflowId: 'hunt', reviewId: 'current' }]);
            await act(async () => {
                for (let i = 0; i < 20; i++) publishHomeAccountChange(serverId, [`session-${i}`], { changeKinds: ['session'] });
            });
            await new Promise<void>(resolve => setImmediate(resolve));
            expect(requests).toHaveLength(1);
            runs = 3;
            await act(async () => { publishHomeAccountChange(serverId, ['earlier-review'], { changeKinds: ['artifact'],
                artifactKinds: [deriveArtifactStoredKindV1({ kind: REVIEW_ARTIFACT_KIND_V1 })] }); });
            await waitForHomeGovernance(() => expect(screen.findHostByTestId('first')?.props.children).toBe('3:true'));
            expect(requests).toHaveLength(2);
            await act(async () => { screen.update(page(false)); });
            runs = 4;
            await act(async () => { publishHomeAccountChange(serverId, ['earlier-review'], { changeKinds: ['artifact'],
                artifactKinds: [deriveArtifactStoredKindV1({ kind: REVIEW_ARTIFACT_KIND_V1 })] }); });
            await new Promise<void>(resolve => setImmediate(resolve));
            expect(requests).toHaveLength(2);
            await act(async () => { screen.update(page(true)); });
            await waitForHomeGovernance(() => expect(screen.findHostByTestId('first')?.props.children).toBe('4:true'));
            await act(async () => { screen.update(page(true, 'different-account')); });
            expect(screen.findHostByTestId('first')?.props.children).toBe('idle');
            expect(requests).toHaveLength(3);
        } finally { await screen.unmount(); await connection.dispose(); }
    });
});
