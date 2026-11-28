import { AutomationEventActionHttpPathsV1, AutomationEventAdmitHttpRequestV1Schema } from '@happier-dev/protocol/automations/event';
import { projectAutomationDatabaseFindingSubjectV1 } from '@happier-dev/protocol/automations/automationSubjectV1';
import { PluginEventAutomationSetupResultV1Schema } from '@happier-dev/protocol/automations/event-setup-result';
import { PluginAvailabilityActionHttpPathsV1, PluginAvailabilityMaterializationsReadActionOutputV1Schema } from '@happier-dev/protocol/plugins/availability/actions';
import { OpenProjectResultV1Schema } from '@happier-dev/protocol/projects/openProjectV1';
import { LocalServiceActionResultV1Schema } from '@happier-dev/protocol/local/services/actions/v1';
import { readAccountIdFromToken } from '../../../../apps/cli/src/cloud/decodeJwtPayload';
import { addFriend, setUsername } from '../../src/testkit/socialFriends';
import { WorkflowActionOutputSchemasV1 } from '@happier-dev/protocol/workflows/actionsV1';
import { DATABASE_FINDING_EVENT_REF, DATABASE_FINDING_SETUP_LOCAL_ID } from '../../../plugins/database-workbench/src/insights/events';
import { fetchJson } from '../../src/testkit/http';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import {
  DATABASE_ACCESS_SET_ACTION_ID_V1, DATABASE_CAPTURE_CLEAR_ACTION_ID_V1, DATABASE_CAPTURE_CONFIGURE_ACTION_ID_V1,
  DATABASE_CAPTURE_QUERIES_LIST_ACTION_ID_V1,
  DATABASE_CAPTURE_RESOURCE_REF_V1,
  DATABASE_CAPTURE_TRACES_LIST_ACTION_ID_V1, DATABASE_CAPTURE_TRACE_GET_ACTION_ID_V1,
  DatabaseCaptureConfigureResultV1Schema, DatabaseCaptureQueriesListResultV1Schema,
  DatabaseCaptureTracesListResultV1Schema, DatabaseCaptureTraceGetResultV1Schema,
  databaseActionLocalIdV1,
} from '@happier-dev/database-protocol';
import { DatabaseWorktreeTargetV1Schema } from '@happier-dev/plugin-sdk/database';
import { sanitizeDockerEnv } from '../../scripts/extended-db-docker.plan.mjs';
import { LocalServiceLauncherSnapshotV1Schema,
  DaemonLocalServiceLauncherStartResponseV1Schema } from '@happier-dev/protocol/local/services/launcher/v1';
import { installDatabaseCapturePluginFixture, startDatabaseWorkbenchInsightsFixture } from '../../src/testkit/databaseWorkbench';
import { repoRootDir } from '../../src/testkit/paths';
import { createRunDirs } from '../../src/testkit/runDir';
import { waitFor } from '../../src/testkit/timing';

const run = createRunDirs({ runLabel: 'core' });
const execute = promisify(execFile);

