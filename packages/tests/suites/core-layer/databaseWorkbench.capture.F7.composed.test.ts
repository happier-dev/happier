import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import {
  DATABASE_ACCESS_SET_ACTION_ID_V1, DATABASE_CAPTURE_CLEAR_ACTION_ID_V1, DATABASE_CAPTURE_CONFIGURE_ACTION_ID_V1, DATABASE_CAPTURE_QUERIES_LIST_ACTION_ID_V1,
  DATABASE_CAPTURE_QUERY_GET_ACTION_ID_V1,
  DATABASE_CAPTURE_ENDPOINTS_LIST_ACTION_ID_V1, DATABASE_CAPTURE_LOGS_LIST_ACTION_ID_V1,
  DATABASE_CAPTURE_STATUS_ACTION_ID_V1, DATABASE_CAPTURE_RESOURCE_REF_V1,
  DATABASE_CAPTURE_TRACES_LIST_ACTION_ID_V1, DATABASE_CAPTURE_TRACE_GET_ACTION_ID_V1,
  DatabaseCaptureConfigureResultV1Schema, DatabaseCaptureQueriesListResultV1Schema,
  DatabaseCaptureEndpointsListResultV1Schema, DatabaseCaptureLogsListResultV1Schema,
  DatabaseCaptureStatusResultV1Schema, DatabaseCaptureTracesListResultV1Schema, DatabaseCaptureTraceGetResultV1Schema,
  databaseActionLocalIdV1,
} from '@happier-dev/database-protocol';
import { resolvePluginStorePathLayout } from '../../../../apps/cli/src/plugins/store/pathLayout';
import { DatabaseWorktreeTargetV1Schema } from '@happier-dev/plugin-sdk/database';
import { sanitizeDockerEnv } from '../../scripts/extended-db-docker.plan.mjs';
import { LocalServiceLauncherSnapshotV1Schema,
  DaemonLocalServiceLauncherStartResponseV1Schema } from '@happier-dev/protocol/local/services/launcher/v1';
