import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { ACTION_ID_FAMILIES_V1 } from '@happier-dev/protocol/actions/actionIds';
import type { PluginUiJsonValueV1 } from '@happier-dev/protocol/plugins/ui';
import { createDefaultCollectionSpaceV1 } from '@happier-dev/protocol/collections/spaces/collectionSpacesV1';
import { standardCleanup } from '@/dev/testkit';
import { serveActionHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { renderMountedCurrentUiContext } from '@/dev/testkit/harness/mountedCurrentUiContext';
import { reportCollectionLayout } from '@/dev/testkit/harness/collectionLayoutHarness';
import { readCurrentUiContextActionReader } from '@/components/appShell/currentUiContext/currentUiContextActionRuntime';
import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { WorkspaceRouteBody } from '@/app/(app)/reviews';
import { t } from '@/text';

// The physical recycler and DOM portal are boundaries; the collection, filter and commands stay real.
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(
    (await import('@/dev/testkit/mocks/virtualizedList')).createCapturingFlatListMock().module));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/components/ui/popover', async original => (await import('@/dev/testkit/mocks/popover')).createInlinePopoverModuleMock(original));
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({ pathname: '/reviews' }).module);

let home: Awaited<ReturnType<typeof serveActionHomes>> | undefined;
afterEach(async () => {
    await standardCleanup();
    retireActiveServerAccountScopeLifetime();
    await home?.dispose();
    home = undefined;
    vi.unstubAllGlobals();
});

it('changes the mounted collection search, query and selected space through semantic commands', async () => {
    const requests: unknown[] = [];
    const release = { ...createDefaultCollectionSpaceV1('review'), id: 'release', name: 'Release',
        membership: { mode: 'filter_or_manual' as const }, filter: { needsDecision: true } };
    home = await serveActionHomes({ homes: [{ key: 'a', serverUrl: 'https://review-view-command.test', accountId: 'account-a',
        settings: { collectionSpacesEnabled: true, reviewSpacesEnabled: true, collectionSpacesV1: { v: 1, spaces: [release] } } }],
        route: request => {
            if (request.path === '/v1/kv/bulk') return Response.json({ values: [] });
            if (request.path !== '/v1/reviews/list') return undefined;
            requests.push(request.body);
            return Response.json({ items: ['repository', 'pull_request'].map(subjectKind => ({
                reviewId: `review-${subjectKind}`, projectSourceId: null, workflowId: null,
                subjectKind, sourceKind: 'direct', state: 'completed', currentRoundOrdinal: 1,
                startedAt: 1, finishedAt: 2, createdAt: 1, updatedAt: 2, counts: { total: 1, needsDecision: 0 },
                needsYou: { reviewId: `review-${subjectKind}`, roundOrdinal: 1, reason: 'review_needs_you',
                    needsYou: false, requestedVerdict: false, pendingDecisions: false, canSubmitVerdict: false },
            })), cursor: null });
        } });
    const server = home.homes.a!;
    publishAppliedActiveServerSnapshot({ serverId: server.id, serverUrl: server.serverUrl, generation: 0 });
    const screen = await renderMountedCurrentUiContext(<WorkspaceRouteBody />);
    const executor = createDefaultActionExecutor();
    const commands = () => readCurrentUiContextActionReader({ surface: 'agent' })!.readCurrentUiContext()!.commands;
    const invoke = async (control: string, input: PluginUiJsonValueV1) => {
        const command = commands().find(row => row.description?.startsWith(control));
        expect(command, control).toBeDefined();
        let result: Awaited<ReturnType<typeof executor.execute>> | undefined;
        await act(async () => { result = await executor.execute(ACTION_ID_FAMILIES_V1.current_ui_context[1], {
            commandId: command!.id, input,
        }, { surface: 'agent' }); });
        return result;
    };
    await reportCollectionLayout(screen, 'reviews:list');
    await vi.waitFor(() => expect(screen.findHostByTestId('reviews:row:review-pull_request')).not.toBeNull());
    expect(await invoke('reviews.query', { value: t('reviewWalkthrough.collection.subjectPullRequest') })).toMatchObject({ ok: true });
    expect(screen.findByTestId('reviews:search')?.props.value).toBe(t('reviewWalkthrough.collection.subjectPullRequest'));
    expect(screen.findHostByTestId('reviews:row:review-repository')).toBeNull();
    expect(await invoke('reviews.view', { state: 'running' })).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(requests.at(-1)).toMatchObject({ state: 'running' }));
    expect(await invoke('reviews.view', { state: 'invented' })).toMatchObject({ ok: false });
    expect(await invoke('collection.review.space.select', { spaceId: 'missing' })).toMatchObject({ ok: false });
    expect(await invoke('collection.review.space.select', { spaceId: 'release' })).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(requests.at(-1)).toMatchObject({ spaceId: 'release', needsDecision: true }));
    expect(screen.getTextContent()).toContain('Release');
    expect(await invoke('reviews.query', { value: '' })).toMatchObject({ ok: true });
    expect(screen.findHostByTestId('reviews:row:review-repository')).not.toBeNull();
});
