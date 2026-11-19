import { afterEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import axios from 'axios';
import { createDeploymentEnvironmentDetailV1, createDeploymentReceiptDetailV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { OwnServerDeploymentInputBasisV1Schema, EnvironmentSecretLaunchAdmissionInputV1Schema,
    EnvironmentSecretLaunchAdmissionResultV1Schema, computeEnvironmentSecretLaunchAdmissionDigestV1 } from '@happier-dev/deployment-protocol';
import { verifyMachineInstallationProof } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { ACTION_INVOKE_ACTION_ID_V1 } from '@happier-dev/protocol/actions/actionIds';
import { DATABASE_STATEMENT_RUN_ACTION_ID_V1 } from '@happier-dev/protocol/actions/actionIdsDatabaseV1';
import { readDeploymentDatabaseSizesV1 } from '@happier-dev/deployments';
import { parseQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import { EXTERNAL_ACTION_EFFECT_ACTION_HEADER, EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER,
    verifyExternalActionMachineRequestV1 } from '@happier-dev/protocol/actions';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { ExternalActionExecutionAuthorizationV1Schema, projectDeploymentReadAdmissionV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { projectExternalActionRequesterHttpAuthorization } from '@/api/externalActionExecutionAuthorization';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { configuration } from '@/configuration';
import { withConfiguredDaemonTestHome, writeDaemonSettingsFixture } from '@/daemon/testkit/fakeDaemonLifecycle.testkit';
import { readOrCreateInstallationIdentity } from '@/daemon/identity/store';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createProductionPluginInvocationServiceOwners } from '@/plugins/runtime/invocation/services/production';
import { machineNativeEffectAdmission } from '@/daemon/local/services/launch/machineNativeEffectAdmission';
import { createScmBackendRegistry } from '@/scm/registry';
import { sealMachineSecretGrant } from '../../secrets/machineSecretGrant';
import { createDeploymentDatabasesServiceForHost } from '../createDeploymentDatabasesServiceForHost';
import { createDeploymentDataSizeActionForHost } from '../../actions/dataSize';
import { DEPLOYMENT_DATA_SIZE_ACTION_ID_V1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import { createDeploymentSourceMaterializationPort } from './exactCommitRelease';
import { resolveOwnServerDeploymentIdentityForHost } from './paths';
import { createNativePostgresqlFixture, nativePostgresqlAvailable } from './nativePostgresql.testkit';
import { createNativeDatabaseContainerFixture, nativeMysqlImage, nativePostgresqlImage } from './nativeDatabaseContainer.testkit';

afterEach(() => vi.restoreAllMocks());

for (const shape of ['acquisition-refusals', 'postgresql', 'postgresql-private', 'mysql'] as const) {
const engine = shape === 'mysql' ? 'mysql' : 'postgresql';
const acquisitionRefusals = shape === 'acquisition-refusals';
it.skipIf(shape === 'postgresql' ? !nativePostgresqlAvailable : shape === 'mysql' ? !nativeMysqlImage : shape === 'postgresql-private' && !nativePostgresqlImage)(
    acquisitionRefusals ? 'recovers the selected cold database service before enforcing native container custody'
        : `opens the exact native ${shape} deployment through installed custody and retains exclusion until close`, async () => {
    await withConfiguredDaemonTestHome({ prefix: 'happier-native-database-', env: {
        HAPPIER_SERVER_URL: 'https://home.test', HAPPIER_WEBAPP_URL: 'https://home.test',
    } }, async ({ homeDir }) => {
        await writeDaemonSettingsFixture(homeDir, { activeServerId: 'home', servers: { home: {
            id: 'home', name: 'Home', serverUrl: 'https://home.test', webappUrl: 'https://home.test',
            createdAt: 1, updatedAt: 1, lastUsedAt: 1, homeConnectionDescriptorAuthority: 'exact',
            homeConnectionDescriptor: { v: 1, homeServerIdentityId: 'srv_native_database', revision: 1,
                canonicalServerUrl: 'https://home.test', endpoints: [{ kind: 'https', url: 'https://home.test' }] },
        } } });
        const pg = shape === 'postgresql' ? await createNativePostgresqlFixture(join(homeDir, 'postgres')) : null;
        const container = shape === 'postgresql' || acquisitionRefusals ? null : await createNativeDatabaseContainerFixture(engine,
            engine === 'mysql' ? nativeMysqlImage! : nativePostgresqlImage!);
        const database = pg ? 'postgres' : 'native_fixture';
        try {
            const installation = await readOrCreateInstallationIdentity();
            const accountId = 'custody-account';
            const credentials = { token: `header.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`, encryption: null };
            const detail = createDeploymentEnvironmentDetailV1();
            detail.environment.id = `native-${shape}`;
            detail.environment.serverId = 'home';
            for (const row of detail.targetLinks) row.targetLink.environmentId = detail.environment.id;
            detail.environment.controllerMachineId = 'other-controller';
            const link = detail.targetLinks[0]!.targetLink;
            detail.environment.runtimeTargetLinkId = link.id;
            link.members = [{ machineId: 'machine-a', installationId: installation.installationId, state: 'active' }];
            const use = { purpose: 'dataRole' as const, service: 'database', role: 'readOnlyPassword' as const,
                source: { kind: 'secret' as const, ref: formatSharedSavedSecretRefV1('native-role'), resourceRevision: 1 } };
            const variable = { purpose: 'variable' as const, phase: 'runtime' as const, name: 'DB_NAME', source: { kind: 'value' as const, value: database } };
            detail.content.bindings = [variable, use];
            detail.content.template = { templateRef: { sourceId: 'catalog', itemId: 'postgres', version: '1', ref: { kind: 'version', version: '1' } },
                definition: { kind: 'stored', contentRevision: 1, composeDigest: `sha256:${'a'.repeat(64)}` }, services: ['database'],
                data: [{ engine: engine === 'postgresql' ? 'postgres' : 'mysql', service: 'database', version: engine === 'mysql' ? '8.4' : '17', variables: { database: 'DB_NAME' }, port: engine === 'mysql' ? 3306 : 5432 }] };
            const target = { kind: 'deployment_service' as const, environment: { serverId: 'home', projectSourceId: detail.environment.projectSourceId,
                environmentId: detail.environment.id }, targetLinkId: link.id, deploymentId: `deployment-${shape}`, serviceId: 'database', database };
            link.activeDeploymentId = target.deploymentId;
            if (pg) await pg.execute("CREATE ROLE happier_ro LOGIN PASSWORD 'private-native-password'; GRANT pg_read_all_data TO happier_ro; CREATE TABLE native_items(id bigint PRIMARY KEY, note text); INSERT INTO native_items VALUES(1,NULL)");
            if (container) await container.execute(engine === 'postgresql'
                ? "CREATE ROLE happier_ro LOGIN PASSWORD 'private-native-password'; GRANT pg_read_all_data TO happier_ro; CREATE TABLE native_items(id bigint PRIMARY KEY, note text); INSERT INTO native_items VALUES(1,NULL)"
                : "CREATE USER 'happier_ro'@'127.0.0.1' IDENTIFIED BY 'private-native-password'; GRANT SELECT, SHOW VIEW ON native_fixture.* TO 'happier_ro'@'127.0.0.1'; CREATE TABLE native_fixture.native_items(id BIGINT PRIMARY KEY,note TEXT); INSERT INTO native_fixture.native_items VALUES(1,NULL)");
            const fixture = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController, runtimeOptions: { pluginIds: [] } });
            const owners = createProductionPluginInvocationServiceOwners({ loggerSink: { write() {} } });
            try {
                const identity = await resolveOwnServerDeploymentIdentityForHost({ happierHomeDir: configuration.happyHomeDir,
                    serverId: 'home', environmentId: detail.environment.id });
                const document = `services: {database: {image: "${engine === 'postgresql' ? 'postgres:17' : 'mysql:8.4'}"}}`;
                const materializer = createDeploymentSourceMaterializationPort({ registry: createScmBackendRegistry([]), async admit() {
                    return { environmentId: detail.environment.id, environmentInstanceId: identity.environmentInstanceId,
                        deploymentId: target.deploymentId, machineId: 'machine-a', installationId: installation.installationId,
                        deploymentRoot: join(homeDir, 'deployments'), artifactDirectory: join(homeDir, 'artifacts'),
                        definition: { kind: 'stored' as const, contentRevision: 1, document,
                            composeDigest: `sha256:${createHash('sha256').update(document).digest('hex')}`, profiles: [], services: ['database'] },
                        async assertCurrent() {} };
                } });
                const release = await materializer.materialize({ environmentId: detail.environment.id, deploymentId: target.deploymentId });
                await release.commit();
                const keys = [{ kind: 'composeProject' as const, dockerEndpoint: 'fixture-pg-engine', projectName: 'native-database' }];
                let observedComposeProject = 'native-database';
                const mountService = () => fixture.registry.projectManagedServices.superviseProject({ kind: 'environment', serverId: identity.homeServerIdentityId,
                    machineId: 'machine-a', environmentId: detail.environment.id, environmentInstanceId: identity.environmentInstanceId,
                    deploymentId: target.deploymentId, release, composeService: 'database', serviceId: `${identity.environmentInstanceId}/database`,
                    specIdentity: 'native-database', isCurrent: () => true, releaseObservation: async () => {}, nativeEffects: { keys },
                    processSpec: { mode: { kind: 'native', observationOnly: true, builtinLifecycle: {
                        async inspect() { return { phase: 'running', readiness: 'not_reported', endpoint: null }; },
                        async stop() { return { status: 'stopped' }; },
                        nativeContainers: () => [{ id: container?.name ?? 'native-pg', service: 'database', composeProject: observedComposeProject }],
                        runtimeFacts: () => ({ freshness: 'current', observedAt: 1, configuration: { name: 'database', replicas: 1,
                            resources: { cpus: null, memory: null }, restartPolicy: null, healthcheck: 'absent', mounts: [],
                            ports: pg ? [{ target: 5432, published: pg.port, bindAddress: '127.0.0.1', protocol: 'tcp' }] : [] } }),
                        async nativeDocker() { return { engineId: 'fixture-pg-engine', async run(args) {
                            expect(args).toEqual(['context', 'inspect', '--format', '{{json .Endpoints.docker.Host}}']);
                            return { exitCode: 0, stdout: JSON.stringify('unix:///var/run/docker.sock') };
                        }, ...(container ? { openStream: container.openStream } : {}) }; },
                    } } } });
                if (!acquisitionRefusals) await mountService();
                const receipt = createDeploymentReceiptDetailV1();
                receipt.deployment.id = target.deploymentId;
                receipt.deployment.environmentId = detail.environment.id;
                receipt.content.ownServer = { approvedInputBasis: OwnServerDeploymentInputBasisV1Schema.parse({ v: 1,
                    environmentId: detail.environment.id, environmentRevision: 1, targetLinkId: link.id, targetLinkRevision: 1,
                    sourceIntent: receipt.content.sourceIntent, manifestFingerprint: release.manifestFingerprint, configInputDigests: [],
                    physicalProjectName: 'native-database', toolVersion: '2.40.1', services: ['database'], profiles: [], bindings: [variable], images: [],
                    members: [{ machineId: 'machine-a', installationId: installation.installationId }] }) };
                const publicKey = Buffer.from(installation.publicKey, 'base64url');
                const grant = sealMachineSecretGrant({ subject: { v: 1, kind: 'secret', environmentId: detail.environment.id,
                    machineId: 'machine-a', installationId: installation.installationId, resourceId: 'native-role', resourceRevision: 1 },
                    installationPublicKey: publicKey, content: { kind: 'secret', value: 'private-native-password' } });
                const action = parseQualifiedPluginActionId(DATABASE_STATEMENT_RUN_ACTION_ID_V1);
                if (!action) throw new Error('Expected the canonical database Action identity');
                const statement = {
                    sql: engine === 'postgresql' ? "SELECT note AS duplicate, ''::text AS duplicate, 9223372036854775807::bigint AS exact FROM native_items WHERE id=$1"
                        : "SELECT note AS duplicate, '' AS duplicate, CAST(9223372036854775807 AS SIGNED) AS exact FROM native_items WHERE id=?",
                    parameters: [{ type: 'integer' as const, value: '1' }],
                };
                const actionInput = { action, input: { operation: 'statement.run', target, mode: 'read', statement } };
                const machineTarget = { kind: 'machine' as const, machineId: 'machine-a' };
                const envelope = { v: 1 as const, requestId: 'native-real-pg', target: machineTarget, input: actionInput };
                const root = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'native-query-root', binding: {
                    accountId, authentication: { kind: 'account', tokenEpoch: 1 }, serverIdentityId: 'home',
                    actionId: ACTION_INVOKE_ACTION_ID_V1, target: machineTarget, machineId: 'machine-a',
                    installationId: installation.installationId, custodianAccountId: accountId, accountEncryptionMode: 'plain',
                    requestId: envelope.requestId, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
                    deploymentReadAdmission: projectDeploymentReadAdmissionV1(ACTION_INVOKE_ACTION_ID_V1, actionInput),
                } });
                const authorization = await projectExternalActionRequesterHttpAuthorization({ authorization: root,
                    serverId: 'home', serverIdentityId: 'home', serverHttpBaseUrl: 'https://home.test', target: machineTarget,
                    installationId: installation.installationId, privateKey: Buffer.from(installation.privateKey, 'base64url'), rootAdmitted: true });
                if (!authorization) throw new Error('Expected signed native database HTTP custody');
                const sizeInput = { serverId: 'home', environmentId: detail.environment.id,
                    expectedRevision: detail.environment.revision, targetLinkId: link.id, deploymentId: target.deploymentId,
                    machineId: 'machine-a', installationId: installation.installationId, service: 'database' };
                const sizeEnvelope = { ...envelope, requestId: 'native-size', input: sizeInput };
                const sizeRoot = ExternalActionExecutionAuthorizationV1Schema.parse({ ...root, token: 'native-size-root',
                    binding: { ...root.binding, actionId: DEPLOYMENT_DATA_SIZE_ACTION_ID_V1, requestId: sizeEnvelope.requestId,
                        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(sizeEnvelope),
                        deploymentReadAdmission: projectDeploymentReadAdmissionV1(DEPLOYMENT_DATA_SIZE_ACTION_ID_V1, sizeInput) } });
                const sizeAuthorization = await projectExternalActionRequesterHttpAuthorization({ authorization: sizeRoot,
                    serverId: 'home', serverIdentityId: 'home', serverHttpBaseUrl: 'https://home.test', target: machineTarget,
                    installationId: installation.installationId, privateKey: Buffer.from(installation.privateKey, 'base64url'), rootAdmitted: true });
                if (!sizeAuthorization) throw new Error('Expected signed deployment size custody');
                let activeRoot = sizeRoot;
                let secretReads = 0;
                vi.spyOn(axios, 'request').mockImplementation(async request => {
                    expect(new URL(request.url!).pathname).toBe(`/v1/deployments/environments/${detail.environment.id}/secret-launch-admission`);
                    const { proof, ...body } = EnvironmentSecretLaunchAdmissionInputV1Schema.parse(request.data);
                    expect(body.materialization).toEqual({ kind: 'dataRole', expectedRevision: 1, deploymentId: target.deploymentId, service: 'database' });
                    expect(request.headers?.[EXTERNAL_ACTION_EFFECT_ACTION_HEADER]).toBe(activeRoot.binding.actionId);
                    expect(verifyExternalActionMachineRequestV1({ authorizationToken: activeRoot.token,
                        effectActionId: activeRoot.binding.actionId, target: machineTarget, installationId: installation.installationId,
                        requestId: activeRoot.binding.requestId, method: 'POST', path: new URL(request.url!).pathname, body: request.data,
                        signature: String(request.headers?.[EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER] ?? ''), publicKey })).toBe(true);
                    expect(verifyMachineInstallationProof({ proof, publicKey, payload: { version: 1, machineId: 'machine-a',
                        installationId: installation.installationId, accountId,
                        deploymentSecretLaunch: { requestBodyDigest: computeEnvironmentSecretLaunchAdmissionDigestV1(body) } } })).toBe(true);
                    secretReads++;
                    return { status: 200, data: EnvironmentSecretLaunchAdmissionResultV1Schema.parse({ ok: true, grants: [grant] }) };
                });
                const actionCancellation = new AbortController();
                const signal = actionCancellation.signal;
                // D26: finite deployment reads use the shared engine without loading
                // the optional workbench. The admitted runtime above has no plugins.
                if (!acquisitionRefusals) {
                    const internalSize = await createDeploymentDataSizeActionForHost({ serverId: 'home', machineId: 'machine-a',
                        credentials, serverHttpBaseUrl: 'https://home.test', async assertCurrent() {},
                        async readEnvironment() { return detail; }, async readReceipt() { return receipt; } })(sizeInput,
                        { authority: 'present_user', runtimeAccountId: accountId, signal, actionRequestId: sizeEnvelope.requestId,
                            externalActionExecutionAuthorization: sizeAuthorization, externalActionTarget: machineTarget,
                            originalActionEnvelope: sizeEnvelope });
                    expect(internalSize).toMatchObject({ ok: true, size: { service: 'database', size: {
                        status: 'available', measurement: engine === 'postgresql' ? 'database_bytes' : 'table_bytes_estimate' },
                        growth: { status: 'unavailable', reason: 'previous_sample_required' },
                    } });
                    expect(await machineNativeEffectAdmission.run({ operation: { operationId: 'after-internal-size', kind: 'deploy' }, keys }, async () => true)).toBe(true);
                }
                activeRoot = root;
                secretReads = 0;
                const recoveryRequests: unknown[] = [];
                const recovery = {
                    async ensureEnvironmentServices(scope: unknown) {
                        recoveryRequests.push(scope);
                        await mountService();
                    },
                };
                const createService = (signal: AbortSignal, recover = false) => createDeploymentDatabasesServiceForHost({
                    ...(recover ? recovery : {}), seed: { plugin: { id: action.pluginId, version: '0.0.0' },
                    contribution: { id: action.localId, qualifiedId: DATABASE_STATEMENT_RUN_ACTION_ID_V1 }, occurrenceId: 'native',
                    correlationId: 'native-real-pg', surface: 'cli', signal, approvalContext: { authority: 'present_user', signal,
                        externalActionExecutionAuthorization: authorization, externalActionTarget: machineTarget,
                        originalActionEnvelope: envelope }, isOccurrenceCurrent: () => true },
                    contributes: { deploymentTargets: [], activationTargets: [] }, targetRegistrations: [], createServices: owners.createServices,
                    resolveInvocationHostPolicy: owners.resolveInvocationHostPolicy, readHost: async () => ({ serverId: 'home', machineId: 'machine-a',
                        installationId: installation.installationId, credentialOwnerAccountId: accountId, credentials, serverHttpBaseUrl: 'https://home.test',
                        async assertCurrent() {}, async readEnvironment() { return detail; }, async readReceipt() { return receipt; } }) });
                const service = createService(signal);
                const executeAdmin = pg ? (sql: string) => pg.execute(sql) : (sql: string) => container!.execute(sql);
                if (engine === 'postgresql') {
                    const member = link.members[0]!;
                    link.members = [{ ...member, installationId: 'neighbor-installation' }];
                    await expect(service.resolve({ operation: 'describe', target }, 'read'))
                        .rejects.toMatchObject({ code: 'target_mismatch' });
                    link.members = [member];
                    receipt.deployment.id = 'neighbor-deployment';
                    await expect(service.resolve({ operation: 'describe', target }, 'read'))
                        .rejects.toMatchObject({ code: 'target_mismatch' });
                    receipt.deployment.id = target.deploymentId;
                    const basis = receipt.content.ownServer!.approvedInputBasis!;
                    const fingerprint = basis.manifestFingerprint;
                    basis.manifestFingerprint = 'neighbor-runtime-release';
                    await expect(service.resolve({ operation: 'describe', target }, 'read'))
                        .rejects.toMatchObject({ code: 'service_unavailable', data: {
                            details: { reason: 'mounted_service_unconfirmed', remedy: expect.any(String) },
                            failureCause: { phase: 'deployment.data.service', errorCode: 'service_unavailable', httpStatus: null },
                        } });
                    basis.manifestFingerprint = fingerprint;
                    expect(secretReads).toBe(0);
                }
                if (acquisitionRefusals) {
                    await expect(service.resolve({ operation: 'describe', target }, 'read'))
                        .rejects.toMatchObject({ code: 'service_unavailable', data: {
                            details: { reason: 'mounted_service_unconfirmed' },
                            failureCause: { phase: 'deployment.data.service', errorCode: 'service_unavailable' },
                        } });
                    observedComposeProject = 'neighbor-runtime-project';
                    await expect(createService(signal, true).resolve({ operation: 'describe', target }, 'read'))
                        .rejects.toMatchObject({ code: 'service_unavailable', data: {
                            details: { reason: 'native_container_unconfirmed', remedy: expect.any(String) },
                            failureCause: { phase: 'deployment.data.container', errorCode: 'service_unavailable', httpStatus: null },
                        } });
                    expect(recoveryRequests).toEqual([{ environmentId: target.environment.environmentId, composeService: target.serviceId }]);
                    expect(secretReads).toBe(0);
                    return;
                }
                if (engine === 'postgresql') {
                    await executeAdmin('ALTER ROLE happier_ro SUPERUSER');
                    await expect(service.resolve({ operation: 'describe', target }, 'read'))
                        .rejects.toMatchObject({ code: 'read_role_unavailable' });
                    await executeAdmin('ALTER ROLE happier_ro NOSUPERUSER');
                }
                const opened = await service.resolve({ operation: 'describe', target }, 'read');
                try {
                    expect(await opened.connection.execute({ operation: 'statement.run', target, mode: 'read', statement }))
                        .toMatchObject({ ok: true, results: [{ columns: [{ name: 'duplicate' }, { name: 'duplicate' }, { name: 'exact' }],
                        rows: [{ cells: [{ type: 'null' }, { type: 'text', value: '' }, { type: 'integer', value: '9223372036854775807' }] }] }] });
                    if (pg) {
                        const sizes = await readDeploymentDatabaseSizesV1({
                            environment: { ...detail.environment, serverId: target.environment.serverId, runtimeTargetLinkId: link.id },
                            content: { ...detail.content, template: { ...detail.content.template!,
                                data: [{ service: 'database', engine: 'postgres' }] } },
                            readTargets: async () => ({ targets: [opened.descriptor], completeness: { complete: true } }),
                            run: request => opened.connection.execute(request),
                        });
                        const actualBytes = Number((await pg.execute('SELECT pg_database_size(current_database())')).stdout.match(/^\s*(\d+)\s*$/mu)?.[1]);
                        expect(sizes[0]?.size).toMatchObject({ status: 'available', bytes: actualBytes });
                        const executeRead = (sql: string) => opened.connection.execute({ operation: 'statement.run', target,
                            mode: 'read', statement: { sql, parameters: [] } });
                        const payload = "hello'; DELETE FROM native_items; --\n\\! echo unsafe";
                        expect(await opened.connection.execute({ operation: 'statement.run', target, mode: 'read',
                            statement: { sql: 'SELECT $1::text AS value', parameters: [{ type: 'text', value: payload }] } }))
                            .toMatchObject({ ok: true, results: [{ rows: [{ cells: [{ type: 'text', value: payload }] }] }] });
                        for (const sql of ["INSERT INTO native_items VALUES(2,'changed')", 'CREATE TABLE public.unwanted(value int)', 'SET ROLE fixture']) {
                            expect(await executeRead(sql)).toMatchObject({ ok: false, code: 'database_engine_error' });
                        }
                        await pg.execute("CREATE FUNCTION public.native_writer() RETURNS int LANGUAGE plpgsql SECURITY DEFINER AS $$BEGIN INSERT INTO native_items VALUES(2,'wrong'); RETURN 1; END$$");
                        expect(await executeRead('SELECT public.native_writer()')).toMatchObject({ ok: false, code: 'database_engine_error' });
                        expect((await pg.execute('SELECT count(*) FROM native_items')).stdout).toMatch(/^\s*1\s*$/mu);
                        await pg.execute('DROP FUNCTION public.native_writer()');
                    }
                    await expect(machineNativeEffectAdmission.run({ operation: { operationId: 'competing-deployment', kind: 'deploy' }, keys }, async () => true))
                        .rejects.toMatchObject({ code: 'effect_in_progress' });
                    expect(secretReads).toBe(engine === 'postgresql' ? 2 : 1);
                    const bindings = detail.content.bindings;
                    const readsBeforeMissingRole = secretReads;
                    for (const neighboringRole of [false, true]) {
                        detail.content.bindings = bindings.filter(binding => binding.purpose !== 'dataRole');
                        if (neighboringRole) detail.content.bindings.push({ ...use, service: 'neighboring-database' });
                        await expect(service.resolve({ operation: 'describe', target }, 'read'))
                            .rejects.toMatchObject({ errorCode: 'read_role_setup_required' });
                        expect(secretReads).toBe(readsBeforeMissingRole);
                    }
                    detail.content.bindings = bindings;
                    const active = engine === 'mysql'
                        ? "SELECT COUNT(*) FROM information_schema.PROCESSLIST WHERE USER='happier_ro' AND INFO LIKE '%SLEEP(60)%'"
                        : "SELECT COUNT(*) FROM pg_stat_activity WHERE usename='happier_ro' AND state='active' AND query LIKE '%pg_sleep(60)%'";
                    const sleeping = opened.connection.execute({ operation: 'statement.run', target, mode: 'read', statement: {
                        sql: engine === 'mysql' ? 'SELECT SLEEP(60)' : 'SELECT pg_sleep(60)', parameters: [],
                    } }, signal);
                    await vi.waitFor(async () => { expect((await executeAdmin(active)).stdout).toMatch(/^\s*1\s*$/mu); }, { timeout: 60_000 });
                    actionCancellation.abort();
                    expect(await sleeping).toMatchObject({ ok: false, status: 'cancelled', code: 'database_cancelled' });
                    expect((await executeAdmin(active)).stdout).toMatch(/^\s*0\s*$/mu);
                } finally { await opened.connection.close(); }
                expect(await machineNativeEffectAdmission.run({ operation: { operationId: 'after-query', kind: 'deploy' }, keys }, async () => true)).toBe(true);
            } finally {
                await owners.dispose(); await fixture.dispose();
            }
        } finally {
            await pg?.close(); await container?.close();
        }
    });
}, 120_000);
}
