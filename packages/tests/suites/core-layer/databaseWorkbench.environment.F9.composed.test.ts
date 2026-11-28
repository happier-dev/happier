import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

import { DeploymentContentV1Schema } from '@happier-dev/deployments/contracts/v1';
import { DatabaseEditsApplyInputV1Schema, DatabaseOperationResultV1Schema, DatabaseStatsOperationInputV1Schema } from '@happier-dev/plugin-sdk/database';
import { DATABASE_DESCRIBE_ACTION_ID_V1, DATABASE_EDITS_APPLY_ACTION_ID_V1, DATABASE_STATS_READ_ACTION_ID_V1, DATABASE_PLUGIN_ID_V1, type DatabaseActionIdV1 } from '@happier-dev/database-protocol';
import { databaseActionLocalIdV1 } from '@happier-dev/database-protocol';
import { AutomationEventActionHttpPathsV1 } from '@happier-dev/protocol/automations/event';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import { EXTERNAL_ACTION_HTTP_BODY_HEADER_V1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { bindExternalActionExecutionAuthorizationHttpPathV1 } from '@happier-dev/protocol/actions/externalActionApi';
import {
  DeploymentEnvironmentCreateIntentInputV1Schema,
  DeploymentEnvironmentCreateResultV1Schema,
  DeploymentEnvironmentGetResultV1Schema,
  DeploymentReceiptGetResultV1Schema,
  DeploymentReceiptResultV1Schema,
  DeploymentBindingsSetResultV1Schema,
} from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { PluginEventAutomationSetupResultV1Schema } from '@happier-dev/protocol/automations/event-setup-result';
import { PluginAvailabilityActionHttpPathsV1, PluginAvailabilityMaterializationsReadActionOutputV1Schema } from '@happier-dev/protocol/plugins/availability/actions';
import { WorkflowActionOutputSchemasV1 } from '@happier-dev/protocol/workflows/actionsV1';
import type { WorkflowRunSummaryV1 } from '@happier-dev/protocol/workflows/workflowProgressV1';
import { MachineInstallationIdentityV1Schema } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { REGISTRY_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/registries';
import {
  sealSavedSecretResourceRecipientEnvelopeV1,
  sealSavedSecretResourceStoredContentV1,
} from '@happier-dev/protocol/account/settings/savedSecretResourceContentV1';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';

import { createCredentialedAccountArtifactStore } from '../../../../apps/cli/src/api/artifacts/accountArtifactStore';
import { runWithServerHttpBaseUrl } from '../../../../apps/cli/src/api/client/serverHttpBaseUrl';
import { readAccountIdFromToken } from '../../../../apps/cli/src/cloud/decodeJwtPayload';
import { DATABASE_FINDING_EVENT_REF, DATABASE_FINDING_SETUP_LOCAL_ID } from '../../../plugins/database-workbench/src/insights/events';
import { projectAutomationDatabaseFindingSubjectV1 } from '@happier-dev/protocol/automations/automationSubjectV1';
import { fetchJson } from '../../src/testkit/http';
import { waitFor } from '../../src/testkit/timing';
import { startDatabaseWorkbenchFixture } from '../../src/testkit/databaseWorkbench';
import { trackDatabaseWorkbenchDeployments } from '../../src/testkit/databaseWorkbenchDeployments';
import { repoRootDir } from '../../src/testkit/paths';

const run = promisify(execFile);

it('P4 F9: an owner Workflow describes the selected native database', async () => {
  const started = Date.now();
  const step = (label: string) => console.info(`DBW F9 +${Math.round((Date.now() - started) / 1000)}s ${label}`);
  const testDir = await mkdtemp(join(tmpdir(), 'happier-dbw-f9-'));
  const automation = { HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1' };
  const postArmEventAdmissionStatuses: (number | null)[] = [];
  let starterAccountId: string | null = null;
  let recordingOwnerObservation = false;
  const fixture = await startDatabaseWorkbenchFixture({
    testDir, serverEnv: automation, guestReachableHome: { host: '127.0.0.1' },
    beforeForwardResponse(request) {
      if (request.path === bindExternalActionExecutionAuthorizationHttpPathV1('action.invoke')) {
        step(`contributed Action mint status=${request.statusCode}`);
      }
      if (request.path.endsWith('/secret-launch-admission')) {
        const auth = request.headers.authorization;
        const accountId = typeof auth === 'string' ? readAccountIdFromToken(auth.replace(/^Bearer /u, '')) : null;
        step(`secret launch status=${request.statusCode} starterBearer=${accountId === starterAccountId} framed=${request.headers[EXTERNAL_ACTION_HTTP_BODY_HEADER_V1] !== undefined}`);
      }
      if (recordingOwnerObservation && request.path === AutomationEventActionHttpPathsV1['automation.event.admit']) {
        postArmEventAdmissionStatuses.push(request.statusCode);
      }
    },
  });
  const deployments = trackDatabaseWorkbenchDeployments(fixture, testDir);
  await deployments.run(async () => {
    const owner = await fixture.createAccount('f9-owner');
    const ownerAccountId = readAccountIdFromToken(owner.credentials.token);
    const ownerEncryption = owner.credentials.encryption;
    if (!ownerAccountId || ownerEncryption?.type !== 'dataKey') throw new Error('F9 fixture omitted the owner Account key');
    starterAccountId = ownerAccountId;
    await fixture.claimHomeOwner(owner);
    const machine = await fixture.enrollDaemon(owner, {
      env: { ...automation, HAPPIER_WEB_LATENCY_TRACE: '1' },
      cliLaunchSpec: {
        command: process.execPath,
        args: [
          '--import',
          resolve(
            repoRootDir(),
            'packages/cli-common/registerSourceRuntime.mjs',
          ),
          resolve(repoRootDir(), 'apps/cli/src/index.ts'),
        ],
        cwd: repoRootDir(),
      },
    });
    step('enrolled');
    const installation = MachineInstallationIdentityV1Schema.parse(
      JSON.parse(
        await readFile(
          join(machine.homeDir, 'installation-identity.json'),
          'utf8',
        ),
      ),
    );
    const onMachine = (actionId: ActionId) => ({
      externalActionTarget: {
        kind: 'machine' as const,
        machineId: machine.target.machineId,
      },
      presentUserConfirmation: { actionId },
    });
    async function reviewed(
      actionId: ActionId,
      input: unknown,
      machineTarget = false,
    ) {
      const result = await owner.executeReviewed(
        actionId,
        input,
        machineTarget
          ? onMachine(actionId)
          : { presentUserConfirmation: { actionId } },
      );
      if (!result.ok)
        throw new Error(`F9 setup ${actionId} refused (${result.errorCode})`);
      return result.result;
    }
    async function asPerson(actionId: ActionId, input: unknown) {
      const result = await owner.executeAsPerson(actionId, input);
      if (!result.ok)
        throw new Error(`F9 setup ${actionId} refused (${result.errorCode})`);
      return result.result;
    }
    const catalog = REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.sources.list']
      .parse(await asPerson('registries.sources.list', { kind: 'app' }))
      .sources.find(
        (source) =>
          'packageContent' in source &&
          source.origin.pluginId === 'happier.deployment.templates',
      );
    if (!catalog)
      throw new Error('F9 setup daemon omitted the shipped app catalog');
    const item = REGISTRY_ACTION_OUTPUT_SCHEMAS_V1[
      'registries.items.read'
    ].parse(
      await asPerson('registries.items.read', {
        kind: 'app',
        sourceId: catalog.id,
        itemId: 'postgresql',
      }),
    ).item;
    if (
      item.payload.kind !== 'app' ||
      item.payload.state !== 'ready' ||
      !item.summary.version
    )
      throw new Error('F9 setup PostgreSQL app is unavailable');
    const templateRef = { sourceId: catalog.id, itemId: 'postgresql', version: item.summary.version, ref: item.payload.ref };
    const createEnvironment = async (name: string) => DeploymentEnvironmentCreateResultV1Schema.parse(
      await reviewed(
        'deployments.environments.create',
        DeploymentEnvironmentCreateIntentInputV1Schema.parse({
          serverId: fixture.serverId,
          name,
          requestKey: randomUUID(),
          newProject: {
            name,
            requestKey: randomUUID(),
            owner: {
              kind: 'account',
              accountId: ownerAccountId,
            },
          },
          definition: { from: 'catalogApp', templateRef },
          protection: 'nonProduction',
          purpose: 'standard',
          deployerMode: 'managers',
          controllerMachineId: machine.target.machineId,
          buildMachineId: machine.target.machineId,
          firstTargetLink: {
            machines: [
              {
                machineId: machine.target.machineId,
                installationId: installation.installationId,
              },
            ],
          },
        }),
        true,
      ),
    );
    const created = await createEnvironment('F9 Workbench');
    if (!created.ok)
      throw new Error(
        `F9 setup Environment creation failed (${created.error})`,
      );
    const address = {
      serverId: fixture.serverId,
      environmentId: created.environmentId,
    };
    async function environment(environmentId = address.environmentId) {
      const read = DeploymentEnvironmentGetResultV1Schema.parse(
        await reviewed('deployments.environments.get', { ...address, environmentId }),
      );
      if (!read.ok)
        throw new Error(`F9 Environment read failed (${read.error})`);
      return read.environment;
    }
    step('environment created');
    const initial = await environment();
    const targetLinkId = initial.runtimeTargetLinkId;
    if (!targetLinkId)
      throw new Error('F9 setup Environment omitted its runtime target');
    const recordedProject = await deployments.recordInitialDeploy(owner, { environmentId: address.environmentId, targetLinkId });
    const deployed = DeploymentReceiptResultV1Schema.parse(
      await reviewed('deployments.deploy', { ...address, targetLinkId }, true),
    );
    if (!deployed.ok || !('deploymentId' in deployed))
      throw new Error('F9 setup native deployment did not settle');
    step('deployed');
    const record = DeploymentReceiptGetResultV1Schema.parse(
      await reviewed('deployments.receipts.get', {
        ...address,
        deploymentId: deployed.deploymentId,
      }),
    );
    if (!record.ok)
      throw new Error(`F9 setup receipt read failed (${record.error})`);
    const contentArtifactId = record.deployment.contentArtifactId;
    if (!contentArtifactId) throw new Error('F9 setup receipt omitted its content reference');
    const artifact = await runWithServerHttpBaseUrl(
      fixture.server.baseUrl,
      () => createCredentialedAccountArtifactStore(owner.credentials).read(contentArtifactId),
    );
    if (!artifact || typeof artifact.body !== 'string')
      throw new Error('F9 setup receipt content is unavailable');
    const project = DeploymentContentV1Schema.parse(JSON.parse(artifact.body))
      .ownServer?.approvedInputBasis.physicalProjectName;
    if (!project)
      throw new Error('F9 setup receipt omitted its native project');
    expect(project).toBe(recordedProject);
    const container = (
      await run('docker', [
        'ps',
        '--quiet',
        '--filter',
        `label=com.docker.compose.project=${project}`,
        '--filter',
        'label=com.docker.compose.service=database',
      ])
    ).stdout.trim();
    if (!container || /\s/u.test(container))
      throw new Error('F9 setup must identify exactly one database container');
    const admin = (sql: string) =>
      run('docker', [
        'exec',
        container,
        'psql',
        '-X',
        '-A',
        '-t',
        '-v',
        'ON_ERROR_STOP=1',
        '-U',
        'happier',
        '-d',
        'app',
        '-c',
        sql,
      ]);
    await admin(
      "CREATE TABLE dbw_f9 (id integer PRIMARY KEY, note text); INSERT INTO dbw_f9 VALUES (1, 'before')",
    );

    step('table seeded');
    async function password(name: string) {
      const resourceId = randomUUID();
      const resourceDataKey = Uint8Array.from(randomBytes(32));
      try {
        await reviewed('secrets.shared.create', {
          resourceId,
          displayName: name,
          kind: 'password',
          encryptionMode: 'e2ee',
          storedContent: sealSavedSecretResourceStoredContentV1({
            resourceId,
            mode: 'e2ee',
            resourceDataKey,
            randomBytes,
            content: { v: 1, name, kind: 'password', value: randomUUID() },
          }),
          keyEnvelopes: [
            {
              recipientAccountId: ownerAccountId,
              ...sealSavedSecretResourceRecipientEnvelopeV1({
                resourceDataKey,
                recipientContentPublicKey: ownerEncryption.publicKey,
                randomBytes,
              }),
            },
          ],
        });
      } finally {
        resourceDataKey.fill(0);
      }
      return {
        kind: 'secret' as const,
        ref: formatSharedSavedSecretRefV1(resourceId),
        resourceRevision: 1,
      };
    }
    async function bind(set: unknown[], remove: unknown[] = []) {
      const result = DeploymentBindingsSetResultV1Schema.parse(
        await reviewed(
          'deployments.bindings.set',
          {
            ...address,
            expectedRevision: (await environment()).revision,
            set,
            remove,
          },
          true,
        ),
      );
      if (!result.ok)
        throw new Error(`F9 bindings.set failed (${result.error})`);
    }
    async function update(patch: unknown) {
      const current = await environment();
      await reviewed('deployments.environments.update', {
        ...address,
        expectedRevision: current.revision,
        contentArtifactId: current.contentArtifactId,
        contentHeaderVersion: current.contentHeaderVersion,
        contentBodyVersion: current.contentBodyVersion,
        patch,
      });
    }
    await bind([
      {
        purpose: 'dataRole',
        service: 'database',
        role: 'readOnlyPassword',
        source: await password('F9 read'),
      },
      {
        purpose: 'dataRole',
        service: 'database',
        role: 'write',
        source: await password('F9 write'),
      },
    ]);
    step('reader and writer bindings set');
    await update({ dataEditorMode: 'managers', dataAgentAccess: 'read' });

    expect(await environment()).toMatchObject({ dataEditorMode: 'managers', dataAgentAccess: 'read' });

    const target = {
      kind: 'deployment_service' as const,
      environment: { ...address, projectSourceId: initial.projectSourceId },
      deploymentId: deployed.deploymentId,
      targetLinkId,
      serviceId: 'database',
      database: 'app',
    };
    // The person answers their own Ask in place (staged review is the confirmation).
    const invoke = (actionId: DatabaseActionIdV1, input: unknown) =>
      owner.executeReviewed(
        'action.invoke',
        {
          action: {
            pluginId: DATABASE_PLUGIN_ID_V1,
            localId: databaseActionLocalIdV1(actionId),
          },
          input,
        },
        onMachine('action.invoke'),
      );
    // P4 F9 shares the existing native deployment and bounded reader binding.
    const stats = DatabaseStatsOperationInputV1Schema.parse({ operation: 'stats.read', target,
      request: { kind: 'stats.read', group: 'tables', selection: { relation: { schema: 'public', name: 'dbw_f9' } } } });
    const expectedStats = { ok: true, operation: 'stats.read', observation: {
      status: 'available', group: 'tables', scope: { database: target.database },
    } };
    const control = await invoke(DATABASE_STATS_READ_ACTION_ID_V1, stats);
    if (!control.ok) throw new Error(`F9 Environment owner Stats refused (${control.errorCode})`);
    expect(DatabaseOperationResultV1Schema.parse(control.result)).toMatchObject(expectedStats);

    const { machineId } = machine.target;
    const description = await invoke(DATABASE_DESCRIBE_ACTION_ID_V1, { operation: 'describe', target });
    if (!description.ok) throw new Error(`F9 Environment description refused (${description.errorCode})`);
    const described = DatabaseOperationResultV1Schema.parse(description.result);
    if (!described.ok || described.operation !== 'describe') throw new Error('F9 Environment did not describe the selected database');
    const automationSubject = described.descriptor.automationSubject;
    if (!automationSubject?.ok) throw new Error('F9 selected database did not expose an Automation subject');
    const path = PluginAvailabilityActionHttpPathsV1['account.plugins.availability.materializations.read'];
    const available = await fetchJson<unknown>(fixture.server.baseUrl + path, {
      method: 'POST', headers: { Authorization: `Bearer ${owner.credentials.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ pluginIds: [DATABASE_PLUGIN_ID_V1] }),
    });
    expect(available.status).toBe(200);
    const materialization = PluginAvailabilityMaterializationsReadActionOutputV1Schema.parse(available.data).snapshots
      .find(row => row.machineId === machineId)?.materializations
      .find(row => row.pluginId === DATABASE_PLUGIN_ID_V1 && row.enabled && row.trustState === 'trusted');
    if (!materialization) throw new Error('F9 Environment source omitted its live Workbench materialization');
    const event = await reviewed('action.invoke', {
      action: { pluginId: DATABASE_PLUGIN_ID_V1, localId: DATABASE_FINDING_SETUP_LOCAL_ID },
      input: { v: 1, subject: projectAutomationDatabaseFindingSubjectV1(fixture.serverId, described.descriptor.target), sourceScope: machine.target },
    }, true);
    const eventSource = PluginEventAutomationSetupResultV1Schema.parse(event);
    const readWorkflow = (selectedTarget: typeof target) => ({ version: 1, blocks: [{ kind: 'action', id: 'read-selected-database',
      actionId: DATABASE_DESCRIBE_ACTION_ID_V1, input: { operation: { kind: 'literal', value: 'describe' },
        target: { kind: 'literal', value: selectedTarget } } }] });
    const arm = async (selectedTarget: typeof target) => WorkflowActionOutputSchemasV1['workflow.trigger.add'].parse(await reviewed('workflow.trigger.add', {
      project: { machineId, directory: machine.workspaceDir },
      target: { kind: 'inline', definition: readWorkflow(selectedTarget) },
      trigger: { kind: 'pluginEvent', enabled: true, eventRef: DATABASE_FINDING_EVENT_REF,
        sourceInstanceId: eventSource.sourceInstanceId, sourceContractVersion: eventSource.sourceContractVersion,
        sourceConfig: eventSource.sourceConfig, displayLabel: eventSource.displayLabel, maximumObservationAgeMs: null,
        observationTransport: { kind: 'checkpointedPull', watcherMaterializationRef: {
          machineId, pluginId: materialization.pluginId, materializationId: materialization.materializationId,
        } }, filter: { v: 1, all: [{ op: 'eq', field: '/observation/kind', value: 'tables' }] } },
    }));
    const observeRun = async (readRuns: () => Promise<WorkflowRunSummaryV1[]>) => {
      await waitFor(async () => {
        const runs = await readRuns();
        expect(runs.length).toBeLessThanOrEqual(1);
        return runs.some(run => ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(run.state));
      }, { timeoutMs: 90_000, intervalMs: 100, failFast: true, context: 'F9 Environment public Run terminal state' });
      const [settled] = await readRuns();
      if (!settled) throw new Error('F9 did not retain the settled Run');
      const history = WorkflowActionOutputSchemasV1['workflow.run.invocations.list'].parse(await asPerson(
        'workflow.run.invocations.list', { runId: settled.id, includeContent: true },
      ));
      const selectedRead = history.invocationDetails?.find(({ progress }) => progress?.invocationPath?.blockId === 'read-selected-database');
      step(`Run ${settled.id} state=${settled.state} code=${settled.errorCode} leaf=${selectedRead?.index.lifecycle} phase=${selectedRead?.progress?.reason?.failureCause?.phase}`);
      return { state: settled.state, code: settled.errorCode, step: selectedRead?.index.lifecycle,
        cause: selectedRead?.progress?.reason?.failureCause };
    };
    const observeEventRun = async (selectedTarget: typeof target) => {
      const armed = await arm(selectedTarget);
      const readRuns = async () => {
        const result = await asPerson('workflow.run.list', { origin: 'automation' });
        return WorkflowActionOutputSchemasV1['workflow.run.list'].parse(result).runs.filter(run =>
          run.origin.kind === 'automation' && run.origin.automationId === armed.set.automationId);
      };
      try {
        expect(await readRuns()).toEqual([]);
        postArmEventAdmissionStatuses.length = 0;
        recordingOwnerObservation = true;
        try {
          const result = await invoke(DATABASE_STATS_READ_ACTION_ID_V1, stats);
          if (!result.ok) throw new Error(`F9 owner Stats refused (${result.errorCode})`);
          expect(DatabaseOperationResultV1Schema.parse(result.result)).toMatchObject(expectedStats);
        } finally {
          recordingOwnerObservation = false;
        }
        expect(postArmEventAdmissionStatuses).toContain(200);
        return await observeRun(readRuns);
      } finally {
        await reviewed('workflow.trigger.remove', { automationId: armed.set.automationId, triggerId: armed.triggerId });
      }
    };
    expect(await observeEventRun(target)).toMatchObject({ state: 'succeeded', step: 'completed' });

    // A reviewed Agent Action still respects the Environment's read-only policy.
    const write = await invoke(DATABASE_EDITS_APPLY_ACTION_ID_V1, DatabaseEditsApplyInputV1Schema.parse({
      operation: 'edits.apply',
      target,
      relation: { schema: 'public', name: 'dbw_f9' },
      changes: [{
        kind: 'update',
        key: [{ column: 'id', value: { type: 'integer', value: '1' } }],
        original: [{ column: 'note', value: { type: 'text', value: 'before' } }],
        values: [{ column: 'note', value: { kind: 'value', cell: { type: 'text', value: 'forbidden' } } }],
      }],
    }));
    expect(write).toMatchObject({ ok: false, errorCode: 'database_agent_access_read_only' });
    expect((await admin('SELECT note FROM dbw_f9 WHERE id = 1')).stdout.trim()).toBe('before');

    const other = await createEnvironment('F9 other Environment');
    if (!other.ok) throw new Error(`F9 control Environment creation failed (${other.error})`);
    const otherEnvironment = await environment(other.environmentId);
    expect(await observeEventRun({ ...target, environment: { ...target.environment,
      environmentId: otherEnvironment.id, projectSourceId: otherEnvironment.projectSourceId } })).toMatchObject({
      code: 'credential_scope_denied', step: 'failed',
    });

    await update({ dataAgentAccess: 'none' });
    const runId = randomUUID();
    const start = await owner.executeReviewed('workflow.run.start', {
      runId, source: { kind: 'inline', definition: readWorkflow(target) }, executionTarget: { kind: 'detached_run' },
    }, {
      presentUserConfirmation: { actionId: 'workflow.run.start' },
      externalActionTarget: { kind: 'machine', machineId, project: { machineId, directory: machine.workspaceDir } },
    });
    if (!start.ok) throw new Error(`F9 no-access Workflow start refused (${start.errorCode})`);
    expect(WorkflowActionOutputSchemasV1['workflow.run.start'].parse(start.result).run.id).toBe(runId);
    expect(await observeRun(async () => WorkflowActionOutputSchemasV1['workflow.run.list'].parse(
      await asPerson('workflow.run.list', { runId }),
    ).runs)).toMatchObject({ code: 'database_agent_access_none', step: 'failed' });
  });
}, 1_200_000);
