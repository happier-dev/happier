import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { beforeAll, expect, it } from 'vitest';
import nacl from 'tweetnacl';

import {
    DatabaseManagedDeploymentTargetV1Schema,
    DatabaseOperationResultV1Schema,
    DatabaseTargetsListResultV1Schema,
    DatabaseReadStatementInputV1Schema,
    DatabaseWriteStatementInputV1Schema,
    DatabaseEditsApplyInputV1Schema,
} from '@happier-dev/plugin-sdk/database';
import {
    DATABASE_TARGETS_LIST_ACTION_ID_V1,
    DATABASE_PLUGIN_ID_V1,
    DATABASE_STATEMENT_RUN_ACTION_ID_V1,
    DATABASE_DESCRIBE_ACTION_ID_V1,
    DATABASE_RELATIONS_LIST_ACTION_ID_V1,
    DATABASE_SCHEMAS_LIST_ACTION_ID_V1,
    DATABASE_EDITS_APPLY_ACTION_ID_V1,
    type DatabaseActionIdV1,
} from '@happier-dev/database-protocol';
import { databaseActionLocalIdV1 } from '@happier-dev/database-protocol';
import { DeploymentTargetLinkContentV1Schema } from '@happier-dev/protocol/deployments/deploymentTargetLinkContentV1';
import { AutomationV3RunListResponseSchema, buildAccountStoredContentCompatibilityHttpHeadersV1,
  CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION } from '@happier-dev/protocol';
import { WorkflowTriggerWriteResultV1Schema } from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';
import { WorkflowRunWaitResultV1Schema } from '@happier-dev/protocol/workflows/actionsV1';
import { AUTOMATION_EVENT_STORED_DEFINITIONS_READ_HTTP_PATH_V1, AutomationEventActionHttpPathsV1,
  AutomationEventAdmitHttpRequestV1Schema, AutomationEventStoredDefinitionsReadHttpRequestV1Schema } from '@happier-dev/protocol/automations/event';
import { PluginEventAutomationSetupResultV1Schema } from '@happier-dev/protocol/automations/event-setup-result';
import { PluginAvailabilityActionHttpPathsV1, PluginAvailabilityMaterializationsReadActionOutputV1Schema } from '@happier-dev/protocol/plugins/availability/actions';
import { DATABASE_TELEMETRY_MACHINE_ROLE_ID_V1, MachineRolesGetResultV1Schema } from '@happier-dev/protocol/machines/roles/machineRolesV1';
import { DATABASE_FINDING_EVENT_REF, DATABASE_FINDING_SETUP_LOCAL_ID } from '../../../plugins/database-workbench/src/insights/events';
import { projectAutomationDatabaseFindingSubjectV1 } from '@happier-dev/protocol/automations/automationSubjectV1';
import { ACTION_INVOKE_ACTION_ID_V1, SESSION_PERMISSION_MODE_SET_ACTION_ID_V1,
  type ActionId } from '@happier-dev/protocol/actions/actionIds';
