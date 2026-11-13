import { SessionDirectoryIntentV1Schema, type SessionDirectoryIntentV1 } from '@happier-dev/protocol/sessions/creation/sessionDirectoryIntentV1';
import { maxCodeUnits } from '@happier-dev/protocol/strings/maxCodeUnits';
import {
    SessionServerStartSpawnDraftV1Schema,
    type SessionServerStartSpawnDraftV1,
} from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';
import { MAX_AGENT_ROUTING_ID_BYTES } from '@happier-dev/protocol/agents/agentIdV1';
import {
    PLUGIN_UI_LAUNCH_INPUT_MAX_UTF8_BYTES_V1,
    PluginUiSessionCheckoutIntentV1Schema,
    PluginUiSessionPlacementCandidateV1Schema,
    type PluginUiJsonObjectV1,
    type PluginUiSessionCheckoutIntentV1,
    type PluginUiSessionPlacementCandidateV1,
} from '@happier-dev/protocol/plugins/ui';
import { z } from 'zod/mini';
import { z as mini } from 'zod/mini';

import { isPermissionMode, type PermissionMode } from '@/sync/domains/permissions/permissionTypes';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';

const SessionServerStartDraftSeedSchema = z.strictObject({
    existingDraft: mini.optional(SessionServerStartSpawnDraftV1Schema),
    directory: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(4_096))),
    directoryIntent: z.optional(SessionDirectoryIntentV1Schema),
    // Host Agent routing id: qualified `<pluginId>/<localId>` for an installed
    // Agent, so the seed bound is that contract rather than a bare local id.
    agentId: z.optional(z.string().check(z.trim(), z.minLength(1), maxCodeUnits(MAX_AGENT_ROUTING_ID_BYTES))),
    permissionMode: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(64))),
    profileId: z.optional(z.string().check(z.trim(), z.minLength(1))),
    executionTarget: z.optional(z.strictObject({
        serverId: z.string().check(z.trim(), z.minLength(1)),
        machineId: z.string().check(z.trim(), z.minLength(1)),
    })),
    checkoutIntent: mini.optional(PluginUiSessionCheckoutIntentV1Schema),
    candidates: z.optional(z.array(PluginUiSessionPlacementCandidateV1Schema)),
}).check(z.refine(seed => seed.directory === undefined || seed.directoryIntent === undefined, {
    message: 'Directory and directory intent are mutually exclusive', path: ['directoryIntent'],
}));

