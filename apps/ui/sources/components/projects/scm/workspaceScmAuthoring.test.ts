import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { standardCleanup } from '@/dev/testkit';
import { applyProjectAccountRowsFixture } from '@/dev/testkit/fixtures/projectAccountRows';
import { ScmComparisonSchema } from '@happier-dev/protocol/scm/comparison';
import { ScmDiffSummaryResultSchema } from '@happier-dev/protocol/scm/diffSummaryResult';
import { PluginUiNewSessionSeedV1Schema, PluginUiNewSessionSeedOriginV1Schema } from '@happier-dev/protocol/plugins/ui';
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
const navigate = vi.hoisted(() => vi.fn());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({ router: { push: navigate } }).module);
const { storage } = await import('@/sync/domains/state/storage');
const { ActionsSettingsV1Schema } = await import('@happier-dev/protocol/actions/actionSettings');
const { buildWorkspaceScmAuthoringSeed, openWorkspaceScmAuthoringDraft } = await import('./workspaceScmAuthoring');
// Production owners load after the socket boundary, which must precede socket.io-client's first import.
const { seedAndOpenNewSession } = await import('@/components/sessions/new/newSessionSeedComposer');
const { readNewSessionDraftFromRepository } = await import('@/components/sessions/composer/newSessionDraftRepositoryAdapter');
const { resetSessionDraftRepositoryForTests } = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');

const workspace = { serverId: 'home-a', workspaceId: 'checkout-exact', machineId: 'machine-a', rootPath: '/repo' };
const scope = { serverId: workspace.serverId, accountId: 'alice' };
const comparison = ScmComparisonSchema.parse({ id: 'comparison-exact', source: { kind: 'branch', head: 'feature', base: 'main' },
    repository: { rootPath: '/repo' }, endpoints: { before: 'before-oid', after: 'after-oid' }, inventory: { state: 'complete', reasons: [], files: [
        { path: 'a.ts', changeKind: 'modified', binary: false, generated: false, lockfile: false,
            evidence: { state: 'available', unifiedDiff: '--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-before\n+after\n@@ -10 +10 @@\n-otherBefore\n+otherAfter\n' },
            occurrences: [
                { id: 'change-one', alias: 'c1', path: 'a.ts', position: 0, before: { startLine: 1, lineCount: 1 }, after: { startLine: 1, lineCount: 1 } },
                { id: 'change-other', alias: 'c2', path: 'a.ts', position: 1, before: { startLine: 10, lineCount: 1 }, after: { startLine: 10, lineCount: 1 } },
            ] },
        { path: 'denied.ts', changeKind: 'modified', binary: false, generated: false, lockfile: false,
            evidence: { state: 'unavailable', reason: 'permission_denied', unifiedDiff: 'DO_NOT_DISCLOSE' }, occurrences: [] },
    ] } });
const result = ScmDiffSummaryResultSchema.parse({ resultId: 'saved-result', revision: 4, canUndo: false, output: {
    success: false, error: 'Partial', errorCode: 'SUMMARY_FAILED', sourceKey: comparison.id,
    comparison, resultId: 'saved-result', revision: 4,
    requestedOutputs: ['walkthrough'],
    analysis: { suppliedChangeRefs: ['change-one', 'change-other'], analysedChangeRefs: ['change-one'], remainingChangeRefs: ['change-other'] },
    outputs: { walkthrough: { state: 'partial', value: { title: 'Reading', intro: 'Overview', otherChangeRefs: ['change-other'],
        stops: [{ id: 'stop-one', title: 'Saved stop', explanationMarkdown: 'Saved explanation', changeRefs: ['change-one'] }] } } },
} });
afterEach(resetSessionDraftRepositoryForTests);

describe('workspace SCM ordinary authoring seed', () => {
    it('carries a chosen stop question through the existing editable authoring seed', () => {
        const question = 'Why does this change keep the earlier value?';
        const seed = buildWorkspaceScmAuthoringSeed({ workspace, accountId: scope.accountId, comparison, result,
            stopId: 'stop-one', question });
        expect(seed?.prompt).toContain(question);
        expect(seed?.prompt).toContain('Saved explanation');
        expect(seed?.prompt).not.toContain('+otherAfter');
        expect(seed).toMatchObject({ placement: { kind: 'exactTarget', machineId: workspace.machineId } });
    });
    it('captures the exact checkout and basis with only the selected stop authorized excerpts', () => {
        const seed = buildWorkspaceScmAuthoringSeed({ workspace, accountId: scope.accountId, comparison, result, stopId: 'stop-one' });
        expect(seed).not.toBeNull();
        expect(PluginUiNewSessionSeedV1Schema.parse(seed)).toEqual({ ...seed, prompt: seed?.prompt?.trim() });
        expect(PluginUiNewSessionSeedOriginV1Schema.parse(seed?.origin)).toEqual(seed?.origin);
        expect(seed?.prompt).toContain('before-oid');
        expect(seed?.prompt).toContain('Saved explanation');
        expect(seed?.prompt).toContain('+after');
        expect(seed?.prompt).not.toContain('+otherAfter');
        expect(seed?.prompt).not.toContain('DO_NOT_DISCLOSE');
        expect(seed).toMatchObject({ placement: { kind: 'exactTarget', serverId: workspace.serverId, machineId: workspace.machineId, directory: workspace.rootPath },
            origin: { workspace, accountId: scope.accountId, comparisonId: comparison.id, page: 'changes' } });
    });

    it('refuses retired scopes before any draft or navigation, and refuses mismatched comparison or absent stop evidence', () => {
        const seed = buildWorkspaceScmAuthoringSeed({ workspace, accountId: scope.accountId, comparison, result });
        const navigate = vi.fn();
        expect(seedAndOpenNewSession({ seed, scope, isCurrent: () => false,
            createDraftId: () => 'stale-draft', navigateToNewSession: navigate })).toMatchObject({ kind: 'stale' });
        expect(readNewSessionDraftFromRepository({ scope, draftId: 'stale-draft' })).toBeNull();
        expect(navigate).not.toHaveBeenCalled();
        expect(buildWorkspaceScmAuthoringSeed({ workspace, accountId: scope.accountId, comparison, result: null, stopId: 'stop-one' })).toBeNull();
        expect(buildWorkspaceScmAuthoringSeed({ workspace, accountId: scope.accountId, comparison: { ...comparison, id: 'different' }, result })).toBeNull();
        expect(buildWorkspaceScmAuthoringSeed({ workspace: { ...workspace, rootPath: '/other' }, accountId: scope.accountId, comparison, result })).toBeNull();
    });
});

