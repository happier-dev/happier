import { randomUUID } from 'node:crypto';
import { createServer, request as requestHttp } from 'node:http';
import { readFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';

import { DeploymentActionOutputSchemasV1 } from '@happier-dev/protocol';
import { databaseActionLocalIdV1 } from '@happier-dev/database-protocol';
import { TELEMETRY_EXPORT_ENVIRONMENT_KEYS_V1 } from '@happier-dev/deployments/telemetry';
import { PluginEventAutomationSetupResultV1Schema } from '@happier-dev/protocol/automations/event-setup-result';
import { DEPLOYMENT_RECEIPT_EVENT_REFS_V1, DeploymentReceiptEventSetupV1Schema } from '@happier-dev/protocol/deployments/deploymentReceiptEventsV1';
import { MachineInstallationIdentityV1Schema } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { MachineResourcesPolicyGetResultV1Schema, MachineResourcesPolicyMutationResultV1Schema } from '@happier-dev/protocol/machines/resources/machineResourcesPolicyV1';
import { DATABASE_TELEMETRY_MACHINE_ROLE_ID_V1, MachineRolesGetResultV1Schema } from '@happier-dev/protocol/machines/roles/machineRolesV1';
import { PluginAvailabilityActionHttpPathsV1, PluginAvailabilityMaterializationsReadActionOutputV1Schema } from '@happier-dev/protocol/plugins/availability/actions';
import { WORKFLOW_TRIGGER_ADD_ACTION_ID } from '@happier-dev/protocol/actions/workflowTriggerActionIds';
import { WorkflowActionOutputSchemasV1 } from '@happier-dev/protocol/workflows/actionsV1';
import { formatWorkflowDefinitionRefV1 } from '@happier-dev/protocol/workflows/workflowDefinitionRefV1';
import { projectWorkflowPluginSourceV1 } from '@happier-dev/protocol/workflows/workflowPluginSourceContractV1';
import { createOwnServerDockerBoundary } from '../../../../apps/cli/src/deployments/targets/ownServer/ownServerDeployment.testkit';
import { TELEMETRY_REGRESSIONS_COMPARE_ACTION_ID_V1, TELEMETRY_REGRESSIONS_SCHEDULE_ACTION_ID_V1 } from '@happier-dev/database-protocol';
import { regressionCompareResultSchema } from '../../../plugins/telemetry/src/regressionSchemas';
import { TELEMETRY_REGRESSION_WORKFLOW_ID_V1 } from '../../../plugins/telemetry/src/regressionWorkflow';
import { startDatabaseWorkbenchFixture } from '../../src/testkit/databaseWorkbench';
import { applyTrustedLocalPluginFixture } from '../../src/testkit/externalSessionLiveLifecycleFixture';
import { fetchJson } from '../../src/testkit/http';
import { FAKE_CLAUDE_OBSERVATION_TIMEOUT_MS } from '../../src/testkit/fakeClaude';
import { repoRootDir } from '../../src/testkit/paths';
import { createRunDirs } from '../../src/testkit/runDir';
import { runFreshDeploymentSourceSmoke } from '../../src/scenarios/deployments.scenario';
import { waitFor } from '../../src/testkit/timing';

const run = createRunDirs({ runLabel: 'core' });

// P7 §10: falsify the existing unattended consent path separately, before
// interpreting any failure in the complete deployment journey below.
it('P7-F16 an approved scheduled Run adds one once trigger to its own saved Workflow', async () => {
  const fixture = await startDatabaseWorkbenchFixture({ testDir: run.testDir('dbw-regression-f16'),
    serverEnv: { HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1', HAPPIER_FEATURE_WORKFLOWS__ENABLED: '1' } });
  try {
    const owner = await fixture.createAccount('regression-owner');
    await fixture.claimHomeOwner(owner);
    const machine = await fixture.enrollDaemon(owner, { env: {
      HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1', HAPPIER_FEATURE_WORKFLOWS__ENABLED: '1',
    } });
    const project = { machineId: machine.target.machineId, directory: machine.workspaceDir };
    const armed = await owner.execute(WORKFLOW_TRIGGER_ADD_ACTION_ID, {
      target: { kind: 'inline', definition: { version: 1, blocks: [
        { kind: 'action', id: 'control', actionId: 'workflow.starters.list', input: {} },
      ] } }, project,
      trigger: { kind: 'schedule', enabled: true, schedule: { kind: 'once', scheduledAt: Date.now() } },
    }, { presentUserConfirmation: { actionId: WORKFLOW_TRIGGER_ADD_ACTION_ID } });
    expect(armed.ok, JSON.stringify(armed)).toBe(true);
    if (!armed.ok) throw new Error(`F16 control arming refused (${armed.errorCode})`);
    const control = WorkflowActionOutputSchemasV1[WORKFLOW_TRIGGER_ADD_ACTION_ID].parse(armed.result);
    async function completedRun(automationId: string) {
      const arrival = await owner.execute('workflow.run.list', { origin: 'automation' });
      expect(arrival.ok, JSON.stringify(arrival)).toBe(true);
      if (!arrival.ok) throw new Error(`F16 Run read refused (${arrival.errorCode})`);
      const runs = WorkflowActionOutputSchemasV1['workflow.run.list'].parse(arrival.result).runs.filter(row =>
        row.origin.kind === 'automation' && row.origin.automationId === automationId);
      const settled = runs.find(row => row.state === 'failed' || row.state === 'succeeded');
      if (settled) expect(settled.state, JSON.stringify(settled)).toBe('succeeded');
      return settled !== undefined;
    }
    // G1: the same real Postgres Home and daemon must complete a scheduled
    // Workflow before any consent refusal counts as evidence.
    await waitFor(() => completedRun(control.set.automationId), { failFast: true,
      context: 'F16 known-good scheduled Workflow control' });
    console.info('P7-F16-known-good-scheduled-run passed');

    const definitionId = randomUUID();
    // An explicit absolute instant isolates consent. Computing an instant from
    // each deploy's observedAt is a separate producer, not a fixture substitute.
    const scheduledAt = Date.UTC(2099, 0, 1);
    const saved = await owner.execute('workflow.definition.create', { definitionId,
      metadata: { title: 'Regression schedule consent probe' },
      definition: { version: 1, blocks: [
        { kind: 'action', id: 'schedule', actionId: WORKFLOW_TRIGGER_ADD_ACTION_ID, input: {
          workflow: { kind: 'literal', value: definitionId },
          project: { kind: 'literal', value: project },
          trigger: { kind: 'literal', value: { kind: 'schedule', enabled: true,
            schedule: { kind: 'once', scheduledAt } } },
        } },
      ] } });
    expect(saved.ok, JSON.stringify(saved)).toBe(true);
    // The signed-in person saves the standing consent in the native trigger owner.
    const started = await owner.execute(WORKFLOW_TRIGGER_ADD_ACTION_ID, {
      workflow: definitionId, project, actionApproval: 'automatic',
      trigger: { kind: 'schedule', enabled: true, schedule: { kind: 'once', scheduledAt: Date.now() } },
    }, { presentUserConfirmation: { actionId: WORKFLOW_TRIGGER_ADD_ACTION_ID } });
    expect(started.ok, JSON.stringify(started)).toBe(true);
    if (!started.ok) throw new Error(`F16 approved arming refused (${started.errorCode})`);
    const schedule = WorkflowActionOutputSchemasV1[WORKFLOW_TRIGGER_ADD_ACTION_ID].parse(started.result);
    await waitFor(() => completedRun(schedule.set.automationId), { failFast: true,
      context: 'F16 unattended automationRun adds a once schedule under existing consent' });
    const listed = await owner.execute('workflow.trigger.list', { workflow: definitionId });
    expect(listed.ok, JSON.stringify(listed)).toBe(true);
    if (!listed.ok) throw new Error(`F16 trigger read refused (${listed.errorCode})`);
    const sets = WorkflowActionOutputSchemasV1['workflow.trigger.list'].parse(listed.result).sets;
    expect(sets).toHaveLength(1);
    expect(sets[0]?.automationId).toBe(schedule.set.automationId);
    expect(sets[0]?.triggers.filter(trigger => trigger.kind === 'schedule'
      && trigger.schedule.kind === 'once' && trigger.schedule.scheduledAt === scheduledAt)).toHaveLength(1);
  } finally { await fixture.stop(); }
}, 0);

// Docker and the coding vendor executable are the only substituted boundaries.
// Account credentials, Home/Postgres, enrolled daemon, deployment receipts,
// exporter-token admission, retained metrics, Workflow worker and Session run real.
it('P7-F16 a deployment schedules one check whose firing compares the intervening live deployment and starts a diagnosis Session', async () => {
  const testDir = run.testDir('dbw-regression-f16-journey');
  const docker = await createOwnServerDockerBoundary(join(testDir, 'docker-boundary'));
  const image = await docker.registerImage('checkout', 'f16');
  const fixture = await startDatabaseWorkbenchFixture({ testDir,
    serverEnv: { HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1', HAPPIER_FEATURE_WORKFLOWS__ENABLED: '1' } });
  let stopWorkload: (() => Promise<void>) | undefined;
  try {
    const { account, machine, sourceId } = await runFreshDeploymentSourceSmoke(fixture, { env: {
      PATH: `${join(testDir, 'docker-boundary')}${delimiter}${process.env.PATH ?? ''}`,
      HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1', HAPPIER_FEATURE_WORKFLOWS__ENABLED: '1',
    } });
    await fixture.claimHomeOwner(account);
    await fixture.assertKnownGoodSessionControl(account, machine);
    const machineId = machine.target.machineId;
    const project = { machineId, directory: machine.workspaceDir };
    const onMachine = { externalActionTarget: { kind: 'machine' as const, machineId } };
    const control = await account.execute(WORKFLOW_TRIGGER_ADD_ACTION_ID, {
      target: { kind: 'inline', definition: { version: 1, blocks: [
        { kind: 'action', id: 'control', actionId: 'workflow.starters.list', input: {} },
      ] } }, project, trigger: { kind: 'schedule', enabled: true, schedule: { kind: 'once', scheduledAt: Date.now() } },
    }, { presentUserConfirmation: { actionId: WORKFLOW_TRIGGER_ADD_ACTION_ID } });
    if (!control.ok) throw new Error(`F16 G1 arming refused (${control.errorCode})`);
    const controlSet = WorkflowActionOutputSchemasV1[WORKFLOW_TRIGGER_ADD_ACTION_ID].parse(control.result);
    async function runs(automationId: string) {
      const read = await account.execute('workflow.run.list', { origin: 'automation' });
      if (!read.ok) throw new Error(`F16 Run read refused (${read.errorCode})`);
      return WorkflowActionOutputSchemasV1['workflow.run.list'].parse(read.result).runs.filter(row =>
        row.origin.kind === 'automation' && row.origin.automationId === automationId);
    }
    await waitFor(async () => {
      const observed = await runs(controlSet.set.automationId);
      expect(observed.find(row => row.state === 'failed')).toBeUndefined();
      return observed.some(row => row.state === 'succeeded');
    }, { failFast: true, context: 'F16 G1 actual scheduled Workflow on the credentialed Home and daemon' });
    console.info('P7-F16-G1-scheduled-and-Agent-controls passed');

    // The ephemeral Machine retains only this test's small export. Set its
    // disk reserve explicitly so fleet disk occupancy does not select the
    // default product policy for this regression journey.
    const resources = await account.execute('machines.resources.policy.get', machine.target);
    if (!resources.ok) throw new Error(`F16 Machine resource policy read refused (${resources.errorCode})`);
    const resourcePolicy = MachineResourcesPolicyGetResultV1Schema.parse(resources.result);
    if (resourcePolicy.status !== 'ready') throw new Error(`F16 Machine resource policy unavailable (${resourcePolicy.status})`);
    const reserve = await account.executeReviewed('machines.resources.policy.set', {
      ...machine.target, expectedRevision: resourcePolicy.revision,
      patch: { alerts: { disk: { threshold: { freeFraction: 0.01 } } } },
    }, { presentUserConfirmation: { actionId: 'machines.resources.policy.set' } });
    if (!reserve.ok) throw new Error(`F16 Machine disk reserve refused (${reserve.errorCode})`);
    expect(MachineResourcesPolicyMutationResultV1Schema.parse(reserve.result)).toMatchObject({ status: 'applied' });

    await applyTrustedLocalPluginFixture({ daemonPort: machine.daemon.state.httpPort,
      controlToken: machine.daemon.state.controlToken, pluginRoot: join(repoRootDir(), 'packages/plugins/telemetry'),
      pluginId: 'happier.telemetry', interactionId: 'f16-install-collector' });
    const roles = await account.execute('machines.roles.get', { serverId: fixture.serverId, machineId });
    if (!roles.ok) throw new Error(`F16 role read refused (${roles.errorCode})`);
    const policy = MachineRolesGetResultV1Schema.parse(roles.result);
    if (policy.status !== 'ready') throw new Error(`F16 roles unavailable (${policy.status})`);
    expect(await account.executeReviewed('machines.roles.set', { serverId: fixture.serverId, machineId,
      expectedPolicy: policy.policy, expectedMetadataVersion: policy.metadataVersion,
      policy: { active: [...policy.policy.active, DATABASE_TELEMETRY_MACHINE_ROLE_ID_V1] },
    }, { presentUserConfirmation: { actionId: 'machines.roles.set' } })).toMatchObject({ ok: true });
    const checkoutComposeDocument = (imageReference: string) => JSON.stringify({ services: { checkout: {
      image: imageReference,
      environment: Object.fromEntries(TELEMETRY_EXPORT_ENVIRONMENT_KEYS_V1.map(key => [key, null])),
    } } });
    const created = await account.executeReviewed('deployments.environments.create', {
      serverId: fixture.serverId, projectSourceId: sourceId, requestKey: randomUUID(), name: 'F16 checkout',
      retainPreviousDeployments: 2, definition: { from: 'compose', profiles: [], services: ['checkout'],
        document: checkoutComposeDocument(image.registryReference) },
      protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers',
      controllerMachineId: machineId, buildMachineId: machineId,
    }, { ...onMachine, presentUserConfirmation: { actionId: 'deployments.environments.create' } });
    if (!created.ok) throw new Error(`F16 Environment create refused (${created.errorCode})`);
    const environment = DeploymentActionOutputSchemasV1['deployments.environments.create'].parse(created.result);
    if (!environment.ok) throw new Error(`F16 Environment unavailable (${environment.error})`);
    const environmentId = environment.environmentId;
    const address = { serverId: fixture.serverId, environmentId };
    const identity = MachineInstallationIdentityV1Schema.parse(JSON.parse(await readFile(join(machine.homeDir, 'installation-identity.json'), 'utf8')));
    const linked = await account.executeReviewed('deployments.targets.link', { ...address, expectedRevision: environment.revision,
      requestKey: randomUUID(), targetId: 'own-server', role: 'runtime',
      machines: [{ machineId, installationId: identity.installationId }],
    }, { ...onMachine, presentUserConfirmation: { actionId: 'deployments.targets.link' } });
    if (!linked.ok) throw new Error(`F16 target link refused (${linked.errorCode})`);
    const target = DeploymentActionOutputSchemasV1['deployments.targets.link'].parse(linked.result);
    if (!target.ok) throw new Error(`F16 target unavailable (${target.error})`);
    expect(await account.executeReviewed('deployments.environments.telemetry.set', { ...address, expectedRevision: target.revision,
      collector: { machineId }, capabilities: { metrics: true, appLlmCost: false, exceptions: false },
    }, { ...onMachine, presentUserConfirmation: { actionId: 'deployments.environments.telemetry.set' } }))
      .toMatchObject({ ok: true, result: { ok: true, state: 'redeploy_required' } });
    async function deploy() {
      const result = await account.executeReviewed('deployments.deploy', { ...address, targetLinkId: target.targetLinkId },
        { ...onMachine, presentUserConfirmation: { actionId: 'deployments.deploy' } });
      if (!result.ok) throw new Error(`F16 native deploy refused (${JSON.stringify(result)})`);
      const receipt = DeploymentActionOutputSchemasV1['deployments.deploy'].parse(result.result);
      if (!receipt.ok || !('deploymentId' in receipt)) throw new Error('F16 settled native deployment required');
      expect(receipt.state).toBe('succeeded');
      const delivered = await docker.readRuntimeEnvironment('checkout');
      expect(Boolean(delivered.OTEL_EXPORTER_OTLP_ENDPOINT && delivered.OTEL_EXPORTER_OTLP_HEADERS),
        'The active checkout deployment must receive its declared collector endpoint and auth headers').toBe(true);
      return receipt.deploymentId;
    }
    const baselineId = await deploy();

    const definitionId = randomUUID();
    const recipeRef = formatWorkflowDefinitionRefV1({ kind: 'plugin',
      contribution: { pluginId: 'happier.telemetry', localId: TELEMETRY_REGRESSION_WORKFLOW_ID_V1 } });
    const { connectUiActionClient, readUiMachineProjection } = await import('@happier-tests/ui-action-client');
    const ui = await connectUiActionClient({ serverUrl: fixture.server.baseUrl, credentials: account.uiCredentials });
    let recipe: ReturnType<typeof projectWorkflowPluginSourceV1> | undefined;
    try {
      const catalog = await readUiMachineProjection({
        machineId, serverId: ui.serverId, sections: ['familiesById.workflows'],
      });
      if (catalog?.kind !== 'ready') throw new Error(`F16 installed Workflow catalog unavailable (${catalog?.kind ?? 'absent'})`);
      const candidates = Object.values(catalog.inputs.pluginProjectionV2?.familiesById.workflows?.entriesById ?? {})
        .filter(row => row.pluginId === 'happier.telemetry' && row.definition.id === TELEMETRY_REGRESSION_WORKFLOW_ID_V1);
      expect(candidates).toHaveLength(1);
      const candidate = candidates[0];
      if (candidate?.pluginId) recipe = projectWorkflowPluginSourceV1({ pluginId: candidate.pluginId,
        pluginVersion: candidate.pluginVersion, definition: candidate.definition });
    } finally { await ui.close(); }
    if (!recipe || recipe.workflow !== recipeRef) throw new Error('F16 installed telemetry recipe was not published');
    expect(await account.execute('workflow.definition.create', { definitionId, metadata: { title: 'F16 regression journey' },
      definition: recipe.definition })).toMatchObject({ ok: true });
    const eventRef = DEPLOYMENT_RECEIPT_EVENT_REFS_V1.succeeded;
    let watcherMaterializationRef: { machineId: string; materializationId: string; pluginId: string } | undefined;
    await waitFor(async () => {
      const response = await fetchJson<unknown>(`${fixture.server.baseUrl}${PluginAvailabilityActionHttpPathsV1['account.plugins.availability.materializations.read']}`, {
        method: 'POST', headers: { Authorization: `Bearer ${account.credentials.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ pluginIds: [eventRef.pluginId] }),
      });
      expect(response.status).toBe(200);
      const installed = PluginAvailabilityMaterializationsReadActionOutputV1Schema.parse(response.data).snapshots
        .find(row => row.machineId === machineId)?.materializations.find(row => row.pluginId === eventRef.pluginId && row.enabled && row.trustState === 'trusted');
      if (!installed) return false;
      watcherMaterializationRef = { machineId, materializationId: installed.materializationId, pluginId: installed.pluginId };
      return true;
    }, { context: 'F16 actual installed deployment Event observer' });
    if (!watcherMaterializationRef) throw new Error('F16 deployment Event materialization unavailable');
    const setup = await account.execute('action.invoke', {
      action: { pluginId: eventRef.pluginId, localId: `${eventRef.localId}/setup` },
      input: DeploymentReceiptEventSetupV1Schema.parse({ v: 1, ...address, targetLinkId: target.targetLinkId }),
    }, onMachine);
    if (!setup.ok) throw new Error(`F16 Event setup refused (${setup.errorCode})`);
    const source = PluginEventAutomationSetupResultV1Schema.parse(setup.result);
    // The composed runner observed more than a minute between deploy requests.
    // Leave room for the intervening deploy to settle before the first check.
    const observationDelayMs = 120_000;
    // The retained export cadence reached four seconds under runner load.
    const windowMs = 10_000;
    const armed = await account.execute(WORKFLOW_TRIGGER_ADD_ACTION_ID, { workflow: definitionId, project,
      actionApproval: 'automatic', inputs: { configuration: { ...address, serviceName: 'checkout', workflow: definitionId,
        project, windowMs, observationDelayMs, changePercent: 50,
        measure: { kind: 'route', routes: [{ method: 'POST', route: '/checkout' }], statistic: 'p95' } },
      diagnosis: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } } },
      trigger: { kind: 'pluginEvent', enabled: true, eventRef, sourceInstanceId: source.sourceInstanceId,
        sourceContractVersion: source.sourceContractVersion, sourceConfig: source.sourceConfig,
        displayLabel: source.displayLabel, filter: null, maximumObservationAgeMs: null,
        observationTransport: { kind: 'checkpointedPull', watcherMaterializationRef } },
    }, { ...onMachine, presentUserConfirmation: { actionId: WORKFLOW_TRIGGER_ADD_ACTION_ID } });
    if (!armed.ok) throw new Error(`F16 Event arm refused (${armed.errorCode})`);
    const saved = WorkflowActionOutputSchemasV1[WORKFLOW_TRIGGER_ADD_ACTION_ID].parse(armed.result);
    async function readTriggerSet() {
      const result = await account.execute('workflow.trigger.list', { workflow: definitionId });
      if (!result.ok) throw new Error(`F16 trigger read refused (${result.errorCode})`);
      const sets = WorkflowActionOutputSchemasV1['workflow.trigger.list'].parse(result.result).sets;
      expect(sets).toHaveLength(1);
      expect(sets[0]?.automationId).toBe(saved.set.automationId);
      return sets[0]!;
    }
    const readTriggers = async () => (await readTriggerSet()).triggers;
    // Substitute the app and HAProxy containers at the Docker boundary. The
    // deployed hostname selects the real relay socket, which forwards the
    // injected token and histogram through the ordinary collector receiver.
    let slow = false;
    let exporterVersion = 'exporter-fixture-version';
    let previousRequestAt = Date.now();
    const observeRequest = (until: number) => ({
      resource: { attributes: [
        { key: 'service.name', value: { stringValue: 'checkout' } },
        { key: 'service.version', value: { stringValue: exporterVersion } },
        { key: 'service.instance.id', value: { stringValue: 'checkout-one' } },
      ] }, scopeMetrics: [{ scope: { name: 'f16-checkout-exporter', version: '1' }, metrics: [{
        name: 'http.server.request.duration', unit: 's', histogram: { aggregationTemporality: 1, dataPoints: [{
          startTimeUnixNano: String(BigInt(previousRequestAt) * 1_000_000n), timeUnixNano: String(BigInt(until) * 1_000_000n),
          count: '1', explicitBounds: [0.01, 0.1], bucketCounts: slow ? ['0', '1', '0'] : ['1', '0', '0'],
          attributes: [{ key: 'http.request.method', value: { stringValue: 'POST' } },
            { key: 'http.route', value: { stringValue: '/checkout' } }],
        }] },
      }] }],
    });
    const samples: Array<{ until: number; metric: ReturnType<typeof observeRequest> }> = [];
    const app = createServer((_request, response) => {
      const until = Date.now();
      if (until > previousRequestAt) {
        samples.push({ until, metric: observeRequest(until) });
        previousRequestAt = until;
      }
      response.end('checkout');
    });
    await new Promise<void>(resolve => app.listen(0, '127.0.0.1', resolve));
    const traffic = new AbortController();
    const endpoint = app.address();
    if (!endpoint || typeof endpoint === 'string') throw new Error('F16 workload endpoint unavailable');
    const trafficIntervalMs = 1_000;
    const sending = (async () => {
      while (!traffic.signal.aborted) {
        try {
          const result = await fetch(`http://127.0.0.1:${endpoint.port}/checkout`, { method: 'POST', signal: traffic.signal });
          await result.arrayBuffer();
        } catch (error) {
          if (!traffic.signal.aborted) throw error;
        }
        await delay(trafficIntervalMs);
      }
    })();

    let lastExportStatus: number | undefined;
    let lastExportAt = 0;
    const exporting = (async () => {
      while (!traffic.signal.aborted) {
        const batch = samples.slice();
        if (batch.length) {
          try {
            const env = await docker.readRuntimeEnvironment('checkout');
            const collector = new URL('/v1/metrics', env.OTEL_EXPORTER_OTLP_ENDPOINT);
            const socketPath = await docker.readPrivateRelaySocketPath(collector.hostname);
            const headers = Object.fromEntries((env.OTEL_EXPORTER_OTLP_HEADERS ?? '').split(',').filter(Boolean).map(header => {
              const equals = header.indexOf('=');
              return [header.slice(0, equals), decodeURIComponent(header.slice(equals + 1))];
            }));
            lastExportStatus = await new Promise<number>((resolve, reject) => {
              const exporter = requestHttp({ socketPath, method: 'POST', path: collector.pathname, signal: traffic.signal,
                headers: { ...headers, Host: collector.host, 'Content-Type': 'application/json' } }, exported => {
                exported.once('error', reject);
                exported.once('end', () => resolve(exported.statusCode ?? 502));
                exported.resume();
              });
              exporter.once('error', reject);
              exporter.end(JSON.stringify({ resourceMetrics: batch.map(sample => sample.metric) }));
            });
            // Retry rejected and ambiguous responses with unchanged point IDs.
            // App requests continue to record their own intervals during export.
            if (lastExportStatus === 200) {
              samples.splice(0, batch.length);
              lastExportAt = batch.at(-1)!.until;
            }
          } catch {
            lastExportStatus = undefined;
          }
        }
        await delay(trafficIntervalMs);
      }
    })();
    stopWorkload = async () => {
      traffic.abort();
      try { await Promise.all([sending, exporting]); }
      finally { await new Promise<void>((resolve, reject) => app.close(error => error ? reject(error) : resolve())); }
    };
    const readTrafficWindow = (since: number, context: string) => waitFor(() => {
      expect(lastExportStatus).toBe(200);
      return lastExportAt >= since + windowMs;
    }, { context, timeoutMs: observationDelayMs });
    await readTrafficWindow(Date.now(), 'F16 same-route baseline traffic');
    const armedId = await deploy();
    let schedulingRunId: string | undefined;
    await waitFor(async () => {
      const admitted = await runs(saved.set.automationId);
      if (admitted.length === 0) return false;
      expect(admitted).toHaveLength(1);
      schedulingRunId = admitted[0]?.id;
      return schedulingRunId !== undefined;
    }, { failFast: true, timeoutMs: observationDelayMs, context: 'F16 deployment Event admits one Workflow Run' });
    const scheduled = await account.execute('workflow.run.wait', {
      runId: schedulingRunId, conditions: ['terminal', 'attention'], timeoutSeconds: observationDelayMs / 1000,
    });
    if (!scheduled.ok) throw new Error(`F16 scheduling Run wait refused (${scheduled.errorCode})`);
    const scheduling = WorkflowActionOutputSchemasV1['workflow.run.wait'].parse(scheduled.result);
    async function readInvocations(runId: string) {
      const detail = await account.execute('workflow.run.invocations.list', { runId, includeContent: true });
      if (!detail.ok) throw new Error(`F16 invocation read refused (${detail.errorCode})`);
      return WorkflowActionOutputSchemasV1['workflow.run.invocations.list'].parse(detail.result);
    }
    if (scheduling.observation !== 'terminal' || scheduling.run.state !== 'succeeded') {
      const history = await readInvocations(scheduling.run.id);
      const invocations = history.invocationDetails?.map(({ index, progress }) => ({
        lifecycle: index.lifecycle, blockId: progress.invocationPath.blockId,
        reason: progress.reason?.code, cause: progress.reason?.failureCause,
      }));
      throw new Error(`F16 scheduling Run ${scheduling.run.id}: ${JSON.stringify({
        observation: scheduling.observation, state: scheduling.run.state, error: scheduling.run.errorCode, invocations,
      })}`);
    }
    const armedReceipt = await account.execute('deployments.receipts.get', { ...address, deploymentId: armedId });
    if (!armedReceipt.ok) throw new Error(`F16 scheduled receipt read refused (${armedReceipt.errorCode})`);
    const finished = DeploymentActionOutputSchemasV1['deployments.receipts.get'].parse(armedReceipt.result);
    if (!finished.ok || finished.deployment.settledAtMs === undefined) throw new Error('F16 finished receipt unavailable');
    const scheduledAt = finished.deployment.settledAtMs + observationDelayMs;
    const history = await readInvocations(scheduling.run.id);
    const producer = history.invocationDetails?.find(row => row.progress.execution?.kind === 'action'
      && row.progress.execution.actionId === TELEMETRY_REGRESSIONS_SCHEDULE_ACTION_ID_V1);
    expect(producer?.progress.result).toEqual({ kind: 'schedule', enabled: true,
      schedule: { kind: 'once', scheduledAt } });
    const scheduleWrite = history.invocationDetails?.find(row => row.progress.execution?.kind === 'action'
      && row.progress.execution.actionId === WORKFLOW_TRIGGER_ADD_ACTION_ID);
    const once = WorkflowActionOutputSchemasV1[WORKFLOW_TRIGGER_ADD_ACTION_ID].parse(scheduleWrite?.progress.result);
    expect(once.set.automationId).toBe(saved.set.automationId);
    expect(once.triggerId).toBeDefined();
    expect((await readTriggers()).filter(row => row.kind === 'schedule')).toMatchObject([
      { id: once.triggerId, kind: 'schedule', schedule: { kind: 'once', scheduledAt } },
    ]);
    console.info('P7-F16 receipt-derived native same-Workflow once trigger created');

    const liveId = await deploy();
    expect(new Set([baselineId, armedId, liveId]).size).toBe(3);
    slow = true;
    await waitFor(async () => (await readTriggers()).filter(row => row.kind === 'schedule').length === 2,
      { context: 'F16 intervening deployment has its own single finite schedule' });
    let diagnosisSessionId: string | undefined;
    await waitFor(async () => {
      for (const candidate of await runs(saved.set.automationId)) {
        const history = await readInvocations(candidate.id);
        const comparison = history.invocationDetails?.find(row => row.progress.execution?.kind === 'action'
          && row.progress.execution.actionId === TELEMETRY_REGRESSIONS_COMPARE_ACTION_ID_V1);
        if (!comparison || candidate.origin.kind !== 'automation' || candidate.origin.cause?.kind !== 'trigger'
          || candidate.origin.cause.triggerId !== once.triggerId) continue;
        expect(candidate.origin.cause).toMatchObject({ triggerKind: 'schedule', evidence: { scheduledFor: scheduledAt } });
        if (comparison.progress.result === undefined) continue;
        const compared = regressionCompareResultSchema.parse(comparison.progress.result);
        expect(compared, compared.status === 'inconclusive' ? compared.reasons.join(', ') : undefined)
          .toMatchObject({ status: 'comparable', liveDeploymentId: liveId,
            previousDeploymentId: armedId, changePercent: expect.any(Number) });
        const diagnosis = history.invocationDetails?.find(row => row.progress.execution?.kind === 'session');
        if (diagnosis?.progress.execution?.kind !== 'session') continue;
        diagnosisSessionId = diagnosis.progress.execution.sessionId;
        expect(candidate.state, JSON.stringify(candidate)).not.toBe('failed');
        return candidate.state === 'succeeded';
      }
      return false;
    }, { failFast: true, timeoutMs: observationDelayMs + FAKE_CLAUDE_OBSERVATION_TIMEOUT_MS,
      context: 'F16 firing reads current history, compares retained traffic and completes a real diagnosis Session' });
    if (!diagnosisSessionId) throw new Error('F16 diagnosis Session unavailable');
    expect((await account.readSessionMetadata(diagnosisSessionId)).machineId).toBe(machineId);
    await fixture.assertSessionAgentOutput(account, diagnosisSessionId);
    console.info('P7-F16 once trigger fired; comparison and diagnosis Session completed');
    // The comparison/condition/Session branch must add no further schedule.
    expect((await readTriggers()).filter(row => row.kind === 'schedule')).toHaveLength(2);

    await waitFor(async () => {
      const schedules = (await readTriggers()).filter(row => row.kind === 'schedule');
      expect(schedules).toHaveLength(2);
      return schedules.every(row => row.remainingOccurrences === 0 && row.nextRunAt === null)
        && (await runs(saved.set.automationId)).every(row => row.state === 'succeeded');
    }, { timeoutMs: observationDelayMs + FAKE_CLAUDE_OBSERVATION_TIMEOUT_MS,
      context: 'F16 both native once triggers are spent and inert after their admitted checks settle' });
    const spent = await readTriggerSet();
    expect(spent.triggers.filter(row => row.kind === 'schedule')).toEqual([
      expect.objectContaining({ remainingOccurrences: 0, nextRunAt: null }),
      expect.objectContaining({ remainingOccurrences: 0, nextRunAt: null }),
    ]);
    const settledRunIds = (await runs(saved.set.automationId)).map(row => row.id).sort();
    expect(settledRunIds).toHaveLength(4); // two deploy branches and two finite checks
    const disarmed = await account.execute('workflow.trigger.update', { automationId: saved.set.automationId,
      expectedRevision: spent.revision, patch: { enabled: false },
    }, { presentUserConfirmation: { actionId: 'workflow.trigger.update' } });
    if (!disarmed.ok) throw new Error(`F16 disarm refused (${disarmed.errorCode})`);
    expect(WorkflowActionOutputSchemasV1['workflow.trigger.update'].parse(disarmed.result).set.enabled).toBe(false);

    // Model the approved app fix at the substituted image boundary, then deploy
    // it through the same native owner. No Workflow, metric or comparison state
    // is altered by the fixture, and the same /checkout workload verifies it.
    const fixedImage = await docker.registerImage('checkout', 'f16-fixed');
    const currentEnvironment = await account.execute('deployments.environments.get', address);
    if (!currentEnvironment.ok) throw new Error(`F16 fix Environment read refused (${currentEnvironment.errorCode})`);
    const current = DeploymentActionOutputSchemasV1['deployments.environments.get'].parse(currentEnvironment.result);
    if (!current.ok) throw new Error(`F16 fix Environment unavailable (${current.error})`);
    const updated = await account.executeReviewed('deployments.environments.update', {
      ...address, expectedRevision: current.environment.revision,
      contentArtifactId: current.environment.contentArtifactId,
      contentHeaderVersion: current.environment.contentHeaderVersion,
      contentBodyVersion: current.environment.contentBodyVersion,
      patch: { definition: { from: 'compose', profiles: [], services: ['checkout'],
        document: checkoutComposeDocument(fixedImage.registryReference) } },
    }, { ...onMachine, presentUserConfirmation: { actionId: 'deployments.environments.update' } });
    expect(updated.ok, JSON.stringify(updated)).toBe(true);
    const fixedId = await deploy();
    expect(fixedId).not.toBe(liveId);
    expect(await docker.readRunningImageConfig('checkout')).toBe(fixedImage.configDigest);
    slow = false;
    exporterVersion = 'exporter-fixture-fixed';
    await readTrafficWindow(Date.now(), 'F16 same route exercises the fixed version for the authored comparison window');
    const recovered = await account.execute('action.invoke', { action: { pluginId: 'happier.telemetry',
      localId: databaseActionLocalIdV1(TELEMETRY_REGRESSIONS_COMPARE_ACTION_ID_V1) },
      input: { ...address, serviceName: 'checkout', windowMs,
        measure: { kind: 'route', routes: [{ method: 'POST', route: '/checkout' }], statistic: 'p95' } },
    }, onMachine);
    if (!recovered.ok) throw new Error(`F16 recovery comparison refused (${recovered.errorCode})`);
    const recovery = regressionCompareResultSchema.parse(recovered.result);
    expect(recovery, recovery.status === 'inconclusive' ? recovery.reasons.join(', ') : undefined)
      .toMatchObject({ status: 'comparable', liveDeploymentId: fixedId, previousDeploymentId: liveId });
    if (recovery.status !== 'comparable') throw new Error('F16 fixed-version comparison was inconclusive');
    expect(recovery.changePercent).not.toBeNull();
    expect(recovery.changePercent!).toBeLessThan(0);
    expect((await runs(saved.set.automationId)).map(row => row.id).sort(),
      'Disarming prevents a new deployment or further app traffic from evaluating the Workflow').toEqual(settledRunIds);
    const afterDisarm = await readTriggerSet();
    expect(afterDisarm.enabled).toBe(false);
    expect(afterDisarm.triggers.filter(row => row.kind === 'schedule')).toEqual([
      expect.objectContaining({ remainingOccurrences: 0, nextRunAt: null }),
      expect.objectContaining({ remainingOccurrences: 0, nextRunAt: null }),
    ]);
    console.info('P7-F16 both once triggers spent; disarm and fixed deployment verified');
  } finally {
    try { await stopWorkload?.(); } finally { await fixture.stop(); }
  }
}, 0);
