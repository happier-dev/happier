import { ApiClient } from '@/api/api';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { resolveMachineEffectCli } from '@/machines/adminAccess/machineEffectCli';
import type { DomainNativeSetupForHost } from './ownServerDomainNative';
import type { OwnServerDeploymentTargetHostInput } from './ownServerDeploymentTarget';
import { privateServicePublicationBindings } from './privateServicePublication';

const unavailable = (code: string): never => { throw Object.assign(new Error(code), { code }); };

/** The installed Action host lends its existing setup/elevation and requester read ports. */
export function createPrivateServicePublicationSettlementForHost(host: Pick<OwnServerDeploymentTargetHostInput,
    'credentials' | 'serverHttpBaseUrl' | 'machineId'> & Readonly<{
        captureNativeSetup?(): DomainNativeSetupForHost;
    }>): NonNullable<OwnServerDeploymentTargetHostInput['settlePrivateWorkloadFirewall']> {
    return async (request, input) => {
        const exported = input.environment.content.ownServer?.serviceExports ?? [];
        const machine = await runWithServerHttpBaseUrl(host.serverHttpBaseUrl, () => request.context.externalActionExecutionAuthorization
            ? ApiClient.getRequesterMachine(host.machineId, { authorization: request.context.externalActionExecutionAuthorization,
                signal: input.signal, effectActionId: request.actionId })
            : ApiClient.create(host.credentials).then(api => api.getMachine(host.machineId, { signal: input.signal })));
        const privateNetworks = machine?.daemonState?.reachability?.privateNetworks ?? [];
        const privateWorkloadBindings = privateServicePublicationBindings({ environmentId: input.environment.environment.id,
            exports: exported, services: input.render.review.services, privateNetworks });
        const setup = host.captureNativeSetup?.();
        if (!setup?.settlePrivateWorkloadFirewall) return unavailable('private_scope_unenforceable');
        const desired = await setup.readDesired();
        if (desired.status !== 'ready') return unavailable('required_fact_unavailable');
        await setup.settlePrivateWorkloadFirewall({ machineId: host.machineId, installationId: input.installationId,
            operationId: input.context.operation.operationId,
            basis: { kind: 'setup', machineId: host.machineId, desiredRevision: desired.policy.revision },
            privateWorkloadBindings, privateNetworks, native: input.context,
            elevation: { ...setup.elevation, installationId: input.installationId, ...resolveMachineEffectCli() },
            signal: input.signal, runNative: async command => {
                const result = await input.docker.run(command.args, command.signal ?? input.signal, command.inputBytes);
                return { code: result.exitCode, stdout: result.stdout, stderr: result.stderr ?? '' };
            } });
    };
}
