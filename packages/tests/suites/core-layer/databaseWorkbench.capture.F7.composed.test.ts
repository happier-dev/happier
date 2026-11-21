import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { expect, it } from 'vitest';
import { DATABASE_CAPTURE_CONFIGURE_ACTION_ID_V1, DATABASE_CAPTURE_QUERIES_LIST_ACTION_ID_V1, DATABASE_CAPTURE_STATUS_ACTION_ID_V1, DATABASE_CAPTURE_RESOURCE_REF_V1, DatabaseCaptureConfigureResultV1Schema, DatabaseCaptureQueriesListResultV1Schema, DatabaseCaptureStatusResultV1Schema } from '@happier-dev/database-protocol';
import { databaseActionLocalIdV1 } from '@happier-dev/database-protocol';
import { LocalServiceLauncherSnapshotV1Schema,
  DaemonLocalServiceLauncherStartResponseV1Schema } from '@happier-dev/protocol/local/services/launcher/v1';
import { LocalServiceActionResultV1Schema } from '@happier-dev/protocol/local/services/actions/v1';
import { startDatabaseWorkbenchInsightsFixture } from '../../src/testkit/databaseWorkbench';
import { applyTrustedLocalPluginFixture } from '../../src/testkit/externalSessionLiveLifecycleFixture';
import { repoRootDir } from '../../src/testkit/paths';
import { createRunDirs } from '../../src/testkit/runDir';
import { waitFor } from '../../src/testkit/timing';

const run = createRunDirs({ runLabel: 'core' });

