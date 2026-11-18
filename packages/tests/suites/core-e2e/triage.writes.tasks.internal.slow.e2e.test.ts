import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  InternalTaskListOutputSchema,
  InternalTaskMutationOutputSchema,
  InternalTaskReadOutputSchema,
} from '@happier-dev/protocol/actions/internalTaskActions';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { connectUiTriageActionClient } from '@happier-tests/ui-action-client';

import { createTestAuth, type TestAuth } from '../../src/testkit/auth';
import { repoRootDir } from '../../src/testkit/paths';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createRunDirs } from '../../src/testkit/runDir';
import { seedCliAuthForTestAccount } from '../../src/testkit/cliAuth';
import { startTestDaemon } from '../../src/testkit/daemon/daemon';
import { waitFor } from '../../src/testkit/timing';

// QB: QB-60, QB-36 / U: U-TASKS-T4, U-TASKS-T5, U-TASKS-T8, U-TASKS-T9
const run = createRunDirs({ runLabel: 'triage-writes-tasks-internal' });

describe('Triage writes: internal Tasks through the Account Action boundary', () => {
  let server: StartedServer;
  let owner: TestAuth;
  let daemon: Awaited<ReturnType<typeof startTestDaemon>> | undefined;
  let daemonParams: Parameters<typeof startTestDaemon>[0];
  let client: Awaited<ReturnType<typeof connectUiTriageActionClient>> | undefined;

  beforeAll(async () => {
    const testDir = run.testDir('internal-tasks');
    const sourceOptions = [process.env.NODE_OPTIONS, '--import', pathToFileURL(join(repoRootDir(),
      'packages/cli-common/registerSourceRuntime.mjs')).href].filter(Boolean).join(' ');
    server = await startServerLight({
      testDir,
      extraEnv: {
        NODE_OPTIONS: sourceOptions,
        HAPPIER_E2E_PROVIDER_USE_SERVER_SOURCE_ENTRYPOINT: '1',
        HAPPIER_E2E_PROVIDER_SKIP_SERVER_SHARED_DEPS_BUILD: '1',
      },
    });
    owner = await createTestAuth(server.baseUrl);
    const cliHome = join(testDir, 'daemon-home');
    await seedCliAuthForTestAccount({ cliHome, serverUrl: server.baseUrl, auth: owner, mode: 'dataKey' });
    daemonParams = {
      testDir,
      happyHomeDir: cliHome,
      requireMachineControlReady: true,
      env: {
        ...process.env,
        NODE_OPTIONS: sourceOptions,
        HAPPIER_HOME_DIR: cliHome,
        HAPPIER_SERVER_URL: server.baseUrl,
        HAPPIER_WEBAPP_URL: server.baseUrl,
        HAPPIER_DISABLE_CAFFEINATE: '1',
        HAPPIER_VARIANT: 'dev',
        HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
        HAPPIER_E2E_PROVIDER_SKIP_CLI_SHARED_DEPS_BUILD: '1',
      },
    };
  });

  beforeAll(async () => {
    daemon = await startTestDaemon(daemonParams);
  });

  beforeEach(async () => {
    client = await connectUiTriageActionClient({ serverUrl: server.baseUrl, accountSecret: owner.accountSigningSeed });
    await waitFor(() => client!.isAccountReady(), { context: 'internal Tasks Account readiness' });
  });

  afterEach(async () => {
    await client?.close();
    client = undefined;
  });

  afterAll(async () => {
    const failures: unknown[] = [];
    for (const close of [() => client?.close(), () => daemon?.stop(), () => server?.stop()]) {
      try { await close(); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, 'Internal Tasks journey cleanup failed');
  });

  function actionContext() {
    if (!client) throw new Error('Triage Action client unavailable');
    return {
      surface: 'ui' as const,
      authority: 'present_user' as const,
      actionCaller: { kind: 'host' as const },
      serverId: client.serverId,
    };
  }

  async function invoke(actionId: string, input: unknown) {
    if (!client) throw new Error('Triage Action client unavailable');
    const result = await client.executeConfirmed(actionId, input, actionContext());
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error(`Action ${actionId} refused (${result.errorCode})`);
    return result.result;
  }

  it('creates, edits, transitions, reads and lists one real Account Task', async () => {
    const title = `Internal Task ${randomUUID()}`;
    const notes = `Task notes ${randomUUID()}`;
    const created = InternalTaskMutationOutputSchema.parse(await invoke('tasks.internal.create', {
      fields: { title, notes },
    }));
    expect(created.status).toBe('applied');
    if (created.status !== 'applied') throw new Error('Task creation was not applied');

    const editedTitle = `${title} edited`;
    const edited = InternalTaskMutationOutputSchema.parse(await invoke('tasks.internal.edit', {
      scope: created.scope,
      taskId: created.todo.id,
      fields: { title: editedTitle, notes: `${notes} edited` },
    }));
    expect(edited).toMatchObject({ status: 'applied', todo: { id: created.todo.id, title: editedTitle } });

    const transitioned = InternalTaskMutationOutputSchema.parse(await invoke('tasks.internal.transition', {
      scope: created.scope,
      taskId: created.todo.id,
      state: 'completed',
    }));
    expect(transitioned).toMatchObject({ status: 'applied', todo: { id: created.todo.id, state: 'completed' } });

    const read = InternalTaskReadOutputSchema.parse(await invoke('tasks.internal.read', {
      taskId: created.todo.id,
      ownerAccountId: created.scope.accountId,
    }));
    expect(read).toMatchObject({ status: 'applied', todo: { id: created.todo.id, title: editedTitle, state: 'completed' } });

    const list = InternalTaskListOutputSchema.parse(await invoke('tasks.internal.list', {}));
    expect(list).toMatchObject({ status: 'ok', scope: created.scope });
    if (list.status !== 'ok') throw new Error('Task list was not available');
    expect(list.todos.some(todo => todo.id === created.todo.id && todo.state === 'completed')).toBe(true);
    expect(list.completedOrder).toContain(created.todo.id);
  });

});
