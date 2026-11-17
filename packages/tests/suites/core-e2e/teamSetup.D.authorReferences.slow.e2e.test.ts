import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { ApprovalRequestPublicSettlementSchema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { ProjectSourcesReadOutputV1Schema } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { resolveProjectSourceOnboardingTaskV1 } from '@happier-dev/protocol/projects/sources/projectSourceOnboardingTaskV1';
import { PromptDocReadResultV1Schema } from '@happier-dev/protocol/prompts/library/promptDocV2';
import { OpenProjectResultV1Schema } from '@happier-dev/protocol/projects/openProjectV1';
import { TeamSummaryV1Schema } from '@happier-dev/protocol/teams/projections';
import { TEAM_SHARED_RESOURCES_SUMMARY_ACTION_ID_V1 } from '@happier-dev/protocol/teams/actionIdsV1';
import { TeamSharedResourcesSummaryV1Schema } from '@happier-dev/protocol/teams/teamShareableResourceKindV1';
import { readAccountIdFromToken } from '../../../../apps/cli/src/cloud/decodeJwtPayload';
import { startTeamSetupFFixture, type TeamSetupFFixture } from '../../src/testkit/teamSetupF';
import { repoRootDir } from '../../src/testkit/paths';
import { waitFor } from '../../src/testkit/timing';

describe('Team setup author references', () => {
  let fixture: TeamSetupFFixture | undefined;
  afterEach(async () => { await fixture?.stop(); fixture = undefined; });

  it('TS.D.authorReferences persists a task reference without granting prompt access and opens it as an editable task for the daemon workspace', async () => {
    const dbProvider = process.env.HAPPIER_E2E_DB_PROVIDER === 'sqlite' ? 'sqlite' : 'postgres';
    const databaseUrl = process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL;
    if (dbProvider === 'postgres' && !databaseUrl) throw new Error('TS.D.authorReferences requires the disposable PostgreSQL harness URL');
    const testDir = await mkdtemp(join(tmpdir(), 'team-setup-d-author-'));
    fixture = await startTeamSetupFFixture({ testDir,
      dbProvider, ...(dbProvider === 'postgres' ? { serverEnv: { DATABASE_URL: databaseUrl } } : {}) });
    const owner = await fixture.createAccount('author');
    const other = await fixture.createAccount('other');
    expect((await fixture.claimHomeOwner(owner)).result.status).toBe('claimed');
    async function invoke(account: typeof owner, actionId: ActionId, input: unknown) {
      let result = await account.execute(actionId, input);
      const approval = result.ok ? ActionApprovalRequestCreatedResultSchema.safeParse(result.result) : null;
      if (approval?.success) {
        expect((await account.executeAsPerson('approval.request.decide', { artifactId: approval.data.artifactId, decision: 'approve' })).ok).toBe(true);
        const read = await account.execute('approval.request.get', { artifactId: approval.data.artifactId });
        if (!read.ok) throw new Error(`Approval unavailable: ${read.errorCode}`);
        const projected = getActionSpec('approval.request.get').outputSchema?.parse(read.result);
        if (!projected || typeof projected !== 'object' || !('request' in projected)) throw new Error('Approval settlement missing');
        result = ApprovalRequestPublicSettlementSchema.parse(projected.request).execution;
      }
      return result;
    }
    const teamCreation = await invoke(owner, 'teams.create', { v: 1, name: 'D Authoring', requestKey: randomUUID(),
      initialOwnerAccountId: readAccountIdFromToken(owner.credentials.token) });
    if (!teamCreation.ok) throw new Error(`Team creation refused: ${teamCreation.errorCode}: ${teamCreation.error}`);
    const team = TeamSummaryV1Schema.parse(teamCreation.result);
    const membership = await invoke(owner, 'teams.members.add', { v: 1, teamId: team.id,
      accountId: readAccountIdFromToken(other.credentials.token), role: 'member', historyAccess: 'from_membership' });
    expect(membership.ok).toBe(true);
    const prompt = await invoke(owner, 'prompt_doc.create', { title: 'First task', markdown: 'Review the project and suggest the next change.' });
    expect(prompt.ok).toBe(true);
    if (!prompt.ok || typeof prompt.result !== 'object' || !prompt.result || !('artifactId' in prompt.result)
      || typeof prompt.result.artifactId !== 'string') throw new Error('Prompt creation missing identity');
    const ref = { kind: 'doc' as const, artifactId: prompt.result.artifactId };
    const created = await invoke(owner, 'projects.sources.create', { serverId: fixture.serverId, requestKey: randomUUID(), name: 'First project',
      owner: { kind: 'team', teamId: team.id } });
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error(`Source creation refused: ${created.errorCode}`);
    const row = ProjectSourcesReadOutputV1Schema.parse(created.result);
    if (!row.ok) throw new Error(`Source creation refused: ${row.error}`);
    // The canonical source loader runs the moving CLI and its workspace closure,
    // as in the existing composed B fixture; no release snapshot is prepared.
    const machine = await fixture.enrollDaemon(other, { cliLaunchSpec: { command: process.execPath,
      args: ['--import', resolve(repoRootDir(), 'packages/cli-common/registerSourceRuntime.mjs'),
        resolve(repoRootDir(), 'apps/cli/src/index.ts')], cwd: repoRootDir() } });
    const control = await invoke(other, 'projects.open', { ...machine.target,
      source: { kind: 'folder', path: machine.workspaceDir }, materialization: { kind: 'attach' } });
    if (!control.ok) throw new Error(`Control folder open refused: ${control.errorCode}`);
    const opened = OpenProjectResultV1Schema.parse(control.result);
    if (opened.kind !== 'opened') throw new Error(`Control folder did not open: ${JSON.stringify(opened)}`);
    expect(opened.directory).toBe(machine.workspaceDir);
    const summary = await invoke(other, TEAM_SHARED_RESOURCES_SUMMARY_ACTION_ID_V1, { v: 1, teamId: team.id });
    if (!summary.ok) throw new Error(`Shared resource summary refused: ${summary.errorCode}`);
    expect(TeamSharedResourcesSummaryV1Schema.parse(summary.result).kinds).toEqual(expect.arrayContaining([
      { kind: 'projectSources', status: 'available', count: 1 },
      { kind: 'sessions', status: 'available', count: 0 },
    ]));
    const update = { serverId: fixture.serverId, sourceId: row.source.id, expectedRevision: row.source.revision,
      patch: { attachment: { kind: 'attach', attachment: { purpose: 'onboarding_task', ref } } } };
    const attached = await invoke(owner, 'projects.sources.update', update);
    // RED before D3: the existing mutation union refuses this purpose.
    expect(attached.ok).toBe(true);
    if (!attached.ok) throw new Error(`Task attachment refused: ${attached.errorCode}`);
    const saved = ProjectSourcesReadOutputV1Schema.parse(attached.result);
    expect(saved).toMatchObject({ ok: true, source: { attachments: [{ purpose: 'onboarding_task', ref }] } });
    if (!saved.ok) throw new Error(`Task attachment refused: ${saved.error}`);
    const unchanged = await invoke(owner, 'projects.sources.update', { ...update, expectedRevision: saved.source.revision });
    if (!unchanged.ok) throw new Error(`Task reference replay refused: ${unchanged.errorCode}`);
    expect(ProjectSourcesReadOutputV1Schema.parse(unchanged.result)).toMatchObject({ ok: true, source: { revision: saved.source.revision } });
    const memberSource = await invoke(other, 'projects.sources.read', { serverId: fixture.serverId, sourceId: row.source.id });
    expect(memberSource.ok).toBe(true);
    if (!memberSource.ok) throw new Error(`Member Source unavailable: ${memberSource.errorCode}`);
    const readableSource = ProjectSourcesReadOutputV1Schema.parse(memberSource.result);
    if (!readableSource.ok) throw new Error(`Member Source unavailable: ${readableSource.error}`);
    const readSuggestedTask = () => resolveProjectSourceOnboardingTaskV1({
      sources: [{ serverId: fixture!.serverId, source: readableSource.source }],
      readPrompt: async ref => {
        const result = await invoke(other, 'prompt_doc.read', { artifactId: ref.artifactId });
        return result.ok ? PromptDocReadResultV1Schema.parse(result.result) : result;
      },
    });
    const ownRead = await invoke(owner, 'prompt_doc.read', { artifactId: ref.artifactId });
    expect(ownRead.ok).toBe(true);
    if (!ownRead.ok) throw new Error(`Task unavailable: ${ownRead.errorCode}`);
    const task = PromptDocReadResultV1Schema.parse(ownRead.result);
    const denied = await invoke(other, 'prompt_doc.read', { artifactId: ref.artifactId });
    expect(denied.ok).toBe(false);
    expect(JSON.stringify(denied)).not.toContain(task.markdown);
    expect(await readSuggestedTask()).toMatchObject({ task: null, unavailable: [{ sourceId: row.source.id, result: denied }] });
    const grant = await invoke(owner, 'artifact.access.grants.set', { artifactId: ref.artifactId,
      principal: { kind: 'team', teamId: team.id }, accessLevel: 'view' });
    if (!grant.ok) throw new Error(`Prompt sharing refused: ${grant.errorCode}`);
    // The existing Artifact read owns E2EE recipient-key preparation after sharing.
    expect((await invoke(owner, 'prompt_doc.read', { artifactId: ref.artifactId })).ok).toBe(true);
    const available = await invoke(other, 'prompt_doc.read', { artifactId: ref.artifactId });
    if (!available.ok) throw new Error(`Shared task unavailable: ${available.errorCode}`);
    const memberTask = PromptDocReadResultV1Schema.parse(available.result);
    const suggested = await readSuggestedTask();
    expect(suggested.unavailable).toEqual([]);
    expect(suggested.task).toMatchObject({ sourceId: row.source.id, title: memberTask.title, markdown: memberTask.markdown });
    if (!suggested.task) throw new Error('Readable suggested task was not selected');
    const { connectUiActionClient } = await import('@happier-tests/ui-action-client');
    const { getActiveServerAccountScope } = await import('../../../../apps/ui/sources/sync/domains/scope/activeServerAccountScope');
    const { createFrontDoorActionExecute } = await import('../../../../apps/ui/sources/sync/ops/actions/frontDoorRuntimeActionExecutor');
    const { readNewSessionDraftProjectionFromRepository } = await import('../../../../apps/ui/sources/components/sessions/composer/newSessionDraftRepositoryAdapter');
    const { createNewSessionComposerDocumentOwner } = await import('../../../../apps/ui/sources/components/sessions/composer/newSessionComposerDocumentOwner');
    const { prepareLocalSessionDraftScope } = await import('../../../../apps/ui/sources/sync/ops/sessionDrafts/sessionDraftRepository');
    const ui = await connectUiActionClient({ serverUrl: fixture.server.baseUrl, credentials: other.uiCredentials });
    try {
      await waitFor(() => ui.isAccountReady(), { timeoutMs: 60_000 });
      const scope = getActiveServerAccountScope();
      if (!scope) throw new Error('Member Account not ready');
      await prepareLocalSessionDraftScope(scope);
      let draftId: string | undefined;
      const execute = createFrontDoorActionExecute(undefined, { sessionAuthoringPresentation: {
        navigateToNewSession: input => { draftId = input.draftId; },
      } });
      const composed = await execute('session.authoring.open', { seed: { prompt: suggested.task.markdown,
        placement: { kind: 'exactTarget', serverId: ui.serverId, machineId: machine.target.machineId,
          directory: opened.directory } } }, { surface: 'ui', authority: 'present_user', serverId: ui.serverId,
        expectedAccountId: scope.accountId, actionCaller: { kind: 'host' } });
      expect(composed.ok).toBe(true);
      if (!draftId) throw new Error('Normal task composer was not opened');
      expect(readNewSessionDraftProjectionFromRepository({ scope, draftId })?.draft).toMatchObject({
        input: task.markdown, selectedMachineId: machine.target.machineId, selectedPath: opened.directory });
      const composer = createNewSessionComposerDocumentOwner({ scope, ref: { kind: 'newSession', draftId } });
      composer.apply(composer.read().revision, { text: 'My edited task', references: [], attachments: [] });
      expect(readNewSessionDraftProjectionFromRepository({ scope, draftId })?.draft.input).toBe('My edited task');
    } finally { await ui.close(); }
    const replacement = await invoke(owner, 'prompt_doc.create', { title: 'Next task', markdown: 'Inspect the project tests.' });
    if (!replacement.ok || typeof replacement.result !== 'object' || !replacement.result || !('artifactId' in replacement.result)
      || typeof replacement.result.artifactId !== 'string') throw new Error('Replacement prompt creation missing identity');
    const nextRef = { kind: 'doc' as const, artifactId: replacement.result.artifactId };
    const changed = await invoke(owner, 'projects.sources.update', { ...update, expectedRevision: saved.source.revision,
      patch: { attachment: { kind: 'attach', attachment: { purpose: 'onboarding_task', ref: nextRef } } } });
    if (!changed.ok) throw new Error(`Task replacement refused: ${changed.errorCode}`);
    const changedSource = ProjectSourcesReadOutputV1Schema.parse(changed.result);
    expect(changedSource).toMatchObject({ ok: true, source: { attachments: [{ purpose: 'onboarding_task', ref: nextRef }] } });
    if (!changedSource.ok) throw new Error(`Task replacement refused: ${changedSource.error}`);
    const detached = await invoke(owner, 'projects.sources.update', { ...update, expectedRevision: changedSource.source.revision,
      patch: { attachment: { kind: 'detach', purpose: 'onboarding_task', ref: nextRef } } });
    if (!detached.ok) throw new Error(`Task removal refused: ${detached.errorCode}`);
    expect(ProjectSourcesReadOutputV1Schema.parse(detached.result)).toMatchObject({ ok: true, source: { attachments: [] } });
  // Server, daemon and Action owners retain their lifecycle budgets.
  }, 0);
});
