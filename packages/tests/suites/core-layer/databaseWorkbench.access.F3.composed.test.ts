import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

import { DeploymentContentV1Schema } from '@happier-dev/deployments/contracts/v1';
import { DatabaseEditsApplyInputV1Schema, DatabaseOperationResultV1Schema, DatabaseStatsOperationInputV1Schema, DatabaseWriteStatementInputV1Schema } from '@happier-dev/plugin-sdk/database';
import { DATABASE_DESCRIBE_ACTION_ID_V1, DATABASE_EDITS_APPLY_ACTION_ID_V1, DATABASE_STATS_READ_ACTION_ID_V1, DATABASE_STATEMENT_RUN_ACTION_ID_V1, DATABASE_PLUGIN_ID_V1, type DatabaseActionIdV1 } from '@happier-dev/database-protocol';
import { databaseActionLocalIdV1 } from '@happier-dev/database-protocol';
import { ArtifactAccessRecipientCensusResponseV1Schema } from '@happier-dev/protocol/artifacts/artifactAccessV1';
import { MachineAccessGrantsListResultV1Schema } from '@happier-dev/protocol/machines/machineAccessV1';
import { TeamSummaryV1Schema } from '@happier-dev/protocol/teams/projections';
import { ApprovalQueueListResultV1Schema } from '@happier-dev/protocol/approvals/approvalRequestPublicRead';
import { ActionOperationAcceptedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { StoredTargetActionApprovalRequestV1Schema } from '@happier-dev/protocol/approvals/targetActionApprovalRequestV1';
import { ACTION_INVOKE_ACTION_ID_V1, type ActionId } from '@happier-dev/protocol/actions/actionIds';
import { bindExternalActionExecutionAuthorizationHttpPathV1,
  ExternalActionExecutionAuthorizationRequestV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { projectAutomationDatabaseFindingSubjectV1 } from '@happier-dev/protocol/automations/automationSubjectV1';
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
import { ProjectSourcesReadOutputV1Schema } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { WorkflowActionOutputSchemasV1 } from '@happier-dev/protocol/workflows/actionsV1';
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
import { fetchJson } from '../../src/testkit/http';
import { settleReviewedSessionMcpAction, startSessionMcpAgent } from '../../src/testkit/sessionMcpAgent';
import { waitFor } from '../../src/testkit/timing';
import { startDatabaseWorkbenchFixture } from '../../src/testkit/databaseWorkbench';
import { trackDatabaseWorkbenchDeployments } from '../../src/testkit/databaseWorkbenchDeployments';
import { repoRootDir } from '../../src/testkit/paths';

const run = promisify(execFile);

// TS.P3.F3-own-server-editors (D15): CLI executor → server + PostgreSQL → enrolled daemon →
// native catalog PostgreSQL deployment. G1 control P3-F3-known-good-editor-write: an editor's
// Apply commits as the bounded `happier_rw` login before any refusal counts. Chosen-member and
// revoke cases (F5d) wait on E2EE-TEAMREAD-171 (a Team deployer cannot read the Environment yet).
it('TS.P3.F3: an editor applies through the bounded write role; editing off, missing role and server-file reads refuse', async () => {
  const started = Date.now();
    const step = (label: string) => console.info(`TS.P3.F3 +${Math.round((Date.now() - started) / 1000)}s ${label}`);
  const testDir = await mkdtemp(join(tmpdir(), 'happier-dbw-f3own-'));
  const automation = { HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1' };
  const admissionPath = bindExternalActionExecutionAuthorizationHttpPathV1(ACTION_INVOKE_ACTION_ID_V1);
  let applyEnvironmentId: string | undefined;
  let writeAdmissions = 0;
  let writeRoleAcquisitions = 0;
  const fixture = await startDatabaseWorkbenchFixture({
    testDir, serverEnv: automation, guestReachableHome: { host: '127.0.0.1' },
    captureRequestBody: request => applyEnvironmentId !== undefined && request.path === admissionPath,
    beforeForwardResponse(request) {
      if (!applyEnvironmentId || request.method !== 'POST' || request.statusCode !== 200) return;
      if (request.path === `/v1/deployments/environments/${encodeURIComponent(applyEnvironmentId)}/secret-launch-admission`) {
        writeRoleAcquisitions++;
      }
      if (request.path !== admissionPath || !request.body?.complete || request.body.truncated) return;
      const { envelope } = ExternalActionExecutionAuthorizationRequestV1Schema.parse(JSON.parse(request.body.text));
      const admission = 'deploymentReadAdmission' in envelope ? envelope.deploymentReadAdmission : undefined;
      if (admission && 'databaseTarget' in admission && admission.access === 'write'
        && admission.environmentId === applyEnvironmentId
        && admission.action.pluginId === DATABASE_PLUGIN_ID_V1
        && admission.action.localId === databaseActionLocalIdV1(DATABASE_EDITS_APPLY_ACTION_ID_V1)) writeAdmissions++;
    },
  });
  const deployments = trackDatabaseWorkbenchDeployments(fixture, testDir);
  await deployments.run(async () => {
    const owner = await fixture.createAccount('f3-owner');
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
      if (!result.ok) {
        const cause = result.failureCause;
        if (cause) console.info('F3 setup Action failure', {
          phase: cause.phase, errorCode: cause.errorCode,
          nativeErrorCode: 'nativeErrorCode' in cause ? cause.nativeErrorCode : undefined,
          nativeErrorReason: 'nativeErrorReason' in cause ? cause.nativeErrorReason : undefined,
        });
        throw new Error(`F3 setup ${actionId} refused (${result.errorCode})`);
      }
      return result.result;
    }
    async function asPerson(actionId: ActionId, input: unknown) {
      const result = await owner.executeAsPerson(actionId, input);
      if (!result.ok)
        throw new Error(`F3 setup ${actionId} refused (${result.errorCode})`);
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
      throw new Error('F3 setup daemon omitted the shipped app catalog');
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
      throw new Error('F3 setup PostgreSQL app is unavailable');
    const created = DeploymentEnvironmentCreateResultV1Schema.parse(
      await reviewed(
        'deployments.environments.create',
        DeploymentEnvironmentCreateIntentInputV1Schema.parse({
          serverId: fixture.serverId,
          name: 'F3 editors',
          requestKey: randomUUID(),
          newProject: {
            name: 'F3 editors',
            requestKey: randomUUID(),
            owner: {
              kind: 'account',
              accountId: readAccountIdFromToken(owner.credentials.token),
            },
          },
          definition: {
            from: 'catalogApp',
            templateRef: {
              sourceId: catalog.id,
              itemId: 'postgresql',
              version: item.summary.version,
              ref: item.payload.ref,
            },
          },
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
    if (!created.ok)
      throw new Error(
        `F3 setup Environment creation failed (${created.error})`,
      );
    const address = {
      serverId: fixture.serverId,
      environmentId: created.environmentId,
    };
    async function environment() {
      const read = DeploymentEnvironmentGetResultV1Schema.parse(
        await reviewed('deployments.environments.get', address),
      );
      if (!read.ok)
        throw new Error(`F3 Environment read failed (${read.error})`);
      return read.environment;
    }
    step('environment created');
    const initial = await environment();
    const targetLinkId = initial.runtimeTargetLinkId;
    if (!targetLinkId)
      throw new Error('F3 setup Environment omitted its runtime target');
    const recordedProject = await deployments.recordInitialDeploy(owner, { environmentId: address.environmentId, targetLinkId });
    const deployed = DeploymentReceiptResultV1Schema.parse(
      await reviewed('deployments.deploy', { ...address, targetLinkId }, true),
    );
    if (!deployed.ok || !('deploymentId' in deployed))
      throw new Error('F3 setup native deployment did not settle');
    step('deployed');
    const record = DeploymentReceiptGetResultV1Schema.parse(
      await reviewed('deployments.receipts.get', {
        ...address,
        deploymentId: deployed.deploymentId,
      }),
    );
    if (!record.ok)
      throw new Error(`F3 setup receipt read failed (${record.error})`);
    const artifact = await runWithServerHttpBaseUrl(
      fixture.server.baseUrl,
      () =>
        createCredentialedAccountArtifactStore(owner.credentials).read(
          record.deployment.contentArtifactId,
        ),
    );
    if (!artifact || typeof artifact.body !== 'string')
      throw new Error('F3 setup receipt content is unavailable');
    const project = DeploymentContentV1Schema.parse(JSON.parse(artifact.body))
      .ownServer?.approvedInputBasis.physicalProjectName;
    if (!project)
      throw new Error('F3 setup receipt omitted its native project');
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
      throw new Error('F3 setup must identify exactly one database container');
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
      "CREATE TABLE dbw_f3 (id integer PRIMARY KEY, note text); INSERT INTO dbw_f3 VALUES (1, 'before'), (2, 'before')",
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
              recipientAccountId: readAccountIdFromToken(
                owner.credentials.token,
              ),
              ...sealSavedSecretResourceRecipientEnvelopeV1({
                resourceDataKey,
                recipientContentPublicKey:
                  owner.credentials.encryption.publicKey,
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
        throw new Error(`F3 bindings.set failed (${result.error})`);
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
    const writeRole = {
      purpose: 'dataRole',
      service: 'database',
      role: 'write',
    };
    await bind([
      {
        purpose: 'dataRole',
        service: 'database',
        role: 'readOnlyPassword',
        source: await password('F3 read'),
      },
      { ...writeRole, source: await password('F3 write') },
    ]);
    expect(
      (
        await admin(
          "SELECT rolsuper::text || rolcreaterole::text FROM pg_roles WHERE rolname = 'happier_rw'",
        )
      ).stdout.trim(),
    ).toBe('falsefalse');
    step('bindings set (write role bootstrapped)');
    await update({ dataEditorMode: 'managers', dataAgentAccess: 'read' });

    const target = {
      kind: 'deployment_service' as const,
      environment: { ...address, projectSourceId: initial.projectSourceId },
      deploymentId: deployed.deploymentId,
      targetLinkId,
      serviceId: 'database',
      database: 'app',
    };
    // The signed Person settles any Ask from the terminal automation requester.
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
      request: { kind: 'stats.read', group: 'tables', selection: { relation: { schema: 'public', name: 'dbw_f3' } } } });
    const expectedStats = { ok: true, operation: 'stats.read', observation: {
      status: 'available', group: 'tables', scope: { database: target.database },
    } };
    const control = await invoke(DATABASE_STATS_READ_ACTION_ID_V1, stats);
    if (!control.ok) throw new Error(`F9 Environment owner Stats refused (${control.errorCode})`);
    expect(DatabaseOperationResultV1Schema.parse(control.result)).toMatchObject(expectedStats);

    const viewer = await fixture.createAccount('f9-environment-viewer');
    const outsider = await fixture.createAccount('f9-environment-outsider');
    const ownerId = readAccountIdFromToken(owner.credentials.token);
    if (!ownerId) throw new Error('F9 owner Account identity unavailable');

    async function grantTeamMachineUse(member: typeof viewer, name: string) {
      const accountId = readAccountIdFromToken(member.credentials.token);
      if (!accountId) throw new Error(`F9 ${name} member Account identity unavailable`);
      const team = TeamSummaryV1Schema.parse(await reviewed('teams.create', {
        v: 1, name, initialOwnerAccountId: ownerId, requestKey: randomUUID(),
      }));
      await reviewed('teams.members.add', {
        v: 1, teamId: team.id, accountId, role: 'member', historyAccess: 'all_existing',
      });
      const principal = { kind: 'team', teamId: team.id } as const;
      await reviewed('machines.access.grant.set', { ...machine.target, principal, level: 'view' });
      return { accountId, principal };
    }

    const reader = await grantTeamMachineUse(viewer, 'F9 readers');
    const other = await grantTeamMachineUse(outsider, 'F9 other Team');
    await reviewed('machines.access.prepareKeys', machine.target);
    for (const member of [viewer, outsider]) {
      const access = await member.executeAsPerson('machines.access.grants.list', machine.target);
      if (!access.ok) throw new Error(`F9 Team member Machine access refused (${access.errorCode})`);
      expect(MachineAccessGrantsListResultV1Schema.parse(access.result)).toMatchObject({
        access: { role: 'use', accessState: 'ready' },
      });
    }

    const projectAddress = { serverId: fixture.serverId, sourceId: initial.projectSourceId };
    const source = ProjectSourcesReadOutputV1Schema.parse(await asPerson('projects.sources.read', projectAddress));
    if (!source.ok) throw new Error(`F9 Environment Project read refused (${source.error})`);
    const audience = [{ principal: reader.principal, level: 'view' as const }];
    // Use the Person entry that prepares E2EE artifact envelopes when saving the Source audience.
    const saved = await owner.execute('projects.sources.update', {
      ...projectAddress, expectedRevision: source.source.revision, patch: { audience },
    }, { presentUserConfirmation: { actionId: 'projects.sources.update' } });
    expect(saved).toMatchObject({ ok: true, result: { ok: true } });
    expect(await viewer.executeAsPerson('projects.sources.read', projectAddress)).toMatchObject({
      ok: true, result: { ok: true, source: { audience } },
    });

    const deployment = DeploymentEnvironmentGetResultV1Schema.parse(
      await asPerson('deployments.environments.get', address),
    );
    if (!deployment.ok) throw new Error(`F9 Environment read refused (${deployment.error})`);
    const link = deployment.targetLinks.find(candidate => candidate.id === targetLinkId);
    if (!link || link.activeDeploymentId !== deployed.deploymentId) {
      throw new Error('F9 Target Link did not select the native deployment as active');
    }
    const receipt = DeploymentReceiptGetResultV1Schema.parse(
      await asPerson('deployments.receipts.get', { ...address, deploymentId: link.activeDeploymentId }),
    );
    if (!receipt.ok || !receipt.deployment.contentArtifactId) {
      throw new Error('F9 active deployment Receipt content is unavailable');
    }
    const artifacts = [
      { kind: 'Environment', id: deployment.environment.contentArtifactId },
      { kind: 'Target Link', id: link.contentArtifactId },
      { kind: 'active Receipt', id: receipt.deployment.contentArtifactId },
    ];
    let viewerHasReceiptEnvelope = false;
    for (const { kind, id } of artifacts) {
      const census = await fetchJson<unknown>(
        `${fixture.server.baseUrl}/v1/artifacts/${encodeURIComponent(id)}/access/recipients`,
        { headers: { Authorization: `Bearer ${owner.auth.token}` } },
      );
      expect(census.status, `F9 ${kind} recipient census`).toBe(200);
      const { recipients } = ArtifactAccessRecipientCensusResponseV1Schema.parse(census.data);
      expect(recipients.some(row => row.recipientAccountId === other.accountId && Boolean(row.encryptedDataKey)),
        `F9 other Team received an encrypted ${kind} envelope`).toBe(false);
      if (kind === 'active Receipt') {
        viewerHasReceiptEnvelope = recipients.some(
          row => row.recipientAccountId === reader.accountId && Boolean(row.encryptedDataKey),
        );
      }
    }

    const description = await invoke(DATABASE_DESCRIBE_ACTION_ID_V1, { operation: 'describe', target });
    if (!description.ok) throw new Error(`F9 Environment description refused (${description.errorCode})`);
    const described = DatabaseOperationResultV1Schema.parse(description.result);
    if (!described.ok || described.operation !== 'describe') throw new Error('F9 Environment did not describe the selected database');
    const automationSubject = described.descriptor.automationSubject;
    if (!automationSubject?.ok) throw new Error('F9 selected database did not expose an Automation subject');
    const { machineId } = machine.target;
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
      input: { v: 1, subject: projectAutomationDatabaseFindingSubjectV1(address.serverId, target), sourceScope: machine.target },
    }, true);
    const eventSource = PluginEventAutomationSetupResultV1Schema.parse(event);
    const armed = WorkflowActionOutputSchemasV1['workflow.trigger.add'].parse(await reviewed('workflow.trigger.add', {
      project: { machineId, directory: machine.workspaceDir },
      target: { kind: 'inline', definition: { version: 1, blocks: [{ kind: 'action', id: 'read-selected-database',
        actionId: DATABASE_DESCRIBE_ACTION_ID_V1, input: { operation: { kind: 'literal', value: 'describe' },
          target: { kind: 'literal', value: target } } }] } },
      trigger: { kind: 'pluginEvent', enabled: true, eventRef: DATABASE_FINDING_EVENT_REF,
        sourceInstanceId: eventSource.sourceInstanceId, sourceContractVersion: eventSource.sourceContractVersion,
        sourceConfig: eventSource.sourceConfig, displayLabel: eventSource.displayLabel, maximumObservationAgeMs: null,
        observationTransport: { kind: 'checkpointedPull', watcherMaterializationRef: {
          machineId, pluginId: materialization.pluginId, materializationId: materialization.materializationId,
        } }, filter: { v: 1, all: [{ op: 'eq', field: '/observation/kind', value: 'tables' }] } },
    }));
    const expectRuns = (count: number) => waitFor(async () => {
      const result = await asPerson('workflow.run.list', { origin: 'automation' });
      const runs = WorkflowActionOutputSchemasV1['workflow.run.list'].parse(result).runs.filter(run =>
        run.origin.kind === 'automation' && run.origin.automationId === armed.set.automationId);
      expect(runs.length).toBeLessThanOrEqual(count);
      return runs.length === count && runs.every(run => run.state === 'succeeded');
    }, { timeoutMs: 90_000, intervalMs: 100, failFast: true, context: `F9 Environment Worker settled ${count} Run(s)` });

    const invokeAsPerson = (account: typeof owner, actionId: DatabaseActionIdV1, input: unknown) => {
      const action = { pluginId: DATABASE_PLUGIN_ID_V1, localId: databaseActionLocalIdV1(actionId) };
      return account.executeAsPerson('action.invoke', { action, input },
        { externalActionTarget: { kind: 'machine', machineId } }, { action, machineId });
    };
    const readAsViewer = await invokeAsPerson(viewer, DATABASE_STATS_READ_ACTION_ID_V1, stats);
    const readAsOutsider = await invokeAsPerson(outsider, DATABASE_STATS_READ_ACTION_ID_V1, stats);
    expect(readAsOutsider).toMatchObject({ ok: false, errorCode: 'credential_scope_denied' });
    const viewerOutcome = readAsViewer.ok ? 'admitted' : readAsViewer.errorCode;
    expect(viewerHasReceiptEnvelope, `F9 Source viewer active Receipt envelope (Stats: ${viewerOutcome})`).toBe(true);
    if (!readAsViewer.ok) throw new Error(`F9 Environment reader refused (${readAsViewer.errorCode})`);
    expect(DatabaseOperationResultV1Schema.parse(readAsViewer.result)).toMatchObject(expectedStats);
    step('F9 viewer Receipt and Stats passed; other Team refused without envelopes');
    await expectRuns(1);
    step('F9 selected Environment reader and Worker passed');

    const agent = await startSessionMcpAgent({ testDir, directory: machine.workspaceDir, daemonState: machine.daemon.state,
      executeAsPerson: owner.executeAsPerson });
    try {
      const readAsAgent = await agent.execute(DATABASE_STATS_READ_ACTION_ID_V1, stats);
      if (!readAsAgent.ok) throw new Error(`F9 Environment Agent refused (${readAsAgent.errorCode})`);
      expect(DatabaseOperationResultV1Schema.parse(readAsAgent.result)).toMatchObject(expectedStats);
      await expectRuns(2);
      await reviewed('workflow.trigger.remove', { automationId: armed.set.automationId, triggerId: armed.triggerId });
      step('F9 selected Environment Agent and Worker passed');

      const changePolicy = (mode: 'allowed' | 'ask_first') => asPerson('actions.policy.set', {
        actionId: DATABASE_STATEMENT_RUN_ACTION_ID_V1, audience: 'agent', mode,
      });
      const execute = (statements: ReturnType<typeof DatabaseWriteStatementInputV1Schema.parse>['statements']) =>
        agent.execute(DATABASE_STATEMENT_RUN_ACTION_ID_V1, DatabaseWriteStatementInputV1Schema.parse({
          operation: 'statement.run', target, mode: 'write', executionMode: 'transaction', statements,
        }));
      const note = async () => (await admin('SELECT note FROM dbw_f3 WHERE id=1')).stdout.trim();
      const approvals = async () => ApprovalQueueListResultV1Schema.parse(await asPerson('approval.request.list', {}))
        .items.filter(item => item.sessionId === agent.sessionId);
      const finish = (result: Awaited<ReturnType<typeof execute>>) =>
        settleReviewedSessionMcpAction(result, { serverId: fixture.serverId, serverHttpBaseUrl: fixture.server.baseUrl,
          token: owner.credentials.token, execute: owner.executeAsPerson,
          decide: async () => { throw new Error('An approval must be reviewed before observing its operation'); } });
      const replaceNote = (value: string) => ({
        sql: 'UPDATE dbw_f3 SET note=$1 WHERE id=1',
        parameters: [{ type: 'text' as const, value }],
      });
      const expectNativeWrite = async (result: Awaited<ReturnType<typeof execute>>, value: string) => {
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error(`Deployed Agent write refused (${result.errorCode})`);
        expect(DatabaseOperationResultV1Schema.parse(result.result)).toMatchObject({
          ok: true, operation: 'statement.run', results: [ { affectedRows: '1' } ],
        });
        expect(await note()).toBe(value);
      };
      await update({ dataAgentAccess: 'readWriteNoApproval' });
      await changePolicy('allowed');
      const baseline = await note();
      const baselineApprovals = await approvals();
      await expectNativeWrite(await finish(await execute([replaceNote('f10-control')])), 'f10-control');
      expect(await approvals()).toEqual(baselineApprovals);
      step('P3-F10-known-good-agent-write passed on exact deployed target');

      await update({ dataAgentAccess: 'read' });
      expect(await finish(await execute([replaceNote('must-not-run')])))
        .toMatchObject({ ok: false, errorCode: 'database_agent_access_read_only' });
      await update({ dataAgentAccess: 'none' });
      expect(await finish(await agent.execute(DATABASE_STATS_READ_ACTION_ID_V1, stats)))
        .toMatchObject({ ok: false, errorCode: 'database_agent_access_none' });
      expect(await note()).toBe('f10-control');
      expect(await approvals()).toEqual(baselineApprovals);

      const readApproval = async (artifactId: string) => {
        const record = await runWithServerHttpBaseUrl(fixture.server.baseUrl,
          () => createCredentialedAccountArtifactStore(owner.credentials).read(artifactId));
        if (typeof record?.body !== 'string') throw new Error('Deployed Agent review omitted the Artifact body');
        return StoredTargetActionApprovalRequestV1Schema.parse(JSON.parse(record.body));
      };
      async function reviewBatch(value: string, priorValue: string) {
        const before = new Set((await approvals()).map(item => item.artifactId));
        const after = async () => (await approvals()).filter(item => !before.has(item.artifactId));
        const statements = [
          { sql: 'SELECT txid_current() AS transaction_id', parameters: [] },
          replaceNote(value),
          { sql: 'SELECT txid_current() AS transaction_id', parameters: [] },
        ];
        const result = await execute(statements);
        if (!result.ok) throw new Error(`Deployed Agent batch refused (${result.errorCode})`);
        ActionOperationAcceptedResultSchema.parse(result.result);
        await waitFor(async () => (await after()).some(item => item.status === 'open'), { context: 'deployed Agent review' });
        const opened = await after();
        expect(opened).toMatchObject([{ status: 'open' }]);
        const { artifactId } = opened[0]!;
        expect(await note()).toBe(priorValue);
        expect(await readApproval(artifactId)).toMatchObject({
          status: 'open', input: { target, statements: [
            statements[0], { ...statements[1], parameters: [{ type: 'text', value: '[REDACTED]' }] }, statements[2],
          ] },
        });
        await asPerson('approval.request.decide', { artifactId, decision: 'approve' });
        const applied = await finish(result);
        if (!applied.ok) throw new Error(`Deployed Agent review failed (${applied.errorCode})`);
        const native = DatabaseOperationResultV1Schema.parse(applied.result);
        expect(native).toMatchObject({ ok: true, results: [
          { rows: [{ cells: [expect.objectContaining({ value: expect.stringMatching(/^\d+$/u) })] }] },
          { affectedRows: '1' }, { rows: [{ cells: [expect.any(Object)] }] },
        ] });
        if (!native.ok || native.operation !== 'statement.run') throw new Error('Expected deployed batch result');
        expect(native.results[2]?.rows).toEqual(native.results[0]?.rows);
        expect(await note()).toBe(value);
        expect(await after()).toMatchObject([{ artifactId }]);
        expect(await readApproval(artifactId)).toMatchObject({ status: 'executed', input: null });
      }
      await update({ dataAgentAccess: 'readWriteAsk' });
      await reviewBatch('f10-target-ask', 'f10-control');
      await update({ dataAgentAccess: 'readWriteNoApproval' });
      await changePolicy('ask_first');
      await reviewBatch('f10-preference-ask', 'f10-target-ask');

      await changePolicy('allowed');
      const priorRollback = await approvals();
      const failed = await finish(await execute([
        replaceNote('must-roll-back'),
        { sql: "INSERT INTO dbw_f3 VALUES (1, 'duplicate')", parameters: [] },
        replaceNote('must-not-run'),
      ]));
      expect(failed).toMatchObject({ ok: true, result: {
        ok: false, status: 'failed', cause: { source: 'engine', code: '23505', statementIndex: 1 },
      } });
      expect(await note()).toBe('f10-preference-ask');
      expect(await approvals()).toEqual(priorRollback);
      await expectNativeWrite(await finish(await execute([replaceNote(baseline)])), baseline);
      expect(await approvals()).toEqual(priorRollback);
      await update({ dataAgentAccess: 'read' });
      step('P3-F10 deployed level, Ask floors, redaction, rollback and replay passed');
    } finally { await agent.stop(); }

    const apply = (note: string, before = 'committed', ids = ['1']) =>
      invokeAsPerson(
        owner,
        DATABASE_EDITS_APPLY_ACTION_ID_V1,
        DatabaseEditsApplyInputV1Schema.parse({
          operation: 'edits.apply',
          target,
          relation: { schema: 'public', name: 'dbw_f3' },
          changes: ids.map(id => ({
              kind: 'update',
              key: [{ column: 'id', value: { type: 'integer', value: id } }],
              original: [{ column: 'note', value: { type: 'text', value: before } }],
              values: [
                {
                  column: 'note',
                  value: { kind: 'value', cell: { type: 'text', value: note } },
                },
              ],
          })),
        }),
      );

    // G1: the editor's Apply commits through happier_rw.
    const probe = await invokeAsPerson(owner, DATABASE_STATEMENT_RUN_ACTION_ID_V1, {
      operation: 'statement.run', mode: 'read', target,
      statement: { sql: 'SELECT note FROM dbw_f3 WHERE id = 1', parameters: [] },
    });
    if (!probe.ok) throw new Error(`F3 editor read refused (${probe.errorCode})`);
    expect(DatabaseOperationResultV1Schema.parse(probe.result)).toMatchObject({
      ok: true, operation: 'statement.run',
      results: [{ rows: [{ cells: [{ type: 'text', value: 'before' }] }] }],
    });
    applyEnvironmentId = address.environmentId;
    const committed = await apply('committed', 'before', ['1', '2']).finally(() => { applyEnvironmentId = undefined; });
    if (!committed.ok) throw new Error(`F3 editor Apply refused (${committed.errorCode})`);
    expect(DatabaseOperationResultV1Schema.parse(committed.result)).toMatchObject({ ok: true, status: 'committed', updated: '2' });
    // PostgreSQL stamps both updated tuples with the transaction that wrote them.
    expect((await admin("SELECT count(*) || '/' || count(DISTINCT xmin::text) FROM dbw_f3 WHERE note = 'committed'"))
      .stdout.trim()).toBe('2/1');
    expect({ writeAdmissions, writeRoleAcquisitions }).toEqual({ writeAdmissions: 1, writeRoleAcquisitions: 1 });
    console.info('P3-F3-known-good-editor-write passed');

    // The write login has no server-file reach.
    step('G1 passed; file read next');
    const fileRead = await invokeAsPerson(
      owner,
      DATABASE_STATEMENT_RUN_ACTION_ID_V1,
      DatabaseWriteStatementInputV1Schema.parse({
        operation: 'statement.run',
        mode: 'write',
        target,
        executionMode: 'transaction',
        statements: [
          { sql: "SELECT pg_read_file('/etc/hostname')", parameters: [] },
        ],
      }),
    );
    expect(
      fileRead.ok && DatabaseOperationResultV1Schema.parse(fileRead.result),
    ).toMatchObject({ ok: false, code: 'database_engine_error' });
    // Editing Off refuses the person at the caller.
    step('editing off next');
    await update({ dataEditorMode: 'off' });
    expect(await apply('editing-off')).toMatchObject({
      ok: false,
      errorCode: 'database_editing_off',
    });
    // Without its own binding the writer is not set up.
    await update({ dataEditorMode: 'managers' });
    step('remove write role next');
    await bind([], [writeRole]);
    expect(await apply('no-role')).toMatchObject({
      ok: false,
      errorCode: 'write_role_setup_required',
    });
    expect(
      (await admin('SELECT note FROM dbw_f3 WHERE id = 1')).stdout.trim(),
    ).toBe('committed');
  });
}, 1_200_000);
