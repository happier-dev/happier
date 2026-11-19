import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { formatQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';

import {
  TRIAGE_ADMINISTER_ACTION_ACTION_LOCAL_ID_V1,
  TRIAGE_READ_ACTIONS_ACTION_LOCAL_ID_V1,
  TriageAdministerActionResultV1Schema,
  TriageReadActionsResultV1Schema,
} from '../../../plugins/triage/src/actions/actionsCatalogProtocol';
import { createRunDirs } from '../../src/testkit/runDir';
import { repoRootDir } from '../../src/testkit/paths';
import { createTestAuth } from '../../src/testkit/auth';
import { seedCliAuthForTestAccount } from '../../src/testkit/cliAuth';
import { startServerLight } from '../../src/testkit/process/serverLight';
import { startTestDaemon } from '../../src/testkit/daemon/daemon';
import { runCliJson } from '../../src/testkit/uiE2e/cliJson';

const run = createRunDirs({ runLabel: 'triage-runtime' });

describe('Triage runtime: configured Actions survive cold reads', () => {
  let server: Awaited<ReturnType<typeof startServerLight>> | undefined;
  let daemon: Awaited<ReturnType<typeof startTestDaemon>> | undefined;
  let daemonParams: Parameters<typeof startTestDaemon>[0];
  let machineId: string;
  let serverId: string;

  beforeAll(async () => {
    const testDir = run.testDir(`configuration-${randomUUID()}`);
    const sourceOptions = [process.env.NODE_OPTIONS, '--import', pathToFileURL(join(repoRootDir(),
      'packages/cli-common/registerSourceRuntime.mjs')).href].filter(Boolean).join(' ');
    server = await startServerLight({ testDir, extraEnv: {
      NODE_OPTIONS: sourceOptions,
      HAPPIER_E2E_PROVIDER_USE_SERVER_SOURCE_ENTRYPOINT: '1',
      HAPPIER_E2E_PROVIDER_SKIP_SERVER_SHARED_DEPS_BUILD: '1',
    } });
    const auth = await createTestAuth(server.baseUrl);
    const homeDir = join(testDir, 'daemon-home');
    await mkdir(homeDir, { recursive: true });
    const seeded = await seedCliAuthForTestAccount({ cliHome: homeDir, serverUrl: server.baseUrl, auth, mode: 'dataKey' });
    machineId = seeded.machineId;
    serverId = seeded.serverId;
    daemonParams = { testDir, happyHomeDir: homeDir, requireMachineControlReady: true, env: {
      ...process.env, NODE_OPTIONS: sourceOptions, CI: '1', HAPPIER_VARIANT: 'dev',
      HAPPIER_HOME_DIR: homeDir, HAPPIER_SERVER_URL: server.baseUrl, HAPPIER_WEBAPP_URL: server.baseUrl,
      HAPPIER_DISABLE_CAFFEINATE: '1', HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
      HAPPIER_E2E_PROVIDER_SKIP_CLI_SHARED_DEPS_BUILD: '1',
    } };
  });

  beforeAll(async () => {
    daemon = await startTestDaemon(daemonParams);
  });

  afterAll(async () => {
    const failures: unknown[] = [];
    for (const close of [() => daemon?.stop(), () => server?.stop()]) {
      try { await close(); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, 'Triage runtime cleanup failed');
  });

  async function invoke(localId: string, input: unknown, confirmed = false) {
    if (!server) throw new Error('Triage runtime server not started');
    const result = await runCliJson({
      testDir: daemonParams.testDir, cliHomeDir: daemonParams.happyHomeDir,
      serverUrl: server.baseUrl, webappUrl: server.baseUrl, env: { ...daemonParams.env },
      label: `configuration-${randomUUID()}`,
      args: ['actions', 'invoke', formatQualifiedPluginActionId({ pluginId: 'happier.triage', localId }),
        '--input-json', JSON.stringify(input), '--server-id', serverId, '--machine-id', machineId,
        '--json', ...(confirmed ? ['--yes'] : [])],
      launchOptions: { preferSourceEntrypoint: true, skipSourceFreshnessCheck: true, skipSharedDepsBuild: true },
    });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    if (!result.ok) throw new Error(`Triage Action ${localId} refused (${JSON.stringify(result.error)})`);
    return result.data;
  }

  const read = async () => TriageReadActionsResultV1Schema.parse(await invoke(TRIAGE_READ_ACTIONS_ACTION_LOCAL_ID_V1, { v: 1 }));
  const write = async (input: unknown) => TriageAdministerActionResultV1Schema.parse(await invoke(
    TRIAGE_ADMINISTER_ACTION_ACTION_LOCAL_ID_V1, input, true));

  it('saves an edited Action and reads its exact configuration after restarting its runtime', async () => {
    const before = await read();
    const label = `Cold configuration ${randomUUID()}`;
    const draft = { label, enabled: true, appliesTo: ['deploymentEnvironment'], profileId: null,
      workspaceMode: 'repository', target: { kind: 'agent', promptInvocationId: null, delivery: 'compose' } };
    const saved = await write({ v: 1, kind: 'create', expectedRevision: before.revision, ...draft });
    expect(saved.status).toBe('applied');
    const created = saved.actions?.find(action => action.label === label);
    expect(created).toBeDefined();
    if (!created) throw new Error('Saved Action missing from authoritative result');
    const edited = { ...draft, label: `${label} updated`, enabled: false,
      target: { kind: 'agent', promptInvocationId: null, delivery: 'compose' } };
    expect(await write({ v: 1, kind: 'update', actionId: created.actionId,
      expectedRevision: saved.revision, ...edited })).toMatchObject({ status: 'applied' });
    await daemon?.stop();
    daemon = await startTestDaemon(daemonParams);
    const cold = await read();
    expect(cold.availability).toBe('parsed');
    expect(cold.actions.find(action => action.actionId === created.actionId)).toMatchObject(edited);
  });
});
