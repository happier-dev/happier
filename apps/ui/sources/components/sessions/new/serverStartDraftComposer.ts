import {
    SessionServerStartSpawnDraftV1Schema,
    type SessionServerStartSpawnDraftV1,
} from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';
import {
    PLUGIN_UI_LAUNCH_INPUT_MAX_UTF8_BYTES_V1,
    PluginUiSessionCheckoutIntentV1Schema,
    PluginUiSessionPlacementCandidateV1Schema,
    type PluginUiJsonObjectV1,
    type PluginUiSessionCheckoutIntentV1,
    type PluginUiSessionPlacementCandidateV1,
} from '@happier-dev/protocol/plugins/ui';
import { z } from 'zod';

import { isPermissionMode, type PermissionMode } from '@/sync/domains/permissions/permissionTypes';

const SessionServerStartDraftSeedSchema = z.object({
    directory: z.string().trim().min(1).max(4_096).optional(),
    agentId: z.string().trim().min(1).max(256).optional(),
    permissionMode: z.string().trim().min(1).max(64).optional(),
    profileId: z.string().trim().min(1).optional(),
    executionTarget: z.object({
        serverId: z.string().trim().min(1),
        machineId: z.string().trim().min(1),
    }).strict().optional(),
    checkoutIntent: PluginUiSessionCheckoutIntentV1Schema.optional(),
    candidates: z.array(PluginUiSessionPlacementCandidateV1Schema).optional(),
}).strict();

export type SessionServerStartDraftSeed = Readonly<{
    directory?: string;
    agentId?: string;
    permissionMode?: PermissionMode;
    profileId?: string;
    checkoutIntent?: PluginUiSessionCheckoutIntentV1;
    candidates?: readonly PluginUiSessionPlacementCandidateV1[];
}>;

/** The complete server-scoped machine target a no-invoke draft may describe. */
export type SessionServerStartDraftTarget = Readonly<{
    serverId: string;
    machineId: string;
}>;

export type SessionServerStartDraftPresentation = Readonly<{
    result: Promise<unknown | null>;
    /** Closes the transient composer without creating or dispatching a Session. */
    close: () => void;
}>;

export type SessionServerStartDraftComposerOutcome =
    | Readonly<{ kind: 'submitted'; draft: SessionServerStartSpawnDraftV1 }>
    | Readonly<{ kind: 'cancelled' }>
    | Readonly<{ kind: 'invalid'; reason: 'draft_invalid' | 'settlement_invalid' }>
    | Readonly<{ kind: 'unavailable'; reason: 'aborted' | 'draft_too_large' | 'presentation_unavailable' }>
    | Readonly<{ kind: 'stale'; reason: 'host_retired' }>;

function isWithinDraftByteLimit(value: unknown): boolean {
    try {
        return new TextEncoder().encode(JSON.stringify(value)).byteLength
            <= PLUGIN_UI_LAUNCH_INPUT_MAX_UTF8_BYTES_V1;
    } catch {
        return false;
    }
}

/**
 * The seed the presentation authors from, and the machine it authors for.
 *
 * They are separated here because they are different kinds of fact: the seed
 * pre-fills fields the reader may change, while the complete server-scoped
 * machine target scopes the Agent catalogue, readiness, and directory picker.
 */
type ReadSeed = Readonly<{
    seed: SessionServerStartDraftSeed;
    executionTarget?: SessionServerStartDraftTarget;
}>;

function readSeed(draft: PluginUiJsonObjectV1 | undefined): ReadSeed | null {
    const parsed = SessionServerStartDraftSeedSchema.safeParse(draft ?? {});
    if (!parsed.success) return null;

    if (parsed.data.permissionMode !== undefined && !isPermissionMode(parsed.data.permissionMode)) {
        return null;
    }

    return {
        seed: {
            ...(parsed.data.directory ? { directory: parsed.data.directory } : {}),
            ...(parsed.data.agentId ? { agentId: parsed.data.agentId } : {}),
            ...(parsed.data.permissionMode ? { permissionMode: parsed.data.permissionMode as PermissionMode } : {}),
            ...(parsed.data.profileId ? { profileId: parsed.data.profileId } : {}),
            ...(parsed.data.checkoutIntent ? { checkoutIntent: parsed.data.checkoutIntent } : {}),
            ...(parsed.data.candidates ? { candidates: parsed.data.candidates } : {}),
        },
        ...(parsed.data.executionTarget ? { executionTarget: parsed.data.executionTarget } : {}),
    };
}

