import { readPluginActionError, readPluginActionFailureAuthorPayload } from '@happier-dev/protocol/plugins/actions/invocation';
import { randomUUID } from 'node:crypto';
import { decodeBase64 } from '@happier-dev/protocol/crypto/base64';
import type { ActionExecutorContext, ActionExecuteFailure } from '@happier-dev/protocol';
import type { DeploymentDataQueryInputV1 } from '@happier-dev/protocol/deployments/deploymentReadsV1';
import { environmentSecretBindingIdentityV1 } from '@happier-dev/deployment-protocol';
import { readInstallationIdentityIfExistsSync } from '@/daemon/identity/store';
import type { StoredCredentials } from '@/persistence';
import { readEnvironmentDataRoleLaunchAdmissionForHost } from '../secrets/readEnvironmentSecretLaunchAdmissionForHost';
import { prepareEnvironmentSecretBindingsForLaunch } from '../secrets/prepareEnvironmentSecretBindingsForLaunch';
import { projectDeploymentFailure } from '../deploymentFailure';
import { executeOwnServerReadOnlyDataQuery } from '../targets/ownServer/dataQuery';
import { withOwnServerDataQueryNativeForHost } from '../targets/ownServer/dataQueryNative';
import { acquireOwnServerDataServiceForHost, type OwnServerDataServiceHost } from '../targets/ownServer/dataQueryScope';

const failure = (errorCode: string): ActionExecuteFailure => ({ ok: false, errorCode, error: errorCode });
const unavailableFailure = (code: string) => ({ ok: false as const, error: 'deployment_unavailable' as const, diagnostic: { code } });

/** Query acquires only the dedicated read-role binding. Missing setup never
 * opens application/admin grants and never invokes bootstrap implicitly. */
export function createDeploymentDataQueryActionForHost(host: OwnServerDataServiceHost & Readonly<{
    credentials: StoredCredentials; serverHttpBaseUrl: string;
}>) {
    return async (input: DeploymentDataQueryInputV1, context: ActionExecutorContext) => {
        try {
            await host.assertCurrent(context);
            const installation = readInstallationIdentityIfExistsSync();
            if (input.serverId !== host.serverId || input.machineId !== host.machineId
                || installation?.installationId !== input.installationId) return failure('target_mismatch');
            const signal = context.signal ?? new AbortController().signal;
            const scope = await acquireOwnServerDataServiceForHost(host, input, context);
            try {
                const use = scope.use;
                const admission = await readEnvironmentDataRoleLaunchAdmissionForHost({ credentials: host.credentials,
                    serverId: input.serverId, serverHttpBaseUrl: host.serverHttpBaseUrl, environmentId: input.environmentId,
                    targetLinkId: input.targetLinkId, machineId: input.machineId, installationId: input.installationId,
                    expectedRevision: input.expectedRevision, deploymentId: input.deploymentId, service: input.service,
                    context, signal });
                try {
                    const prepared = await prepareEnvironmentSecretBindingsForLaunch({ environmentId: input.environmentId,
                        machineId: input.machineId, installationId: input.installationId, installationPrivateSeed: decodeBase64(installation.privateKey, 'base64url').slice(0, 32),
                        bindings: scope.environment.content.bindings, grants: admission.grants, use,
                        assertCurrent: admission.assertCurrent });
                    try {
                        const password = prepared.operationalValues.get(environmentSecretBindingIdentityV1(use));
                        if (!password) return unavailableFailure('read_role_setup_required');
                        return await withOwnServerDataQueryNativeForHost({ ...scope, operationId: context.actionRequestId ?? randomUUID(), signal,
                            allowTruncatedStdout: true },
                            async native => ({ ok: true as const, ...await executeOwnServerReadOnlyDataQuery({ ...scope.definition,
                                sql: input.sql, params: input.params, password, signal }, native) }));
                    } finally { prepared.dispose(); }
                } finally { await admission.release?.(); }
            } finally { await scope.dispose(); }
        } catch (error) {
            const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code
                : error && typeof error === 'object' && 'data' in error && error.data && typeof error.data === 'object'
                    && 'code' in error.data && typeof error.data.code === 'string' ? error.data.code : 'deployment_unavailable';
            const plugin = readPluginActionError(error);
            const details = plugin ? readPluginActionFailureAuthorPayload(plugin.data)?.details : undefined;
            const reason = details && typeof details === 'object' && 'reason' in details && typeof details.reason === 'string'
                ? details.reason : code;
            if (!context.signal?.aborted) {
                if (code === 'project_native_toolchain_output_incomplete') return unavailableFailure('native_output_truncated');
                if (code === 'unsupported_action') return { ok: false as const, error: 'unsupported_action' as const, diagnostic: { code: reason } };
                if (code === 'read_role_unavailable' || code === 'read_role_setup_required' || reason === 'read_role_unavailable' || code === 'secret_missing') return unavailableFailure(reason);
            }
            return projectDeploymentFailure(context.signal?.aborted ? 'cancelled' : code, error, 'deployment.data.query');
        }
    };
}