import { bindExternalActionExecutionAuthorizationHttpPathV1,
  ExternalActionExecutionAuthorizationRequestV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { TeamSummaryV1Schema } from '@happier-dev/protocol/teams/projections';
import { ConnectedAccountAttemptResponseSchema } from '@happier-dev/protocol/connect/connectedAccountDaemonRpcV1';
import { CONNECTED_SERVICE_CONFIGURATION_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/connect/configurationActionsV1';
import { DeploymentBindingsSetResultV1Schema, DeploymentEnvironmentCreateIntentInputV1Schema, DeploymentEnvironmentCreateResultV1Schema,
  DeploymentEnvironmentGetResultV1Schema, DeploymentEnvironmentUpdateResultV1Schema, DeploymentTargetLinkResultV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { ProjectSourcesReadOutputV1Schema } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { sealSavedSecretResourceRecipientEnvelopeV1, sealSavedSecretResourceStoredContentV1 } from '@happier-dev/protocol/account/settings/savedSecretResourceContentV1';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';

import { readAccountIdFromToken } from '../../../../apps/cli/src/cloud/decodeJwtPayload';
import { startDatabaseWorkbenchFixture } from '../../src/testkit/databaseWorkbench';
import { startDeploymentProvidersHttp } from '../../src/testkit/deploymentProvidersHttp';
import { repoRootDir } from '../../src/testkit/paths';
import { fetchJson } from '../../src/testkit/http';
import { createIsolatedFakeClaudeControlShim } from '../../src/testkit/fakeClaude';
import { waitFor } from '../../src/testkit/timing';
import { reserveAvailablePort } from '../../src/testkit/network/reserveAvailablePort';
import { createEphemeralTlsServerFixture } from '../../src/testkit/tls/ephemeralTlsServerFixture.mjs';

const providers = ['neon', 'supabase'] as const;

beforeAll(async () => {
  // The source CLI reads package-local Account graphs, which can be absent on a cold test worker.
  const { prepareSourceCliPluginUiArtifacts } = await import('../../../../apps/cli/scripts/prepareSourcePluginUiArtifacts.mjs');
  const result = await prepareSourceCliPluginUiArtifacts({
    repoRoot: repoRootDir(),
    workspaceNames: providers.map(provider => `plugins-deployment-${provider}`),
  });
  expect(result).toMatchObject({ pluginFailures: [] });
});

// Only third-party HTTPS is replaced. PROGRAM G1 and P1 section 15 require each
// transport's supported path: selected semantic reads plus the bound
// direct write precede missing-connection and provider-error controls.
// A failure before those positive controls is a setup blocker, not valid RED.
it.each(providers)('F4 selects %s preview/production without a neighboring fallback', provider => exerciseManagedDatabase(provider), 0);

it('F4 managed Session reads admit the owner and refuse requesters without Source access',
  () => exerciseManagedDatabase('neon', 'session'), 0);

async function exerciseManagedDatabase(provider: (typeof providers)[number], mode: 'managed' | 'session' = 'managed') {
  const testDir = await mkdtemp(join(tmpdir(), `happier-dbw-${provider}-`));
  const readers = new Map<string, string>();
  // Use the server's existing PostgreSQL driver at the fixture's wire boundary.
  const { Client } = createRequire(new URL('../../../../apps/server/package.json', import.meta.url))('pg') as {
    Client: new (options: { connectionString: string; types: { getTypeParser: () => (value: string) => string } }) => {
      connect(): Promise<void>;
      query(sql: string, parameters?: readonly unknown[]): Promise<{ rows: Record<string, string | null>[] }>;
      end(): Promise<void>;
    };
  };
  let fixture: Awaited<ReturnType<typeof startDatabaseWorkbenchFixture>> | undefined;
  const collectorPort = await reserveAvailablePort();
  const eventAdmitPath = AutomationEventActionHttpPathsV1['automation.event.admit'];
  const eventSourcePath = AUTOMATION_EVENT_STORED_DEFINITIONS_READ_HTTP_PATH_V1;
  const actionAdmissionPath = bindExternalActionExecutionAuthorizationHttpPathV1(ACTION_INVOKE_ACTION_ID_V1);
  let observeSessionReads = false;
  const sessionReadAdmissions: { sessionId: string; target: unknown; statusCode: number | null }[] = [];
  const collectorReadStatus = new Map<string, number | null>();
  const admittedFindings: string[] = [];
  let databaseSourceReads = 0;
  const providerBoundary = {
    seedManagedProjects: true,
    managedSupabaseAddress() {
      if (!fixture) throw new Error('F4 PostgreSQL address was requested before startup');
      return new URL(fixture.postgres.selectedDatabaseUrl);
    },
    async readManagedSupabase({ branchRef, sql, parameters }: { branchRef: string; sql: string; parameters: readonly unknown[] }) {
      const connectionString = readers.get(branchRef);
      if (!connectionString) return undefined;
      const client = new Client({ connectionString, types: { getTypeParser: () => value => value } });
      try {
        await client.connect();
        await client.query('BEGIN READ ONLY');
        return (await client.query(sql, parameters)).rows;
      } finally { await client.end(); }
    },
  };
  const boundary = await startDeploymentProvidersHttp(providerBoundary);
  let postgresTls: Awaited<ReturnType<typeof createEphemeralTlsServerFixture>> | undefined;
  try {
    const providerHttpPreload = new URL('../../src/testkit/deploymentProvidersHttpPreload.mjs', import.meta.url).href;
    const hostEnv = { ...boundary.env, HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1' };
    if (provider === 'supabase') {
      postgresTls = await createEphemeralTlsServerFixture();
      const trustBundle = join(testDir, 'fixture-trust.pem');
      const certificates = await Promise.all([boundary.env.NODE_EXTRA_CA_CERTS, postgresTls.caCertificatePath]
        .map(path => readFile(path, 'utf8')));
      await writeFile(trustBundle, certificates.join('\n'));
      hostEnv.NODE_EXTRA_CA_CERTS = trustBundle;
    }
    fixture = await startDatabaseWorkbenchFixture({
      testDir, postgresTls, serverEnv: { ...hostEnv, NODE_ENV: process.env.NODE_ENV },
      serverPreloadModules: [providerHttpPreload],
      advertiseRequestObservationEndpoint: provider === 'neon',
      captureRequestBody: request => request.path === eventAdmitPath || request.path === eventSourcePath
        || observeSessionReads && request.path === actionAdmissionPath,
      beforeForwardResponse(request) {
        if (request.method === 'GET' && /^\/v1\/deployments\/environments\/[^/?]+(?:\?|$)/.test(request.path)) {
          const id = request.path.split('/').at(-1)?.split('?')[0];
          if (id) collectorReadStatus.set(id, request.statusCode);
        }
        if (!request.body?.complete || request.body.truncated) return;
        if (request.path === actionAdmissionPath) {
          const { envelope, sessionActionOrigin } = ExternalActionExecutionAuthorizationRequestV1Schema.parse(JSON.parse(request.body.text));
          const admission = 'deploymentReadAdmission' in envelope ? envelope.deploymentReadAdmission : undefined;
          if (sessionActionOrigin && admission && 'databaseTarget' in admission) {
            sessionReadAdmissions.push({ sessionId: sessionActionOrigin.caller.sessionId, target: admission.databaseTarget,
              statusCode: request.statusCode });
          }
        }
        if (request.path === eventAdmitPath) {
          const admission = AutomationEventAdmitHttpRequestV1Schema.parse(JSON.parse(request.body.text));
          const ref = 'input' in admission ? admission.input.eventRef : admission.hostEvidence.eventRef;
          if (ref.pluginId === DATABASE_FINDING_EVENT_REF.pluginId && ref.localId === DATABASE_FINDING_EVENT_REF.localId) {
            admittedFindings.push(request.body.text);
          }
        }
        if (request.path === eventSourcePath) {
          const read = AutomationEventStoredDefinitionsReadHttpRequestV1Schema.parse(JSON.parse(request.body.text));
          if (read.caller.pluginId === DATABASE_PLUGIN_ID_V1 && request.statusCode === 200) databaseSourceReads++;
        }
      },
    });
    const account = await fixture.createAccount(`${provider}-fresh-owner`);
    const accountId = readAccountIdFromToken(account.credentials.token);
    const recipientContentPublicKey = nacl.box.keyPair.fromSecretKey(account.auth.accountMachineKey).publicKey;
    expect(await account.execute('machines.list', { serverId: fixture.serverId })).toMatchObject({ ok: true, result: { items: [] } });
    expect(await fixture.postgres.sql('happier', 'SELECT count(*) FROM "ProjectSource"')).toBe('0');
    expect(await fixture.postgres.sql('happier', 'SELECT count(*) FROM "Machine"')).toBe('0');
    await fixture.claimHomeOwner(account);
    expect((await fetchJson(`${fixture.server.baseUrl}/health`)).status, 'Plan 85 Home READY').toBe(200);
    const requesterVendor = mode === 'session' ? await createIsolatedFakeClaudeControlShim({
      testDir: join(testDir, 'requester-claude'), captureEnvironmentKeys: [], logFullStdin: false,
    }) : undefined;
    const managedDaemonOptions = { cliLaunchSpec: { command: process.execPath,
      args: ['--import', resolve(repoRootDir(), 'packages/cli-common/registerSourceRuntime.mjs'),
        resolve(repoRootDir(), 'apps/cli/src/index.ts')], cwd: repoRootDir() }, env: { ...hostEnv,
      ...(requesterVendor ? { HAPPIER_CLAUDE_PATH: requesterVendor.executablePath } : {}),
      HAPPIER_DEPLOYED_TELEMETRY_PORT: String(collectorPort),
      NODE_OPTIONS: `${fixture.sourceOptions} --import ${providerHttpPreload}` } };
    const machine = await fixture.enrollDaemon(account, managedDaemonOptions);
    await writeFile(join(testDir, 'runtime.json'), JSON.stringify({ homeId: fixture.serverId,
      serverPid: fixture.server.proc.child.pid, daemonPid: machine.daemon.state.pid,
      machineId: machine.target.machineId, sourceRuntime: true }));
    async function invoke(actionId: ActionId, input: unknown) {
      const result = await account.execute(actionId, input, { presentUserConfirmation: { actionId } });
      if (!result.ok) throw new Error(`F4 setup ${actionId} refused (${result.errorCode})`);
      return result.result;
    }
    async function setBindings(input: unknown) {
      const result = await account.executeReviewed('deployments.bindings.set', input, {
        externalActionTarget: { kind: 'machine', machineId: machine.target.machineId },
        presentUserConfirmation: { actionId: 'deployments.bindings.set' },
      });
      if (!result.ok) throw new Error(`F4 binding review refused (${result.errorCode})`);
      const saved = DeploymentBindingsSetResultV1Schema.parse(result.result);
      if (!saved.ok) throw new Error(`F4 binding update refused (${saved.error})`);
    }
    function executeDatabase(actionId: DatabaseActionIdV1, input: unknown, surface: 'cli' | 'person') {
      const action = { pluginId: DATABASE_PLUGIN_ID_V1, localId: databaseActionLocalIdV1(actionId) };
      const { machineId } = machine.target;
      const externalActionTarget = { kind: 'machine', machineId } as const;
      return surface === 'person'
        ? account.executeAsPerson('action.invoke', { action, input }, { externalActionTarget }, { action, machineId })
        : account.execute('action.invoke', { action, input }, { externalActionTarget,
          presentUserConfirmation: { actionId: 'action.invoke' } });
    }
    async function invokeDatabase(actionId: DatabaseActionIdV1, input: unknown, surface: 'cli' | 'person' = 'cli') {
      const result = await executeDatabase(actionId, input, surface);
      if (!result.ok) throw new Error(`F4 semantic Action refused (${result.errorCode})`);
      return result.result;
    }
    const pluginId = `happier.deploy.${provider}`;
    const service = { pluginId, localId: provider };
    expect(CONNECTED_SERVICE_CONFIGURATION_ACTION_OUTPUT_SCHEMAS_V1['connectedServices.accounts.list'].parse(
      await invoke('connectedServices.accounts.list', { service })).accounts).toEqual([]);
    const attempt = ConnectedAccountAttemptResponseSchema.parse(await invoke('connectedServices.authentication.beginConnect', {
      service, modeId: 'token' }));
    if (attempt.status !== 'configurationRequired' || attempt.target.kind !== 'attempt' || !attempt.attemptId) {
      throw new Error(`F4 Connect did not request Account configuration (${attempt.status}${'code' in attempt ? `/${attempt.code}` : ''})`);
    }
    const configuration = CONNECTED_SERVICE_CONFIGURATION_ACTION_OUTPUT_SCHEMAS_V1['connectedServices.configuration.replace'].parse(
      await invoke('connectedServices.configuration.replace', { target: { kind: 'attempt', attemptId: attempt.attemptId }, expectedRevision: null,
        values: provider === 'neon' ? { organizationId: boundary.neon.organizationId }
          : { organizationSlug: boundary.supabase.organizationSlug }, secretValues: {} }));
    const begun = ConnectedAccountAttemptResponseSchema.parse(await invoke('connectedServices.authentication.continueConnect', {
      attemptId: attempt.attemptId, expectedConfigurationRevision: configuration.revision }));
    if (begun.status !== 'awaitingManual') throw new Error(`F4 Connect did not request credentials (${begun.status})`);
    const token = `${provider}-F4-fixture-only-token`;
    const beforeConnect = boundary.entries().length;
    const connected = ConnectedAccountAttemptResponseSchema.parse(await invoke('connectedServices.authentication.submitManual', {
      attemptId: begun.attemptId, fields: { token } }));
    if (connected.status !== 'connected') {
      throw new Error(`F4 Connect did not settle (${connected.status}${'code' in connected ? `/${connected.code}` : ''})`);
    }
    const organizationPath = provider === 'neon' ? `/api/v2/organizations/${boundary.neon.organizationId}` : '/v1/organizations';
    expect(boundary.entries().slice(beforeConnect).some(request => request.method === 'GET' && request.path === organizationPath)).toBe(true);
    const source = ProjectSourcesReadOutputV1Schema.parse(await invoke('projects.sources.create', {
      serverId: fixture.serverId, name: `${provider} first Project`, requestKey: randomUUID(), defaultRef: 'main',
      repository: { provider: { id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
        repository: { nameWithOwner: 'journey/database', cloneUrl: 'https://github.com/journey/database.git' }, protocol: 'https' } }));
    if (!source.ok) throw new Error(`F4 Project creation failed (${source.error})`);

    const branches = mode === 'session' ? boundary.managedBranches.filter(branch => branch.name === 'production')
      : boundary.managedBranches;
    if (mode === 'session') expect(branches).toHaveLength(1);
    for (const branch of branches) {
      const created = await account.executeReviewed('deployments.environments.create', DeploymentEnvironmentCreateIntentInputV1Schema.parse({
        serverId: fixture.serverId, projectSourceId: source.source.id, requestKey: randomUUID(), name: `${provider} ${branch.name}`,
        definition: { from: 'repository', ref: branch.name }, retainPreviousDeployments: 1,
        protection: branch.name === 'production' ? 'production' : 'nonProduction', purpose: 'standard', deployerMode: 'managers',
        controllerMachineId: machine.target.machineId }), { externalActionTarget: { kind: 'machine', machineId: machine.target.machineId },
        presentUserConfirmation: { actionId: 'deployments.environments.create' } });
      if (!created.ok) throw new Error(`F4 setup deployments.environments.create refused (${created.errorCode})`);
      const environment = DeploymentEnvironmentCreateResultV1Schema.parse(created.result);
      if (!environment.ok) throw new Error(`F4 Environment creation failed (${environment.error})`);
      const address = { serverId: fixture.serverId, environmentId: environment.environmentId };
      const scope = { kind: 'environment' as const, environment: { ...address, projectSourceId: source.source.id } };
      expect(DatabaseTargetsListResultV1Schema.parse(await invokeDatabase(DATABASE_TARGETS_LIST_ACTION_ID_V1, { scope })))
        .toMatchObject({ targets: [], completeness: { complete: true } });
      const principal = { kind: 'account' as const, accountId,
        purpose: { consumer: { pluginId, localId: 'projects-link' }, purpose: 'deploy-manage' },
        target: { kind: 'account' as const, account: connected.account } };
      const platformProjectId = provider === 'neon' ? boundary.neon.projectId : boundary.supabase.projectRef;
      const branchId = provider === 'neon' ? branch.neonId : branch.supabaseRef;
      // projects-link inspects a provider target. The later deployment Link
      // Action changes state and carries its own review.
      const inspected = await account.execute('action.invoke', { action: { pluginId, localId: 'projects-link' }, input: {
        v: 1, ...address, expectedRevision: environment.revision, credentialRef: connected.account, credentialPrincipal: principal,
        providerAccountId: provider === 'neon' ? boundary.neon.organizationId : boundary.supabase.organizationSlug,
        providerEnvironment: { kind: 'native', selection: { branchId } },
        ...(provider === 'neon' ? { projectId: platformProjectId, branchId } : { projectRef: platformProjectId }) } },
        { externalActionTarget: { kind: 'machine', machineId: machine.target.machineId } });
      if (!inspected.ok) throw new Error(`F4 provider target inspection refused (${inspected.errorCode})`);
      const linked = inspected.result;
      if (!linked || typeof linked !== 'object' || Array.isArray(linked)
        || !('providerIdentity' in linked) || !('providerEnvironment' in linked)) throw new Error('F4 provider link omitted its result');
      const linkContent = DeploymentTargetLinkContentV1Schema.parse({ credentialPrincipal: principal,
        providerIdentity: linked.providerIdentity, providerEnvironment: linked.providerEnvironment,
        data: { engine: 'postgres', providerConsole: 'providerConsole' in linked ? linked.providerConsole : undefined } });
      if (!linkContent.providerIdentity) throw new Error('F4 provider omitted its selected identity');
      const linkAction = await account.executeReviewed('deployments.targets.link', {
        ...address, expectedRevision: environment.revision, requestKey: randomUUID(), role: 'data', machines: [],
        targetId: 'database', targetKind: provider, source: { kind: 'plugin', contribution: { pluginId, localId: 'database' } },
        provider: linkContent }, { externalActionTarget: { kind: 'machine', machineId: machine.target.machineId },
        presentUserConfirmation: { actionId: 'deployments.targets.link' } });
      if (!linkAction.ok) throw new Error(`F4 selected managed database Link refused (${linkAction.errorCode})`);
      const parsedLink = DeploymentTargetLinkResultV1Schema.safeParse(linkAction.result);
      if (!parsedLink.success) throw new Error(`F4 selected managed database Link returned unexpected fields (${Object.keys(linkAction.result ?? {}).join(', ')})`);
      const link = parsedLink.data;
      if (!link.ok || !('targetLinkId' in link)) throw new Error('F4 selected managed database did not link');
      if (provider === 'neon') {
        // The public custody/binding producer owns the dedicated P45 read role.
        const resourceId = randomUUID();
        const resourceDataKey = Uint8Array.from(randomBytes(32));
        try {
          await invoke('secrets.shared.create', { resourceId, displayName: 'F4 read role', kind: 'token', encryptionMode: 'e2ee',
            storedContent: sealSavedSecretResourceStoredContentV1({ resourceId, mode: 'e2ee', resourceDataKey, randomBytes,
              content: { v: 1, name: 'F4 read role', kind: 'token', value: randomUUID() } }),
            keyEnvelopes: [{ recipientAccountId: accountId, ...sealSavedSecretResourceRecipientEnvelopeV1({ resourceDataKey,
              recipientContentPublicKey, randomBytes }) }] });
        } finally { resourceDataKey.fill(0); }
        const current = DeploymentEnvironmentGetResultV1Schema.parse(await invoke('deployments.environments.get', address));
        if (!current.ok) throw new Error(`F4 Environment read failed (${current.error})`);
        await setBindings({ ...address, expectedRevision: current.environment.revision,
          set: [{ purpose: 'dataRole', targetLinkId: link.targetLinkId, role: 'readOnlyPassword', source: {
            kind: 'secret', ref: formatSharedSavedSecretRefV1(resourceId), resourceRevision: 1 } }], remove: [] });
      }
      const expectedTarget = DatabaseManagedDeploymentTargetV1Schema.parse({ kind: 'managed_deployment',
        environment: { ...address, projectSourceId: source.source.id }, targetLinkId: link.targetLinkId,
        contribution: { pluginId, contributionId: 'database' }, platformProjectId, branchId,
        database: provider === 'neon' ? 'neondb' : 'postgres' });
      const discovered = DatabaseTargetsListResultV1Schema.parse(await invokeDatabase(DATABASE_TARGETS_LIST_ACTION_ID_V1, { scope }));
      const selectedDescriptor = discovered.targets.find(descriptor => descriptor.target.kind === 'managed_deployment'
        && descriptor.target.targetLinkId === link.targetLinkId);
      expect(selectedDescriptor, 'F4 linked database must be reachable through real target discovery').toBeDefined();
      const target = DatabaseManagedDeploymentTargetV1Schema.parse(selectedDescriptor?.target);
      expect(target).toEqual(expectedTarget);
      // AM1 binds the public automation subject to the selected data Link.
      const automationSubject = { ok: true, subject: { kind: 'database', serverId: fixture.serverId,
        target: { kind: 'managed_deployment', environmentId: environment.environmentId,
          targetLinkId: link.targetLinkId } } };
      expect(selectedDescriptor?.automationSubject).toEqual(automationSubject);
      async function semantic(actionId: DatabaseActionIdV1, input: unknown, surface?: 'cli' | 'person') {
        return DatabaseOperationResultV1Schema.parse(await invokeDatabase(actionId, input, surface));
      }
      const sql = provider === 'neon' ? 'SELECT marker, typed_text AS duplicate, exact_integer AS duplicate, absent, empty_text FROM dbw_managed_sentinel'
        : 'SELECT marker, absent, empty_text FROM dbw_managed_sentinel';
      const read = (statement: string) => semantic(DATABASE_STATEMENT_RUN_ACTION_ID_V1,
        DatabaseReadStatementInputV1Schema.parse({ operation: 'statement.run', mode: 'read', target, statement: { sql: statement, parameters: [] } }));
      const selected = await read(sql);
      expect(selected).toMatchObject({ ok: true, operation: 'statement.run', results: [{ rows: [{ cells: provider === 'neon'
        ? [{ type: 'text', value: branch.marker }, { type: 'text', value: 'typed-text' },
          { type: 'integer', value: '9007199254740993' }, { type: 'null' }, { type: 'text', value: '' }]
        : [{ type: 'text', value: branch.marker }, { type: 'null' }, { type: 'text', value: '' }] }],
      completeness: provider === 'neon' ? { complete: true } : { complete: false, reason: 'transport_unproven' } }] });
      if (mode === 'session') {
        const input = DatabaseReadStatementInputV1Schema.parse({
          operation: 'statement.run', mode: 'read', target, statement: { sql, parameters: [] },
        });
        const person = await executeDatabase(DATABASE_STATEMENT_RUN_ACTION_ID_V1, input, 'person');
        expect(person).toMatchObject({ ok: true, result: selected });

        if (!requesterVendor) throw new Error('F4 native Session vendor fixture is missing');
        const ownerSession = await fixture.assertKnownGoodSessionControl(account, machine);
        try {
          await setDefaultPermissionMode(account, ownerSession.sessionId);
          const runRead = () => fixture.executeSessionMcpAction(account,
            { ...ownerSession, logPath: requesterVendor.logPath }, DATABASE_STATEMENT_RUN_ACTION_ID_V1, input);
          const setAgentAccess = async (dataAgentAccess: 'none' | 'read') => {
            const current = DeploymentEnvironmentGetResultV1Schema.parse(await invoke('deployments.environments.get', address));
            if (!current.ok) throw new Error(`Managed role policy read refused (${current.error})`);
            const changed = await account.executeReviewed('deployments.environments.update', { ...address,
              expectedRevision: current.environment.revision, contentArtifactId: current.environment.contentArtifactId,
              contentHeaderVersion: current.environment.contentHeaderVersion, contentBodyVersion: current.environment.contentBodyVersion,
              patch: { dataAgentAccess },
            }, { presentUserConfirmation: { actionId: 'deployments.environments.update' } });
            expect(changed).toMatchObject({ ok: true, result: { ok: true } });
          };
          await setAgentAccess('none');
          expect(await runRead()).toMatchObject({ ok: false, errorCode: 'database_agent_access_none' });
          await setAgentAccess('read');
          expect(await runRead()).toMatchObject({ ok: true, result: selected });
        } finally {
          await account.executeAsPerson('session.stop', { sessionId: ownerSession.sessionId });
        }

        const outsider = await fixture.createAccount('f4-foreign-session');
        const member = await fixture.createAccount('f4-team-member-without-source');
        const memberId = readAccountIdFromToken(member.credentials.token);
        if (!accountId || !memberId) throw new Error('F4 foreign Session fixture is incomplete');
        const team = TeamSummaryV1Schema.parse(await reviewed('teams.create', {
          v: 1, name: 'F4 Team without Source access', initialOwnerAccountId: accountId, requestKey: randomUUID(),
        }));
        await reviewed('teams.members.add', {
          v: 1, teamId: team.id, accountId: memberId, role: 'member', historyAccess: 'all_existing',
        });
        for (const requester of [outsider, member]) {
          const requesterMachine = await fixture.enrollDaemon(requester, managedDaemonOptions);
          const { sessionId } = await fixture.assertKnownGoodSessionControl(requester, requesterMachine);
          try {
            await setDefaultPermissionMode(requester, sessionId);
            observeSessionReads = true;
            const providerRequests = boundary.entries().length;
            const refused = await fixture.executeSessionMcpAction(requester, { sessionId, logPath: requesterVendor.logPath },
              DATABASE_STATEMENT_RUN_ACTION_ID_V1, input);
            expect(refused, requester.name).toMatchObject({ ok: false, errorCode: 'credential_scope_denied' });
            expect(sessionReadAdmissions, requester.name).toContainEqual({ sessionId, target, statusCode: 403 });
            expect(boundary.entries().slice(providerRequests).some(request => request.path === '/sql')).toBe(false);
          } finally {
            observeSessionReads = false;
            await requester.executeAsPerson('session.stop', { sessionId });
          }
        }
        async function setDefaultPermissionMode(requester: typeof account, sessionId: string) {
          // Let the database authorization owner decide the read through action_execute.
          const permission = await requester.executeAsPerson(SESSION_PERMISSION_MODE_SET_ACTION_ID_V1, {
            sessionId, permissionMode: 'default', applyTiming: 'immediate',
          });
          expect(permission, requester.name).toMatchObject({ ok: true, result: { ok: true } });
        }

        async function reviewed(actionId: ActionId, input: unknown) {
          const result = await account.executeReviewed(actionId, input, { presentUserConfirmation: { actionId } });
          if (!result.ok) throw new Error(`F4 setup ${actionId} refused (${result.errorCode})`);
          return result.result;
        }
        return;
      }
      const empty = await read(`${sql} WHERE false`);
      expect(empty).toMatchObject({ ok: true, operation: 'statement.run', results: [{ rows: [],
        ...(provider === 'neon' ? { columns: [{ name: 'marker' }, { name: 'duplicate' }, { name: 'duplicate' }, { name: 'absent' }, { name: 'empty_text' }] } : {}),
        completeness: provider === 'neon' ? { complete: true } : { complete: false, reason: 'transport_unproven' } }] });
      const schemas = () => semantic(DATABASE_SCHEMAS_LIST_ACTION_ID_V1,
        { operation: 'schemas.list', target, page: { rows: 1 } }, 'person');
      expect(await schemas()).toMatchObject({ ok: true, operation: 'schemas.list', schemas: [{ name: 'public' }],
        completeness: { complete: false, reason: 'page', continuation: { after: 'public' } } });
      if (provider === 'supabase') {
        expect(await semantic(DATABASE_RELATIONS_LIST_ACTION_ID_V1,
          { operation: 'relations.list', target, schema: 'public', page: { rows: 10 } }, 'person'))
          .toMatchObject({ ok: true, operation: 'relations.list',
            relations: [{ relation: { schema: 'public', name: 'dbw_managed_sentinel' }, kind: 'table', estimatedRows: '1' }] });
        boundary.rejectNextManagedQuery(provider);
        expect(await schemas()).toMatchObject({ ok: false, status: 'failed', code: 'provider_http_429' });
      }
      {
        // Permit the person at the owning Environment policy so this assertion
        // distinguishes transport support from the default editing-off refusal.
        const current = DeploymentEnvironmentGetResultV1Schema.parse(await invoke('deployments.environments.get', address));
        if (!current.ok) throw new Error(`F4 editing setup read failed (${current.error})`);
        const editing = await account.executeReviewed('deployments.environments.update', { ...address,
          expectedRevision: current.environment.revision, contentArtifactId: current.environment.contentArtifactId,
          contentHeaderVersion: current.environment.contentHeaderVersion, contentBodyVersion: current.environment.contentBodyVersion,
          patch: { dataEditorMode: 'managers' } },
        { presentUserConfirmation: { actionId: 'deployments.environments.update' } });
        if (!editing.ok) throw new Error(`F4 editing setup refused (${editing.errorCode})`);
        const updated = DeploymentEnvironmentUpdateResultV1Schema.parse(editing.result);
        if (!updated.ok) throw new Error(`F4 editing setup failed (${updated.error})`);
        const described = await semantic(DATABASE_DESCRIBE_ACTION_ID_V1, { operation: 'describe', target });
        expect(described).toMatchObject({ ok: true, operation: 'describe', descriptor: {
          automationSubject,
          capabilities: expect.arrayContaining([expect.objectContaining({ operation: 'edits.apply', available: true })]) } });
        // TS.P3.F5e-managed-write: the supported selected managed read above is
        // P3-F5e-known-good-managed-read. Bind the existing direct connection
        // Saved Secret through the public P42 path; no provider admin fallback.
        const database = provider === 'neon' ? 'neondb' : 'postgres';
        if (provider === 'neon' && branch.name === boundary.managedBranches[0]!.name) {
          await fixture.postgres.sql('happier', 'CREATE DATABASE neondb');
        }
        const table = `dbw_write_${branch.name}`;
        await fixture.postgres.sql(database, `CREATE TABLE ${table}(id bigint PRIMARY KEY, value text NOT NULL, mutations integer NOT NULL DEFAULT 0);
          INSERT INTO ${table} VALUES (1, 'before')`);
        const direct = new URL(fixture.postgres.selectedDatabaseUrl);
        direct.pathname = `/${database}`;
        const resourceId = randomUUID();
        const resourceDataKey = Uint8Array.from(randomBytes(32));
        try {
          await invoke('secrets.shared.create', { resourceId, displayName: 'Existing direct connection', kind: 'token', encryptionMode: 'e2ee',
            storedContent: sealSavedSecretResourceStoredContentV1({ resourceId, mode: 'e2ee', resourceDataKey, randomBytes,
              content: { v: 1, name: 'Existing direct connection', kind: 'token', value: direct.href } }),
            keyEnvelopes: [{ recipientAccountId: accountId, ...sealSavedSecretResourceRecipientEnvelopeV1({ resourceDataKey,
              recipientContentPublicKey, randomBytes }) }] });
        } finally { resourceDataKey.fill(0); }
        const bindingBasis = DeploymentEnvironmentGetResultV1Schema.parse(await invoke('deployments.environments.get', address));
        if (!bindingBasis.ok) throw new Error(`F5e write binding setup failed (${bindingBasis.error})`);
        expect(bindingBasis.environment).toMatchObject({ dataEditorMode: 'managers', capabilities: { editData: true } });
        await setBindings({ ...address, expectedRevision: bindingBasis.environment.revision,
          set: [{ purpose: 'dataRole', targetLinkId: link.targetLinkId, role: 'write', source: {
            kind: 'secret', ref: formatSharedSavedSecretRefV1(resourceId), resourceRevision: 1 } }], remove: [] });
        const write = (statements: { sql: string; parameters: { type: 'text'; value: string }[] }[]) =>
          semantic(DATABASE_STATEMENT_RUN_ACTION_ID_V1, DatabaseWriteStatementInputV1Schema.parse({
            operation: 'statement.run', mode: 'write', target, executionMode: 'transaction', statements }), 'person');
        // Match the real qualified contributed Action against the selected
        // managed Database, excluding a neighboring binding.
        const armAfter = async (targetLinkId: string) => {
          const armed = await account.executeReviewed('workflow.trigger.add', {
            project: { machineId: machine.target.machineId, directory: machine.workspaceDir },
            target: { kind: 'inline', definition: { version: 1, blocks: [
              { kind: 'action', id: 'read-policy', actionId: 'actions.policy.get', input: { profiles: { kind: 'literal', value: true } } },
            ] } },
            trigger: { kind: 'action', enabled: true, phase: 'after', actionIds: [DATABASE_STATEMENT_RUN_ACTION_ID_V1],
              subject: { ...automationSubject.subject, target: { ...automationSubject.subject.target, targetLinkId } } },
          }, { externalActionTarget: { kind: 'machine', machineId: machine.target.machineId },
            presentUserConfirmation: { actionId: 'workflow.trigger.add' } });
          if (!armed.ok) throw new Error(`Database after trigger refused (${armed.errorCode})`);
          return WorkflowTriggerWriteResultV1Schema.parse(armed.result);
        };
        const after = await armAfter(link.targetLinkId);
        const neighborAfter = await armAfter(randomUUID());
        const serverBaseUrl = fixture.server.baseUrl;
        const runs = async (automationId: string) => {
          const response = await fetchJson<unknown>(`${serverBaseUrl}/v3/automations/${encodeURIComponent(automationId)}/runs`, {
            headers: { Authorization: `Bearer ${account.credentials.token}`,
              ...buildAccountStoredContentCompatibilityHttpHeadersV1(CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION) },
          });
          expect(response.status).toBe(200);
          return AutomationV3RunListResponseSchema.parse(response.data).runs;
        };
        if (provider === 'neon' && branch === boundary.managedBranches[0]) {
          const otherAccount = await fixture.createAccount('plan85-unshared-owner');
          const otherMachine = await fixture.enrollDaemon(otherAccount);
          const refused = await otherAccount.executeReviewed('deployments.environments.create', {
            serverId: address.serverId, name: 'Unshared collector control', requestKey: randomUUID(),
            newProject: { name: 'Plan 85 private', requestKey: randomUUID(), owner: {
              kind: 'account', accountId: readAccountIdFromToken(otherAccount.credentials.token),
            } },
            definition: { from: 'compose', document: JSON.stringify({ services: { app: { image: 'node:22' } } }), profiles: [], services: ['app'] },
            protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers', controllerMachineId: otherMachine.target.machineId,
          }, { externalActionTarget: { kind: 'machine', machineId: otherMachine.target.machineId },
            presentUserConfirmation: { actionId: 'deployments.environments.create' } });
          if (!refused.ok) throw new Error(`Plan 85 private Environment refused setup (${refused.errorCode})`);
          const privateEnvironment = DeploymentEnvironmentCreateResultV1Schema.parse(refused.result);
          if (!privateEnvironment.ok) throw new Error(`Plan 85 private Environment unavailable (${privateEnvironment.error})`);
          const selectedToken = randomUUID();
          const refusedToken = randomUUID();
          // Seed only the existing assignment, including one valid exporter whose collector
          // is outside the Environment's Account. Home still signs assignments and decides reads.
          for (const [environmentId, token] of [[address.environmentId, selectedToken], [privateEnvironment.environmentId, refusedToken]]) {
            const hash = createHash('sha256').update(token).digest('hex');
            await fixture.postgres.sql('happier', `UPDATE "DeploymentEnvironment" SET "telemetryMachineId" = '${machine.target.machineId}',
                "telemetryTokenHash" = '${hash}' WHERE id = '${environmentId}'`);
            collectorReadStatus.delete(environmentId);
          }
          const roles = MachineRolesGetResultV1Schema.parse(await invoke('machines.roles.get', machine.target));
          if (roles.status !== 'ready') throw new Error('Plan 85 Machine roles unavailable');
          const enabled = await account.executeReviewed('machines.roles.set', { ...machine.target,
            expectedPolicy: roles.policy, expectedMetadataVersion: roles.metadataVersion,
            policy: { active: [...new Set([...roles.policy.active, DATABASE_TELEMETRY_MACHINE_ROLE_ID_V1])] },
          }, { presentUserConfirmation: { actionId: 'machines.roles.set' } });
          if (!enabled.ok) throw new Error(`Plan 85 collector role refused (${enabled.errorCode})`);
          expect(enabled.result).toMatchObject({ status: 'applied', policy: {
            active: expect.arrayContaining([DATABASE_TELEMETRY_MACHINE_ROLE_ID_V1]) } });
          await waitFor(() => {
            const selected = collectorReadStatus.get(address.environmentId);
            const refused = collectorReadStatus.get(privateEnvironment.environmentId);
            if (selected === 200 && [403, 404].includes(refused ?? 0)) return true;
            throw new Error(`Collector binding read statuses ${selected ?? 'missing'} / ${refused ?? 'missing'}`);
          }, { timeoutMs: 90_000, context: 'Home must admit the collector custodian only to the selected Environment' });

          const availability = await fetchJson<unknown>(fixture.server.baseUrl + PluginAvailabilityActionHttpPathsV1['account.plugins.availability.materializations.read'], {
            method: 'POST', headers: { Authorization: `Bearer ${account.credentials.token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ pluginIds: [DATABASE_PLUGIN_ID_V1] }),
          });
          expect(availability.status).toBe(200);
          const materialization = PluginAvailabilityMaterializationsReadActionOutputV1Schema.parse(availability.data).snapshots
            .find(row => row.machineId === machine.target.machineId)?.materializations
            .find(row => row.pluginId === DATABASE_PLUGIN_ID_V1 && row.enabled && row.trustState === 'trusted');
          if (!materialization) throw new Error('Plan 85 missing installed Workbench');
          const arm = async (targetLinkId: string) => {
            const setup = await account.execute('action.invoke', { action: { pluginId: DATABASE_PLUGIN_ID_V1, localId: DATABASE_FINDING_SETUP_LOCAL_ID },
              input: { v: 1, sourceScope: machine.target,
                subject: projectAutomationDatabaseFindingSubjectV1(fixture.serverId, { ...target, targetLinkId }) } },
            { externalActionTarget: { kind: 'machine', machineId: machine.target.machineId } });
            if (!setup.ok) throw new Error(`Plan 85 source setup refused (${setup.errorCode})`);
            const source = PluginEventAutomationSetupResultV1Schema.parse(setup.result);
            const result = await account.executeReviewed('workflow.trigger.add', {
              project: { machineId: machine.target.machineId, directory: machine.workspaceDir },
              target: { kind: 'inline', definition: { version: 1, blocks: [
                { kind: 'action', id: 'read-policy', actionId: 'actions.policy.get', input: { profiles: { kind: 'literal', value: true } } },
              ] } },
              trigger: { kind: 'pluginEvent', enabled: true, eventRef: DATABASE_FINDING_EVENT_REF,
                sourceInstanceId: source.sourceInstanceId, sourceContractVersion: source.sourceContractVersion,
                sourceConfig: source.sourceConfig, displayLabel: source.displayLabel, maximumObservationAgeMs: null,
                observationTransport: { kind: 'checkpointedPull', watcherMaterializationRef: {
                  machineId: machine.target.machineId, pluginId: materialization.pluginId, materializationId: materialization.materializationId,
                } }, filter: { v: 1, all: [{ op: 'eq', field: '/observation/kind', value: 'suspected_n_plus_one' }] } },
            });
            if (!result.ok) throw new Error(`Plan 85 trigger refused (${result.errorCode})`);
            return WorkflowTriggerWriteResultV1Schema.parse(result.result);
          };
          const armed = await arm(target.targetLinkId);
          const neighboring = await arm(randomUUID());
          function trace(databaseName?: string, sql = 'SELECT $1::integer AS plan85_id') {
            const traceId = randomBytes(16).toString('hex');
            const spanId = randomBytes(8).toString('hex');
            const begin = BigInt(Date.now()) * 1_000_000n;
            const timing = { startTimeUnixNano: String(begin), endTimeUnixNano: String(begin + 1_000_000n) };
            const attr = (key: string, stringValue: string) => ({ key, value: { stringValue } });
            return [{ ...timing, traceId, spanId, kind: 2,
              name: 'GET /plan85', attributes: [attr('http.request.method', 'GET'), attr('http.route', '/plan85')] },
            ...[1, 2, 3].map(parameter => ({ ...timing, traceId, spanId: randomBytes(8).toString('hex'), parentSpanId: spanId, kind: 3,
              name: 'SELECT', attributes: [attr('db.system.name', 'postgresql'), attr('server.address', direct.hostname),
                { key: 'server.port', value: { intValue: direct.port } }, ...(databaseName ? [attr('db.namespace', databaseName)] : []),
                attr('db.query.text', sql),
                { key: 'db.query.parameter.1', value: { intValue: String(parameter) } }] }))];
          }
          async function emit(token: string, ...requests: ReturnType<typeof trace>[]) {
            const body = JSON.stringify({ resourceSpans: [{ scopeSpans: [{ spans: requests.flat() }] }] });
            const response = await fetch(`http://127.0.0.1:${collectorPort}/v1/traces`, { method: 'POST', body,
              headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } });
            expect(response.status).toBe(200);
            expect(await response.json()).not.toHaveProperty('partialSuccess');
          }
          const first = trace(database);
          await emit(selectedToken, first);
          await waitFor(async () => (await runs(armed.set.automationId)).some(run => run.state === 'succeeded'),
            { timeoutMs: 90_000, context: 'Configured installed Workbench finding completes real Workflow Run' });
          expect(await runs(armed.set.automationId)).toHaveLength(1);
          await emit(selectedToken, first);
          await emit(selectedToken, trace(`${database}_neighbor`));
          await emit(selectedToken, trace());
          await emit(refusedToken, trace(database));
          // Export distinct application requests in the same batches the OTLP receiver accepts in production.
          const remaining = 999;
          const requestsPerExport = 50;
          for (let sent = 0; sent < remaining; sent += requestsPerExport) {
            const requests = Array.from({ length: Math.min(requestsPerExport, remaining - sent) }, () => trace(database));
            await emit(selectedToken, ...requests);
          }
          expect(admittedFindings).toHaveLength(1);
          expect(await runs(armed.set.automationId)).toHaveLength(1);
          await emit(selectedToken, trace(database, 'SELECT $1::integer AS plan85_control_id'));
          await waitFor(async () => (await runs(armed.set.automationId)).filter(run => run.state === 'succeeded').length === 2,
            { timeoutMs: 90_000, context: 'A distinct SQL shape on the same binding completes one more Run' });
          expect(await runs(neighboring.set.automationId)).toEqual([]);
          expect(admittedFindings.length).toBe(2);
          const privateValues = [direct.href, JSON.stringify(direct.password), 'plan85_id', JSON.stringify(database)];
          expect(admittedFindings.some(request => privateValues.some(value => request.includes(value)))).toBe(false);
          const readsBefore = databaseSourceReads;
          const disabled = WorkflowTriggerWriteResultV1Schema.parse(await invoke('workflow.trigger.update', {
            automationId: armed.set.automationId,
            expectedRevision: armed.set.revision, patch: { enabled: false } }));
          expect(disabled.set.enabled).toBe(false);
          await emit(selectedToken, trace(database, 'SELECT $1::integer AS plan85_disabled_id'));
          await waitFor(() => databaseSourceReads > readsBefore, { context: 'Installed Workbench reloads the source catalog after disable' });
          expect(admittedFindings.length).toBe(2);
          expect(await runs(armed.set.automationId)).toHaveLength(2);
          await invoke('workflow.trigger.remove', { automationId: armed.set.automationId, triggerId: armed.triggerId });
          await invoke('workflow.trigger.remove', { automationId: neighboring.set.automationId, triggerId: neighboring.triggerId });
          console.info('Plan 85 READY replay verified', { homeId: fixture.serverId, machineId: machine.target.machineId });
        }
        const committed = await write([{ sql: `UPDATE ${table} SET value=$1, mutations=mutations+1 WHERE id=1 RETURNING value AS duplicate, 9007199254740993::bigint AS duplicate`,
          parameters: [{ type: 'text', value: 'committed' }] }]);
        expect(committed, 'P3-F5e-known-good-write-binding').toMatchObject({ ok: true, results: [{ affectedRows: '1',
          columns: [{ name: 'duplicate' }, { name: 'duplicate' }], rows: [{ cells: [
            { type: 'text', value: 'committed' }, { type: 'integer', value: '9007199254740993' }] }] }] });
        expect(await fixture.postgres.sql(database, `SELECT value FROM ${table} WHERE id=1`)).toBe('committed');
        expect(await fixture.postgres.sql(database, `SELECT mutations FROM ${table} WHERE id=1`)).toBe('1');
        let runId: string | undefined;
        try {
          await waitFor(async () => {
            const admitted = await runs(after.set.automationId);
            if (admitted.length === 0) return false;
            expect(admitted).toHaveLength(1);
            runId = admitted[0]?.id;
            return runId !== undefined;
          }, { failFast: true, context: 'Selected managed Database write admits its after Action Run' });
        } catch (error) {
          if (provider !== 'neon') throw error;
          const matchingOccurrences = fixture.readActionOccurrences().filter(({ evidence, triggers }) =>
            evidence.phase === 'after' && evidence.actionId === DATABASE_STATEMENT_RUN_ACTION_ID_V1
            && triggers.some(trigger => trigger.triggerId === after.triggerId));
          throw new Error(`F4 after Action Run admission failed (${matchingOccurrences.length} matching requests reached the recorder)`,
            { cause: error });
        }
        const waited = WorkflowRunWaitResultV1Schema.parse(await invoke('workflow.run.wait', {
          runId, conditions: ['terminal', 'attention'],
        }));
        expect({ observation: waited.observation, state: waited.run.state, errorCode: waited.run.errorCode },
          'Selected managed Database after Action Run settles').toMatchObject({ observation: 'terminal', state: 'succeeded' });
        expect(await runs(after.set.automationId)).toMatchObject([{ state: 'succeeded' }]);
        expect(await runs(neighborAfter.set.automationId)).toEqual([]);
        await invoke('workflow.trigger.remove', { automationId: after.set.automationId, triggerId: after.triggerId });
        await invoke('workflow.trigger.remove', { automationId: neighborAfter.set.automationId, triggerId: neighborAfter.triggerId });
        expect(await write([{ sql: `UPDATE ${table} SET value=$1 WHERE id=1`, parameters: [{ type: 'text', value: 'rollback' }] },
          { sql: `INSERT INTO ${table}(id,value) VALUES (1,$1)`, parameters: [{ type: 'text', value: 'conflict' }] }]))
          .toMatchObject({ ok: false, status: 'failed', cause: { source: 'engine', code: '23505' } });
        expect(await fixture.postgres.sql(database, `SELECT value FROM ${table} WHERE id=1`)).toBe('committed');
        const apply = (changes: unknown[]) => semantic(DATABASE_EDITS_APPLY_ACTION_ID_V1,
          DatabaseEditsApplyInputV1Schema.parse({ operation: 'edits.apply', target,
            relation: { schema: 'public', name: table }, changes }), 'person');
        const update = (before: string, after: string) => ({ kind: 'update',
          key: [{ column: 'id', value: { type: 'integer', value: '1' } }],
          original: [{ column: 'value', value: { type: 'text', value: before } }],
          values: [{ column: 'value', value: { kind: 'value', cell: { type: 'text', value: after } } }] });
        expect(await apply([update('committed', 'edited'), { kind: 'insert', values: [
          { column: 'id', value: { kind: 'value', cell: { type: 'integer', value: '2' } } },
          { column: 'value', value: { kind: 'value', cell: { type: 'text', value: 'inserted-once' } } },
        ] }])).toMatchObject({ ok: true, operation: 'edits.apply', status: 'committed', updated: '1', inserted: '1' });
        expect(await fixture.postgres.sql(database, `SELECT value FROM ${table} WHERE id=1`)).toBe('edited');
        expect(await fixture.postgres.sql(database, `SELECT count(*) FROM ${table}`)).toBe('2');
        expect(await apply([update('edited', 'must-rollback'), { kind: 'insert', values: [
          { column: 'id', value: { kind: 'value', cell: { type: 'integer', value: '1' } } },
          { column: 'value', value: { kind: 'value', cell: { type: 'text', value: 'duplicate' } } },
        ] }])).toMatchObject({ ok: false, status: 'failed', cause: { source: 'engine', code: '23505' } });
        expect(await fixture.postgres.sql(database, `SELECT value FROM ${table} WHERE id=1`)).toBe('edited');
        if (provider === 'supabase') {
          const readWithoutReader = await executeDatabase(DATABASE_STATEMENT_RUN_ACTION_ID_V1,
            DatabaseReadStatementInputV1Schema.parse({ operation: 'statement.run', mode: 'read', target,
              statement: { sql, parameters: [] } }), 'person');
          expect(readWithoutReader).toMatchObject({ ok: false, errorCode: 'read_role_setup_required' });
        } else {
          expect(await read(sql)).toMatchObject({ ok: true });
        }
        expect(JSON.stringify(committed)).not.toContain(direct.href);

        // Exercise missing setup only after the same selected transport's real
        // admitted write and native effects have established G1.
        const removalBasis = DeploymentEnvironmentGetResultV1Schema.parse(await invoke('deployments.environments.get', address));
        if (!removalBasis.ok) throw new Error(`F4 write binding removal setup failed (${removalBasis.error})`);
        await setBindings({ ...address, expectedRevision: removalBasis.environment.revision,
          set: [], remove: [{ purpose: 'dataRole', targetLinkId: link.targetLinkId, role: 'write' }] });
        const beforeWrite = boundary.entries().length;
        const written = await executeDatabase(DATABASE_STATEMENT_RUN_ACTION_ID_V1, DatabaseWriteStatementInputV1Schema.parse({
          operation: 'statement.run', mode: 'write', target, executionMode: 'transaction', statements: [
            { sql: 'UPDATE dbw_managed_sentinel SET empty_text = $1', parameters: [{ type: 'text', value: 'must-not-write' }] }] }), 'person');
        expect(written).toMatchObject({ ok: false, errorCode: 'write_connection_setup_required' });
        expect(boundary.entries().slice(beforeWrite).some(entry => entry.method === 'POST'
          && (entry.path.includes('/database/query') || entry.path === '/sql'))).toBe(false);
        if (provider === 'supabase') {
          expect(await read(sql)).toMatchObject({ ok: true, operation: 'statement.run', results: [{ rows: [{
            cells: [{ type: 'text', value: branch.marker }, { type: 'null' }, { type: 'text', value: '' }],
          }] }] });
          const reader = new URL(direct);
          reader.username = `dbw_read_${branch.name}`;
          reader.password = randomUUID();
          try {
            await fixture.postgres.sql(database, `CREATE ROLE ${reader.username} LOGIN PASSWORD '${reader.password}';
              GRANT CONNECT ON DATABASE ${database} TO ${reader.username};
              GRANT USAGE ON SCHEMA public TO ${reader.username};
              GRANT SELECT ON TABLE ${table} TO ${reader.username};`);
          } catch {
            throw new Error('F4 could not configure the native catalogue reader');
          }
          readers.set(branch.supabaseRef, reader.href);
          try {
            const relations = () => semantic(DATABASE_RELATIONS_LIST_ACTION_ID_V1,
              { operation: 'relations.list', target, schema: 'public', search: table, page: { rows: 10 } }, 'person');
            expect(await relations()).toMatchObject({ ok: true, operation: 'relations.list',
              relations: [{ relation: { schema: 'public', name: table }, kind: 'table' }] });
            boundary.rejectNextManagedQuery(provider);
            expect(await relations()).toMatchObject({ ok: false, status: 'failed', code: 'provider_http_429' });
          } finally { readers.delete(branch.supabaseRef); }
        }
      }
      boundary.rejectNextManagedQuery(provider);
      const failed = await read(sql);
      expect(failed).toMatchObject({ ok: false, status: 'failed', cause: {
        code: provider === 'neon' ? '42601' : 'provider_http_429' } });
      expect(JSON.stringify({ selected, empty, failed })).not.toContain(token);
      expect(boundary.entries().some(entry => entry.path.endsWith('/database/query'))).toBe(false);
    }
  } finally {
    try { await fixture?.stop(); }
    finally {
      try { await boundary.stop(); } finally { await postgresTls?.cleanup(); }
    }
  }
}
