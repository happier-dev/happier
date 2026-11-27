import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { expect, it } from 'vitest';

import { createActionExecuteFailureError } from '@happier-dev/protocol/actions/actionExecutionResult';
import { SESSION_PERMISSION_MODE_SET_ACTION_ID_V1 } from '@happier-dev/protocol/actions/actionIds';
import { InternalTaskMutationOutputSchema } from '@happier-dev/protocol/actions/internalTaskActions';
import { CONNECTED_SERVICE_CONFIGURATION_ACTION_OUTPUT_SCHEMAS_V1 as connectOutput } from '@happier-dev/protocol/connect/configurationActionsV1';
import { SCM_HOSTING_CONNECTED_ACCOUNT_PURPOSE_ID } from '@happier-dev/protocol/plugins/contributions/scmHostingProviders';
import { connectUiTriageActionClient } from '@happier-tests/ui-action-client';
import githubPackage from '../../../plugins/scm-github/package.json';
import { activate as activateGithub } from '../../../plugins/scm-github/src/accountRuntime';
import { GITHUB_SCM_HOSTING_PROVIDER_LOCAL_ID } from '../../../plugins/scm-github/src/adapter';
import { GITHUB_TOKEN_CREDENTIAL_KEY } from '../../../plugins/scm-github/src/auth/tokenKinds';
import { PLUGIN_MANIFEST as GITHUB_MANIFEST } from '../../../plugins/scm-github/src/manifest';
import { GITHUB_CONNECTED_ACCOUNT_SERVICE, GITHUB_PLUGIN_ID } from '../../../plugins/scm-github/src/observations/githubProviderContracts';
import { createIsolatedFakeClaudeControlShim } from '../../src/testkit/fakeClaude';
import { startDatabaseWorkbenchPostgres } from '../../src/testkit/process/databaseWorkbenchPostgres';
import { startConnectedAccountTlsRecordingProxy, writeConnectedAccountTlsProxyPreload } from '../../src/testkit/providers/connectedAccountTlsRecordingProxy';
import { createRunDirs } from '../../src/testkit/runDir';
import { startTeamSetupFFixture } from '../../src/testkit/teamSetupF';
import { waitFor } from '../../src/testkit/timing';
import { execGit, initGitRepo } from '../../src/testkit/uiE2e/gitRepoFixtures';

