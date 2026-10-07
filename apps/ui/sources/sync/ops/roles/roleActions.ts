import type {
    ActionExecuteResult,
    RoleArtifactV1,
    RoleInstructionsOverrideV1,
    RoleOverrideV1,
} from '@happier-dev/protocol';

import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { getStorage } from '@/sync/domains/state/storageStore';
import { normalizeSessionAddress } from '@/sync/domains/session/sessionAddress';
import { resolveSessionAddressFromLocalState } from '@/sync/domains/session/resolveSessionAddressFromLocalState';

/**
 * Role writes from the product UI. Every write is the canonical Action on the one front door
 * (§3.5): policy, approval and the Artifact CAS belong to the Action host, never to this module.
 */
let execute: ReturnType<typeof createFrontDoorActionExecute> | null = null;

function run(actionId: Parameters<ReturnType<typeof createFrontDoorActionExecute>>[0], input: unknown, serverId?: string): Promise<ActionExecuteResult> {
    execute ??= createFrontDoorActionExecute();
    return execute(actionId, input, { surface: 'ui', ...(serverId ? { serverId } : {}) });
}

export type RoleArtifactRevision = Readonly<{ headerVersion: number; bodyVersion: number }>;
export type SessionRoleActionScope = Readonly<{ serverId?: string | null }>;

function runSession(
    actionId: Parameters<ReturnType<typeof createFrontDoorActionExecute>>[0],
    sessionId: string,
    input: Readonly<Record<string, unknown>>,
    scope?: SessionRoleActionScope,
): Promise<ActionExecuteResult> {
    const address = scope?.serverId === undefined
        ? resolveSessionAddressFromLocalState(getStorage().getState(), sessionId)
        : normalizeSessionAddress(scope.serverId, sessionId);
    if (!address) return Promise.resolve({ ok: false, errorCode: 'invalid_parameters', error: 'Session Home is unavailable or ambiguous' });
    return run(actionId, { ...input, sessionId: address.sessionId }, address.serverId);
}

export const roleActions = {
    setApprovalReviewer: (sessionId: string, enabled: boolean, scope?: SessionRoleActionScope) => runSession('session.approval_reviewer.set', sessionId, { enabled }, scope),
    create: (role: RoleArtifactV1) => run('roles.create', { role }),
    update: (roleId: string, role: RoleArtifactV1, expectedRevision: RoleArtifactRevision) =>
        run('roles.update', { roleId, role, expectedRevision }),
    remove: (roleId: string, expectedRevision: RoleArtifactRevision) => run('roles.delete', { roleId, expectedRevision }),
    setOverride: (override: RoleInstructionsOverrideV1) => run('roles.override.set', override),
    resetOverride: (roleId: string) => run('roles.override.reset', { roleId }),
    setSessionRole: (sessionId: string, roleId: string, scope?: SessionRoleActionScope) => runSession('session.role.set', sessionId, { roleId }, scope),
    setSessionOverride: (sessionId: string, override: RoleOverrideV1, scope?: SessionRoleActionScope) =>
        runSession('session.roles.override.set', sessionId, override, scope),
    clearSessionOverride: (sessionId: string, roleId: string, scope?: SessionRoleActionScope) => runSession('session.roles.override.clear', sessionId, { roleId }, scope),
    addSessionRole: (sessionId: string, roleId: string, role: RoleArtifactV1, scope?: SessionRoleActionScope) =>
        runSession('session.roles.add', sessionId, { roleId, role }, scope),
    removeSessionRole: (sessionId: string, roleId: string, scope?: SessionRoleActionScope) => runSession('session.roles.remove', sessionId, { roleId }, scope),
    setSessionNotes: (sessionId: string, notes: string, scope?: SessionRoleActionScope) => runSession('session.notes.set', sessionId, { notes }, scope),
    applyToReports: (sessionId: string, scope?: SessionRoleActionScope) => runSession('session.roles.apply_to_reports', sessionId, {}, scope),
};
