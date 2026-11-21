import { DeploymentEnvironmentGetInputV1Schema, DeploymentPendingCancelInputV1Schema } from '@happier-dev/protocol';
import { ActionOperationAddressV1Schema } from '@happier-dev/protocol/actions/specs/actionOperations';
import { DEPLOYMENT_PENDING_OPERATION_CANCEL_HTTP_PATH_V1 } from '@happier-dev/protocol/deployments/deploymentPendingAdmissionV1';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';

/** The reached host opens and binds the original cancellation Address. Home
 * admits only its signed cleanup bytes; Source rights and exact pending CAS
 * remain owned by the resource routes, not this HTTP purpose classifier. */
export function isExternalActionDeploymentPendingCancelPurpose(input: Readonly<{
    actionId: string; effectActionId: string; serverIdentityId: string;
    method: string; path: string; body: unknown; routeInput?: unknown;
}>): boolean {
    if (input.actionId !== 'action.operations.cancel' || input.effectActionId !== input.actionId) return false;
    const url = new URL(input.path, 'http://home.invalid');
    if (url.hash) return false;
    if (input.method.toUpperCase() === 'GET' && input.body === undefined) {
        if (input.path === '/v1/account/encryption/currentness') return true;
        const match = /^\/v1\/deployments\/environments\/([^/?#]+)$/u.exec(url.pathname);
        if (!match || Array.from(url.searchParams.keys()).length !== 1
            || url.searchParams.get('serverId') !== input.serverIdentityId) return false;
        try {
            const parsed = DeploymentEnvironmentGetInputV1Schema.safeParse({ serverId: input.serverIdentityId,
                environmentId: decodeURIComponent(match[1]) });
            return parsed.success && encodeURIComponent(parsed.data.environmentId) === match[1]
                && (input.routeInput === undefined || sameStrictJsonValue(input.routeInput, parsed.data));
        } catch { return false; }
    }
    if (input.method.toUpperCase() !== 'POST' || url.search) return false;
    if (input.path === DEPLOYMENT_PENDING_OPERATION_CANCEL_HTTP_PATH_V1) {
        const address = ActionOperationAddressV1Schema.safeParse(input.body);
        return address.success && address.data.serverId === input.serverIdentityId
            && (input.routeInput === undefined || sameStrictJsonValue(input.routeInput, address.data));
    }
    const body = DeploymentPendingCancelInputV1Schema.safeParse(input.body);
    return body.success && body.data.serverId === input.serverIdentityId
        && input.path === `/v1/deployments/environments/${encodeURIComponent(body.data.environmentId)}/pending/cancel`
        && (input.routeInput === undefined || sameStrictJsonValue(input.routeInput, body.data));
}