it('leaves a claimed incident in review at PR open and completes only at the exact authenticated merge', async () => {
  const testDir = createRunDirs({ runLabel: 'work-loop-factory-and-incident' }).testDir('pull-request-handoff');
  const repository = 'work-loop-fixture/incident';
  const branch = 'incident-fix';
  const prRef = { url: `https://github.com/${repository}/pull/7` };
  const pullPath = `/repos/${repository}/pulls/7`;
  const token = `github_pat_TEST_ONLY_WORK_LOOP_${randomUUID()}`;
  const fingerprint = `sha256:${createHash('sha256').update(token).digest('hex')}`;
  const mergeCommitSha = 'c'.repeat(40);
  let merged = false;
  const proxy = await startConnectedAccountTlsRecordingProxy({ additionalDnsNames: ['api.github.com'],
    responseForRequest(request) {
      if (request.authorizationFingerprint !== fingerprint) return { statusCode: 401, body: { message: 'Connected Account required' } };
      if (request.method === 'GET' && request.path === '/user') {
        return { statusCode: 200, body: { id: 1116, login: 'work-loop-fixture' }, headers: { 'x-oauth-scopes': 'repo' } };
      }
      if (request.method === 'GET' && request.path === pullPath) return { statusCode: 200,
        body: { number: 7, title: 'Fix incident', html_url: prRef.url, base: { ref: 'main' }, head: { ref: branch },
          state: merged ? 'closed' : 'open', merged, merge_commit_sha: mergeCommitSha } };
      return { statusCode: 404, body: { message: 'Unexpected GitHub fixture request' } };
    },
  });
  const undici: typeof import('undici') = createRequire(new URL('../../../../apps/cli/package.json', import.meta.url))('undici/index.js');
  const dispatcher = new undici.ProxyAgent({ uri: proxy.url, requestTls: { ca: await readFile(proxy.caCertPath) } });
  const originalFetch = globalThis.fetch;
  const originalUndiciFetch = undici.fetch;
  const isProvider = (input: unknown) => new URL(typeof input === 'object' && input !== null && 'url' in input
    ? String(input.url) : String(input)).hostname === 'api.github.com';
  globalThis.fetch = (input, init) => originalFetch(input, isProvider(input)
    ? ({ ...init, dispatcher } satisfies RequestInit & { dispatcher: typeof dispatcher }) : init);
  undici.fetch = (input, init) => originalUndiciFetch(input, isProvider(input) ? { ...init, dispatcher } : init);
  let home: Awaited<ReturnType<typeof startTeamSetupFFixture>> | undefined;
  let database: Awaited<ReturnType<typeof startDatabaseWorkbenchPostgres>> | undefined;
  let client: Awaited<ReturnType<typeof connectUiTriageActionClient>> | undefined;
  try {
    database = await startDatabaseWorkbenchPostgres({ preloadStatistics: false });
    home = await startTeamSetupFFixture({ testDir, dbProvider: 'postgres',
      daemonAuthentication: 'existing-terminal', personActionSurface: 'coreAction',
      serverEnv: { DATABASE_URL: database.homeDatabaseUrl } });
    const account = await home.createAccount('incident-worker');
    const repoDir = join(testDir, 'repository');
    await initGitRepo({ repoDir });
    await writeFile(join(repoDir, 'README.md'), 'Incident fixture\n');
    execGit(repoDir, ['add', 'README.md']);
    execGit(repoDir, ['commit', '-m', 'Create incident fixture']);
    execGit(repoDir, ['remote', 'add', 'origin', `https://github.com/${repository}.git`]);
    const native = await createIsolatedFakeClaudeControlShim({ testDir: join(testDir, 'native'),
      captureEnvironmentKeys: [], logFullStdin: false });
    const preload = await writeConnectedAccountTlsProxyPreload(testDir, proxy, ['api.github.com']);
    const machine = await home.enrollDaemon(account, { workspaceDir: repoDir,
      env: { HAPPIER_CLAUDE_PATH: native.executablePath, NODE_OPTIONS: `${home.sourceOptions} --import ${preload}`,
        GH_TOKEN: '', GITHUB_TOKEN: '', GH_ENTERPRISE_TOKEN: '', GITHUB_ENTERPRISE_TOKEN: '' },
    });
    const clientRuntime = await connectUiTriageActionClient({ ...home.personActionConnection,
      accountSecret: account.auth.accountSigningSeed, withAccountLifecycle: true,
      additionalPlugins: [{ packageName: githubPackage.name, manifest: GITHUB_MANIFEST, activate: activateGithub }],
    });
    client = clientRuntime;
    await waitFor(clientRuntime.isAccountReady, { context: 'Incident Account readiness' });
    const serverId = home.serverId;
    const person = async (actionId: Parameters<typeof account.executeAsPerson>[0], input: unknown) => {
      const result = await clientRuntime.executeConfirmed(actionId, input, { surface: 'ui', authority: 'present_user',
        actionCaller: { kind: 'host' }, serverId: clientRuntime.serverId, serverIdentityId: serverId, actionRequestId: randomUUID() });
      if (!result.ok) throw createActionExecuteFailureError(result);
      return result.result;
    };
    const begun = connectOutput['connectedServices.authentication.beginConnect'].parse(await person(
      'connectedServices.authentication.beginConnect', { service: GITHUB_CONNECTED_ACCOUNT_SERVICE, modeId: 'fine-grained-pat' }));
    if (begun.status !== 'awaitingManual') throw new Error(`GitHub Connect settled as ${begun.status}`);
    const connected = connectOutput['connectedServices.authentication.submitManual'].parse(await person(
      'connectedServices.authentication.submitManual', { attemptId: begun.attemptId, fields: { [GITHUB_TOKEN_CREDENTIAL_KEY]: token } }));
    if (connected.status !== 'connected') {
      const identityReads = proxy.entries().filter(request => request.path === '/user');
      throw new Error(`GitHub Connect settled as ${connected.status} after ${identityReads.length} fixture identity reads`);
    }
    expect(await person('connectedServices.purposes.default.set', {
      purpose: { consumer: { pluginId: GITHUB_PLUGIN_ID, localId: GITHUB_SCM_HOSTING_PROVIDER_LOCAL_ID },
        purpose: SCM_HOSTING_CONNECTED_ACCOUNT_PURPOSE_ID },
      target: { kind: 'account', account: connected.account },
    })).toMatchObject({ applied: true });
    for (const actionId of ['tasks.internal.transition', 'scm.pullRequest.get'] as const) {
      await person('actions.policy.set', { actionId, audience: 'agent', mode: 'allowed' });
    }
    const { sessionId } = await home.assertKnownGoodSessionControl(account, machine);
    expect(await person(SESSION_PERMISSION_MODE_SET_ACTION_ID_V1, {
      sessionId, permissionMode: 'default', applyTiming: 'immediate',
    })).toMatchObject({ ok: true });
    expect(await account.readSessionMetadata(sessionId)).toMatchObject({ permissionMode: 'default' });
    const created = InternalTaskMutationOutputSchema.parse(await person('tasks.internal.create', { fields: { title: 'Fix the incident' } }));
    if (created.status !== 'applied') throw new Error(`Task creation settled as ${created.status}`);
    const taskId = created.todo.id;
    const claimed = InternalTaskMutationOutputSchema.parse(await person('tasks.internal.transition', { taskId,
      expectedVersion: created.todo.version, state: 'started', claim: { kind: 'take', attemptBinding: { sessionId } } }));
    if (claimed.status !== 'applied') throw new Error(`Task Take settled as ${claimed.status}`);
    const handedOff = await home.executeSessionMcpAction(account, { sessionId, logPath: native.logPath }, 'tasks.internal.transition', {
      taskId, expectedVersion: claimed.todo.version, state: 'ready_for_review', claim: { kind: 'result', branch,
        finish: { kind: 'mark_completed_on_merge', sentryIssueId: 'fixture-issue', prRef } },
    });
    expect(handedOff, JSON.stringify(handedOff)).toMatchObject({ ok: true, result: { status: 'applied', todo: {
      state: 'ready_for_review', handoff: { sentryIssueId: 'fixture-issue', taskId, prRef, attempt: { sessionId } },
    } } });
    if (!handedOff.ok) throw createActionExecuteFailureError(handedOff);
    const review = InternalTaskMutationOutputSchema.parse(handedOff.result);
    if (review.status !== 'applied') throw new Error(`PR handoff settled as ${review.status}`);
    const settle = () => home!.executeSessionMcpAction(account, { sessionId, logPath: native.logPath }, 'tasks.internal.transition', {
      taskId, expectedVersion: review.todo.version, state: 'completed', claim: { kind: 'merge' },
    });
    expect(await settle()).toMatchObject({ ok: true, result: { status: 'refused', reason: 'task_pr_not_merged' } });
    merged = true;
    const completed = await settle();
    expect(completed, JSON.stringify(completed)).toMatchObject({ ok: true, result: { status: 'applied', todo: {
      state: 'completed', handoff: { taskId, mergeCommitSha },
    } } });
    expect(proxy.entries().filter(request => request.path === pullPath)
      .map(({ method, authorizationFingerprint }) => ({ method, authorizationFingerprint }))).toEqual(
      Array.from({ length: 3 }, () => ({ method: 'GET', authorizationFingerprint: fingerprint })),
    );
    expect(proxy.entries().filter(request => request.method === 'POST')).toHaveLength(0);
  } finally {
    try { await client?.close(); }
    finally {
      globalThis.fetch = originalFetch;
      undici.fetch = originalUndiciFetch;
      try { await home?.stop(); }
      finally { await Promise.all([database?.stop(), dispatcher.close(), proxy.stop()]); }
    }
  }
}, 360_000);
