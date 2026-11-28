import { PluginError } from '@happier-dev/plugin-sdk/errors';
import type { DatabaseEngineConnectionV1 } from '@happier-dev/plugin-sdk';
import type { ActionExecutorContext } from '@happier-dev/protocol';
import type {
    DatabaseDeploymentServiceTargetV1,
    DatabaseOperationResultV1,
    DatabaseReadStatementInputV1,
    DatabaseStatsOperationInputV1,
} from '@happier-dev/plugin-sdk/database';
import type { PostgresqlConnection } from '@happier-dev/databases/connection/postgresql';
import { decodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { environmentSecretBindingIdentityV1, type DeploymentEnvironmentDetailV1 } from '@happier-dev/deployments/contracts/v1';
import { readInstallationIdentityIfExistsSync } from '@/daemon/identity/store';
import { MACHINE_NATIVE_DATA_READ_KIND, machineNativeEffectAdmission } from '@/daemon/local/services/launch/machineNativeEffectAdmission';
import type { DatabaseConnectionOperationRunner } from '@happier-dev/databases/connection';
import type { StoredCredentials } from '@/persistence';
import { readEnvironmentDataRoleLaunchAdmissionForHost } from '../../secrets/readEnvironmentSecretLaunchAdmissionForHost';
import { prepareEnvironmentSecretBindingsForLaunch } from '../../secrets/prepareEnvironmentSecretBindingsForLaunch';
import { acquireOwnServerDataServiceForHost, type OwnServerDataServiceHost } from './dataQueryScope';
import { readOwnServerDatabaseEndpointForHost } from './databaseEndpoint';
import { ownServerReadOnlyRoleGuardSql } from './dataRoleGuard';
import { postgresqlWriteRoleSetupSql } from '@happier-dev/deployment-protocol';

const refuse = (code: string): never => { throw new PluginError({ code }); };
type Host = OwnServerDataServiceHost & Readonly<{ credentials: StoredCredentials; serverHttpBaseUrl: string }>;
type NativeConnection = PostgresqlConnection & Pick<DatabaseEngineConnectionV1, 'normalizeStatementShape'>
    & Readonly<{ engine: 'postgresql' | 'mysql'; database: string }>;

/** The existing native owner supplies the selected generation and Docker launch.
 * PostgreSQL can consume its observed loopback binding. Private engines borrow
 * the same Docker stream and keep their login on the container's loopback. */
export async function openOwnServerDatabaseConnectionForHost(input: Readonly<{
    host: Host; target: Omit<DatabaseDeploymentServiceTargetV1, 'database'> & { database?: string }; environment: DeploymentEnvironmentDetailV1;
    installationId: string; context: ActionExecutorContext; signal: AbortSignal; operationId: string; expectedRevision?: number;
    /** Write opens the bounded `happier_rw` login (P3 R14); reads keep `happier_ro`. */
    access?: 'read' | 'write';
}>): Promise<NativeConnection> {
    const { host, target, context } = input;
    const write = input.access === 'write';
    await host.assertCurrent(context);
    const installation = readInstallationIdentityIfExistsSync();
    if (!installation || installation.installationId !== input.installationId) return refuse('target_mismatch');
    const scope = await acquireOwnServerDataServiceForHost(host, { ...target.environment,
        expectedRevision: input.expectedRevision ?? input.environment.environment.revision, targetLinkId: target.targetLinkId,
        deploymentId: target.deploymentId, service: target.serviceId, machineId: host.machineId,
        installationId: input.installationId, ...(write ? { role: 'write' as const } : {}) }, context, input.environment);
    let ownsScope = true;
    try {
        if (target.database !== undefined && scope.definition.database !== target.database) return refuse('target_mismatch');
        const keys = await scope.handle.readNativeEffectKeys?.({ signal: input.signal });
        if (!keys || !scope.handle.readNativeDocker) return refuse('service_admission_unavailable');
        const signal = AbortSignal.any([input.signal, scope.handle.retirementSignal]);
        // The watched Resource holds the verified session. Native exclusion
        // covers connection setup and each scheduled database operation.
        const operation = { operationId: input.operationId, kind: write ? 'dataQuery' : MACHINE_NATIVE_DATA_READ_KIND };
        const runOperation: DatabaseConnectionOperationRunner = (execute, requestSignal) =>
            machineNativeEffectAdmission.run({ operation: { ...operation, signal: requestSignal ?? signal }, keys },
                effect => machineNativeEffectAdmission.runStage(effect, execute));
        const connection = await machineNativeEffectAdmission.run({ operation: { ...operation, signal }, keys }, async effect => {
            const docker = await scope.handle.readNativeDocker!({ signal });
            const containerPort = scope.definition.port ?? (scope.definition.engine === 'postgresql' ? 5432 : 3306);
            const endpoint = scope.definition.engine === 'postgresql' ? await machineNativeEffectAdmission.runStage(effect, () => readOwnServerDatabaseEndpointForHost({ docker,
                ports: scope.handle.readNativeRuntimeFacts?.().configuration?.ports ?? [],
                containerPort, signal })).catch((error: unknown) => {
                    if (error instanceof PluginError && error.code === 'database_transport_unavailable' && docker.openStream) return null;
                    throw error;
                }) : null;
            if (!endpoint && !docker.openStream) return refuse('database_transport_unavailable');
            const isPostgresql = scope.definition.engine === 'postgresql';
            const openConnection = isPostgresql
                ? (await import('@happier-dev/databases/connection/postgresql')).openPostgresqlConnection
                : (await import('@happier-dev/databases/connection/mysql')).openMysqlConnection;
            const admission = await readEnvironmentDataRoleLaunchAdmissionForHost({ credentials: host.credentials, serverId: host.serverId,
                serverHttpBaseUrl: host.serverHttpBaseUrl, environmentId: target.environment.environmentId,
                targetLinkId: target.targetLinkId, machineId: host.machineId, installationId: input.installationId,
                expectedRevision: input.environment.environment.revision, deploymentId: target.deploymentId, service: target.serviceId, context, signal });
            try {
                const prepared = await prepareEnvironmentSecretBindingsForLaunch({ environmentId: target.environment.environmentId,
                    machineId: host.machineId, installationId: input.installationId,
                    installationPrivateSeed: decodeBase64(installation.privateKey, 'base64url').slice(0, 32),
                    bindings: scope.environment.content.bindings, grants: admission.grants, use: scope.use, assertCurrent: admission.assertCurrent });
                try {
                    const password = prepared.operationalValues.get(environmentSecretBindingIdentityV1(scope.use));
                    if (!password) return refuse(write ? 'write_role_setup_required' : 'read_role_setup_required');
                    const url = new URL(`${scope.definition.engine}://127.0.0.1`);
                    url.hostname = endpoint?.host === '::1' ? '[::1]' : '127.0.0.1';
                    url.port = String(endpoint?.port ?? containerPort); url.username = write ? 'happier_rw' : 'happier_ro'; url.password = password;
                    url.pathname = `/${encodeURIComponent(scope.definition.database)}`;
                    // postgres:17 and mysql:8.4 ship Bash and cat. This relay has
                    // no listener, SQL parser or credential in argv. Driver
                    // cancellation borrows it under the admitted generation's
                    // lifetime, so Action stop cannot prevent its own cleanup.
                    const transport = endpoint ? {} : { openStream: () =>
                        docker.openStream!(['exec', '-i', scope.containerId, '/bin/bash', '-c',
                            `exec 3<>/dev/tcp/127.0.0.1/${containerPort} || exit; `
                            + 'cat <&3 & reader=$!; cat <&0 >&3 & writer=$!; '
                            + 'wait -n "$reader" "$writer"; kill "$reader" "$writer" 2>/dev/null; wait',
                        ], scope.handle.retirementSignal) };
                    return await machineNativeEffectAdmission.runStage(effect, () => openConnection(url.toString(), signal, {
                        ...transport, runOperation,
                        ...(isPostgresql ? write ? { writeRoleSetupSql: postgresqlWriteRoleSetupSql }
                            : { access: 'read', sessionGuardSql: ownServerReadOnlyRoleGuardSql('postgresql') } : {}),
                    })).catch((error: unknown) => {
                            if (error && typeof error === 'object' && 'code' in error) {
                                if (error.code === 'write_role_unavailable') return refuse(error.code);
                                if (error.code === '42501') return refuse(write ? 'write_role_unavailable' : 'read_role_unavailable');
                            }
                            throw error;
                        });
                } finally { prepared.dispose(); }
            } finally { await admission.release?.(); }
        });
        let closing: Promise<void> | undefined;
        const close = () => {
            signal.removeEventListener('abort', onAbort);
            return closing ??= connection.close().finally(scope.dispose);
        };
        const onAbort = () => { void close().catch(() => {}); };
        ownsScope = false;
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) { await close(); signal.throwIfAborted(); }
        return {
            engine: scope.definition.engine, database: scope.definition.database,
            ...('normalizeStatementShape' in connection ? { normalizeStatementShape: connection.normalizeStatementShape } : {}),
            execute: (request, requestSignal) => connection.execute(request, requestSignal ? AbortSignal.any([signal, requestSignal]) : signal),
            close,
        };
    } catch (error) { if (ownsScope) await scope.dispose(); throw error; }
}

/** Finite deployment reads share the same operation and native custody as the
 * workbench; their lifecycle ends here without activating optional runtime. */
export async function executeOwnServerDatabaseOperationForHost(input: Readonly<
    Omit<Parameters<typeof openOwnServerDatabaseConnectionForHost>[0], 'target'> & {
        request: (DatabaseReadStatementInputV1 | DatabaseStatsOperationInputV1) & { target: DatabaseDeploymentServiceTargetV1 };
    }
>): Promise<DatabaseOperationResultV1> {
    const connection = await openOwnServerDatabaseConnectionForHost({ ...input, target: input.request.target });
    try { return await connection.execute(input.request, input.signal); }
    finally { await connection.close(); }
}