function isCurrent(isCurrent: () => boolean): boolean {
    try {
        return isCurrent();
    } catch {
        return false;
    }
}

function sameTarget(
    left: SessionServerStartDraftTarget,
    right: SessionServerStartDraftTarget,
): boolean {
    return left.serverId === right.serverId && left.machineId === right.machineId;
}

/**
 * Owns the short-lived no-invoke Session authoring lifecycle for the one
 * literal host selector. It accepts only a safe UI seed, returns a strict
 * server-start draft, and deliberately has no creation, persistence, or
 * dispatch dependency.
 */
export async function composeSessionServerStartDraft(params: Readonly<{
    draft?: PluginUiJsonObjectV1;
    signal?: AbortSignal;
    isCurrent: () => boolean;
    target: SessionServerStartDraftTarget;
    present: (params: Readonly<{
        seed: SessionServerStartDraftSeed;
        /**
         * The complete target this composition starts from. The presentation
         * may settle another target only by selecting an admitted candidate.
         */
        target: SessionServerStartDraftTarget;
    }>) => SessionServerStartDraftPresentation;
}>): Promise<SessionServerStartDraftComposerOutcome> {
    if (!isWithinDraftByteLimit(params.draft ?? {})) {
        return { kind: 'invalid', reason: 'draft_invalid' };
    }
    const read = readSeed(params.draft);
    if (!read) return { kind: 'invalid', reason: 'draft_invalid' };
    const target: SessionServerStartDraftTarget = read.executionTarget ?? params.target;
    if (params.signal?.aborted) return { kind: 'unavailable', reason: 'aborted' };
    if (!isCurrent(params.isCurrent)) return { kind: 'stale', reason: 'host_retired' };

    let presentation: SessionServerStartDraftPresentation;
    try {
        presentation = params.present({ seed: read.seed, target });
    } catch {
        return { kind: 'unavailable', reason: 'presentation_unavailable' };
    }

    let aborted = params.signal?.aborted === true;
    const onAbort = () => {
        aborted = true;
        presentation.close();
    };
    params.signal?.addEventListener('abort', onAbort, { once: true });

    try {
        const settled = await presentation.result;
        if (aborted || params.signal?.aborted) {
            return { kind: 'unavailable', reason: 'aborted' };
        }
        if (!isCurrent(params.isCurrent)) {
            presentation.close();
            return { kind: 'stale', reason: 'host_retired' };
        }
        if (settled === null) return { kind: 'cancelled' };

        const parsed = SessionServerStartSpawnDraftV1Schema.safeParse(settled);
        if (!parsed.success) return { kind: 'invalid', reason: 'settlement_invalid' };
        const settledTarget = parsed.data.executionTarget;
        const targetWasOffered = sameTarget(settledTarget, target)
            || read.seed.candidates?.some((candidate) => sameTarget(settledTarget, {
                serverId: candidate.serverId,
                machineId: candidate.machineId,
            })) === true;
        if (!targetWasOffered) {
            return { kind: 'invalid', reason: 'settlement_invalid' };
        }
        if (!isWithinDraftByteLimit(parsed.data)) {
            return { kind: 'unavailable', reason: 'draft_too_large' };
        }
        return { kind: 'submitted', draft: parsed.data };
    } catch {
        if (aborted || params.signal?.aborted) {
            return { kind: 'unavailable', reason: 'aborted' };
        }
        return { kind: 'unavailable', reason: 'presentation_unavailable' };
    } finally {
        params.signal?.removeEventListener('abort', onAbort);
    }
}