it('publishes one owner Worktree finding and keeps guest findings in Capture', async () => {
  const testDir = run.testDir('dbw-worktree-event-plan85');
  const admitPath = AutomationEventActionHttpPathsV1['automation.event.admit'];
  const findingAdmissions: (number | null)[] = [];
  const fixture = await startDatabaseWorkbenchInsightsFixture({
    testDir,
    serverEnv: { HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1' },
    daemonEnv: { HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1' },
    guestReachableHome: { host: '127.0.0.1' },
    captureRequestBody: request => request.path === admitPath,
    beforeForwardResponse(request) {
      if (request.path !== admitPath || !request.body?.complete || request.body.truncated) return;
      const admission = AutomationEventAdmitHttpRequestV1Schema.parse(JSON.parse(request.body.text));
      const ref = 'input' in admission ? admission.input.eventRef : admission.hostEvidence.eventRef;
      if (ref.pluginId === DATABASE_FINDING_EVENT_REF.pluginId && ref.localId === DATABASE_FINDING_EVENT_REF.localId) {
        findingAdmissions.push(request.statusCode);
      }
    },
  });
  // Extract the pinned fixture dependencies on Linux. The reviewed launcher owns the service process and its loopback listeners.
  const image = process.platform === 'linux' ? `happier-f7-app:${randomUUID()}` : undefined;
  const dockerOptions = { env: sanitizeDockerEnv(process.env) };
  let imageBuilt = false;
  try {
    const serviceName = 'capture';
    const target = fixture.targets.selected;
    const pluginId = DATABASE_CAPTURE_RESOURCE_REF_V1.pluginId;
    await installDatabaseCapturePluginFixture({ testDir, daemonPort: fixture.machine.daemon.state.httpPort,
      controlToken: fixture.machine.daemon.state.controlToken });
    const project = { serverId: fixture.serverId, machineId: fixture.machine.target.machineId, projectId: target.projectKey };
    const source = { kind: 'worktree' as const, ...project, workspaceId: target.workspace.workspaceId };
    type Account = typeof fixture.owner;
    type CaptureAction = typeof DATABASE_CAPTURE_CLEAR_ACTION_ID_V1 | typeof DATABASE_CAPTURE_CONFIGURE_ACTION_ID_V1
      | typeof DATABASE_CAPTURE_QUERIES_LIST_ACTION_ID_V1 | typeof DATABASE_CAPTURE_TRACES_LIST_ACTION_ID_V1
      | typeof DATABASE_CAPTURE_TRACE_GET_ACTION_ID_V1;
    const machinePlacement = { externalActionTarget: { kind: 'machine' as const, machineId: project.machineId } };
    async function capture(actionId: CaptureAction, input: unknown, person?: Account) {
      const action = { pluginId, localId: databaseActionLocalIdV1(actionId) };
      const result = person
        ? await person.executeAsPerson('action.invoke', { action, input }, machinePlacement, { action, machineId: project.machineId })
        : await fixture.owner.executeReviewed('action.invoke', { action, input },
          { ...machinePlacement, presentUserConfirmation: { actionId: 'action.invoke' } });
      expect(result.ok, JSON.stringify(result)).toBe(true);
      if (!result.ok) throw new Error(`Worktree Capture Action refused (${result.errorCode})`);
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
    async function declareWorkload(workspaceRoot: string) {
      await mkdir(join(workspaceRoot, '.happier'), { recursive: true });
      await writeFile(join(workspaceRoot, '.env'), `DATABASE_URL=${fixture.postgres.selectedDatabaseUrl}\n`);
      await writeFile(join(workspaceRoot, '.happier/project.json'), JSON.stringify({ version: 1,
        environmentVariables: [{ name: 'DATABASE_URL', kind: 'config' }],
        services: { [serviceName]: { source: { kind: 'command', command }, runtime: { portSlot: 0 } } },
        worktreePorts: { enabled: true, slots: 1 } }));
    }
    await declareWorkload(root);
    async function readService(account: Account, workspaceRoot: string, sessionId?: string) {
      const result = await account.execute('localServices.launcher.snapshot', { machineId: project.machineId, workspaceRoot, ...(sessionId && { sessionId }) },
        { defaultSessionId: sessionId });
      if (!result.ok) throw new Error(`Worktree launcher read refused (${result.errorCode})`);
      const service = LocalServiceLauncherSnapshotV1Schema.parse(result.result).targets
        .find(row => row.declaration?.selection.kind === 'manifest' && row.declaration.selection.name === serviceName);
      if (!service) throw new Error('Worktree launcher omitted Capture app');
      return service;
    }
    async function startService(account: Account, service: Awaited<ReturnType<typeof readService>>, sessionId?: string) {
      const result = await account.executeReviewed('localServices.launcher.start', { machineId: project.machineId,
        targetId: service.id, workspace: service.workspace, declaration: service.declaration, ...(sessionId && { sessionId }) },
        { defaultSessionId: sessionId, presentUserConfirmation: { actionId: 'localServices.launcher.start' } });
      if (!result.ok) throw new Error(`Worktree Start refused (${result.errorCode})`);
      const launch = DaemonLocalServiceLauncherStartResponseV1Schema.parse(result.result);
      expect(launch.status).toBe('succeeded');
      if (!launch.currentTarget) throw new Error('Worktree launcher omitted the app lifetime');
      return launch.currentTarget;
    }
    const service = await readService(fixture.owner, root);
    const databaseTarget = DatabaseWorktreeTargetV1Schema.parse({ ...target,
      source: { kind: 'service', serviceId: service.id, variable: 'DATABASE_URL' },
    });
    expect(await fixture.executeDatabase(DATABASE_ACCESS_SET_ACTION_ID_V1, { target: databaseTarget, agentAccess: 'read' }))
      .toMatchObject({ ok: true, result: { ok: true, agentAccess: 'read' } });
    const headers = { Authorization: `Bearer ${fixture.owner.credentials.token}` };
    let materialization: { machineId: string; materializationId: string; pluginId: string } | undefined;
    await waitFor(async () => {
      const response = await fetchJson<unknown>(`${fixture.server.baseUrl}${PluginAvailabilityActionHttpPathsV1['account.plugins.availability.materializations.read']}`, {
        method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ pluginIds: [DATABASE_FINDING_EVENT_REF.pluginId] }),
      });
      expect(response.status).toBe(200);
      const snapshot = PluginAvailabilityMaterializationsReadActionOutputV1Schema.parse(response.data).snapshots
        .find(row => row.machineId === fixture.machine.target.machineId);
      const installed = snapshot?.materializations.find(row => row.pluginId === DATABASE_FINDING_EVENT_REF.pluginId
        && row.enabled && row.trustState === 'trusted');
      if (!installed) return false;
      materialization = { machineId: installed.machineId, materializationId: installed.materializationId,
        pluginId: installed.pluginId };
      return true;
    }, { context: 'The installed database Event source is published by its actual daemon' });
    if (!materialization) throw new Error('Database source materialization was not published');

    async function arm(subject: ReturnType<typeof projectAutomationDatabaseFindingSubjectV1>) {
      if (!materialization) throw new Error('Database source materialization was not published');
      const setup = await fixture.owner.execute('action.invoke', {
        action: { pluginId: DATABASE_FINDING_EVENT_REF.pluginId, localId: DATABASE_FINDING_SETUP_LOCAL_ID },
        input: { v: 1, subject, sourceScope: fixture.machine.target },
      }, { externalActionTarget: { kind: 'machine', machineId: fixture.machine.target.machineId },
        presentUserConfirmation: { actionId: 'action.invoke' } });
      expect(setup.ok, JSON.stringify(setup)).toBe(true);
      if (!setup.ok) throw new Error(`Database source setup refused (${setup.errorCode})`);
      const configuredSource = PluginEventAutomationSetupResultV1Schema.parse(setup.result);
      const eventSource = { kind: 'pluginEvent', eventRef: DATABASE_FINDING_EVENT_REF,
        sourceInstanceId: configuredSource.sourceInstanceId, sourceContractVersion: configuredSource.sourceContractVersion,
        sourceConfig: configuredSource.sourceConfig, displayLabel: configuredSource.displayLabel,
        observationTransport: { kind: 'checkpointedPull', watcherMaterializationRef: materialization },
        maximumObservationAgeMs: null };
      const armed = await fixture.owner.executeReviewed('workflow.trigger.add', {
        target: { kind: 'inline', definition: { version: 1, blocks: [
          { kind: 'action', id: 'read-starters', actionId: 'workflow.starters.list', input: {} },
        ] } },
        project: { machineId: fixture.machine.target.machineId, directory: fixture.machine.workspaceDir },
        trigger: { ...eventSource, enabled: true, filter: null },
      });
      expect(armed.ok, JSON.stringify(armed)).toBe(true);
      if (!armed.ok) throw new Error(`Database trigger refused (${armed.errorCode})`);
      return WorkflowActionOutputSchemasV1['workflow.trigger.add'].parse(armed.result).set.automationId;
    }
    const ownerAutomation = await arm(projectAutomationDatabaseFindingSubjectV1(fixture.serverId, databaseTarget));

    async function readRuns(automationId = ownerAutomation) {
      const arrival = await fixture.owner.execute('workflow.run.list', { origin: 'automation' });
      expect(arrival.ok, JSON.stringify(arrival)).toBe(true);
      if (!arrival.ok) throw new Error(`Run listing refused (${arrival.errorCode})`);
      return WorkflowActionOutputSchemasV1['workflow.run.list'].parse(arrival.result).runs.filter(row =>
        row.origin.kind === 'automation' && row.origin.automationId === automationId);
    }
    expect(await readRuns()).toEqual([]);
    await startService(fixture.owner, service);
    // Use the actual service's app endpoint, with no access to Capture's private ingest port.
    async function awaitEndpoint(account: Account, workspaceRoot: string, sessionId?: string) {
      let endpoint = '';
      await waitFor(async () => {
        const candidate = (await readService(account, workspaceRoot, sessionId)).endpointUrl;
        if (!candidate || !(await fetch(image ? new URL('/checkout', candidate) : candidate)).ok) return false;
        endpoint = candidate;
        return true;
      }, { context: 'Reviewed Worktree launch serves the Capture test workload' });
      return endpoint;
    }
    const endpoint = await awaitEndpoint(fixture.owner, root);
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
    await observed.text();
    await waitFor(async () => (await wireRows()).length > beforeObserving.length,
      { context: 'F7 M4 observing commit' });
    const observing = { requests: 1, retainedWireQueries: (await wireRows()).length - beforeObserving.length };
    expect(observing.retainedWireQueries).toBe(1);
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
      void requesting.catch(() => {});
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
      let traceId = '';
      await waitFor(async () => {
        const requests = DatabaseCaptureTracesListResultV1Schema.parse(await capture(DATABASE_CAPTURE_TRACES_LIST_ACTION_ID_V1,
          { source, page: { limit: 20 } }));
        if (!requests.ok) return false;
        traceId = requests.items.find(row => row.endpointRoute === '/orders' && row.serviceName === serviceName)?.traceId ?? '';
        return traceId.length > 0;
      }, { context: 'F7 SDK request visible through Traces Action' });
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
      console.info('Plan 85 exact Worktree Capture control', { traceId, wireQueries: queries.items.length });
      await waitFor(async () => {
        const runs = await readRuns();
        expect(runs.length).toBeLessThanOrEqual(1);
        return runs.length === 1 && runs[0]?.state === 'succeeded';
      }, { timeoutMs: 90_000, intervalMs: 100, failFast: true,
        context: 'The captured exact Worktree database finding completes a real Workflow Run' }).catch(error => {
        throw new Error(`Worktree finding made ${findingAdmissions.length} real Home Event admission attempts`,
          { cause: error });
      });
      expect(findingAdmissions).toEqual([200]);
      expect(await readRuns()).toHaveLength(1);

      // The guest and owner Services run concurrently on the same daemon under two real Accounts.
      const guest = await fixture.createAccount('guest-capture');
      const guestId = readAccountIdFromToken(guest.credentials.token);
      const ownerId = readAccountIdFromToken(fixture.owner.credentials.token);
      if (!guestId || !ownerId) throw new Error('Worktree Account identity unavailable');
      await setUsername(fixture.server.baseUrl, fixture.owner.credentials.token, 'plan85_owner');
      await setUsername(fixture.server.baseUrl, guest.credentials.token, 'plan85_guest');
      await addFriend(fixture.server.baseUrl, fixture.owner.credentials.token, guestId);
      await addFriend(fixture.server.baseUrl, guest.credentials.token, ownerId);
      expect(await fixture.owner.executeAsPerson('machines.access.grant.set', { ...fixture.machine.target,
        principal: { kind: 'account', accountId: guestId }, level: 'admin' })).toMatchObject({ ok: true });
      expect(await fixture.owner.executeAsPerson('machines.access.prepareKeys', fixture.machine.target))
        .toMatchObject({ ok: true, result: { kind: 'prepared' } });
      const guestRoot = join(root, 'guest-worktree');
      await declareWorkload(guestRoot);
      await cp(join(root, 'capture-app'), join(guestRoot, 'capture-app'), { recursive: true });
      const guestOpened = await guest.executeReviewed('projects.open', { ...fixture.machine.target,
        source: { kind: 'folder', path: guestRoot }, materialization: { kind: 'attach' } },
        { presentUserConfirmation: { actionId: 'projects.open' } });
      if (!guestOpened.ok) throw new Error(`Guest Project Open refused (${guestOpened.errorCode})`);
      const guestWorkspace = OpenProjectResultV1Schema.parse(guestOpened.result);
      if (guestWorkspace.kind !== 'opened' || !guestWorkspace.facts?.projectKey) throw new Error('Guest Project Open omitted the Worktree identity');
      const guestProject = { ...project, projectId: guestWorkspace.facts.projectKey };
      const guestSource = { kind: 'worktree' as const, ...guestProject, workspaceId: guestWorkspace.workspace.workspaceId };
      // Capture starts from the daemon Account's saved preference for this Project on the shared Machine.
      expect(await capture(DATABASE_CAPTURE_CONFIGURE_ACTION_ID_V1, { project: guestProject, enabled: true }))
        .toMatchObject({ ok: true, enabled: true });
      const guestWorkspaceControl = { target: fixture.machine.target, workspaceDir: guestRoot };
      const { sessionId } = await fixture.assertKnownGoodSessionControl(guest, guestWorkspaceControl);
      const guestService = await readService(guest, guestRoot, sessionId);
      const guestTarget = DatabaseWorktreeTargetV1Schema.parse({ ...databaseTarget, accountId: guestId,
        projectKey: guestProject.projectId, workspace: guestWorkspace.workspace,
        source: { kind: 'service', serviceId: guestService.id, variable: 'DATABASE_URL' } });
      // Arm the guest binding on the daemon's Event publisher too, so an incorrect fallback would make a Run.
      const guestAutomation = await arm(projectAutomationDatabaseFindingSubjectV1(fixture.serverId, guestTarget));
      await startService(guest, guestService, sessionId);
      const guestEndpoint = await awaitEndpoint(guest, guestRoot, sessionId);
      expect(guestEndpoint).not.toBe(endpoint);
      expect((await fetch(new URL('/measurement', endpoint))).ok).toBe(true);

      async function recordLocalFinding(account: Account, appEndpoint: string, worktreeSource: typeof source) {
        const baseline = await fetch(new URL('/flush', appEndpoint));
        expect(baseline.ok).toBe(true);
        const collecting = fetch(new URL('/orders?paceCapture=1', appEndpoint));
        void collecting.catch(() => {});
        for (const count of [1, 2, 3]) {
          await waitFor(async () => {
            const result = DatabaseCaptureQueriesListResultV1Schema.parse(await capture(DATABASE_CAPTURE_QUERIES_LIST_ACTION_ID_V1,
              { source: worktreeSource, page: { limit: 20 } }, account));
            return result.ok && result.items.filter(row => row.source === 'wire' && row.executionIdentity).length === count;
          }, { context: `Worktree commits tagged wire observation ${count}` });
          expect((await fetch(new URL('/f7/continue', appEndpoint), { method: 'POST' })).status).toBe(204);
        }
        expect((await collecting).status).toBe(200);
        const flushed = await fetch(new URL('/flush', appEndpoint));
        expect(await flushed.json()).toMatchObject({ failedBatches: 0 });
        let localTraceId = '';
        await waitFor(async () => {
          const traces = DatabaseCaptureTracesListResultV1Schema.parse(await capture(DATABASE_CAPTURE_TRACES_LIST_ACTION_ID_V1,
            { source: worktreeSource, page: { limit: 20 } }, account));
          if (!traces.ok) return false;
          localTraceId = traces.items.find(row => row.endpointRoute === '/orders')?.traceId ?? '';
          return localTraceId.length > 0;
        }, { context: 'Workbench lists the locally retained Worktree request' });
        expect(await capture(DATABASE_CAPTURE_TRACE_GET_ACTION_ID_V1,
          { source: worktreeSource, traceId: localTraceId, page: { limit: 20 } }, account)).toMatchObject({
          ok: true, findings: [{ kind: 'suspected_n_plus_one' }],
        });
        return localTraceId;
      }
      const guestTrace = await recordLocalFinding(guest, guestEndpoint, guestSource);
      expect(await capture(DATABASE_CAPTURE_TRACE_GET_ACTION_ID_V1,
        { source: guestSource, traceId: guestTrace, page: { limit: 20 } }, fixture.owner))
        .toMatchObject({ ok: false, code: 'capture_read_expired' });
      expect(await capture(DATABASE_CAPTURE_TRACE_GET_ACTION_ID_V1,
        { source, traceId, page: { limit: 20 } }, guest))
        .toMatchObject({ ok: false, code: 'capture_read_expired' });
      expect(await readRuns(guestAutomation)).toEqual([]);
      expect(findingAdmissions).toEqual([200]);

      expect(await capture(DATABASE_CAPTURE_CLEAR_ACTION_ID_V1, { source }, fixture.owner)).toEqual({ ok: true });
      expect(await capture(DATABASE_CAPTURE_TRACE_GET_ACTION_ID_V1,
        { source, databaseTarget, traceId, page: { limit: 20 } })).toMatchObject({ ok: false, code: 'capture_read_expired' });
      expect(await readRuns()).toHaveLength(1);
      expect(await readRuns(guestAutomation)).toEqual([]);
      expect(findingAdmissions).toEqual([200]);
    } else {
      throw new Error('Plan 85 replay requires the Linux SDK workload');
    }
  } finally {
    try { await fixture.stop(); }
    finally { if (image && imageBuilt) await execute('docker', ['image', 'rm', image], dockerOptions); }
  }
}, 0);
