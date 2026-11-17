import { PluginError } from '@happier-dev/plugin-sdk/errors';
import type { ActionExecutorContext, MachineInstallationIdentityV1 } from '@happier-dev/protocol';
import { DeploymentAppEnrollmentAdmissionResultV1Schema, type DeploymentAppEnrollmentCorrelationV1 } from '@happier-dev/protocol/machines/enrollmentV1';
import { PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1 } from '@happier-dev/protocol/plugins/installations/manifests';
import { DATABASE_TELEMETRY_MACHINE_ROLE_ID_V1, MachineRolesGetResultV1Schema, MachineRolesMutationResultV1Schema } from '@happier-dev/protocol/machines/roles/machineRolesV1';
import { createActionExecuteFailureError } from '@happier-dev/protocol/actions/actionExecutionResult';
import { createManagedNativeBootstrapIO } from '@happier-dev/cli-common/machines/managed';
import { readManagedGuestCliIdentity } from '@happier-dev/cli-common/systemTasks/nativeRemoteSshBootstrap';
import { safeBashSingleQuote } from '@happier-dev/cli-common/ssh';
import axios from '@/api/client/credentialAxios';
import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import { readRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionContext';
import { nativeServiceCommandArgs } from '@/daemon/local/services/launch/serviceCommand';
import { runManagedMachineEnrollment } from '@/machines/managed/enrollment';
import { signPluginInstallationPublisherHeader } from '@/plugins/installations/publisherProof';
import { resolveCliHomeTarget, resolveCurrentCliHomeTarget } from '@/server/homeTarget';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import type { StoredCredentials } from '@/persistence';
import type { OwnServerDeploymentRuntimeAcquisition } from './ownServerDeploymentTarget';

type EnrollmentInput = Parameters<NonNullable<OwnServerDeploymentRuntimeAcquisition['enrollAppServices']>>[0];

/** The accepted deployment lends its existing Compose byte channel to ordinary enrollment. */
export async function enrollOwnServerAppServices(input: EnrollmentInput, host: Readonly<{
    credentials: StoredCredentials; credentialProfileId?: string; serverId: string; serverHttpBaseUrl: string;
    machineId: string; identity: MachineInstallationIdentityV1; context: ActionExecutorContext;
    nativeIo: OwnServerDeploymentRuntimeAcquisition['nativeIo'];
}>): Promise<void> {
    if (!input.render.appEnrollments?.length) return;
    const target = host.credentialProfileId
        ? await resolveCliHomeTarget({ kind: 'saved_profile', profileRef: host.credentialProfileId })
        : await resolveCurrentCliHomeTarget();
    if (target.homeServerIdentityId !== host.serverId || !target.descriptor) {
        throw new PluginError({ code: 'home_identity_mismatch', message: 'App enrollment requires the installed Home descriptor' });
    }
    const accountCredentials = readRequesterAccountActionContext(host.context.externalActionExecutionAuthorization)?.credentials
        ?? (host.context.externalActionExecutionAuthorization ? undefined : host.credentials);
    const guestCli = await readManagedGuestCliIdentity({ homeUrl: host.serverHttpBaseUrl, signal: input.signal });
    for (const declaration of input.render.appEnrollments) {
        const channel = declaration.releaseChannel;
        input.signal?.throwIfAborted();
        const ids = input.project.nativeIdsForService(declaration.serviceName);
        const service = input.services.find(value => value.composeService === declaration.serviceName);
        if (ids.length !== 1 || !service) throw new PluginError({ code: 'machine_registration_unconfirmed',
            message: 'An enrolled App service requires one activated native container' });
        const enrollment: DeploymentAppEnrollmentCorrelationV1 = {
            source: 'deploymentApp', homeId: host.serverId, environmentId: input.deployment.environmentId,
            deploymentId: input.deployment.id, actionOperationId: input.deployment.actionOperationId,
            controller: { machineId: host.machineId, installationId: host.identity.installationId },
        };
        const path = `/v1/deployments/environments/${encodeURIComponent(enrollment.environmentId)}/deployments/${encodeURIComponent(enrollment.deploymentId)}/app-enrollment`;
        const admit = async (binding?: Readonly<{ pairingPublicKey: string }> | Readonly<{ existingMachineId: string }>) => {
            const body = { ...enrollment, ...binding };
            const response = await axios.post(`${host.serverHttpBaseUrl}${path}`, body, { signal: input.signal,
                headers: { ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(), Authorization: `Bearer ${host.credentials.token}`,
                    [PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1]: signPluginInstallationPublisherHeader({
                        identity: host.identity, machineId: host.machineId, path, body }) } });
            return DeploymentAppEnrollmentAdmissionResultV1Schema.parse(response.data);
        };
        const admission = await admit();
        if (!accountCredentials || readAccountIdFromToken(accountCredentials.token) !== admission.enrollmentAccountId) {
            throw new PluginError({ code: 'client_required', message: 'The deployment requester must approve App enrollment' });
        }
        const resource = { value: { ...enrollment, nativeIds: [...ids] } };
        const native = createManagedNativeBootstrapIO({ resource }, async (role, body, options) => {
            // This body is produced in-process by createManagedNativeBootstrapIO, never by an Action caller.
            const request = body as Readonly<{ argv: readonly string[]; inputBase64?: string; guestPath: string; bytesBase64: string }>;
            const launch = input.project.authorizeServiceObserver();
            try {
                const argv = role === 'exec' ? request.argv : role === 'putFile'
                    ? ['sh', '-c', `umask 077; cat > ${safeBashSingleQuote(request.guestPath)}`] : undefined;
                if (!argv) throw new PluginError({ code: 'unsupported', message: 'App enrollment uses native exec and file delivery' });
                const stdin = role === 'putFile' ? Buffer.from(request.bytesBase64, 'base64')
                    : request.inputBase64 === undefined ? undefined : Buffer.from(request.inputBase64, 'base64');
                const result = await host.nativeIo.run({ command: launch.command,
                    args: nativeServiceCommandArgs(launch.args, declaration.serviceName, { mode: 'exec', argv }),
                    cwd: launch.cwd!, env: Object.fromEntries(Object.entries(launch.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
                    signal: options?.signal ?? input.signal, ...(stdin ? { stdin } : {}) });
                if (role === 'putFile') {
                    if (result.exitCode !== 0) throw new PluginError({ code: 'remote_command_failed', message: 'App native file delivery failed' });
                    return { kind: 'confirmed' };
                }
                options?.onStdoutChunk?.(result.stdout);
                return { termination: { requestedBy: { kind: 'none' }, observed: { kind: 'exit', exitCode: result.exitCode } },
                    stdoutBase64: Buffer.from(result.stdout).toString('base64'), stderrBase64: Buffer.from(result.stderr ?? '').toString('base64'),
                    stdoutTruncated: result.stdoutTruncated ?? false, stderrTruncated: false };
            } finally { await launch.release(); }
        });
        const enrolled = await runManagedMachineEnrollment({ source: 'deploymentApp', enrollment: admission.enrollment, target,
            machineDisplayName: 'Telemetry collector', homeDir: declaration.homeDir, happyHomeDir: declaration.happyHomeDir,
            binaryPath: 'happier', deploymentAppBinding: { serviceName: declaration.serviceName, port: declaration.port },
            enrollmentAccountId: admission.enrollmentAccountId,
            guestCli, channel, accountCredentials,
            operationId: input.nativeContext.operation.operationId, signal: input.signal,
            onPairingRequest: async publicKey => { await admit({ pairingPublicKey: publicKey }); },
            onExistingMachine: async existingMachineId => { await admit({ existingMachineId }); },
            restartDaemon: async () => {
                const result = await service.controlNative('restart', { operation: input.nativeContext.operation,
                    admittedContext: input.nativeContext, signal: input.signal });
                if (result.kind !== 'observed') throw new PluginError({ code: 'native_service_control_unconfirmed', message: 'App daemon restart was not confirmed' });
            },
        }, { native });
        const actions = createCliActionExecutorFromCredentials({ credentials: accountCredentials,
            readCredentials: async () => accountCredentials, externalActionClient: true,
            machineId: host.machineId, serverId: host.serverId, serverIdentityId: host.serverId, serverApiUrl: host.serverHttpBaseUrl });
        const context = { surface: host.context.surface ?? 'cli', authority: host.context.authority,
            serverId: host.serverId, signal: input.signal };
        const current = await actions.execute('machines.roles.get', { serverId: host.serverId, machineId: enrolled.machineId }, context);
        if (!current.ok) throw createActionExecuteFailureError(current);
        const roles = MachineRolesGetResultV1Schema.parse(current.result);
        if (roles.status !== 'ready') throw new PluginError({ code: 'machine_roles_unconfirmed', message: 'App Machine role policy is unavailable' });
        if (!roles.policy.active.includes(DATABASE_TELEMETRY_MACHINE_ROLE_ID_V1)) {
            const execution = await actions.execute('machines.roles.set', { serverId: host.serverId,
                machineId: enrolled.machineId, expectedPolicy: roles.policy, expectedMetadataVersion: roles.metadataVersion,
                policy: { active: [...roles.policy.active, DATABASE_TELEMETRY_MACHINE_ROLE_ID_V1] } }, context);
            if (!execution.ok) throw createActionExecuteFailureError(execution);
            const changed = MachineRolesMutationResultV1Schema.parse(execution.result);
            if (!('policy' in changed) || !changed.policy.active.includes(DATABASE_TELEMETRY_MACHINE_ROLE_ID_V1)) {
                throw new PluginError({ code: 'machine_roles_unconfirmed', message: 'App Machine telemetry role was not confirmed' });
            }
        }
    }
}
