import { randomUUID } from 'node:crypto';
import { readAccountIdFromToken } from '../../../../apps/cli/src/cloud/decodeJwtPayload';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { ExecutionRunGetResponseSchema, ExecutionRunListResponseSchema, ScmDiffSummaryGenerateOutputSchema, ScmDiffSummaryResultResponseSchema } from '@happier-dev/protocol';
import { connectUiPersonActionClient } from '@happier-tests/ui-action-client';
import { fakeClaudeFixturePath, waitForFakeClaudeInvocation } from '../../src/testkit/fakeClaude';
import { readFakeCodexAppServerRequestLog, writeFakeCodexAppServerScript } from '../../src/testkit/codexAppServerRemoteHarness';
import { startDatabaseWorkbenchPostgres } from '../../src/testkit/process/databaseWorkbenchPostgres';
import { createRunDirs } from '../../src/testkit/runDir';
import { startProjectDaemonFixture, type ProjectDaemonFixture } from '../../src/testkit/daemon/projectDaemon';
import { execGit, initGitRepo } from '../../src/testkit/uiE2e/gitRepoFixtures';
import { waitFor } from '../../src/testkit/timing';

const run = createRunDirs({ runLabel: 'core' });

// MATRIX-1110 row 38. UI person -> Home/PostgreSQL -> daemon -> native
// vendor process -> retained saved result. Vendor tenants and visual review
// remain manual; these local vendor boundaries make the task deterministic.
it.each(['claude', 'codex'] as const)('generates comparison outputs with explicit low effort through %s', async agentId => {
  const testDir = run.testDir(`comparison-effort-${agentId}-${randomUUID()}`);
  const workspace = join(testDir, 'workspace');
  await mkdir(workspace, { recursive: true });
  await initGitRepo({ repoDir: workspace });
  await writeFile(join(workspace, 'change.txt'), 'Before\n');
  execGit(workspace, ['add', 'change.txt']);
  execGit(workspace, ['commit', '-m', 'test: comparison baseline']);
  await writeFile(join(workspace, 'change.txt'), 'Captured change\n');
  const codexLog = join(testDir, 'codex.jsonl');
  const claudeLog = join(testDir, 'claude.jsonl');
  const codex = await writeFakeCodexAppServerScript({ dir: testDir, requestLogPath: codexLog,
    assistantReply: JSON.stringify({ summaryMarkdown: 'Captured change explained.',
      walkthrough: { title: 'Captured change', intro: '', stops: [{ id: 'change', title: 'Change',
        explanationMarkdown: 'The captured change.', changeRefs: ['c1'] }], otherChangeRefs: [] },
      commitPlan: { groups: [{ id: 'change', message: 'fix: captured change', rationale: '', changeRefs: ['c1'] }], leftOutChangeRefs: [] } }) });
  const postgres = await startDatabaseWorkbenchPostgres({ preloadStatistics: false });
  let fixture: ProjectDaemonFixture | undefined;
  let ui: Awaited<ReturnType<typeof connectUiPersonActionClient>> | undefined;
  let journeyFailure: unknown;
  try {
    fixture = await startProjectDaemonFixture({ testDir, serverEnv: { ...process.env, DATABASE_URL: postgres.homeDatabaseUrl } });
    const account = await fixture.createAccount('comparison-owner');
    const machine = await fixture.enrollDaemon(account, { env: {
      ...process.env,
      HAPPIER_CLAUDE_PATH: fakeClaudeFixturePath(), HAPPIER_E2E_FAKE_CLAUDE_LOG: claudeLog,
      HAPPIER_E2E_FAKE_CLAUDE_SCENARIO: 'scm-summary-json', ANTHROPIC_API_KEY: 'synthetic-comparison-key',
      HAPPIER_CODEX_APP_SERVER_BIN: codex, HAPPIER_CODEX_EXECUTION_RUN_TRANSPORT: 'appServer',
    } });
    ui = await connectUiPersonActionClient({ serverUrl: fixture.server.baseUrl, accountSecret: account.auth.accountSigningSeed });
    await waitFor(() => ui!.isAccountReady() && ui!.isMachineActive(machine.target.machineId), { timeoutMs: 60_000 });
    const context = { surface: 'ui' as const, authority: 'present_user' as const, serverId: ui.serverId,
      actionCaller: { kind: 'host' as const }, externalActionTarget: { kind: 'machine' as const,
        machineId: machine.target.machineId, project: { machineId: machine.target.machineId, directory: workspace } } };
    const started = await ui.execute('scm.diffSummary.generate', { cwd: workspace, source: { kind: 'workingTree' },
      modelSelector: { backendTargetKey: `backend:${agentId}`, modelId: agentId === 'codex' ? 'gpt-5.4' : 'claude-sonnet-4-5',
        sessionConfigOptionOverrides: { v: 1, updatedAt: 1, overrides: { reasoning_effort: { updatedAt: 1, value: 'low' } } } },
      outputs: ['summary', 'walkthrough', 'commitPlan'], cachePolicy: { mode: 'bypass' } }, context);
    expect(started, JSON.stringify(started)).toMatchObject({ ok: true });
    if (!started.ok) throw new Error('Comparison Action refused');
    const generated = ScmDiffSummaryGenerateOutputSchema.parse(started.result);
    expect(generated, JSON.stringify(generated)).toMatchObject({ success: true, runId: expect.any(String), resultId: expect.any(String) });
    const scope = { cwd: workspace, resultId: generated.resultId };
    const waited = await ui.execute('execution.run.get', { runId: generated.runId, includeStructured: true,
      waitForOutput: { kind: 'scm_diff_summary', comparisonId: generated.comparison?.id,
        resultId: generated.resultId, output: 'summary', afterRevision: 0 } }, context);
    expect(waited, JSON.stringify(waited)).toMatchObject({ ok: true });
    await waitFor(async () => {
      const read = await ui!.execute('scm.diffSummary.result.read', scope, context);
      if (!read.ok) throw new Error(JSON.stringify(read));
      const saved = ScmDiffSummaryResultResponseSchema.parse(read.result);
      if (!saved.success) throw new Error(JSON.stringify(saved));
      const outputs = saved.result.output.outputs;
      for (const kind of ['summary', 'walkthrough', 'commitPlan'] as const) {
        if (outputs?.[kind]?.state === 'failed') throw new Error(JSON.stringify(saved.result.output));
      }
      if (!outputs || Object.values(outputs).some(output => output.state !== 'complete')) return false;
      expect(outputs.summary?.value?.summaryMarkdown).toBe('Captured change explained.');
      expect(saved.result.output.analysis?.remainingChangeRefs).toEqual([]);
      return true;
    }, { timeoutMs: 120_000, failFast: true, context: 'all requested comparison outputs saved' });
    if (agentId === 'claude') {
      const invocation = await waitForFakeClaudeInvocation(claudeLog, row => row.mode === 'sdk');
      expect(invocation.argv).toEqual(expect.arrayContaining(['--effort', 'low']));
    } else {
      const requests = await readFakeCodexAppServerRequestLog(codexLog);
      expect(requests.find(request => request.method === 'turn/start')?.params).toMatchObject({ effort: 'low' });
      // MATRIX-1110 row 91: B has actual Manage access to this same Machine,
      // so an empty Run store proves requester scoping rather than Machine denial.
      const other = await fixture.createAccount('comparison-observer');
      expect(await ui.executeConfirmed('machines.access.grant.set', { ...machine.target,
        principal: { kind: 'account', accountId: readAccountIdFromToken(other.credentials.token) }, level: 'admin' }, context))
        .toMatchObject({ ok: true });
      const owned = await ui.execute('execution.run.get', { runId: generated.runId }, context);
      expect(owned, JSON.stringify(owned)).toMatchObject({ ok: true });
      if (!owned.ok) throw new Error('Owner Run is unavailable before foreign probes');
      const ownedRun = ExecutionRunGetResponseSchema.parse(owned.result).run;
      await ui.close();
      ui = await connectUiPersonActionClient({ serverUrl: fixture.server.baseUrl,
        accountSecret: other.auth.accountSigningSeed });
      await waitFor(() => ui!.isAccountReady() && ui!.isMachineActive(machine.target.machineId), { timeoutMs: 60_000 });
      const otherContext = { ...context, serverId: ui.serverId };
      expect(await ui.execute('machines.list', { serverId: ui.serverId }, otherContext))
        .toMatchObject({ ok: true, result: { items: expect.arrayContaining([
          expect.objectContaining({ machineId: machine.target.machineId }),
        ]) } });
      expect(await ui.execute('execution.run.get', { runId: generated.runId }, otherContext))
        .toMatchObject({ ok: false, errorCode: 'execution_run_not_found' });
      const foreignList = await ui.execute('execution.run.list', {}, otherContext);
      expect(foreignList, JSON.stringify(foreignList)).toMatchObject({ ok: true });
      if (!foreignList.ok) throw new Error('Foreign Account Run list was not serviceable');
      expect(ExecutionRunListResponseSchema.parse(foreignList.result).runs).toEqual([]);
      await ui.close();
      ui = await connectUiPersonActionClient({ serverUrl: fixture.server.baseUrl,
        accountSecret: account.auth.accountSigningSeed });
      await waitFor(() => ui!.isAccountReady() && ui!.isMachineActive(machine.target.machineId), { timeoutMs: 60_000 });
      const reread = await ui.execute('execution.run.get', { runId: generated.runId }, { ...context, serverId: ui.serverId });
      expect(reread, JSON.stringify(reread)).toMatchObject({ ok: true });
      if (!reread.ok) throw new Error('Foreign probes displaced the owner Run');
      expect(ExecutionRunGetResponseSchema.parse(reread.result).run)
        .toMatchObject({ runId: ownedRun.runId, status: ownedRun.status });

    }
  } catch (error) {
    journeyFailure = error;
    throw error;
  } finally {
    const failures: unknown[] = [];
    for (const cleanup of [() => ui?.close(), () => fixture?.stop(), () => postgres.stop()]) {
      try { await cleanup(); } catch (error) { failures.push(error); }
    }
    if (failures.length) {
      const errors = [...(journeyFailure ? [journeyFailure] : []), ...failures];
      const messages = errors.flatMap(error => error instanceof AggregateError ? error.errors : [error])
        .map(error => error instanceof Error ? error.message : String(error));
      throw new AggregateError(errors, `Comparison journey/cleanup failed: ${messages.join('; ')}`);
    }
  }
}, 600_000);
