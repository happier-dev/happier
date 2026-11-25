import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import {
  DATABASE_CAPTURE_CONFIGURE_ACTION_ID_V1, DATABASE_CAPTURE_QUERIES_LIST_ACTION_ID_V1,
  DATABASE_CAPTURE_STATUS_ACTION_ID_V1, DATABASE_CAPTURE_RESOURCE_REF_V1,
  DATABASE_CAPTURE_TRACES_LIST_ACTION_ID_V1, DATABASE_CAPTURE_TRACE_GET_ACTION_ID_V1,
  DatabaseCaptureConfigureResultV1Schema, DatabaseCaptureQueriesListResultV1Schema,
  DatabaseCaptureStatusResultV1Schema, DatabaseCaptureTracesListResultV1Schema, DatabaseCaptureTraceGetResultV1Schema,
  databaseActionLocalIdV1,
} from '@happier-dev/database-protocol';
import { sanitizeDockerEnv } from '../../scripts/extended-db-docker.plan.mjs';
import { LocalServiceLauncherSnapshotV1Schema,
  DaemonLocalServiceLauncherStartResponseV1Schema } from '@happier-dev/protocol/local/services/launcher/v1';
import { LocalServiceActionResultV1Schema } from '@happier-dev/protocol/local/services/actions/v1';
import { installDatabaseCapturePluginFixture, startDatabaseWorkbenchInsightsFixture } from '../../src/testkit/databaseWorkbench';
import { repoRootDir } from '../../src/testkit/paths';
import { createRunDirs } from '../../src/testkit/runDir';
import { waitFor } from '../../src/testkit/timing';

const run = createRunDirs({ runLabel: 'core' });
const execute = promisify(execFile);