describe('captured workspace SCM authoring Action admission', () => {
    let serverId: string;
    beforeEach(async () => {
        await homes.reset(); await loadSyncSingletonForTests();
        serverId = await homes.addHome({ name: 'Review Home', serverUrl: 'https://review-authoring.test', accountId: 'account-a' });
        const ref = { id: workspace.workspaceId, serverId, machineId: workspace.machineId, rootPath: workspace.rootPath, createdAtMs: 1 };
        const key = { kind: 'workspace-ref', serverId, id: ref.id };
        homes.answer(serverId, 'POST /v1/account/project-rows/list', { body: { status: 'listed', coverage: 'complete',
            rows: [{ key, revision: 0, content: { t: 'plain', v: { key, value: ref } } }] } });
        const { restoreConnectionToActiveServer } = await import('@/sync/runtime/orchestration/connectionManager');
        await restoreConnectionToActiveServer({ token: homes.findByServerUrl('https://review-authoring.test')!.token! });
        applyProjectAccountRowsFixture(storage, { workspaceRefs: [ref] });
        navigate.mockClear();
    });
    afterEach(async () => {
        await standardCleanup();
        const { disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
        await disconnectActiveServerConnection(); await homes.reset();
    });
    const open = (serverId: string) => openWorkspaceScmAuthoringDraft({
        scope: { serverId, machineId: workspace.machineId, rootPath: workspace.rootPath },
        comparison, result, isCurrent: () => true,
    });
    it('disabled authoring leaves captured Review drafts and navigation untouched', async () => {
        const accountScope = { serverId, accountId: 'account-a' };
        const settings = { ...storage.getState().settings, actionsSettingsV1: ActionsSettingsV1Schema.parse({
            v: 1, actions: { 'session.authoring.open': { disabledSurfaces: ['ui'] } },
        }) };
        storage.getState().applySettingsForScope(accountScope, settings, 1);
        homes.answer(serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: settings }, version: 1 } });
        const { listNewSessionDraftProjections } = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
        const before = listNewSessionDraftProjections(accountScope);
        expect(await open(serverId)).toMatchObject({ kind: 'unavailable' });
        expect(listNewSessionDraftProjections(accountScope)).toEqual(before);
        expect(navigate).not.toHaveBeenCalled();
        expect(storage.getState().sessions).toEqual({});
    });
    it('Ask retains the exact captured Review seed until rejection or approval', async () => {
        await homes.requireUiApproval(serverId, 'session.authoring.open');
        const accountScope = { serverId, accountId: 'account-a' };
        const { listNewSessionDraftProjections } = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
        const before = listNewSessionDraftProjections(accountScope);
        const pending = await open(serverId);
        expect(pending).toMatchObject({ kind: 'approval_request_created', artifactId: expect.any(String) });
        expect(listNewSessionDraftProjections(accountScope)).toEqual(before);
        expect(navigate).not.toHaveBeenCalled();
        if (!('artifactId' in pending) || typeof pending.artifactId !== 'string') throw new Error('Expected canonical approval receipt');
        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
        const executor = createDefaultActionExecutor();
        expect(await executor.execute('approval.request.decide', { artifactId: pending.artifactId, decision: 'reject' }, { surface: 'ui', serverId }))
            .toMatchObject({ ok: true, result: { status: 'rejected' } });
        expect(listNewSessionDraftProjections(accountScope)).toEqual(before);
        const accepted = await open(serverId);
        if (!('artifactId' in accepted) || typeof accepted.artifactId !== 'string') throw new Error('Expected fresh exact approval receipt');
        expect(await executor.execute('approval.request.decide', { artifactId: accepted.artifactId, decision: 'approve' }, { surface: 'ui', serverId }))
            .toMatchObject({ ok: true, result: { status: 'executed' } });
        const drafts = listNewSessionDraftProjections(accountScope);
        expect(drafts).toHaveLength(before.length + 1);
        const created = drafts.find(item => !before.some(previous => previous.draftId === item.draftId));
        const draft = created ? readNewSessionDraftFromRepository({ scope: accountScope, draftId: created.draftId }) : null;
        expect(draft).toMatchObject({ selectedMachineId: workspace.machineId, selectedPath: '/repo', authoringOrigin: {
            workspace: { ...workspace, serverId }, accountId: 'account-a', page: 'changes', comparisonId: comparison.id,
        } });
        expect(draft?.input).toContain('before-oid');
        expect(draft?.input).not.toContain('DO_NOT_DISCLOSE');
        expect(navigate).toHaveBeenCalledTimes(1);
        expect(storage.getState().sessions).toEqual({});
    });
});