export type SessionServerStartDraftSeed = Readonly<{
    existingDraft?: SessionServerStartSpawnDraftV1;
    directory?: string;
    directoryIntent?: SessionDirectoryIntentV1;
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

export type SessionServerStartDraftPresentation<Result = unknown> = Readonly<{
    result: Promise<Result | null>;
    /** Closes the transient composer without creating or dispatching a Session. */
    close: () => void;
}>;

export type SessionServerStartDraftComposerOutcome =
    | Readonly<{ kind: 'submitted'; draft: SessionServerStartSpawnDraftV1 }>
    | Readonly<{ kind: 'cancelled' }>
    | Readonly<{ kind: 'invalid'; reason: 'draft_invalid' | 'settlement_invalid' }>
    | Readonly<{ kind: 'unavailable'; reason: 'aborted' | 'draft_too_large' | 'presentation_unavailable' | 'host_unavailable' }>
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

function resolveDraftTarget(target: SessionServerStartDraftTarget): SessionServerStartDraftTarget {
    return { ...target, serverId: resolveServerProfileScopeIdForIdentifier(target.serverId) };
}

function readSeed(draft: PluginUiJsonObjectV1 | undefined): ReadSeed | null {
    const parsed = SessionServerStartDraftSeedSchema.safeParse(draft ?? {});
    if (!parsed.success) return null;

    if (parsed.data.permissionMode !== undefined && !isPermissionMode(parsed.data.permissionMode)) {
        return null;
    }

    // A recipe can retain this device's pre-discovery Home id. Resolve only
    // proven profile aliases, as New Session does, before any target-bound
    // Machine, catalog or Folder reader receives the seed.
    const existingDraft = parsed.data.existingDraft ? {
        ...parsed.data.existingDraft,
        executionTarget: resolveDraftTarget(parsed.data.existingDraft.executionTarget),
    } : undefined;
    const executionTarget = parsed.data.executionTarget ?? existingDraft?.executionTarget;
    return {
        seed: {
            ...(existingDraft ? { existingDraft } : {}),
            ...(parsed.data.directory ? { directory: parsed.data.directory } : {}),
            ...(parsed.data.directoryIntent ? { directoryIntent: parsed.data.directoryIntent } : {}),
            ...(parsed.data.agentId ? { agentId: parsed.data.agentId } : {}),
            ...(parsed.data.permissionMode ? { permissionMode: parsed.data.permissionMode as PermissionMode } : {}),
            ...(parsed.data.profileId ? { profileId: parsed.data.profileId } : {}),
            ...(parsed.data.checkoutIntent ? { checkoutIntent: parsed.data.checkoutIntent } : {}),
            ...(parsed.data.candidates ? { candidates: parsed.data.candidates.map(candidate => ({
                ...candidate, serverId: resolveServerProfileScopeIdForIdentifier(candidate.serverId),
            })) } : {}),
        },
        ...(executionTarget
            ? { executionTarget: resolveDraftTarget(executionTarget) }
            : {}),
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
    target?: SessionServerStartDraftTarget;
    selectPlacement?: (candidates: readonly PluginUiSessionPlacementCandidateV1[]) =>
        | SessionServerStartDraftPresentation<PluginUiSessionPlacementCandidateV1>
        | Promise<SessionServerStartDraftPresentation<PluginUiSessionPlacementCandidateV1>>;
    selectTarget?: () => SessionServerStartDraftPresentation<SessionServerStartDraftTarget>
        | Promise<SessionServerStartDraftPresentation<SessionServerStartDraftTarget>>;
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
    if (params.signal?.aborted) return { kind: 'unavailable', reason: 'aborted' };
    if (!isCurrent(params.isCurrent)) return { kind: 'stale', reason: 'host_retired' };

    let presentation: SessionServerStartDraftPresentation | undefined;
    let aborted = params.signal?.aborted === true;
    const onAbort = () => {
        aborted = true;
        presentation?.close();
    };
    params.signal?.addEventListener('abort', onAbort, { once: true });

    try {
        let target = read.executionTarget ?? (params.target ? resolveDraftTarget(params.target) : undefined);
        const seed = { ...read.seed };
        if (!target) {
            let initialSelection: SessionServerStartDraftPresentation<SessionServerStartDraftTarget | PluginUiSessionPlacementCandidateV1>;
            if (seed.candidates?.length && params.selectPlacement) {
                initialSelection = await params.selectPlacement(seed.candidates);
            } else if (params.selectTarget) {
                initialSelection = await params.selectTarget();
            } else {
                return { kind: 'unavailable', reason: 'host_unavailable' };
            }
            presentation = initialSelection;
            if (aborted) initialSelection.close();
            const selected = await initialSelection.result;
            if (aborted || params.signal?.aborted) return { kind: 'unavailable', reason: 'aborted' };
            if (!isCurrent(params.isCurrent)) {
                initialSelection.close();
                return { kind: 'stale', reason: 'host_retired' };
            }
            if (selected === null) return { kind: 'cancelled' };
            target = { serverId: selected.serverId, machineId: selected.machineId };
            if ('rootPath' in selected) {
                seed.directory = selected.rootPath;
                delete seed.directoryIntent;
            }
        }
        presentation = params.present({ seed, target });
        if (aborted) presentation.close();
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
        const settledTarget = resolveDraftTarget(parsed.data.executionTarget);
        const targetWasOffered = sameTarget(settledTarget, target)
            || read.seed.candidates?.some((candidate) => sameTarget(settledTarget, {
                serverId: candidate.serverId,
                machineId: candidate.machineId,
            })) === true;
        if (!targetWasOffered) {
            return { kind: 'invalid', reason: 'settlement_invalid' };
        }
        const draft = { ...parsed.data, executionTarget: settledTarget };
        if (!isWithinDraftByteLimit(draft)) {
            return { kind: 'unavailable', reason: 'draft_too_large' };
        }
        return { kind: 'submitted', draft };
    } catch {
        if (aborted || params.signal?.aborted) {
            return { kind: 'unavailable', reason: 'aborted' };
        }
        return { kind: 'unavailable', reason: 'presentation_unavailable' };
    } finally {
        params.signal?.removeEventListener('abort', onAbort);
    }
}
