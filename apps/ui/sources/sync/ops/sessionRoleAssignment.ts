import {
    applySessionRoleChangeV1ToMetadata,
    FreshAssignableSessionRoleV1Schema,
    planSessionRoleChangeV1,
    type PendingRequestedActionV1,
    type AssignableSessionRole,
    type AssignableSessionRoleProfileV1,
    type FreshAssignableSessionRoleV1,
    type SessionRoleSetActionResultV1,
} from '@happier-dev/protocol';

import { randomUUID } from '@/platform/randomUUID';
import { listUiAssignableSessionRoleProfiles } from '@/components/sessions/roles/sessionRoleProfileOrder';
import { storage } from '@/sync/domains/state/storage';
import { settingsParse } from '@/sync/domains/settings/settings';
import { createServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { loadAccountSettings, loadPendingAccountSettings } from '@/sync/domains/state/accountSettingsPersistence';
import { resolveServerScopedSessionContext } from '@/sync/runtime/orchestration/serverScopedRpc/resolveServerScopedSessionContext';
import type { Metadata } from '@/sync/domains/state/storageTypes';
import { getSyncSingleton } from '@/sync/runtime/getSyncSingleton';
import { sendSessionMessageWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionSendMessage';

/** Queue behind any in-flight turn so the provider reads it on its next normal turn. */
const ROLE_INSTRUCTION_REQUESTED_ACTION: PendingRequestedActionV1 = { v: 1, kind: 'enqueue' };

/**
 * Account settings of the session's own server/account. The active account uses the live store;
 * any other account uses its canonical per-scope persisted settings plus pending edits. An
 * account this device has never synchronized is unknown (null), never the active account's.
 */
async function resolveTargetAccountSettingsOrNull(serverId: string | null): Promise<unknown | null> {
    try {
        return await resolveTargetAccountSettings(serverId);
    } catch {
        return null;
    }
}

async function resolveTargetAccountSettings(serverId: string | null): Promise<unknown | null> {
    const context = await resolveServerScopedSessionContext({ serverId });
    if (context.scope === 'active') return storage.getState().settings;
    const scope = createServerAccountScope(context.targetServerId, context.targetAccountId);
    if (!scope) return null;
    const persisted = loadAccountSettings(scope);
    if (persisted.version === null) return null;
    const base = persisted.settings && typeof persisted.settings === 'object' ? persisted.settings : {};
    return settingsParse({ ...base, ...loadPendingAccountSettings(scope) });
}

export async function resolveAssignableSessionRoleProfilesForServer(
    serverId: string | null,
): Promise<readonly AssignableSessionRoleProfileV1[] | null> {
    const settings = await resolveTargetAccountSettingsOrNull(serverId);
    return settings === null ? null : listUiAssignableSessionRoleProfiles(settings);
}

/**
 * The single UI resolution of a role into the exact snapshot an assignment retains, from the
 * target session's account. Defaults are read once here; later edits reach a session only by
 * reapplying. Null means the target account's role profiles are unknown on this device.
 */
export async function resolveSessionRoleAssignmentSnapshot(params: Readonly<{
    role: AssignableSessionRole;
    serverId: string | null;
}>): Promise<FreshAssignableSessionRoleV1 | null> {
    const settings = await resolveTargetAccountSettingsOrNull(params.serverId);
    if (settings === null) return null;
    const assignment = planSessionRoleChangeV1({ role: params.role, settings, changeId: randomUUID(), at: Date.now() })?.assignment;
    const parsed = FreshAssignableSessionRoleV1Schema.safeParse(assignment);
    return parsed.success ? parsed.data : null;
}

export type SessionRoleDeliveryResult =
    | Readonly<{ ok: true; instructionLocalId: string }>
    /** Nothing changed: the target account's role profiles are unknown on this device. */
    | Readonly<{ ok: false; stage: 'settings'; error: string }>
    /** Nothing changed: the role was not recorded and no instruction was queued. */
    | Readonly<{ ok: false; stage: 'metadata'; error: string }>
    /** Nothing changed: a resumed change is no longer the current role state. */
    | Readonly<{ ok: false; stage: 'not_current'; error: string }>
    /** The role is recorded but its visible instruction was not queued; retry resends the same message. */
    | Readonly<{
        ok: false;
        stage: 'delivery';
        errorCode: string;
        error: string;
        instruction: Readonly<{ localId: string; message: string }>;
        retry: () => Promise<SessionRoleDeliveryResult>;
    }>;

/**
 * Owner-local abort for the metadata CAS: a resume the protocol owner rejects (`not_current`)
 * changes nothing, and the shared writer would otherwise still emit a same-content update.
 */
class SessionRoleResumeNotCurrent extends Error {}

/**
 * Assign, reassign, reapply, or clear a session role. The role and its exact instruction
 * snapshot are recorded through the canonical metadata CAS writer, then the visible instruction
 * is queued through the canonical pending-outbox path with an id derived from the assignment,
 * so a retry never duplicates it. Permissions, model, control, provenance, and placement are untouched.
 */
export async function setSessionRoleWithDelivery(params: Readonly<{
    sessionId: string;
    role: AssignableSessionRole | null;
    serverId: string | null;
    /** Caller correlation id, recorded on the assignment; identity only for an explicit resume. */
    actionRequestId?: string;
    /** Action resume: resolve this request's retained current change only, never write a new one. */
    resume?: boolean;
}>): Promise<SessionRoleDeliveryResult> {
    const sessionId = String(params.sessionId ?? '').trim();
    if (!sessionId) return { ok: false, stage: 'metadata', error: 'invalid_parameters' };

    const actionRequestId = params.actionRequestId?.trim() || undefined;
    const resume = params.resume === true && Boolean(actionRequestId);
    // Clearing needs no profile; an assignment needs the target account's own profiles; a resume
    // delivers the persisted snapshot and needs none.
    const settings = params.role && !resume ? await resolveTargetAccountSettingsOrNull(params.serverId ?? null) : null;
    if (params.role && !resume && settings === null) {
        return { ok: false, stage: 'settings', error: 'target_account_role_profiles_unavailable' };
    }
    const planned = planSessionRoleChangeV1({
        role: params.role,
        settings,
        changeId: randomUUID(),
        at: Date.now(),
        ...(actionRequestId ? { actionRequestId } : {}),
        ...(resume ? { resumeExistingAssignment: true } : {}),
    });
    if (planned === null) return { ok: false, stage: 'settings', error: 'session_role_profile_not_found' };
    // A resume delivers the snapshot already persisted for its request, never a recomputed one.
    let plan: typeof planned | null = planned;

    try {
        await getSyncSingleton().patchSessionMetadataWithRetry(
            sessionId,
            (metadata: Metadata) => {
                const applied = applySessionRoleChangeV1ToMetadata(metadata ?? {}, planned, { resume, ...(actionRequestId ? { actionRequestId } : {}) });
                plan = applied.plan;
                // Decided against the writer's own current base, before anything is encrypted or emitted.
                if (applied.outcome === 'not_current') throw new SessionRoleResumeNotCurrent();
                return applied.metadata;
            },
            { serverId: params.serverId ?? null },
        );
    } catch (error) {
        if (error instanceof SessionRoleResumeNotCurrent) {
            return { ok: false, stage: 'not_current', error: 'role_change_not_current' };
        }
        return { ok: false, stage: 'metadata', error: error instanceof Error ? error.message : 'metadata_update_failed' };
    }
    if (plan === null) return { ok: false, stage: 'not_current', error: 'role_change_not_current' };
    const delivered = plan;

    const request = {
        sessionId,
        serverId: params.serverId ?? null,
        message: delivered.message,
        localId: delivered.localId,
        requestedAction: ROLE_INSTRUCTION_REQUESTED_ACTION,
    };
    const deliver = async (): Promise<SessionRoleDeliveryResult> => {
        try {
            const sent = await sendSessionMessageWithServerScope(request);
            if (sent.ok) return { ok: true, instructionLocalId: request.localId };
            return { ok: false, stage: 'delivery', errorCode: sent.errorCode, error: sent.error, instruction: { localId: request.localId, message: request.message }, retry: deliver };
        } catch (error) {
            return {
                ok: false,
                stage: 'delivery',
                errorCode: 'delivery_failed',
                error: error instanceof Error ? error.message : 'delivery_failed',
                instruction: { localId: request.localId, message: request.message },
                retry: deliver,
            };
        }
    };
    return await deliver();
}

/** Maps the UI owner's result onto the shared truthful `session.role.set` result. */
export async function setSessionRoleForAction(params: Readonly<{
    sessionId: string;
    role: AssignableSessionRole | null;
    serverId: string | null;
    actionRequestId?: string;
    resume?: boolean;
}>): Promise<SessionRoleSetActionResultV1> {
    const result = await setSessionRoleWithDelivery(params);
    if (result.ok) {
        return { ok: true, sessionId: params.sessionId, role: params.role, action: params.role ? 'assigned' : 'cleared', instructionLocalId: result.instructionLocalId };
    }
    if (result.stage === 'settings') return { ok: false, errorCode: 'role_profiles_unavailable', error: result.error, roleSaved: false };
    if (result.stage === 'metadata') return { ok: false, errorCode: 'role_update_failed', error: result.error, roleSaved: false };
    if (result.stage === 'not_current') return { ok: false, errorCode: 'role_change_not_current', error: result.error, roleSaved: false };
    return {
        ok: false,
        errorCode: 'role_instruction_not_delivered',
        error: result.error,
        roleSaved: true,
        sessionId: params.sessionId,
        role: params.role,
        instruction: result.instruction,
    };
}