it('P5-F7-known-good-capture records a Happier-started service query and turns recording off', async () => {
  const testDir = run.testDir('dbw-capture-f7');
  const fixture = await startDatabaseWorkbenchInsightsFixture({ testDir });
  // Extract the pinned fixture dependencies on Linux. The reviewed launcher owns the service process and its loopback listeners.
  const image = process.platform === 'linux' ? `happier-f7-app:${randomUUID()}` : undefined;
  const dockerOptions = { env: sanitizeDockerEnv(process.env) };
  let imageBuilt = false;
  try {
    const target = fixture.targets.selected;
    const pluginId = DATABASE_CAPTURE_RESOURCE_REF_V1.pluginId;
    await installDatabaseCapturePluginFixture({ testDir, daemonPort: fixture.machine.daemon.state.httpPort,
      controlToken: fixture.machine.daemon.state.controlToken });
    const project = { serverId: fixture.serverId, machineId: fixture.machine.target.machineId, projectId: target.projectKey };
    const source = { kind: 'worktree' as const, ...project, workspaceId: target.workspace.workspaceId };
    async function capture(actionId: typeof DATABASE_CAPTURE_CONFIGURE_ACTION_ID_V1 | typeof DATABASE_CAPTURE_QUERIES_LIST_ACTION_ID_V1 | typeof DATABASE_CAPTURE_STATUS_ACTION_ID_V1
      | typeof DATABASE_CAPTURE_TRACES_LIST_ACTION_ID_V1 | typeof DATABASE_CAPTURE_TRACE_GET_ACTION_ID_V1, input: unknown) {
      const result = await fixture.owner.executeReviewed('action.invoke', { action: { pluginId, localId: databaseActionLocalIdV1(actionId) }, input },
        { externalActionTarget: { kind: 'machine', machineId: project.machineId }, presentUserConfirmation: { actionId: 'action.invoke' } });
      expect(result.ok, JSON.stringify(result)).toBe(true);
      if (!result.ok) throw new Error(`F7 capture Action refused (${result.errorCode})`);
      return result.result;
    }
    const configured = await capture(DATABASE_CAPTURE_CONFIGURE_ACTION_ID_V1, { project, enabled: true });
    const parsedConfigure = DatabaseCaptureConfigureResultV1Schema.safeParse(configured);
    if (!parsedConfigure.success) {
      const fields = configured && typeof configured === 'object' ? Object.keys(configured) : [typeof configured];
      throw new Error(`F7 Configure returned an unexpected result shape (${fields.join(', ')})`);
    }
    expect(parsedConfigure.data).toMatchObject({ ok: true, enabled: true });
    const root = fixture.machine.workspaceDir;
    await mkdir(join(root, '.happier'), { recursive: true });
    let command: string;
    let clientVersion: string;
    if (image) {
      const workload = join(repoRootDir(), 'apps/cli/src/deployments/testkit/telemetryApp');
      await execute('docker', ['build', '--tag', image, workload], dockerOptions);
      imageBuilt = true;
      const appDir = join(root, 'capture-app');
      await mkdir(appDir);
      const { stdout } = await execute('docker', ['create', image], dockerOptions);
      const containerId = stdout.trim();
      try {
        await execute('docker', ['cp', `${containerId}:/app/.`, appDir], dockerOptions);
      } finally {
        await execute('docker', ['rm', containerId], dockerOptions);
      }
      command = `${JSON.stringify(process.execPath)} --expose-gc capture-app/app.cjs`;
      const client = createRequire(join(appDir, 'app.cjs'))('pg/package.json') as { version: string };
      clientVersion = client.version;
    } else {
      // Retain the existing wire-only G1 fixture outside the Linux composed test lane.
      const require = createRequire(new URL('../../../plugins/database-workbench/package.json', import.meta.url));
      const pg = require.resolve('pg');
      clientVersion = (require('pg/package.json') as { version: string }).version;
      await writeFile(join(root, 'capture-app.cjs'), `const {Client}=require(${JSON.stringify(pg)}); const http=require('node:http');
      http.createServer(async(req,res)=>{ const client=new Client({connectionString:process.env.DATABASE_URL});
        try { await client.connect(); await client.query("SELECT id FROM sentinel WHERE id=1"); res.end('ok'); }
        catch { res.statusCode=500; res.end('query failed'); } finally { await client.end(); }
      }).listen(Number(process.env.PORT),'127.0.0.1');`);
      command = `${JSON.stringify(process.execPath)} capture-app.cjs`;
    }
    await writeFile(join(root, '.env'), `DATABASE_URL=${fixture.postgres.selectedDatabaseUrl}\n`);
    await writeFile(join(root, '.happier/project.json'), JSON.stringify({ version: 1,
      services: { capture: { source: { kind: 'command', command }, runtime: { portSlot: 0 } } },
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
    let endpoint = '';
    await waitFor(async () => {
      const current = await fixture.owner.execute('localServices.launcher.snapshot', { machineId: project.machineId, workspaceRoot: root });
      if (!current.ok) return false;
      const candidate = LocalServiceLauncherSnapshotV1Schema.parse(current.result).targets
        .find(row => row.id === service.id)?.endpointUrl;
      if (!candidate) return false;
      const request = image ? new URL('/checkout', candidate) : candidate;
      if (!(await fetch(request)).ok) return false;
      endpoint = candidate;
      return true;
    }, { context: 'F7 launched app query' });
    await waitFor(async () => {
      const queries = DatabaseCaptureQueriesListResultV1Schema.parse(await capture(DATABASE_CAPTURE_QUERIES_LIST_ACTION_ID_V1,
        { source, page: { limit: 20 } }));
      return queries.ok && queries.items.some(row => row.source === 'wire' &&
        (image ? row.statementKind === 'select' : row.shape?.includes('sentinel')));
    }, { context: 'F7 query visible through public Action' });
    console.info('P5-F7-known-good-capture passed', fixture.runtime);
    const workloadUrl = image ? new URL('/checkout', endpoint) : new URL(endpoint);
    const wireRows = async () => {
      const result = DatabaseCaptureQueriesListResultV1Schema.parse(await capture(DATABASE_CAPTURE_QUERIES_LIST_ACTION_ID_V1,
        { source, page: { limit: 20 } }));
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('F7 wire count unavailable');
      return result.items.filter(row => row.source === 'wire').map(row => row.id).sort();
    };
    const beforeObserving = await wireRows();
    const observed = await fetch(workloadUrl);
    expect(observed.ok).toBe(true);
    const observedBody = await observed.text();
    await waitFor(async () => (await wireRows()).length > beforeObserving.length,
      { context: 'F7 M4 observing commit' });
    const observing = { requests: 1, retainedWireQueries: (await wireRows()).length - beforeObserving.length };
    expect(observing.retainedWireQueries).toBe(1);
    let extendedObserving: { requests: number; executions: number; retainedWireQueries: number } | undefined;
    if (image) {
      const measurement = async () => {
        const response = await fetch(new URL('/measurement', endpoint));
        expect(response.ok).toBe(true);
        return await response.json() as { requests: number; queries: number };
      };
      const before = await measurement();
      const baseline = await fetch(new URL('/flush', endpoint));
      expect(baseline.ok).toBe(true);
      const baselineExport = await baseline.json();
      await waitFor(async () => {
        const traces = DatabaseCaptureTracesListResultV1Schema.parse(await capture(DATABASE_CAPTURE_TRACES_LIST_ACTION_ID_V1,
          { source, page: { limit: 20 } }));
        return traces.ok && traces.items.some(row => row.endpointRoute === '/checkout');
      }, { context: 'F7 baseline SDK request committed before the paired control' });
      const requesting = fetch(new URL('/orders?paceCapture=1', endpoint));
      for (const expected of [1, 2, 3]) {
        await waitFor(async () => {
          const queries = DatabaseCaptureQueriesListResultV1Schema.parse(await capture(DATABASE_CAPTURE_QUERIES_LIST_ACTION_ID_V1,
            { source, page: { limit: 20 } }));
          return queries.ok && queries.items.filter(row => row.source === 'wire' && row.executionIdentity).length === expected;
        }, { context: `F7 tagged wire query ${expected} committed before the next execution` });
        expect((await fetch(new URL('/f7/continue', endpoint), { method: 'POST' })).status).toBe(204);
      }
      const orders = await requesting;
      expect(orders.status).toBe(200);
      expect(await orders.json()).toEqual({ ok: true });
      expect(await measurement()).toMatchObject({ requests: before.requests + 1, queries: before.queries + 3 });
      const exported = await fetch(new URL('/flush', endpoint));
      expect(exported.ok).toBe(true);
      const sdkExport = await exported.json();
      expect(sdkExport).toMatchObject({ failedBatches: 0 });
      expect(sdkExport.exportedRecords).toBe(baselineExport.exportedRecords + 4);
      const diagnostic = async () => {
        const status = DatabaseCaptureStatusResultV1Schema.parse(await capture(DATABASE_CAPTURE_STATUS_ACTION_ID_V1, { source }));
        const traces = DatabaseCaptureTracesListResultV1Schema.parse(await capture(DATABASE_CAPTURE_TRACES_LIST_ACTION_ID_V1,
          { source, page: { limit: 20 } }));
        const queries = DatabaseCaptureQueriesListResultV1Schema.parse(await capture(DATABASE_CAPTURE_QUERIES_LIST_ACTION_ID_V1,
          { source, page: { limit: 20 } }));
        return { status: status.ok ? { enabled: status.enabled, coverage: status.coverage } : { code: status.code },
          traces: traces.ok ? traces.items.map(row => row.endpointRoute) : { code: traces.code },
          queries: queries.ok ? queries.items.map(row => ({ source: row.source, paired: !!row.executionIdentity })) : { code: queries.code } };
      };
      let traceId = '';
      await waitFor(async () => {
        const requests = DatabaseCaptureTracesListResultV1Schema.parse(await capture(DATABASE_CAPTURE_TRACES_LIST_ACTION_ID_V1,
          { source, page: { limit: 20 } }));
        if (!requests.ok) return false;
        traceId = requests.items.find(row => row.endpointRoute === '/orders' && row.serviceName === 'capture')?.traceId ?? '';
        return traceId.length > 0;
      }, { context: 'F7 SDK request visible through Traces Action' }).catch(async error => {
        const initial = await diagnostic();
        await fetch(new URL('/checkout', endpoint));
        await fetch(new URL('/flush', endpoint));
        throw new Error(`F7 captured ingestion diagnostic ${JSON.stringify({ initial, afterNewRequest: await diagnostic() })}`, { cause: error });
      });
      const waterfall = DatabaseCaptureTraceGetResultV1Schema.parse(await capture(DATABASE_CAPTURE_TRACE_GET_ACTION_ID_V1,
        { source, traceId, page: { limit: 20 } }));
      expect(waterfall).toMatchObject({ ok: true, traceId, repeatedQueries: [{
        kind: 'suspected_n_plus_one', repetitionCount: 3,
      }] });
      if (!waterfall.ok) throw new Error('F7 selected request waterfall was refused');
      expect(new Set(waterfall.repeatedQueries[0]?.observationIds).size).toBe(6);
      const queries = DatabaseCaptureQueriesListResultV1Schema.parse(await capture(DATABASE_CAPTURE_QUERIES_LIST_ACTION_ID_V1,
        { source, traceId, page: { limit: 20 } }));
      if (!queries.ok) throw new Error('F7 selected query read was refused');
      expect(queries.items.filter(row => row.source === 'wire')).toHaveLength(3);
      expect(queries.items.filter(row => row.source === 'otlp')).toHaveLength(3);
      expect(JSON.stringify({ queries, waterfall })).not.toContain('must-be-masked');
      extendedObserving = { requests: 1, executions: 3, retainedWireQueries: queries.items.filter(row => row.source === 'wire').length };
    }
    expect(DatabaseCaptureConfigureResultV1Schema.parse(await capture(DATABASE_CAPTURE_CONFIGURE_ACTION_ID_V1,
      { project, enabled: false }))).toMatchObject({ ok: true, enabled: false });
    expect(DatabaseCaptureStatusResultV1Schema.parse(await capture(DATABASE_CAPTURE_STATUS_ACTION_ID_V1, { source })))
      .toMatchObject({ ok: true, enabled: false });
    const running = await fixture.owner.execute('localServices.launcher.snapshot', { machineId: project.machineId, workspaceRoot: root });
    if (!running.ok) throw new Error(`F7 running app read refused (${running.errorCode})`);
    const runningEndpoint = LocalServiceLauncherSnapshotV1Schema.parse(running.result).targets
      .find(row => row.id === service.id)?.endpointUrl;
    if (!runningEndpoint) throw new Error('F7 running app lost its endpoint');
    // Turning capture off must preserve forwarding for the admitted service.
    const beforeRelaying = await wireRows();
    const forwarded = await fetch(new URL(workloadUrl.pathname, runningEndpoint));
    expect(forwarded.ok).toBe(true);
    expect(await forwarded.text()).toBe(observedBody);
    const afterRelaying = await wireRows();
    expect(afterRelaying).toEqual(beforeRelaying);
    const relaying = { requests: 1, retainedWireQueries: afterRelaying.length - beforeRelaying.length };
    let extendedRelaying: typeof extendedObserving;
    if (image) {
      const readWork = async () => {
        const response = await fetch(new URL('/measurement', runningEndpoint));
        expect(response.ok).toBe(true);
        return await response.json() as { requests: number; queries: number };
      };
      const before = await readWork();
      const orders = await fetch(new URL('/orders', runningEndpoint));
      expect(orders.status).toBe(200);
      expect(await orders.json()).toEqual({ ok: true });
      const after = await readWork();
      expect(after).toMatchObject({ requests: before.requests + 1, queries: before.queries + 3 });
      const retained = await wireRows();
      expect(retained).toEqual(beforeRelaying);
      extendedRelaying = { requests: after.requests - before.requests, executions: after.queries - before.queries,
        retainedWireQueries: retained.length - beforeRelaying.length };
    }
    console.info('P5 M4 loaded wire counts', {
      workload: image ? 'checkout simple SELECT and orders parameterized SELECT' : 'sentinel simple SELECT',
      clientVersion,
      nodeVersion: process.version,
      simple: { observing, relaying },
      extended: { observing: extendedObserving, relaying: extendedRelaying },
    });
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
  } finally {
    try { await fixture.stop(); }
    finally { if (image && imageBuilt) await execute('docker', ['image', 'rm', image], dockerOptions); }
  }
}, 0);
