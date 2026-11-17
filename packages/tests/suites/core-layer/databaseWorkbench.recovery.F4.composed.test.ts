import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

import { DeploymentContentV1Schema } from '@happier-dev/deployment-protocol';
import { createDeploymentDumpBackupSourceV1 } from '@happier-dev/deployments';
import { DatabaseReadStatementInputV1Schema, DatabaseWriteStatementInputV1Schema,
    DatabaseOperationResultV1Schema } from '@happier-dev/database-protocol';
import { DATABASE_PLUGIN_ID_V1, DATABASE_STATEMENT_RUN_ACTION_ID_V1,
    databaseActionLocalIdV1 } from '@happier-dev/protocol/actions/actionIdsDatabaseV1';
import { DeploymentEnvironmentCreateIntentInputV1Schema, DeploymentEnvironmentCreateResultV1Schema,
    DeploymentEnvironmentGetResultV1Schema, DeploymentEnvironmentUpdateResultV1Schema,
    DeploymentReceiptGetResultV1Schema, DeploymentDataSizeResultV1Schema,
    DeploymentReceiptResultV1Schema, DeploymentBindingsSetResultV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { DeploymentTeardownPreviewV1Schema } from '@happier-dev/protocol/deployments/deploymentTeardownVolumesV1';
import { MachineInstallationIdentityV1Schema } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { OpenProjectResultV1Schema } from '@happier-dev/protocol/projects/openProjectV1';
import { REGISTRY_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/registries';
import { setScopedActionApprovalPreference } from '@happier-dev/protocol/actions/actionSettings';
import { sealSavedSecretResourceRecipientEnvelopeV1, sealSavedSecretResourceStoredContentV1 } from '@happier-dev/protocol/account/settings/savedSecretResourceContentV1';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { SharedSavedSecretMutationOutputV1Schema } from '@happier-dev/protocol/account/settings/savedSecretResourceActionsV1';
import { DeploymentBackupConfigureResultV1Schema } from '@happier-dev/protocol/deployments/deploymentBackupConfigureV1';
import { buildDeploymentBackupActionInputV1, DeploymentBackupRunResultV1Schema,
    DeploymentBackupVerifyResultV1Schema } from '@happier-dev/protocol/deployments/deploymentBackupActionsV1';
import { DeploymentBackupRestoreDestinationV1Schema, DeploymentBackupRestoreSourceV1Schema,
    DeploymentBackupRestoreResultV1Schema } from '@happier-dev/protocol/deployments/deploymentBackupRestoreV1';
import { manifest as backupDestinationsManifest } from '@happier-dev/plugins-backup-destinations/manifest';
import { createBackupVerifyWorkflowV1, createRestoreDrillWorkflowV1 } from '@happier-dev/protocol/workflows/builtins/backupExamples';
import { WorkflowDefinitionCreateResultV1Schema, WorkflowInvocationListResultV1Schema,
    WorkflowRunStartResultV1Schema, WorkflowRunWaitResultV1Schema } from '@happier-dev/protocol/workflows/actionsV1';
import type { WorkflowDefinitionV1 } from '@happier-dev/protocol/workflows/workflowV1';
import type { JsonValue } from '@happier-dev/protocol/json/strictJsonValue';

import { createCredentialedAccountArtifactStore } from '../../../../apps/cli/src/api/artifacts/accountArtifactStore';
import { runWithServerHttpBaseUrl } from '../../../../apps/cli/src/api/client/serverHttpBaseUrl';
import { readAccountIdFromToken } from '../../../../apps/cli/src/cloud/decodeJwtPayload';
import { startDatabaseWorkbenchFixture } from '../../src/testkit/databaseWorkbench';
import { repoRootDir } from '../../src/testkit/paths';
import { readEncryptedAccountSettingsV2OrEmpty, upsertEncryptedAccountSettingsV2 } from '../../src/testkit/accountSettings';

const execute = promisify(execFile);

// All Actions, Workflow coordination, repositories and native database processes
// are real. G1 requires semantic selected-read and admitted-write controls; an
// unavailable producer before those succeed is a setup blocker.
it('R6 preserves native backup verification and isolated restore-drill outcomes with typed semantic SQL', async () => {
    const testDir = await mkdtemp(join(tmpdir(), 'happier-dbw-recovery-'));
    const fixture = await startDatabaseWorkbenchFixture({ testDir });
    let owner: Awaited<ReturnType<typeof fixture.createAccount>> | undefined;
    let environmentId: string | undefined;
    let targetLinkId: string | undefined;
    const fixtureTargets: Array<{ environmentId: string; targetLinkId: string }> = [];
    try {
        owner = await fixture.createAccount('recovery-owner');
        // G2 starts before Connect, Project creation, Environment creation or deploy.
        expect(await owner.execute('machines.list', { serverId: fixture.serverId }))
            .toMatchObject({ ok: true, result: { items: [] } });
        expect(await fixture.postgres.sql('happier', 'SELECT count(*) FROM "ProjectSource"')).toBe('0');
        expect(await fixture.postgres.sql('happier', 'SELECT count(*) FROM "Machine"')).toBe('0');
        await fixture.claimHomeOwner(owner);
        const machine = await fixture.enrollDaemon(owner, { cliLaunchSpec: { command: process.execPath,
                args: ['--import', resolve(repoRootDir(), 'packages/cli-common/registerSourceRuntime.mjs'),
                    resolve(repoRootDir(), 'apps/cli/src/index.ts')], cwd: repoRootDir() } });
        const opened = await owner.execute('projects.open', { ...machine.target,
            source: { kind: 'folder', path: machine.workspaceDir }, materialization: { kind: 'attach' } },
        { presentUserConfirmation: { actionId: 'projects.open' } });
        if (!opened.ok) throw new Error(`R6 setup Project Open refused (${opened.errorCode})`);
        const acceptedProject = OpenProjectResultV1Schema.parse(opened.result);
        if (acceptedProject.kind === 'refused') throw new Error(`R6 setup Project Open refused (${acceptedProject.code})`);
        expect(acceptedProject).toMatchObject({ kind: 'opened', directory: machine.workspaceDir });
        const installation = MachineInstallationIdentityV1Schema.parse(JSON.parse(
            await readFile(join(machine.homeDir, 'installation-identity.json'), 'utf8')));

        // Select the actual shipped PostgreSQL app through the real catalog owner.
        const available = await owner.executeAsPerson('registries.sources.list', { kind: 'app' });
        if (!available.ok) throw new Error(`R6 setup app sources refused (${available.errorCode})`);
        const catalog = REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.sources.list'].parse(available.result).sources
            .find(source => 'packageContent' in source && source.origin.pluginId === 'happier.deployment.templates');
        if (!catalog) throw new Error('R6 setup enrolled daemon omitted the shipped app catalog');
        const sourceId = catalog.id;
        const listed = await owner.executeAsPerson('registries.items.list', { kind: 'app', sourceIds: [sourceId] });
        if (!listed.ok) throw new Error(`R6 setup app listing refused (${listed.errorCode})`);
        const selected = REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.items.list'].parse(listed.result)
            .pages.flatMap(page => page.items).find(item => item.itemId === 'postgresql');
        if (!selected) throw new Error('R6 setup PostgreSQL app is absent from its catalog');
        const read = await owner.executeAsPerson('registries.items.read', { kind: 'app', sourceId,
            itemId: selected.itemId });
        if (!read.ok) throw new Error(`R6 setup app read refused (${read.errorCode})`);
        const app = REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.items.read'].parse(read.result).item;
        if (app.payload.kind !== 'app' || app.payload.state !== 'ready') throw new Error('R6 setup PostgreSQL app is unavailable');
        if (!app.summary.version) throw new Error('R6 setup selected PostgreSQL app omitted its admitted version');
        const templateRef = { sourceId, itemId: selected.itemId, version: app.summary.version, ref: app.payload.ref };
        const account = owner;
        const accountEncryption = account.credentials.encryption;
        if (!accountEncryption || accountEncryption.type !== 'dataKey') throw new Error('R6 recovery requires its enrolled E2EE Account material');
        function failedHttpRequests() {
            return fixture.takeRequestObservations()
                .filter(request => request.statusCode !== null && request.statusCode >= 400)
                .map(request => ({ method: request.method, path: request.path.replace(/[?#].*$/u, ''),
                    status: request.statusCode }));
        }
        async function createPasswordSecret(name: string) {
            const resourceId = randomUUID();
            const resourceDataKey = Uint8Array.from(randomBytes(32));
            const secret = await account.execute('secrets.shared.create', { resourceId,
                displayName: name, kind: 'password', encryptionMode: 'e2ee',
                storedContent: sealSavedSecretResourceStoredContentV1({ resourceId, mode: 'e2ee', resourceDataKey,
                    randomBytes, content: { v: 1, name, kind: 'password', value: randomUUID() } }),
                keyEnvelopes: [{ recipientAccountId: readAccountIdFromToken(account.credentials.token),
                    ...sealSavedSecretResourceRecipientEnvelopeV1({ resourceDataKey,
                        recipientContentPublicKey: accountEncryption.publicKey, randomBytes }) }],
            }, { presentUserConfirmation: { actionId: 'secrets.shared.create' } });
            if (!secret.ok) throw new Error(`R6 Saved Secret refused (${secret.errorCode})`);
            const created = SharedSavedSecretMutationOutputV1Schema.parse(secret.result);
            return { ref: formatSharedSavedSecretRefV1(created.resourceId), revision: created.revision };
        }
        async function createEnvironment(name: string) {
            const created = await account.executeReviewed('deployments.environments.create', DeploymentEnvironmentCreateIntentInputV1Schema.parse({
                serverId: fixture.serverId, name, requestKey: randomUUID(),
                newProject: { name: 'R6 recovery', requestKey: randomUUID(),
                    owner: { kind: 'account', accountId: readAccountIdFromToken(account.credentials.token) } },
                definition: { from: 'catalogApp', templateRef },
                protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers',
                controllerMachineId: machine.target.machineId, buildMachineId: machine.target.machineId,
                firstTargetLink: { machines: [{ machineId: machine.target.machineId, installationId: installation.installationId }] },
            }), { externalActionTarget: { kind: 'machine', machineId: machine.target.machineId },
                presentUserConfirmation: { actionId: 'deployments.environments.create' } });
            if (!created.ok) throw new Error(`R6 setup Environment creation refused (${created.errorCode})`);
            const environment = DeploymentEnvironmentCreateResultV1Schema.parse(created.result);
            if (!environment.ok) throw new Error(`R6 setup Environment creation failed (${environment.error})`);
            const read = await account.execute('deployments.environments.get', { serverId: fixture.serverId,
                environmentId: environment.environmentId });
            if (!read.ok) throw new Error(`R6 setup created Environment read refused (${read.errorCode})`);
            const current = DeploymentEnvironmentGetResultV1Schema.parse(read.result);
            if (!current.ok) throw new Error(`R6 setup created Environment read failed (${current.error})`);
            if (!current.environment.runtimeTargetLinkId) throw new Error('R6 setup Environment omitted its first runtime target');
            const placement = { environmentId: environment.environmentId, targetLinkId: current.environment.runtimeTargetLinkId };
            fixtureTargets.push(placement);
            return placement;
        }
        const environment = await createEnvironment('R6 recovery source');
        environmentId = environment.environmentId;
        targetLinkId = environment.targetLinkId;

        const serving = await owner.executeReviewed('deployments.deploy', { serverId: fixture.serverId, environmentId,
            targetLinkId }, { externalActionTarget: { kind: 'machine', machineId: machine.target.machineId },
                presentUserConfirmation: { actionId: 'deployments.deploy' } });
        if (!serving.ok) throw new Error(`R6 setup native deployment refused (${serving.errorCode})`);
        const receipt = DeploymentReceiptResultV1Schema.parse(serving.result);
        if (!receipt.ok) throw new Error(`R6 setup native deployment failed (${receipt.error})`);
        if (!('deploymentId' in receipt)) throw new Error('R6 setup native deployment has not settled');
        expect(receipt.state).toBe('succeeded');

        // Seed only this product-created deployment. Its admitted receipt, rather
        // than a guessed Compose name, identifies the real native database.
        const receiptRead = await owner.execute('deployments.receipts.get', { serverId: fixture.serverId,
            environmentId, deploymentId: receipt.deploymentId });
        if (!receiptRead.ok) throw new Error(`R6 setup receipt read refused (${receiptRead.errorCode})`);
        const record = DeploymentReceiptGetResultV1Schema.parse(receiptRead.result);
        if (!record.ok) throw new Error(`R6 setup receipt read failed (${record.error})`);
        const artifacts = createCredentialedAccountArtifactStore(owner.credentials);
        const artifact = await runWithServerHttpBaseUrl(fixture.server.baseUrl, () => artifacts.read(record.deployment.contentArtifactId));
        if (!artifact || typeof artifact.body !== 'string') throw new Error('R6 setup receipt content is unavailable');
        const content = DeploymentContentV1Schema.parse(JSON.parse(artifact.body));
        const project = content.ownServer?.approvedInputBasis.physicalProjectName;
        if (!project) throw new Error('R6 setup receipt omitted its admitted native project');
        const container = (await execute('docker', ['ps', '--quiet', '--filter', `label=com.docker.compose.project=${project}`,
            '--filter', 'label=com.docker.compose.service=database'])).stdout.trim();
        if (!container || /\s/u.test(container)) throw new Error('R6 setup must identify exactly one selected database container');
        const marker = randomUUID();
        await execute('docker', ['exec', container, 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'happier', '-d', 'app', '-c',
            `CREATE TABLE dbw_recovery_sentinel (marker text NOT NULL, absent text, empty_text text NOT NULL, exact_integer bigint NOT NULL);
             INSERT INTO dbw_recovery_sentinel VALUES ('${marker}', NULL, 'before-control', 9007199254740993);`]);
        const currentRead = await owner.execute('deployments.environments.get', { serverId: fixture.serverId, environmentId });
        if (!currentRead.ok) throw new Error(`R6 control Environment read refused (${currentRead.errorCode})`);
        const current = DeploymentEnvironmentGetResultV1Schema.parse(currentRead.result);
        if (!current.ok) throw new Error(`R6 control Environment read failed (${current.error})`);
        // The public binding Action provisions the selected service's read role
        // and seals its Machine grants before publishing the Environment edit.
        fixture.takeRequestObservations();
        const readRoleRef = await createPasswordSecret('R6 database read password');
        const role = await owner.executeReviewed('deployments.bindings.set', { serverId: fixture.serverId,
            environmentId, expectedRevision: current.environment.revision,
            set: [{ purpose: 'dataRole', service: 'database', role: 'readOnlyPassword',
                source: { kind: 'secret', ref: readRoleRef.ref, resourceRevision: readRoleRef.revision } }], remove: [],
        }, { externalActionTarget: { kind: 'machine', machineId: machine.target.machineId },
            presentUserConfirmation: { actionId: 'deployments.bindings.set' } });
        if (!role.ok) throw new Error(`R6 read-role setup refused (${JSON.stringify({
            errorCode: role.errorCode, error: role.error, failureCause: role.failureCause,
            failedHttpRequests: failedHttpRequests(),
        })})`);
        const configuredRole = DeploymentBindingsSetResultV1Schema.parse(role.result);
        if (!configuredRole.ok) throw new Error(`R6 read-role setup failed (${JSON.stringify({
            error: configuredRole.error, failedHttpRequests: failedHttpRequests(),
        })})`);
        const writeRoleRead = await account.execute('deployments.environments.get', { serverId: fixture.serverId, environmentId });
        if (!writeRoleRead.ok) throw new Error(`R6 write-role Environment read refused (${writeRoleRead.errorCode})`);
        const writeRoleBasis = DeploymentEnvironmentGetResultV1Schema.parse(writeRoleRead.result);
        if (!writeRoleBasis.ok) throw new Error(`R6 write-role Environment read failed (${writeRoleBasis.error})`);
        const writeRoleRef = await createPasswordSecret('R6 database write password');
        const writeRole = await owner.executeReviewed('deployments.bindings.set', { serverId: fixture.serverId,
            environmentId, expectedRevision: writeRoleBasis.environment.revision,
            set: [{ purpose: 'dataRole', service: 'database', role: 'write', source: {
                kind: 'secret', ref: writeRoleRef.ref, resourceRevision: writeRoleRef.revision } }], remove: [],
        }, { externalActionTarget: { kind: 'machine', machineId: machine.target.machineId },
            presentUserConfirmation: { actionId: 'deployments.bindings.set' } });
        if (!writeRole.ok) throw new Error(`R6 write-role setup refused (${writeRole.errorCode})`);
        const configuredWriteRole = DeploymentBindingsSetResultV1Schema.parse(writeRole.result);
        if (!configuredWriteRole.ok) throw new Error(`R6 write-role setup failed (${configuredWriteRole.error})`);
        const editorRead = await account.execute('deployments.environments.get', { serverId: fixture.serverId, environmentId });
        if (!editorRead.ok) throw new Error(`R6 editor Environment read refused (${editorRead.errorCode})`);
        const editorBasis = DeploymentEnvironmentGetResultV1Schema.parse(editorRead.result);
        if (!editorBasis.ok) throw new Error(`R6 editor Environment read failed (${editorBasis.error})`);
        const editor = await owner.executeReviewed('deployments.environments.update', { serverId: fixture.serverId,
            environmentId, expectedRevision: editorBasis.environment.revision,
            contentArtifactId: editorBasis.environment.contentArtifactId,
            contentHeaderVersion: editorBasis.environment.contentHeaderVersion,
            contentBodyVersion: editorBasis.environment.contentBodyVersion,
            patch: { dataEditorMode: 'managers' },
        }, { presentUserConfirmation: { actionId: 'deployments.environments.update' } });
        if (!editor.ok) throw new Error(`R6 editor setup refused (${editor.errorCode})`);
        expect(DeploymentEnvironmentUpdateResultV1Schema.parse(editor.result)).toMatchObject({ ok: true });
        const control = await execute('docker', ['exec', container, 'psql', '-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1',
            '-U', 'happier', '-d', 'app', '-c',
            'SELECT json_build_array(marker, absent, empty_text, exact_integer::text)::text FROM dbw_recovery_sentinel']);
        expect(JSON.parse(control.stdout.trim()), 'R6 native setup must seed the selected deployment')
            .toEqual([marker, null, 'before-control', '9007199254740993']);

        // Native setup alone does not satisfy G1. Both semantic controls must
        // traverse the real Action, Home and daemon before recovery assertions.
        const sourceDatabase = { kind: 'deployment_service' as const,
            environment: { serverId: fixture.serverId,
                projectSourceId: current.environment.projectSourceId, environmentId },
            deploymentId: receipt.deploymentId, targetLinkId, serviceId: 'database', database: 'app' };
        const semanticInput = DatabaseReadStatementInputV1Schema.parse({ operation: 'statement.run', mode: 'read',
                target: sourceDatabase,
                statement: { sql: 'SELECT marker, absent, empty_text, exact_integer FROM dbw_recovery_sentinel WHERE marker = $1 AND exact_integer = $2',
                    parameters: [{ type: 'text', value: marker }, { type: 'integer', value: '9007199254740993' }] },
            });
        const semantic = await owner.execute('action.invoke', {
            action: { pluginId: DATABASE_PLUGIN_ID_V1, localId: databaseActionLocalIdV1(DATABASE_STATEMENT_RUN_ACTION_ID_V1) },
            input: semanticInput,
        }, { externalActionTarget: { kind: 'machine', machineId: machine.target.machineId },
            presentUserConfirmation: { actionId: 'action.invoke' } });
        expect(semantic.ok, semantic.ok ? undefined : `R6 G1 setup semantic selected-read refused: ${JSON.stringify({
            errorCode: semantic.errorCode, error: semantic.error, failureCause: semantic.failureCause,
            failedHttpRequests: failedHttpRequests(),
        })}`).toBe(true);
        if (!semantic.ok) return;
        expect(DatabaseOperationResultV1Schema.parse(semantic.result)).toMatchObject({ ok: true, operation: 'statement.run',
            results: [{ rows: [{ cells: [{ type: 'text', value: '[REDACTED]' }, { type: 'null' },
                { type: 'text', value: 'before-control' }, { type: 'text', value: '[REDACTED]' }] }], completeness: { complete: true } }] });
        const written = await owner.executeReviewed('action.invoke', {
            action: { pluginId: DATABASE_PLUGIN_ID_V1, localId: databaseActionLocalIdV1(DATABASE_STATEMENT_RUN_ACTION_ID_V1) },
            input: DatabaseWriteStatementInputV1Schema.parse({ operation: 'statement.run', mode: 'write',
                target: sourceDatabase, executionMode: 'transaction', statements: [{
                    sql: 'UPDATE dbw_recovery_sentinel SET empty_text = $1 WHERE marker = $2 AND exact_integer = $3 AND empty_text = $4 RETURNING empty_text',
                    parameters: [{ type: 'text', value: '' }, { type: 'text', value: marker },
                        { type: 'integer', value: '9007199254740993' }, { type: 'text', value: 'before-control' }],
                }] }),
        }, { externalActionTarget: { kind: 'machine', machineId: machine.target.machineId },
            presentUserConfirmation: { actionId: 'action.invoke' } });
        expect(written.ok, written.ok ? undefined : `R6 G1 setup admitted semantic write refused: ${JSON.stringify({
            errorCode: written.errorCode, error: written.error, failureCause: written.failureCause,
            details: 'details' in written ? written.details : undefined, failedHttpRequests: failedHttpRequests(),
        })}`).toBe(true);
        if (!written.ok) return;
        expect(DatabaseOperationResultV1Schema.parse(written.result)).toMatchObject({ ok: true, operation: 'statement.run',
            results: [{ affectedRows: '1', rows: [{ cells: [{ type: 'text', value: '' }] }], completeness: { complete: true } }] });
        const changed = await execute('docker', ['exec', container, 'psql', '-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1',
            '-U', 'happier', '-d', 'app', '-c',
            'SELECT json_build_array(marker, absent, empty_text, exact_integer::text)::text FROM dbw_recovery_sentinel']);
        expect(JSON.parse(changed.stdout.trim()), 'R6 G1 semantic write must change the same selected native database')
            .toEqual([marker, null, '', '9007199254740993']);

        // Configure the real local restic transport through the same encrypted
        // Saved Secret and Environment-binding path used by the product.
        const repositoryPasswordRef = await createPasswordSecret('R6 repository password');
        const repository = join(testDir, 'native-repository');
        await mkdir(repository, { recursive: true });
        const localDestination = backupDestinationsManifest.contributes?.backupDestinations
            ?.find(descriptor => descriptor.resticTransport === 'local');
        if (!localDestination) throw new Error('R6 fixture requires the shipped local backup destination');
        const destinationRef = { pluginId: backupDestinationsManifest.id, localId: localDestination.id };
        async function readEnvironment(id: string) {
            const result = await account.execute('deployments.environments.get', { serverId: fixture.serverId, environmentId: id });
            if (!result.ok) throw new Error(`R6 Environment read refused (${result.errorCode})`);
            const opened = DeploymentEnvironmentGetResultV1Schema.parse(result.result);
            if (!opened.ok) throw new Error(`R6 Environment read failed (${opened.error})`);
            return opened;
        }
        async function configureRepository(id: string) {
            const before = await readEnvironment(id);
            const result = await account.execute('deployments.backups.configure', { serverId: fixture.serverId,
                environmentId: id, expectedRevision: before.environment.revision, intent: 'initializeAndSave',
                configuration: { configRevision: 1,
                    destinationRef,
                    // Configure resolves the committed runtime occurrence itself
                    // (prepareDeploymentBackupConfigurationV1); callers never pin it.
                    occurrenceId: 'resolved-by-configure', config: { path: repository },
                    credentialBindings: [{ purpose: 'backupDestination', configKey: 'destination', role: 'repositoryPassword' }],
                    sources: [createDeploymentDumpBackupSourceV1('database')],
                    ownership: { environmentId: id, prefix: id }, retention: { kind: 'keepEverything' } },
                backupBindings: [{ purpose: 'backupDestination', configKey: 'destination', role: 'repositoryPassword',
                    source: { kind: 'secret', ref: repositoryPasswordRef.ref, resourceRevision: repositoryPasswordRef.revision } }],
            }, { presentUserConfirmation: { actionId: 'deployments.backups.configure' } });
            if (!result.ok) throw new Error(`R6 native repository setup refused (${result.errorCode})`);
            const configured = DeploymentBackupConfigureResultV1Schema.parse(result.result);
            expect(configured.kind).toBe('configured');
            if (configured.kind !== 'configured') throw new Error(`R6 repository setup did not save (${configured.kind})`);
            return configured;
        }
        const sourceBackup = await configureRepository(environmentId);
        const sourceCurrent = await readEnvironment(environmentId);
        const backupTarget = buildDeploymentBackupActionInputV1('deployments.backups.run', {
            serverId: fixture.serverId, environmentId, targetLinkId, deploymentId: receipt.deploymentId,
            machineId: machine.target.machineId, installationId: installation.installationId,
            expectedRevision: sourceCurrent.environment.revision, configRevision: sourceBackup.configuration.configRevision,
        });
        const backedUp = await account.execute('deployments.backups.run', backupTarget,
            { presentUserConfirmation: { actionId: 'deployments.backups.run' } });
        if (!backedUp.ok) throw new Error(`R6 native backup refused (${backedUp.errorCode})`);
        const captured = DeploymentBackupRunResultV1Schema.parse(backedUp.result);
        expect(captured.kind).toBe('verified');
        const manifest = captured.manifests.find(row => row.sourceId === createDeploymentDumpBackupSourceV1('database').sourceId);
        if (!manifest) throw new Error('R6 native backup omitted its selected database manifest');
        expect(manifest).toMatchObject({ environmentId, configRevision: sourceBackup.configuration.configRevision, kind: 'dump' });
        expect(manifest.totalBytesProcessed).toBeGreaterThan(0);

        async function savedWorkflow(definition: WorkflowDefinitionV1, inputs: Record<string, JsonValue>) {
            const saved = await account.execute('workflow.definition.create', { definitionId: randomUUID(),
                metadata: { title: 'R6 native recovery' }, definition });
            if (!saved.ok) throw new Error(`R6 Workflow save refused (${saved.errorCode})`);
            const authored = WorkflowDefinitionCreateResultV1Schema.parse(saved.result);
            const started = await account.execute('workflow.run.start', { runId: randomUUID(),
                source: { kind: 'saved', definitionId: authored.definitionId, revision: authored.revision },
                inputs, executionTarget: { kind: 'detached_run' } },
            { externalActionTarget: { kind: 'machine', machineId: machine.target.machineId,
                project: { machineId: machine.target.machineId, directory: machine.workspaceDir } } });
            if (!started.ok) throw new Error(`R6 Workflow start refused (${started.errorCode})`);
            const run = WorkflowRunStartResultV1Schema.parse(started.result).run;
            const waited = await account.execute('workflow.run.wait', { runId: run.id, conditions: ['terminal', 'attention'] });
            if (!waited.ok) throw new Error(`R6 Workflow wait refused (${waited.errorCode})`);
            const settled = WorkflowRunWaitResultV1Schema.parse(waited.result);
            expect(settled).toMatchObject({ observation: 'terminal', run: { state: 'succeeded' } });
            const listed = await account.execute('workflow.run.invocations.list', { runId: run.id, includeContent: true });
            if (!listed.ok) throw new Error(`R6 Workflow evidence unavailable (${listed.errorCode})`);
            const history = WorkflowInvocationListResultV1Schema.parse(listed.result);
            expect(history.nextCursor, 'R6 recovery invocation evidence must be complete').toBeUndefined();
            if (!history.invocationDetails) throw new Error('R6 Workflow omitted invocation content');
            return { settled, details: history.invocationDetails };
        }
        const verified = await savedWorkflow(createBackupVerifyWorkflowV1(), { backupTarget,
            backupOperationId: captured.operationId, snapshotId: manifest.snapshot.snapshotId, verificationLevel: 'manifestReadBack' });
        expect(DeploymentBackupVerifyResultV1Schema.parse(verified.settled.result)).toMatchObject({
            kind: 'verified', backupOperationId: captured.operationId,
            snapshotId: manifest.snapshot.snapshotId, verified: true });

        // The drill has its own retained Environment and native database. It
        // begins without the source sentinel, so a read against the source or
        // a no-op restore cannot satisfy the recovery assertion.
        const drill = await createEnvironment('R6 isolated recovery drill');
        expect(drill.environmentId).not.toBe(environmentId);
        const drillDeploy = await account.execute('deployments.deploy', { serverId: fixture.serverId, ...drill },
            { presentUserConfirmation: { actionId: 'deployments.deploy' } });
        if (!drillDeploy.ok) throw new Error(`R6 drill native deploy refused (${drillDeploy.errorCode})`);
        const drillReceipt = DeploymentReceiptResultV1Schema.parse(drillDeploy.result);
        if (!drillReceipt.ok) throw new Error(`R6 drill native deploy failed (${drillReceipt.error})`);
        if (!('deploymentId' in drillReceipt)) throw new Error('R6 drill native deployment has not settled');
        const drillDeploymentId = drillReceipt.deploymentId;
        expect(drillReceipt.state).toBe('succeeded');
        await configureRepository(drill.environmentId);
        const drillCurrent = await readEnvironment(drill.environmentId);
        // Deliberate standing consent is persisted through the Account settings
        // boundary; the Workflow executor still owns every Action admission.
        const settingsTarget = { baseUrl: fixture.server.baseUrl, token: account.auth.token,
            material: accountEncryption };
        const settings = await readEncryptedAccountSettingsV2OrEmpty(settingsTarget);
        let actionsSettings = settings.settings.actionsSettingsV1;
        for (const actionId of ['deployments.backups.restore', 'machines.services.control']) {
            actionsSettings = setScopedActionApprovalPreference({ settings: actionsSettings, actionId,
                scope: { kind: 'environment', environmentId: drill.environmentId }, surface: 'agent', mode: 'waived' });
        }
        await upsertEncryptedAccountSettingsV2({ ...settingsTarget,
            expectedVersion: settings.settingsVersion, settings: { ...settings.settings, actionsSettingsV1: actionsSettings } });
        const drillTarget = { serverId: fixture.serverId, ...drill, deploymentId: drillDeploymentId,
            expectedRevision: drillCurrent.environment.revision, machineId: machine.target.machineId,
            installationId: installation.installationId };
        const drillDatabase = { kind: 'deployment_service' as const,
            environment: { serverId: fixture.serverId, environmentId: drill.environmentId,
                projectSourceId: drillCurrent.environment.projectSourceId },
            deploymentId: drillDeploymentId, targetLinkId: drill.targetLinkId, serviceId: 'database', database: 'app' };
        const absent = await account.execute('action.invoke', {
            action: { pluginId: DATABASE_PLUGIN_ID_V1, localId: databaseActionLocalIdV1(DATABASE_STATEMENT_RUN_ACTION_ID_V1) },
            input: DatabaseReadStatementInputV1Schema.parse({ operation: 'statement.run', mode: 'read', target: drillDatabase,
                statement: { sql: "SELECT to_regclass('public.dbw_recovery_sentinel') IS NULL AS absent", parameters: [] } }),
        }, { externalActionTarget: { kind: 'machine', machineId: machine.target.machineId } });
        if (!absent.ok) throw new Error(`R6 drill pre-restore read refused (${absent.errorCode})`);
        expect(DatabaseOperationResultV1Schema.parse(absent.result)).toMatchObject({ ok: true,
            results: [{ rows: [{ cells: [{ type: 'boolean', value: true }] }] }] });
        const restoreSource = DeploymentBackupRestoreSourceV1Schema.parse({ kind: 'repository',
            backupOperationId: captured.operationId, snapshotId: manifest.snapshot.snapshotId,
            origin: { environmentId, targetLinkId } });
        const restoreDestination = DeploymentBackupRestoreDestinationV1Schema.parse({ kind: 'database', service: 'database', database: 'app' });
        const dataCheck = DatabaseReadStatementInputV1Schema.parse({ operation: 'statement.run', mode: 'read', target: drillDatabase, statement: {
            sql: 'SELECT marker, absent, empty_text, exact_integer FROM dbw_recovery_sentinel WHERE marker = $1 AND absent IS NOT DISTINCT FROM $2::text AND empty_text = $3 AND exact_integer = $4',
            parameters: [{ type: 'text', value: marker }, { type: 'null' }, { type: 'text', value: '' },
                { type: 'integer', value: '9007199254740993' }] } });
        const drillInputs = { backupTarget, restoreSource, drillTarget, restoreDestination, dataCheck,
            verificationLevel: 'manifestReadBack' };
        const recovered = await savedWorkflow(createRestoreDrillWorkflowV1(), drillInputs);
        const resultFor = (blockId: string) => recovered.details.find(row => row.progress.invocationPath.blockId === blockId);
        for (const blockId of ['verify', 'prepareRestore', 'confirmRestore', 'cleanupServices', 'stopService']) {
            expect(resultFor(blockId), `R6 ${blockId} must settle`).toMatchObject({ index: { lifecycle: 'completed' } });
        }
        expect(DeploymentBackupRestoreResultV1Schema.parse(resultFor('confirmRestore')?.progress.result))
            .toMatchObject({ kind: 'restored', verified: true });
        const restoredData = { ok: true, operation: 'statement.run', results: [{ rows: [{ cells: [
            { type: 'text', value: marker }, { type: 'null' }, { type: 'text', value: '' },
            { type: 'integer', value: '9007199254740993' }], }], completeness: { complete: true } }] };
        expect(resultFor('confirmRestore')?.progress.result).toMatchObject({ evidence: { dataCheck: restoredData } });
        async function assertDrillStopped() {
            const read = await account.execute('deployments.receipts.get', { serverId: fixture.serverId,
                environmentId: drill.environmentId, deploymentId: drillDeploymentId });
            if (!read.ok) throw new Error(`R6 drill receipt read refused (${read.errorCode})`);
            const stored = DeploymentReceiptGetResultV1Schema.parse(read.result);
            if (!stored.ok) throw new Error(`R6 drill receipt unavailable (${stored.error})`);
            const artifact = await runWithServerHttpBaseUrl(fixture.server.baseUrl, () => artifacts.read(stored.deployment.contentArtifactId));
            if (!artifact || typeof artifact.body !== 'string') throw new Error('R6 drill receipt content unavailable');
            const project = DeploymentContentV1Schema.parse(JSON.parse(artifact.body)).ownServer?.approvedInputBasis.physicalProjectName;
            if (!project) throw new Error('R6 drill receipt omitted native project');
            expect((await execute('docker', ['ps', '--quiet', '--filter', `label=com.docker.compose.project=${project}`])).stdout.trim(),
                'R6 always-run cleanup must stop all isolated services').toBe('');
        }
        await assertDrillStopped();
        const failed = await savedWorkflow(createRestoreDrillWorkflowV1(), { ...drillInputs,
            restoreSource: { ...restoreSource, snapshotId: 'b'.repeat(64) } });
        expect(failed.details.find(row => row.progress.invocationPath.blockId === 'verify'))
            .toMatchObject({ index: { lifecycle: 'failed' }, progress: { reason: { code: 'backup_required' } } });
        expect(failed.details.some(row => row.progress.invocationPath.blockId === 'confirmRestore')).toBe(false);
        expect(failed.details.find(row => row.progress.invocationPath.blockId === 'stopService'))
            .toMatchObject({ index: { lifecycle: 'completed' } });
        await assertDrillStopped();

        // The enabled G1 controls above distinguish lifecycle refusal from a
        // broken fixture. Backup and verification belong to deployment owners,
        // and must remain usable when the optional workbench is disabled.
        const lifecycleInput = { pluginId: DATABASE_PLUGIN_ID_V1,
            machineId: machine.target.machineId, scope: 'machine' };
        expect(await account.execute('plugins.disable', lifecycleInput,
            { presentUserConfirmation: { actionId: 'plugins.disable' } }))
            .toMatchObject({ ok: true, result: { ok: true, change: { kind: 'committed' } } });
        expect(await account.execute('action.invoke', {
            action: { pluginId: DATABASE_PLUGIN_ID_V1, localId: databaseActionLocalIdV1(DATABASE_STATEMENT_RUN_ACTION_ID_V1) },
            input: semanticInput,
        }, { externalActionTarget: { kind: 'machine', machineId: machine.target.machineId } }))
            .toMatchObject({ ok: false, errorCode: 'plugin_disabled' });
        const disabledSize = await account.execute('deployments.data.size', { serverId: backupTarget.serverId,
            environmentId: backupTarget.environmentId, expectedRevision: backupTarget.expectedRevision,
            targetLinkId: backupTarget.targetLinkId, deploymentId: backupTarget.deploymentId,
            machineId: backupTarget.machineId, installationId: backupTarget.installationId, service: 'database' });
        if (!disabledSize.ok) throw new Error(`D26 disabled-workbench size refused (${disabledSize.errorCode})`);
        const disabledSizeResult = DeploymentDataSizeResultV1Schema.parse(disabledSize.result);
        expect(disabledSizeResult).toMatchObject({ ok: true, size: { service: 'database',
            size: { status: 'available', measurement: 'database_bytes' } } });
        if (disabledSizeResult.ok && disabledSizeResult.size.size.status === 'available') {
            expect(disabledSizeResult.size.size.bytes).toBeGreaterThan(0);
        }
        const disabledBackup = await account.execute('deployments.backups.run', backupTarget,
            { presentUserConfirmation: { actionId: 'deployments.backups.run' } });
        if (!disabledBackup.ok) throw new Error(`R6 disabled-workbench native backup refused (${disabledBackup.errorCode})`);
        const disabledCapture = DeploymentBackupRunResultV1Schema.parse(disabledBackup.result);
        expect(disabledCapture.kind).toBe('verified');
        const disabledManifest = disabledCapture.manifests.find(row => row.sourceId === manifest.sourceId);
        if (!disabledManifest) throw new Error('R6 disabled-workbench backup omitted the selected database');
        expect(disabledManifest.totalBytesProcessed).toBeGreaterThan(0);
        const disabledVerify = await savedWorkflow(createBackupVerifyWorkflowV1(), { backupTarget,
            backupOperationId: disabledCapture.operationId, snapshotId: disabledManifest.snapshot.snapshotId,
            verificationLevel: 'manifestReadBack' });
        expect(DeploymentBackupVerifyResultV1Schema.parse(disabledVerify.settled.result)).toMatchObject({
            kind: 'verified', backupOperationId: disabledCapture.operationId,
            snapshotId: disabledManifest.snapshot.snapshotId, verified: true });
        const disabledDrill = await savedWorkflow(createRestoreDrillWorkflowV1(), { ...drillInputs,
            restoreSource: { ...restoreSource, backupOperationId: disabledCapture.operationId,
                snapshotId: disabledManifest.snapshot.snapshotId } });
        for (const blockId of ['verify', 'prepareRestore', 'confirmRestore', 'cleanupServices', 'stopService']) {
            expect(disabledDrill.details.find(row => row.progress.invocationPath.blockId === blockId),
                `F12 disabled-workbench ${blockId} must settle`).toMatchObject({ index: { lifecycle: 'completed' } });
        }
        expect(disabledDrill.details.find(row => row.progress.invocationPath.blockId === 'confirmRestore')?.progress.result)
            .toMatchObject({ kind: 'restored', verified: true, evidence: { dataCheck: restoredData } });
        await assertDrillStopped();
        expect(await account.execute('plugins.enable', lifecycleInput,
            { presentUserConfirmation: { actionId: 'plugins.enable' } }))
            .toMatchObject({ ok: true, result: { ok: true, change: { kind: 'committed' } } });
        const reenabledRead = await account.execute('action.invoke', {
            action: { pluginId: DATABASE_PLUGIN_ID_V1, localId: databaseActionLocalIdV1(DATABASE_STATEMENT_RUN_ACTION_ID_V1) },
            input: semanticInput,
        }, { externalActionTarget: { kind: 'machine', machineId: machine.target.machineId } });
        if (!reenabledRead.ok) throw new Error(`R6 re-enabled semantic read refused (${reenabledRead.errorCode})`);
        expect(DatabaseOperationResultV1Schema.parse(reenabledRead.result)).toMatchObject({ ok: true,
            results: [{ rows: [{ cells: [{ type: 'text', value: marker }, { type: 'null' },
                { type: 'text', value: '' }, { type: 'integer', value: '9007199254740993' }] }] }] });
    } finally {
        try {
            const account = owner;
            const cleanup = await Promise.allSettled(fixtureTargets.reverse().map(async placement => {
                if (!account) return;
                const target = { serverId: fixture.serverId, ...placement, reason: 'manual' };
                const preview = await account.execute('deployments.teardown', { ...target, mode: 'preview' });
                if (!preview.ok) throw new Error(`R6 fixture teardown preview refused (${preview.errorCode})`);
                const inventory = DeploymentTeardownPreviewV1Schema.parse(preview.result);
                const removed = await account.execute('deployments.teardown', { ...target,
                    volumes: inventory.volumes.map(volume => ({ name: volume.name, disposition: 'delete', confirmation: volume.name })) },
                { presentUserConfirmation: { actionId: 'deployments.teardown' } });
                if (!removed.ok) throw new Error(`R6 fixture native cleanup refused (${removed.errorCode})`);
            }));
            const failures = cleanup.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
            if (failures.length) throw new AggregateError(failures, 'R6 native fixture cleanup failed');
        } finally { await fixture.stop(); }
    }
}, 0);