it('P5-F7-known-good-capture records a Happier-started service query and turns recording off', async () => {
  const fixture = await startDatabaseWorkbenchInsightsFixture({ testDir: run.testDir('dbw-capture-f7') });
  try {
    const target = fixture.targets.selected;
    const pluginId = DATABASE_CAPTURE_RESOURCE_REF_V1.pluginId;
    await applyTrustedLocalPluginFixture({ daemonPort: fixture.machine.daemon.state.httpPort,
      controlToken: fixture.machine.daemon.state.controlToken,
      pluginRoot: join(repoRootDir(), 'packages/plugins/telemetry'), pluginId,
      interactionId: 'dbw-f7-capture-install' });
    const project = { serverId: fixture.serverId, machineId: fixture.machine.target.machineId, projectId: target.projectKey };
    const source = { kind: 'worktree' as const, ...project, workspaceId: target.workspace.workspaceId };
    async function capture(actionId: typeof DATABASE_CAPTURE_CONFIGURE_ACTION_ID_V1 | typeof DATABASE_CAPTURE_QUERIES_LIST_ACTION_ID_V1 | typeof DATABASE_CAPTURE_STATUS_ACTION_ID_V1, input: unknown) {
      const result = await fixture.owner.execute('action.invoke', { action: { pluginId, localId: databaseActionLocalIdV1(actionId) }, input },
        { externalActionTarget: { kind: 'machine', machineId: project.machineId }, presentUserConfirmation: { actionId: 'action.invoke' } });
      expect(result.ok, JSON.stringify(result)).toBe(true);
      if (!result.ok) throw new Error(`F7 capture Action refused (${result.errorCode})`);
      return result.result;
    }
    expect(DatabaseCaptureConfigureResultV1Schema.parse(await capture(DATABASE_CAPTURE_CONFIGURE_ACTION_ID_V1,
      { project, enabled: true }))).toMatchObject({ ok: true, enabled: true });
    const root = fixture.machine.workspaceDir;
    await mkdir(join(root, '.happier'), { recursive: true });
    // A real app uses its launch environment. No direct ingest or synthetic capture rows.
    const pg = createRequire(new URL('../../../plugins/database-workbench/package.json', import.meta.url)).resolve('pg');
    await writeFile(join(root, 'capture-app.cjs'), `const {Client}=require(${JSON.stringify(pg)}); const http=require('node:http');
      http.createServer(async(req,res)=>{ const client=new Client({connectionString:process.env.DATABASE_URL});
        try { await client.connect(); await client.query("SELECT id FROM sentinel WHERE id=1"); res.end('ok'); }
        catch { res.statusCode=500; res.end('query failed'); } finally { await client.end(); }
      }).listen(Number(process.env.PORT),'127.0.0.1');`);
    await writeFile(join(root, '.env'), `DATABASE_URL=${fixture.postgres.selectedDatabaseUrl}\n`);
    await writeFile(join(root, '.happier/project.json'), JSON.stringify({ version: 1,
      services: { capture: { source: { kind: 'command', command: `${JSON.stringify(process.execPath)} capture-app.cjs` }, runtime: { portSlot: 0 } } },
      worktreePorts: { enabled: true, slots: 1 } }));
    const snapshot = await fixture.owner.execute('localServices.launcher.snapshot', { machineId: project.machineId, workspaceRoot: root });
    expect(snapshot.ok, JSON.stringify(snapshot)).toBe(true);
    if (!snapshot.ok) throw new Error(`F7 launcher read refused (${snapshot.errorCode})`);
    const service = LocalServiceLauncherSnapshotV1Schema.parse(snapshot.result).targets
      .find(row => row.declaration?.selection.kind === 'manifest' && row.declaration.selection.name === 'capture');
    expect(service, 'Capture app must be discovered by the production launcher').toBeDefined();
    if (!service) throw new Error('F7 launcher omitted capture app');
    const started = await fixture.owner.executeReviewed('localServices.launcher.start', { machineId: project.machineId,
      targetId: service.id, workspace: service.workspace, declaration: service.declaration },
      { presentUserConfirmation: { actionId: 'localServices.launcher.start' } });
    expect(started.ok, JSON.stringify(started)).toBe(true);
    if (!started.ok) throw new Error(`F7 start refused (${started.errorCode})`);
    const launch = DaemonLocalServiceLauncherStartResponseV1Schema.parse(started.result);
    expect(launch).toMatchObject({ status: 'succeeded' });
    if (!launch.currentTarget) throw new Error('F7 launcher omitted the app lifetime');
    // The launcher endpoint is the app entry, never the collector's private ingest API.
    await waitFor(async () => {
      const current = await fixture.owner.execute('localServices.launcher.snapshot', { machineId: project.machineId, workspaceRoot: root });
      if (!current.ok) return false;
      const endpoint = LocalServiceLauncherSnapshotV1Schema.parse(current.result).targets
        .find(row => row.id === service.id)?.endpointUrl;
      return endpoint ? (await fetch(endpoint)).ok : false;
    }, { context: 'F7 launched app query' });
    await waitFor(async () => {
      const queries = DatabaseCaptureQueriesListResultV1Schema.parse(await capture(DATABASE_CAPTURE_QUERIES_LIST_ACTION_ID_V1,
        { source, page: { limit: 20 } }));
      return queries.ok && queries.items.some(row => row.shape?.includes('sentinel'));
    }, { context: 'F7 query visible through public Action' });
    console.info('P5-F7-known-good-capture passed', fixture.runtime);
    expect(DatabaseCaptureConfigureResultV1Schema.parse(await capture(DATABASE_CAPTURE_CONFIGURE_ACTION_ID_V1,
      { project, enabled: false }))).toMatchObject({ ok: true, enabled: false });
    expect(DatabaseCaptureStatusResultV1Schema.parse(await capture(DATABASE_CAPTURE_STATUS_ACTION_ID_V1, { source })))
      .toMatchObject({ ok: true, enabled: false });
    const running = await fixture.owner.execute('localServices.launcher.snapshot', { machineId: project.machineId, workspaceRoot: root });
    if (!running.ok) throw new Error(`F7 running app read refused (${running.errorCode})`);
    const endpoint = LocalServiceLauncherSnapshotV1Schema.parse(running.result).targets
      .find(row => row.id === service.id)?.endpointUrl;
    if (!endpoint) throw new Error('F7 running app lost its endpoint');
    // Turning capture off must preserve forwarding for the admitted service.
    const forwarded = await fetch(endpoint);
    expect(forwarded.ok).toBe(true);
    expect(await forwarded.text()).toBe('ok');
    const stopped = await fixture.owner.executeReviewed('localServices.actions.stopManaged', {
      requestId: 'f7-stop-app', action: 'stop_managed', target: launch.currentTarget, force: false,
    }, { presentUserConfirmation: { actionId: 'localServices.actions.stopManaged' } });
    if (!stopped.ok) throw new Error(`F7 Stop refused (${stopped.errorCode})`);
    expect(LocalServiceActionResultV1Schema.parse(stopped.result).status).toBe('succeeded');
    expect(DatabaseCaptureConfigureResultV1Schema.parse(await capture(DATABASE_CAPTURE_CONFIGURE_ACTION_ID_V1,
      { project, enabled: true, retry: true }))).toMatchObject({ ok: true, enabled: true });
    const restarted = await fixture.owner.executeReviewed('localServices.launcher.start', { machineId: project.machineId,
      targetId: service.id, workspace: service.workspace, declaration: service.declaration },
      { presentUserConfirmation: { actionId: 'localServices.launcher.start' } });
    if (!restarted.ok) throw new Error(`F7 Restart refused (${restarted.errorCode})`);
    expect(DaemonLocalServiceLauncherStartResponseV1Schema.parse(restarted.result).status).toBe('succeeded');
  } finally { await fixture.stop(); }
}, 0);
