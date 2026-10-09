import type { ActionOperationSnapshotV1 } from '@happier-dev/protocol';
import type { PROJECT_ACTION_INPUT_SCHEMAS_V1 } from '@happier-dev/protocol/actions/projectActionFamily';
import type { WorkspaceAddressV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import type { z } from 'zod';

export type ActionOperationProjectScriptSelection = z.infer<(typeof PROJECT_ACTION_INPUT_SCHEMAS_V1)['projects.script.run']>['selection'];

export type ActionOperationProjectWorkspaceQuery = Readonly<{
    /** Required authenticated Account evidence; unresolved identity fails closed. */
    accountId: string | null;
    /** Original Source checkout, not the operation's execution placement. */
    workspace: WorkspaceAddressV1;
}>;

export type ActionOperationProjectScriptQuery = ActionOperationProjectWorkspaceQuery & Readonly<{
    selection: ActionOperationProjectScriptSelection;
}>;

export type ActionOperationAddress = Readonly<{
    serverId: string | null;
    operationId: string;
}>;

export type ActionOperationMachineAddress = Readonly<{
    serverId: string | null;
    machineId: string;
}>;

export type ActionOperationManagedMachineQuery = ActionOperationMachineAddress & Readonly<{
    accountId: string | null;
    managedId: string;
    /** Portable identity from the actual managed row, not this device's profile id. */
    homeId?: string | null;
    /** Actual joined target, distinct from the allocating controller. */
    enrolledMachineId?: string | null;
}>;

export type ActionOperationSessionAddress = Readonly<{
    serverId: string | null;
    sessionId: string;
    /** When supplied, unresolved Account evidence fails closed. */
    accountId?: string | null;
}>;

export type ActionOperationRequestAddress = Readonly<{
    serverId: string | null;
    accountId: string;
    requestId: string;
}>;

export type QualifiedActionOperation = Readonly<{
    serverId: string;
    snapshot: ActionOperationSnapshotV1;
}>;

export function normalizeActionOperationServerId(serverId: string | null | undefined): string | null {
    const normalized = typeof serverId === 'string' ? serverId.trim() : '';
    return normalized || null;
}

export function actionOperationAddress(
    serverId: string | null | undefined,
    operationId: string,
): ActionOperationAddress {
    return Object.freeze({
        serverId: normalizeActionOperationServerId(serverId),
        operationId,
    });
}

export function qualifyActionOperationSnapshot(
    serverId: string,
    snapshot: ActionOperationSnapshotV1,
): QualifiedActionOperation {
    return Object.freeze({
        serverId,
        snapshot,
    });
}

export function actionOperationAddressKey(address: ActionOperationAddress): string {
    return JSON.stringify([normalizeActionOperationServerId(address.serverId), address.operationId]);
}

export function actionOperationMachineAddressKey(address: ActionOperationMachineAddress): string {
    return JSON.stringify([normalizeActionOperationServerId(address.serverId), address.machineId]);
}

export function actionOperationSessionAddressKey(address: ActionOperationSessionAddress): string {
    return JSON.stringify([normalizeActionOperationServerId(address.serverId), address.sessionId, address.accountId]);
}

export function actionOperationRequestAddressKey(address: ActionOperationRequestAddress): string {
    return JSON.stringify([
        normalizeActionOperationServerId(address.serverId),
        address.accountId,
        address.requestId,
    ]);
}

export function isSameActionOperationAddress(
    left: ActionOperationAddress,
    right: ActionOperationAddress,
): boolean {
    return actionOperationAddressKey(left) === actionOperationAddressKey(right);
}
