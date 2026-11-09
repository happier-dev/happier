import { afterEach, expect, it, vi } from 'vitest';
import { encodeV2SessionListCursorV1 } from '@happier-dev/protocol/sessions/control/contract';
import { SessionReadBatchRequestV1Schema } from '@happier-dev/protocol/sessions/read/sessionReadBatchV1';
import { normalizeSessionListFilterV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';
import { createSessionFixture, createPlainSessionByIdResponseFixture, createSessionOwnerViewerFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { applyProjectAccountRowsFixture } from '@/dev/testkit/fixtures/projectAccountRows';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createSessionListSourceFixture } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { createAccountTokenForTests, createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';

installDisconnectedServerSocketBoundary();
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { getStorage } = await import('@/sync/domains/state/storage');
const { executeSessionFollowAction } = await import('./sessionFollowApi');
const { readSessionFollowRuleInputs } = await import('./sessionFollowRulesApi');
const { primeServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
const { publishHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');
let restored: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
afterEach(async () => { await restored?.dispose(); restored = undefined; await homes.reset(); installDisconnectedServerSocketBoundary(); });

it.each([true, false])('previews Project matches with bounded body reads and safe older-Home paging (selector: %s)', async supported => {
    await homes.reset();
    installHomeGovernanceBoundaries(homes);
    const accountId = 'project-preview-account';
    const serverUrl = 'https://project-preview.test';
    const credentials = { token: createAccountTokenForTests(accountId, { currentAccount: true }) };
    let serverId = await homes.addHome({ name: 'Project preview', serverUrl, accountId, currentAccount: true, credentials });
    // Reuse the listing owner's 2,748-row workload, above the measured heavy
    // Account's 2,450 null-key Sessions (project-null-counts.txt).
    const rows = Array.from({ length: 2748 }, (_, index) => {
        const session = createSessionFixture({ id: `project-session-${index}`, serverId, ownerAccountId: accountId,
            projectKey: index < 3 ? 'payments' : 'other',
            metadata: { path: '/repo', host: 'test', workspaceId: 'checkout' } });
        return { ...createPlainSessionByIdResponseFixture(session).session, viewer: createSessionOwnerViewerFixture(session) };
    });
    homes.answer(serverId, '/v2/sessions', { body: { sessions: [], nextCursor: null, hasNext: false } });
    homes.answer(serverId, '/v2/account/session-follow-rules', { body: { rules: [] } });
    const base = createRootLayoutFeaturesResponse({ features: { sessions: { following: { enabled: true }, filteredListing: { enabled: true } } } });
    const features: ReturnType<typeof createRootLayoutFeaturesResponse> = { ...base, features: { ...base.features, sessions: { ...base.features.sessions,
        filteredListing: { enabled: true, ...(supported ? { projectSelectorVersion: 1 as const } : {}) } } } };
    // Bootstrap and explicit previews must observe the same Home advertisement,
    // including feature reads dispatched while the Account is restoring.
    homes.answer(serverId, '/v1/features', { body: features });
    homes.answer(serverId, '/v1/features/authenticated', { body: features });
    const cursors = new Map<string, number>();
    homes.answer(serverId, '/v2/sessions/query', { select: input => {
        const query = input as { cursor?: string; limit?: number; projectKeys?: { include: string[]; exclude: string[] } };
        const candidates = query.projectKeys ? rows.filter(row => row.projectKey === null
            || ((!query.projectKeys!.include.length || query.projectKeys!.include.includes(row.projectKey!))
                && !query.projectKeys!.exclude.includes(row.projectKey!))) : rows;
        const offset = query.cursor ? cursors.get(query.cursor) ?? 0 : 0;
        const end = Math.min(offset + (query.limit ?? 200), candidates.length);
        const nextCursor = end < candidates.length ? encodeV2SessionListCursorV1(candidates[end - 1]!.id) : null;
        if (nextCursor) cursors.set(nextCursor, end);
        return { body: createSessionListSourceFixture({ sessions: candidates.slice(offset, end), nextCursor,
            hasNext: nextCursor !== null, attentionNextCursor: null, attentionHasNext: false }) };
    } });
    restored = await restoreServerAccountForTest({ serverUrl, accountId, credentials, request: homes.request,
        configureSocket: configureConnectedServerSocketBoundary });
    const { sync } = await import('@/sync/sync');
    await sync.awaitBootstrapForegroundAcquisition();
    await vi.waitFor(() => expect(getStorage().getState().isDataReady).toBe(true));
    const admittedScope = getStorage().getState().profileScope;
    if (!admittedScope || admittedScope.accountId !== accountId) throw new Error('Expected restored preview Account');
    serverId = admittedScope.serverId;
    applyProjectAccountRowsFixture(getStorage(), { workspaceRefs: [{ id: 'checkout', serverId, machineId: 'machine',
        rootPath: '/repo', projectKey: 'payments', createdAtMs: 1 }] });
    primeServerFeaturesSnapshot({ serverId, snapshot: { status: 'ready', features } });
    const rules = await readSessionFollowRuleInputs(serverId);
    const filter = normalizeSessionListFilterV1({ show: 'sessions', homeServerIds: [serverId], scope: 'all_accessible',
        startedBy: ['you', 'agents', 'triggers'],
        projects: { include: [{ serverId, projectKey: 'payments' }], exclude: [] } });
    const read = () => executeSessionFollowAction('follow.preview', { receiver: { kind: 'account' }, filter }, serverId,
        undefined, accountId, undefined, { rules });
    const before = homes.requests.length;
    const result = await read();
    expect(result).toMatchObject({ kind: 'ok', value: { coverage: 'complete', matchCount: 3 } });
    const requests = homes.requests.slice(before);
    const queries = requests.filter(request => request.path === '/v2/sessions/query');
    // The checkout's own id is part of its Project's scope (owner 11-08).
    if (supported) expect(queries[0]!.input).toMatchObject({ projectKeys: { include: ['payments', 'checkout'], exclude: [] } });
    const bodyReads = requests.filter(request => request.path === '/v2/sessions/read-batch')
        .flatMap(request => SessionReadBatchRequestV1Schema.parse(request.input).sessionIds).length;
    expect(bodyReads).toBe(supported ? 3 : rows.length);
    expect(queries).toHaveLength(supported ? 1 : Math.ceil(rows.length / 200));
    if (!supported) expect(queries.every(request => !Object.hasOwn(request.input as object, 'projectKeys'))).toBe(true);

    // Unpublished candidates still use the SAME canonical Workspace resolver.
    const unpublished = { ...rows[3]!, id: 'project-session-unpublished', projectKey: null };
    rows.push(unpublished);
    publishHomeAccountChange(serverId, [unpublished.id], { changeKinds: ['session'], sessionListQueryAffects: 'structural' });
    expect(await read()).toMatchObject({ kind: 'ok', value: { coverage: 'complete', matchCount: 4 } });

    // A real accepted identity change must reach the preview, including a newly matching source.
    rows[4] = { ...rows[4]!, projectKey: 'payments', metadataVersion: rows[4]!.metadataVersion + 1,
        updatedAt: rows[4]!.updatedAt + 1 };
    publishHomeAccountChange(serverId, [rows[4]!.id], { changeKinds: ['session'], sessionListQueryAffects: 'structural' });
    expect(await read()).toMatchObject({ kind: 'ok', value: { coverage: 'complete', matchCount: 5 } });
});
