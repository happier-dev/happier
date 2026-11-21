import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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
    DATABASE_EDITS_APPLY_ACTION_ID_V1,
    type DatabaseActionIdV1,
} from '@happier-dev/database-protocol';
import { databaseActionLocalIdV1 } from '@happier-dev/database-protocol';
import { DeploymentTargetLinkContentV1Schema } from '@happier-dev/protocol/deployments/deploymentTargetLinkContentV1';
import { AutomationV3RunListResponseSchema, buildAccountStoredContentCompatibilityHttpHeadersV1,
  CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION } from '@happier-dev/protocol';
import { WorkflowTriggerWriteResultV1Schema } from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
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
import { waitFor } from '../../src/testkit/timing';

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
it.each(providers)('F4 selects %s preview/production without a neighboring fallback', async provider => {
  const testDir = await mkdtemp(join(tmpdir(), `happier-dbw-${provider}-`));
  const boundary = await startDeploymentProvidersHttp({ seedManagedProjects: true });
  let fixture: Awaited<ReturnType<typeof startDatabaseWorkbenchFixture>> | undefined;
  try {
    fixture = await startDatabaseWorkbenchFixture({ testDir, serverEnv: { ...boundary.env, NODE_ENV: process.env.NODE_ENV, HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1' } });
    const account = await fixture.createAccount(`${provider}-fresh-owner`);
    const accountId = readAccountIdFromToken(account.credentials.token);
    const recipientContentPublicKey = nacl.box.keyPair.fromSecretKey(account.auth.accountMachineKey).publicKey;
    expect(await account.execute('machines.list', { serverId: fixture.serverId })).toMatchObject({ ok: true, result: { items: [] } });
    expect(await fixture.postgres.sql('happier', 'SELECT count(*) FROM "ProjectSource"')).toBe('0');
    expect(await fixture.postgres.sql('happier', 'SELECT count(*) FROM "Machine"')).toBe('0');
    await fixture.claimHomeOwner(account);
    const machine = await fixture.enrollDaemon(account, { cliLaunchSpec: { command: process.execPath,
      args: ['--import', resolve(repoRootDir(), 'packages/cli-common/registerSourceRuntime.mjs'),
        resolve(repoRootDir(), 'apps/cli/src/index.ts')], cwd: repoRootDir() }, env: { ...boundary.env, HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1',
      NODE_OPTIONS: `${fixture.sourceOptions} --import ${new URL('../../src/testkit/deploymentProvidersHttpPreload.mjs', import.meta.url).href}` } });
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
    const connected = ConnectedAccountAttemptResponseSchema.parse(await invoke('connectedServices.authentication.submitManual', {
      attemptId: begun.attemptId, fields: { token } }));
    if (connected.status !== 'connected') throw new Error(`F4 Connect did not settle (${connected.status})`);
    const source = ProjectSourcesReadOutputV1Schema.parse(await invoke('projects.sources.create', {
      serverId: fixture.serverId, name: `${provider} first Project`, requestKey: randomUUID(), defaultRef: 'main',
      repository: { provider: { id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
        repository: { nameWithOwner: 'journey/database', cloneUrl: 'https://github.com/journey/database.git' }, protocol: 'https' } }));
    if (!source.ok) throw new Error(`F4 Project creation failed (${source.error})`);

    for (const branch of boundary.managedBranches) {
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
      // AM1 binds the public automation subject to this selected data Link and
      // database, rather than the provider's project or branch identity.
      const automationSubject = { ok: true, subject: { kind: 'database', serverId: fixture.serverId,
        target: { kind: 'managed_deployment', environmentId: environment.environmentId,
          targetLinkId: link.targetLinkId, databaseName: target.database } } };
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
      const empty = await read(`${sql} WHERE false`);
      expect(empty).toMatchObject({ ok: true, operation: 'statement.run', results: [{ rows: [],
        ...(provider === 'neon' ? { columns: [{ name: 'marker' }, { name: 'duplicate' }, { name: 'duplicate' }, { name: 'absent' }, { name: 'empty_text' }] } : {}),
        completeness: provider === 'neon' ? { complete: true } : { complete: false, reason: 'transport_unproven' } }] });
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
        // managed Database, including exclusion of a neighboring database name.
        const armAfter = async (databaseName: string) => {
          const armed = await account.executeReviewed('workflow.trigger.add', {
            project: { machineId: machine.target.machineId, directory: machine.workspaceDir },
            target: { kind: 'inline', definition: { version: 1, blocks: [
              { kind: 'action', id: 'read-policy', actionId: 'actions.policy.get', input: { profiles: { kind: 'literal', value: true } } },
            ] } },
            trigger: { kind: 'action', enabled: true, phase: 'after', actionIds: [DATABASE_STATEMENT_RUN_ACTION_ID_V1],
              subject: { ...automationSubject.subject, target: { ...automationSubject.subject.target, databaseName } } },
          }, { externalActionTarget: { kind: 'machine', machineId: machine.target.machineId },
            presentUserConfirmation: { actionId: 'workflow.trigger.add' } });
          if (!armed.ok) throw new Error(`Database after trigger refused (${armed.errorCode})`);
          return WorkflowTriggerWriteResultV1Schema.parse(armed.result);
        };
        const after = await armAfter(target.database);
        const neighborAfter = await armAfter(`${target.database}_neighbor`);
        const serverBaseUrl = fixture.server.baseUrl;
        const runs = async (automationId: string) => {
          const response = await fetchJson<unknown>(`${serverBaseUrl}/v3/automations/${encodeURIComponent(automationId)}/runs`, {
            headers: { Authorization: `Bearer ${account.credentials.token}`,
              ...buildAccountStoredContentCompatibilityHttpHeadersV1(CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION) },
          });
          expect(response.status).toBe(200);
          return AutomationV3RunListResponseSchema.parse(response.data).runs;
        };
        const committed = await write([{ sql: `UPDATE ${table} SET value=$1, mutations=mutations+1 WHERE id=1 RETURNING value AS duplicate, 9007199254740993::bigint AS duplicate`,
          parameters: [{ type: 'text', value: 'committed' }] }]);
        expect(committed, 'P3-F5e-known-good-write-binding').toMatchObject({ ok: true, results: [{ affectedRows: '1',
          columns: [{ name: 'duplicate' }, { name: 'duplicate' }], rows: [{ cells: [
            { type: 'text', value: 'committed' }, { type: 'integer', value: '9007199254740993' }] }] }] });
        expect(await fixture.postgres.sql(database, `SELECT value FROM ${table} WHERE id=1`)).toBe('committed');
        expect(await fixture.postgres.sql(database, `SELECT mutations FROM ${table} WHERE id=1`)).toBe('1');
        await waitFor(async () => (await runs(after.set.automationId)).some(run => run.state === 'succeeded'),
          { failFast: true, context: 'Selected managed Database write starts its after Action Run' });
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
        expect(await read(sql)).toMatchObject({ ok: true });
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
      }
      boundary.rejectNextManagedQuery(provider);
      const failed = await read(sql);
      expect(failed).toMatchObject({ ok: false, status: 'failed', cause: {
        code: provider === 'neon' ? '42601' : 'provider_http_429' } });
      expect(JSON.stringify({ selected, empty, failed })).not.toContain(token);
      expect(boundary.entries().some(entry => entry.path.endsWith('/database/query'))).toBe(false);
    }
  } finally {
    try { await fixture?.stop(); } finally { await boundary.stop(); }
  }
}, 0);