import { LocalServiceActionResultV1Schema } from '@happier-dev/protocol/local/services/actions/v1';
import { installDatabaseCapturePluginFixture, startDatabaseWorkbenchAgent, startDatabaseWorkbenchInsightsFixture } from '../../src/testkit/databaseWorkbench';
import { repoRootDir } from '../../src/testkit/paths';
import { createRunDirs } from '../../src/testkit/runDir';
import { settleReviewedSessionMcpAction } from '../../src/testkit/sessionMcpAgent';
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
  let agent: Awaited<ReturnType<typeof startDatabaseWorkbenchAgent>> | undefined;
  try {
    const serviceName = 'capture';
    const target = fixture.targets.selected;
    const pluginId = DATABASE_CAPTURE_RESOURCE_REF_V1.pluginId;
    await installDatabaseCapturePluginFixture({ testDir, daemonPort: fixture.machine.daemon.state.httpPort,
      controlToken: fixture.machine.daemon.state.controlToken });
    const project = { serverId: fixture.serverId, machineId: fixture.machine.target.machineId, projectId: target.projectKey };
    const source = { kind: 'worktree' as const, ...project, workspaceId: target.workspace.workspaceId };
    async function capture(actionId: typeof DATABASE_CAPTURE_CONFIGURE_ACTION_ID_V1 | typeof DATABASE_CAPTURE_QUERIES_LIST_ACTION_ID_V1 | typeof DATABASE_CAPTURE_STATUS_ACTION_ID_V1
      | typeof DATABASE_CAPTURE_TRACES_LIST_ACTION_ID_V1 | typeof DATABASE_CAPTURE_TRACE_GET_ACTION_ID_V1
      | typeof DATABASE_CAPTURE_ENDPOINTS_LIST_ACTION_ID_V1 | typeof DATABASE_CAPTURE_LOGS_LIST_ACTION_ID_V1, input: unknown) {
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
      environmentVariables: [{ name: 'DATABASE_URL', kind: 'config' }],
      services: { [serviceName]: { source: { kind: 'command', command }, runtime: { portSlot: 0 } } },
      worktreePorts: { enabled: true, slots: 1 } }));
    const snapshot = await fixture.owner.execute('localServices.launcher.snapshot', { machineId: project.machineId, workspaceRoot: root });
    expect(snapshot.ok, JSON.stringify(snapshot)).toBe(true);
    if (!snapshot.ok) throw new Error(`F7 launcher read refused (${snapshot.errorCode})`);
    const service = LocalServiceLauncherSnapshotV1Schema.parse(snapshot.result).targets
      .find(row => row.declaration?.selection.kind === 'manifest' && row.declaration.selection.name === serviceName);
    expect(service, 'Capture app must be discovered by the production launcher').toBeDefined();
    if (!service) throw new Error('F7 launcher omitted capture app');
    const databaseTarget = DatabaseWorktreeTargetV1Schema.parse({ ...target,
      source: { kind: 'service', serviceId: service.id, variable: 'DATABASE_URL' },
    });
    expect(await fixture.executeDatabase(DATABASE_ACCESS_SET_ACTION_ID_V1, { target: databaseTarget, agentAccess: 'read' }))
      .toMatchObject({ ok: true, result: { ok: true, agentAccess: 'read' } });
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
        { source, databaseTarget, page: { limit: 20 } }));
      return queries.ok && queries.items.some(row => row.source === 'wire' &&
        (image ? row.statementKind === 'select' : row.shape?.includes('sentinel')));
    }, { context: 'F7 query visible through public Action' });
    console.info('P5-F7-known-good-capture passed', fixture.runtime);
    const workloadUrl = image ? new URL('/checkout', endpoint) : new URL(endpoint);
    const wireRows = async () => {
      const result = DatabaseCaptureQueriesListResultV1Schema.parse(await capture(DATABASE_CAPTURE_QUERIES_LIST_ACTION_ID_V1,
        { source, databaseTarget, page: { limit: 20 } }));
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
            { source, databaseTarget, page: { limit: 20 } }));
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
          { source, databaseTarget, page: { limit: 20 } }));
        return { status: status.ok ? { enabled: status.enabled, coverage: status.coverage } : { code: status.code },
          traces: traces.ok ? traces.items.map(row => row.endpointRoute) : { code: traces.code },
          queries: queries.ok ? queries.items.map(row => ({ source: row.source, paired: !!row.executionIdentity })) : { code: queries.code } };
      };
      let traceId = '';
      await waitFor(async () => {
        const requests = DatabaseCaptureTracesListResultV1Schema.parse(await capture(DATABASE_CAPTURE_TRACES_LIST_ACTION_ID_V1,
          { source, page: { limit: 20 } }));
        if (!requests.ok) return false;
        traceId = requests.items.find(row => row.endpointRoute === '/orders' && row.serviceName === serviceName)?.traceId ?? '';
        return traceId.length > 0;
      }, { context: 'F7 SDK request visible through Traces Action' }).catch(async error => {
        const initial = await diagnostic();
        await fetch(new URL('/checkout', endpoint));
        await fetch(new URL('/flush', endpoint));
        throw new Error(`F7 captured ingestion diagnostic ${JSON.stringify({ initial, afterNewRequest: await diagnostic() })}`, { cause: error });
      });
      const waterfall = DatabaseCaptureTraceGetResultV1Schema.parse(await capture(DATABASE_CAPTURE_TRACE_GET_ACTION_ID_V1,
        { source, databaseTarget, traceId, page: { limit: 20 } }));
      expect(waterfall).toMatchObject({ ok: true, traceId, repeatedQueries: [{
        kind: 'suspected_n_plus_one', repetitionCount: 3,
      }] });
      if (!waterfall.ok) throw new Error('F7 selected request waterfall was refused');
      const queries = DatabaseCaptureQueriesListResultV1Schema.parse(await capture(DATABASE_CAPTURE_QUERIES_LIST_ACTION_ID_V1,
        { source, databaseTarget, traceId, page: { limit: 20 } }));
      if (!queries.ok) throw new Error('F7 selected query read was refused');
      expect(queries.items).toHaveLength(3);
      expect(queries.items.every(row => row.source === 'wire')).toBe(true);
      expect(waterfall.repeatedQueries[0]?.observationIds).toEqual(expect.arrayContaining(queries.items.map(row => row.id)));
      expect(waterfall.repeatedQueries[0]?.observationIds).toHaveLength(3);
      const queryId = queries.items[0]!.id;
      agent = await startDatabaseWorkbenchAgent(fixture, testDir);
      {
        const page = { limit: 20 };
        const selected = { source, databaseTarget };
        const reads = [
          { action: DATABASE_CAPTURE_QUERIES_LIST_ACTION_ID_V1, input: { ...selected, traceId, page },
            result: { ok: true, items: expect.arrayContaining([expect.objectContaining({ id: queryId })]) } },
          { action: DATABASE_CAPTURE_QUERY_GET_ACTION_ID_V1, input: { ...selected, id: queryId },
            result: { ok: true, detail: expect.any(Object) } },
          { action: DATABASE_CAPTURE_TRACE_GET_ACTION_ID_V1, input: { ...selected, traceId, page },
            result: { ok: true, traceId, repeatedQueries: [{ kind: 'suspected_n_plus_one', repetitionCount: 3 }] } },
        ] as const;
        for (const { action, input, result } of reads) {
          expect(await agent.execute(action, input), action).toMatchObject({ ok: true, result });
        }
        expect(await fixture.executeDatabase(DATABASE_ACCESS_SET_ACTION_ID_V1, { target: databaseTarget, agentAccess: 'none' }))
          .toMatchObject({ ok: true, result: { ok: true, agentAccess: 'none' } });
        for (const { action, input } of reads) {
          expect(await agent.execute(action, input), action).toMatchObject({ ok: false, errorCode: 'database_agent_access_none' });
        }
        expect(await agent.execute(DATABASE_CAPTURE_TRACES_LIST_ACTION_ID_V1, { source, page }))
          .toMatchObject({ ok: true, result: { ok: true, source, items: expect.arrayContaining([
            expect.objectContaining({ traceId, endpointRoute: '/orders', serviceName }),
          ]) } });
        expect(await agent.execute(DATABASE_CAPTURE_ENDPOINTS_LIST_ACTION_ID_V1, { source, page }))
          .toMatchObject({ ok: true, result: { ok: true, source, items: expect.arrayContaining([
            expect.objectContaining({ serviceName, method: 'GET', route: '/orders', requestCount: 1, errorCount: 0 }),
          ]) } });
        expect(await agent.execute(DATABASE_CAPTURE_LOGS_LIST_ACTION_ID_V1, { source, serviceName, page }))
          .toMatchObject({ ok: true, result: { ok: true, source, items: expect.arrayContaining([
            expect.objectContaining({ traceId, source: 'otlp', bodyPrefix: 'Orders query completed', serviceName }),
          ]) } });
        expect(await fixture.executeDatabase(DATABASE_ACCESS_SET_ACTION_ID_V1, { target: databaseTarget, agentAccess: 'read' }))
          .toMatchObject({ ok: true, result: { ok: true, agentAccess: 'read' } });
      }
      const endpoints = DatabaseCaptureEndpointsListResultV1Schema.parse(await capture(DATABASE_CAPTURE_ENDPOINTS_LIST_ACTION_ID_V1,
        { source, page: { limit: 20 } }));
      expect(endpoints).toMatchObject({ ok: true, items: expect.arrayContaining([
        expect.objectContaining({ serviceName, method: 'GET', route: '/orders', requestCount: 1, errorCount: 0 }),
      ]) });
      const logs = DatabaseCaptureLogsListResultV1Schema.parse(await capture(DATABASE_CAPTURE_LOGS_LIST_ACTION_ID_V1,
        { source, serviceName, page: { limit: 20 } }));
      if (!logs.ok) throw new Error(`F7 selected logs read refused (${logs.code})`);
      const ordersLog = logs.items.find(row => row.traceId === traceId);
      expect(ordersLog).toMatchObject({ source: 'otlp', bodyPrefix: 'Orders query completed', serviceName });
      const traceAction = { pluginId, localId: databaseActionLocalIdV1(DATABASE_CAPTURE_TRACE_GET_ACTION_ID_V1) };
      const traceInvocation = { action: traceAction, input: { source, traceId, page: { limit: 20 } } };
      const tracePlacement = { externalActionTarget: { kind: 'machine' as const, machineId: project.machineId } };
      const delegatedTrace = await fixture.owner.executeReviewed('action.invoke', traceInvocation, {
        ...tracePlacement, presentUserConfirmation: { actionId: 'action.invoke' },
      });
      expect(delegatedTrace).toMatchObject({ ok: false, errorCode: 'database_target_required' });
      const personTrace = await fixture.owner.executeAsPerson('action.invoke', traceInvocation, tracePlacement,
        { action: traceAction, machineId: project.machineId });
      expect(personTrace.ok).toBe(true);
      if (!personTrace.ok) throw new Error(`F7 Person trace read refused (${personTrace.errorCode})`);
      const appWaterfall = DatabaseCaptureTraceGetResultV1Schema.parse(personTrace.result);
      expect(appWaterfall).toMatchObject({ ok: true, traceId,
        logCorrelations: expect.arrayContaining([expect.objectContaining({ logId: ordersLog?.id, traceId })]),
      });
      expect(JSON.stringify({ queries, waterfall })).not.toContain('must-be-masked');
      extendedObserving = { requests: 1, executions: 3, retainedWireQueries: queries.items.filter(row => row.source === 'wire').length };
    }

    const beforeLoss = DatabaseCaptureStatusResultV1Schema.parse(await capture(DATABASE_CAPTURE_STATUS_ACTION_ID_V1, { source }));
    if (!beforeLoss.ok) throw new Error(`F7 selected status read refused (${beforeLoss.code})`);
    const { storageDir } = resolvePluginStorePathLayout(fixture.machine.homeDir);
    const storePath = join(storageDir, pluginId, 'databases', 'capture.sqlite');
    await access(storePath);
    const captureStore = new DatabaseSync(storePath);
    try {
      // Fail the real recorder write at SQLite while the launched workload keeps using PostgreSQL.
      captureStore.exec(`CREATE TRIGGER f7_reject_wire BEFORE INSERT ON captureSummaries
        WHEN NEW.source = 'wire' BEGIN SELECT RAISE(FAIL, 'F7 capture storage fault'); END`);
      const forwardedDuringLoss = await fetch(workloadUrl);
      expect(forwardedDuringLoss.status).toBe(200);
      expect(await forwardedDuringLoss.text()).toBe(observedBody);
      await waitFor(async () => {
        const status = DatabaseCaptureStatusResultV1Schema.parse(await capture(DATABASE_CAPTURE_STATUS_ACTION_ID_V1, { source }));
        return status.ok && status.enabled === true && status.coverage.lostObservations > beforeLoss.coverage.lostObservations
          && status.coverage.reason !== null && status.coverage.reason !== 'store_busy';
      }, { context: 'F7 selected Capture reports the failed Store write while still forwarding' });
    } finally {
      try { captureStore.exec('DROP TRIGGER IF EXISTS f7_reject_wire'); }
      finally { captureStore.close(); }
    }
    expect(DatabaseCaptureConfigureResultV1Schema.parse(await capture(DATABASE_CAPTURE_CONFIGURE_ACTION_ID_V1,
      { project, enabled: true, retry: true }))).toMatchObject({ ok: true, enabled: true });
    const beforeRecovery = await wireRows();
    const recovered = await fetch(workloadUrl);
    expect(recovered.status).toBe(200);
    expect(await recovered.text()).toBe(observedBody);
    await waitFor(async () => (await wireRows()).length > beforeRecovery.length,
      { context: 'F7 selected Capture records again before the Off control' });
    const session = agent ??= await startDatabaseWorkbenchAgent(fixture, testDir);
    const executeSession = async (actionId: Parameters<typeof session.execute>[0], input: unknown) => {
      const result = await session.execute(actionId, input);
      return settleReviewedSessionMcpAction(result, { serverId: fixture.serverId, token: fixture.owner.credentials.token,
        serverHttpBaseUrl: fixture.actionServerApiUrl, execute: fixture.owner.execute,
        decide: artifactId => fixture.owner.executeAsPerson('approval.request.decide', { artifactId, decision: 'approve' }) });
    };
    expect(await executeSession(DATABASE_CAPTURE_CONFIGURE_ACTION_ID_V1, { project, enabled: false }))
      .toMatchObject({ ok: true, result: { ok: true, enabled: false } });
    expect(await session.execute(DATABASE_CAPTURE_STATUS_ACTION_ID_V1, { source }))
      .toMatchObject({ ok: true, result: { ok: true, source, enabled: false } });
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
    expect(await executeSession(DATABASE_CAPTURE_CONFIGURE_ACTION_ID_V1,
      { project: { ...project, machineId: randomUUID() }, enabled: true }))
      .toMatchObject({ ok: false, errorCode: 'capture_source_unavailable' });
    const beforeClear = await wireRows();
    expect(beforeClear.length).toBeGreaterThan(0);
    expect(await executeSession(DATABASE_CAPTURE_CLEAR_ACTION_ID_V1,
      { source: { ...source, machineId: randomUUID() } }))
      .toMatchObject({ ok: false, errorCode: 'capture_source_unavailable' });
    expect(await wireRows()).toEqual(beforeClear);
    expect(await executeSession(DATABASE_CAPTURE_CLEAR_ACTION_ID_V1, { source }))
      .toMatchObject({ ok: true, result: { ok: true } });
    expect(await wireRows()).toHaveLength(0);
    const stopped = await fixture.owner.executeReviewed('localServices.actions.stopManaged', {
      requestId: 'f7-stop-app', action: 'stop_managed', target: launch.currentTarget, force: false,
    }, { presentUserConfirmation: { actionId: 'localServices.actions.stopManaged' } });
    if (!stopped.ok) throw new Error(`F7 Stop refused (${stopped.errorCode})`);
    expect(LocalServiceActionResultV1Schema.parse(stopped.result).status).toBe('succeeded');
    expect(await executeSession(DATABASE_CAPTURE_CONFIGURE_ACTION_ID_V1, { project, enabled: true, retry: true }))
      .toMatchObject({ ok: true, result: { ok: true, enabled: true } });
    console.info('F7 selected Session Configure and Clear passed with unrelated-scope refusals');
    const restarted = await fixture.owner.executeReviewed('localServices.launcher.start', { machineId: project.machineId,
      targetId: service.id, workspace: service.workspace, declaration: service.declaration },
      { presentUserConfirmation: { actionId: 'localServices.launcher.start' } });
    if (!restarted.ok) throw new Error(`F7 Restart refused (${restarted.errorCode})`);
    expect(DaemonLocalServiceLauncherStartResponseV1Schema.parse(restarted.result).status).toBe('succeeded');
  } finally {
    try { try { await agent?.stop(); } finally { await fixture.stop(); } }
    finally { if (image && imageBuilt) await execute('docker', ['image', 'rm', image], dockerOptions); }
  }
}, 0);
