import type { Metadata, PermissionMode } from '@/api/types';
import { computeMonotonicUpdatedAt } from '@happier-dev/agents/session/timestamps/monotonic';
import {
    readAcpSessionModeIntentFromMetadata,
    readPermissionModeIntentFromMetadata,
    readSessionModelSelectionV2FromMetadata,
    resolveModelSelectionIntentFromSessionMetadata,
} from '@happier-dev/agents/session/state/metadataReaders';
import {
    applyAcpConfigOptionIntentSessionMetadata,
    applyAcpSessionModeIntentSessionMetadata,
    applyModelIntentSessionMetadata,
    applyPermissionModeIntentSessionMetadata,
    clearAcpConfigOptionIntentSessionMetadata,
    clearAcpSessionModeIntentSessionMetadata,
    clearModelIntentSessionMetadata,
    clearPermissionModeIntentSessionMetadata,
} from '@happier-dev/agents/session/state/metadataWriters';
import { readSessionCapabilitySelectionFromMetadataV1, resolveSelectionRestartMarkersForStartupV1, writeSessionCapabilitySelectionToMetadataV1 } from '@happier-dev/protocol/reach/sessionCapabilityMetadataV1';
import type { SessionCapabilitySelectionV1, SessionSkillSelectionV1 } from '@happier-dev/protocol/reach/sessionCapabilitySelectionV1';
import { SessionSkillSelectionV1Schema } from '@happier-dev/protocol/reach/sessionCapabilitySelectionV1';
import { convertStackSkillEntriesV1 } from '@happier-dev/protocol/prompts/library/skills/convertStackSkillEntriesV1';
import type { PromptStackEntryV1 } from '@happier-dev/protocol/prompts/library/promptStacksV1';
import { SessionPromptStackV1StoredSchema, SessionDisabledInheritedEntryIdsV1Schema } from '@happier-dev/protocol/sessions/context/sessionContextV1';
import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { SessionModelSelectionResolutionError } from '@happier-dev/protocol/providers/model-selection';
import type { ProviderBoundModelRef, SessionModelSelectionIntentV1, SessionAttachMetadataIdentityPolicy } from '@happier-dev/protocol';
import { resolveSessionConfigOptionOverridesFromMetadataSnapshot } from './sessionConfigOptionOverrideSync';
import { resolveBackendTargetFromSessionMetadata } from '@/session/backendTargets/resolveBackendTargetFromSessionMetadata';
import { hasSameSessionCheckout } from '@/session/metadata/sessionCheckoutIdentity';

import type { SessionTeamCredentialBindingIntentV1 } from '@happier-dev/protocol/teams/credentials/sessionBindingIntentV1';
import { SessionModelSelectionV2Schema, type SessionModelSelectionV2 } from '@happier-dev/protocol/providers/selection/v2';

/** Initial birth precedes Home's native binding allocation. Fill only that
 * missing representation from the exact accepted source; never replace a
 * changed desired witness or turn a V1 carried prompt into native auth. */
export function restoreAcceptedSessionTeamCredentialModelIntent(
    intent: SessionModelSelectionV2 | null,
    binding: SessionTeamCredentialBindingIntentV1 | null | undefined,
): SessionModelSelectionV2 | null {
    if (intent?.ref.source !== 'team_resource' || intent.ref.deliveryMode !== 'vendor-native' || intent.ref.nativeDelivery
        || binding?.slot.kind !== 'provider_model' || binding.resourceId === null || binding.deliveryMode !== 'vendor-native'
        || !binding.nativeDelivery || !binding.providerModelSelection
        || binding.resourceId !== intent.ref.resourceId || binding.teamId !== intent.ref.teamId
        || binding.expectedResourceRevision !== intent.ref.expectedResourceRevision
        || binding.providerModelSelection.agentTargetKey !== intent.ref.agentTargetKey
        || binding.providerModelSelection.modelId !== intent.ref.modelId
        || binding.providerModelSelection.nativeSource?.sourceRevision !== binding.nativeDelivery.sourceRevision
        || binding.providerModelSelection.nativeSource?.providerTicket !== binding.nativeDelivery.providerTicket) return intent;
    return { ...intent, ref: { ...intent.ref, nativeDelivery: binding.nativeDelivery } };
}

type AcpConfigOptionOverrideUpdate = Readonly<{
    configId: string;
    value: string | number | boolean | null;
    updatedAt: number;
}>;

export type PermissionModeOverride = {
    mode: PermissionMode;
    updatedAt?: number | null;
};

export type StartupMergeMode = 'start' | 'attach';

/** Artifact-authority classification captured by the startup preparation. */
export type SessionStackSkillMigration = Readonly<{
    skillIds: ReadonlySet<string>;
    disabledInheritedEntries?: readonly PromptStackEntryV1[];
}>;

/** The single additive selection calculation serves startup writes and private Run preparation. */
export function resolveSessionStackSkillSelectionForMigration(metadata: unknown, migration: SessionStackSkillMigration):
    Readonly<{ status: 'unchanged' }> | Readonly<{ status: 'updated'; selection: SessionSkillSelectionV1; promptStack: readonly PromptStackEntryV1[] }>
    | Readonly<{ status: 'unavailable' }> {
    const record = metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {};
    const work = Reflect.get(record, 'work');
    const workRecord = work && typeof work === 'object' && !Array.isArray(work) ? work : {};
    const entries = SessionPromptStackV1StoredSchema.safeParse(Reflect.get(workRecord, 'promptStack') ?? []);
    const disabled = SessionDisabledInheritedEntryIdsV1Schema.safeParse(Reflect.get(workRecord, 'disabledInheritedEntryIds') ?? []);
    if (!disabled.success) return { status: 'unavailable' };
    const converted = convertStackSkillEntriesV1(entries.success ? entries.data : [], { kind: 'session' }, {
        skillIds: migration.skillIds, disabledInheritedEntries: migration.disabledInheritedEntries ?? [],
        disabledInheritedEntryIds: disabled.data,
    });
    if (converted.skillIds.length === 0 && converted.excludedSkillIds.length === 0) return { status: 'unchanged' };
    const selection = SessionSkillSelectionV1Schema.safeParse(Reflect.get(record, 'skillSelectionV1') ?? {});
    if (!selection.success) return converted.excludedSkillIds.length > 0
        ? { status: 'unavailable' } : { status: 'unchanged' };
    const excluded = new Set([...selection.data.forceExcludeSkillIds, ...converted.excludedSkillIds]);
    return { status: 'updated', promptStack: converted.remainingEntries, selection: { ...selection.data,
        forceIncludeSkillIds: [...new Set([...selection.data.forceIncludeSkillIds, ...converted.skillIds])]
            .filter(id => !excluded.has(id)), forceExcludeSkillIds: [...excluded] } };
}

function shouldPreserveCurrentIdentityOnAttach(
    policy: SessionAttachMetadataIdentityPolicy | null | undefined,
): boolean {
    return policy !== 'replace_with_runtime_identity';
}

function readAcpConfigOptionUpdates(metadata: Metadata): AcpConfigOptionOverrideUpdate[] {
    return resolveSessionConfigOptionOverridesFromMetadataSnapshot({ metadata }).map((update) => ({
        configId: update.configId,
        value: update.valueId,
        updatedAt: update.updatedAt,
    }));
}

function replayAcpConfigOptionUpdates(
    metadata: Metadata,
    updates: readonly AcpConfigOptionOverrideUpdate[],
): Metadata {
    let nextMetadata = clearAcpConfigOptionIntentSessionMetadata(metadata) as Metadata;
    for (const update of updates) {
        nextMetadata = applyAcpConfigOptionIntentSessionMetadata(nextMetadata, {
            v: 1,
            configId: update.configId,
            value: update.value,
            updatedAt: update.updatedAt,
        }) as Metadata;
    }
    return nextMetadata;
}

function resolvePermissionModeForStartup(opts: {
    current: Metadata;
    next: Metadata;
    nowMs: number;
    override?: PermissionModeOverride | null;
    mode: StartupMergeMode;
}): { mode: PermissionMode; updatedAt: number | null } | null {
    const currentIntent = readPermissionModeIntentFromMetadata(opts.current);
    const currentMode = currentIntent?.permissionMode as PermissionMode | undefined;
    const currentAt = typeof opts.current.permissionModeUpdatedAt === 'number' ? currentIntent?.updatedAt ?? null : null;

    const nextIntent = readPermissionModeIntentFromMetadata(opts.next);
    const nextMode = nextIntent?.permissionMode as PermissionMode | undefined;
    const nextAt = typeof opts.next.permissionModeUpdatedAt === 'number' ? nextIntent?.updatedAt ?? null : null;

    let mode: PermissionMode | null = null;
    let updatedAt: number | null = null;

    if (opts.mode === 'attach') {
        // Attach safety:
        // - Never seed permissionMode from "next" metadata (derived from local process defaults).
        // - Never stamp permissionModeUpdatedAt if it is missing (avoid clobbering message-derived precedence).
        if (currentMode) {
            mode = currentMode;
            updatedAt = currentAt;
        }
    } else {
        if (currentMode) {
            mode = currentMode;
            updatedAt = currentAt;
        } else if (nextMode) {
            mode = nextMode;
            updatedAt = nextAt;
        }
    }

    const override = opts.override;
    if (override) {
        const overrideAt = typeof override.updatedAt === 'number' ? override.updatedAt : opts.nowMs;
        const baselineAt = updatedAt ?? 0;
        // A startup/recovery seed is an existing intent, not a new person edit.
        // Never promote its stale timestamp over a choice made while it starts.
        if (mode && overrideAt <= baselineAt) {
            return { mode, updatedAt };
        }
        return { mode: override.mode, updatedAt: overrideAt };
    }

    if (!mode) return null;

    if (updatedAt === null && opts.mode === 'start') {
        updatedAt = opts.nowMs;
    }

    return { mode, updatedAt };
}

export type SessionModeOverride = {
    modeId: string | null;
    updatedAt?: number | null;
};

export type ModelOverride = SessionModelSelectionIntentV1;

function resolveSessionCapabilitySelectionForStartup(opts: {
    current: Metadata;
    next: Metadata;
    mode: StartupMergeMode;
}): Record<string, unknown> | null {
    const current = readSessionCapabilitySelectionFromMetadataV1(opts.current);
    const next = readSessionCapabilitySelectionFromMetadataV1(opts.next);
    const result: Record<string, unknown> = {};
    for (const [kind, key] of [['mcp', 'mcpSelectionV1'], ['skills', 'skillSelectionV1']] as const) {
        if (opts.current[key] !== undefined) result[key] = current[kind];
        else if (opts.mode === 'start' && opts.next[key] !== undefined) result[key] = next[kind];
    }
    return Object.keys(result).length > 0 ? result : null;
}

function resolveSessionModeOverrideForStartup(opts: {
    current: Metadata;
    next: Metadata;
    nowMs: number;
    override?: SessionModeOverride | null;
    mode: StartupMergeMode;
}): { modeId: string | null; updatedAt: number } | null {
    const currentOverride = readAcpSessionModeIntentFromMetadata(opts.current);
    const nextOverride = readAcpSessionModeIntentFromMetadata(opts.next);

    let modeId: string | null = null;
    let updatedAt: number | null = null;

    if (opts.mode === 'attach') {
        // Attach safety:
        // - Never seed override from "next" metadata (derived from local process defaults).
        if (currentOverride) {
            modeId = currentOverride.modeId;
            updatedAt = currentOverride.updatedAt;
        }
    } else {
        if (currentOverride) {
            modeId = currentOverride.modeId;
            updatedAt = currentOverride.updatedAt;
        } else if (nextOverride) {
            modeId = nextOverride.modeId;
            updatedAt = nextOverride.updatedAt;
        }
    }

    const override = opts.override;
    if (override) {
        const normalized = typeof override.modeId === 'string' ? override.modeId.trim() : '';
        if (normalized) {
            const baselineAt = updatedAt ?? 0;
            const overrideAt = typeof override.updatedAt === 'number' ? override.updatedAt : opts.nowMs;
            const nextAt = computeMonotonicUpdatedAt({
                previousUpdatedAt: baselineAt,
                desiredUpdatedAt: overrideAt,
                previousValue: modeId ?? '',
                desiredValue: normalized,
                policy: 'force_update',
            });
            if (nextAt === null) {
                if (!modeId) return null;
                if (updatedAt === null && opts.mode === 'start') {
                    return { modeId, updatedAt: opts.nowMs };
                }
                if (typeof updatedAt === 'number') {
                    return { modeId, updatedAt };
                }
                return null;
            }
            return { modeId: normalized, updatedAt: nextAt };
        } else if (override.modeId === null) {
            const baselineAt = updatedAt ?? 0;
            const overrideAt = typeof override.updatedAt === 'number' ? override.updatedAt : opts.nowMs;
            const nextAt = computeMonotonicUpdatedAt({
                previousUpdatedAt: baselineAt,
                desiredUpdatedAt: overrideAt,
                previousValue: modeId ?? '',
                desiredValue: '',
                policy: 'force_update',
            });
            if (nextAt === null) {
                if (typeof updatedAt === 'number') return { modeId, updatedAt };
                return null;
            }
            return { modeId: null, updatedAt: nextAt };
        }
    }

    if (modeId === null) {
        return typeof updatedAt === 'number' ? { modeId, updatedAt } : null;
    }

    if (!modeId) return null;

    if (updatedAt === null && opts.mode === 'start') {
        return { modeId, updatedAt: opts.nowMs };
    }

    if (typeof updatedAt === 'number') {
        return { modeId, updatedAt };
    }
    return null;
}

function resolveModelAgentTargetKey(opts: Readonly<{
    current: Metadata;
    next: Metadata;
    override?: ModelOverride | null;
}>): string {
    const overrideTarget = opts.override?.selection?.agentTargetKey;
    if (overrideTarget) return overrideTarget;
    const currentTarget = resolveBackendTargetFromSessionMetadata(opts.current);
    if (currentTarget) return buildBackendTargetKeyV2(currentTarget);
    const nextTarget = resolveBackendTargetFromSessionMetadata(opts.next);
    if (nextTarget) return buildBackendTargetKeyV2(nextTarget);
    throw new SessionModelSelectionResolutionError('model_selection_agent_target_unknown');
}

function resolveModelOverrideForStartup(opts: {
    current: Metadata;
    next: Metadata;
    nowMs: number;
    override?: ModelOverride | null;
    mode: StartupMergeMode;
}): SessionModelSelectionIntentV1 | null {
    const hasModelIntent = (metadata: Metadata): boolean => Object.prototype.hasOwnProperty.call(metadata, 'modelSelectionIntentV1')
        || Object.prototype.hasOwnProperty.call(metadata, 'modelOverrideV1');
    if (!opts.override && !hasModelIntent(opts.current) && !hasModelIntent(opts.next)) return null;

    const agentTargetKey = resolveModelAgentTargetKey(opts);
    const currentOverride = resolveModelSelectionIntentFromSessionMetadata(opts.current, agentTargetKey);
    const nextOverride = resolveModelSelectionIntentFromSessionMetadata(opts.next, agentTargetKey);

    let selection: ProviderBoundModelRef | null = null;
    let updatedAt: number | null = null;

    if (opts.mode === 'attach') {
        // Attach safety:
        // - Never seed override from "next" metadata (derived from local process defaults).
        if (currentOverride) {
            selection = currentOverride.selection;
            updatedAt = currentOverride.updatedAt;
        }
    } else {
        if (currentOverride) {
            selection = currentOverride.selection;
            updatedAt = currentOverride.updatedAt;
        } else if (nextOverride) {
            selection = nextOverride.selection;
            updatedAt = nextOverride.updatedAt;
        }
    }

    const override = opts.override;
    if (override) {
        if (override.selection && override.selection.agentTargetKey !== agentTargetKey) {
            throw new SessionModelSelectionResolutionError('model_selection_agent_target_mismatch');
        }
        const baselineAt = updatedAt ?? 0;
        const nextAt = computeMonotonicUpdatedAt({
            previousUpdatedAt: baselineAt,
            desiredUpdatedAt: override.updatedAt,
            previousValue: JSON.stringify(selection),
            desiredValue: JSON.stringify(override.selection),
            policy: 'force_update',
        });
        if (nextAt === null) {
            return typeof updatedAt === 'number' ? { v: 1, selection, updatedAt } : null;
        }
        return { v: 1, selection: override.selection, updatedAt: nextAt };
    }

    if (updatedAt === null && opts.mode === 'start') {
        return { v: 1, selection, updatedAt: opts.nowMs };
    }

    if (typeof updatedAt === 'number') {
        return { v: 1, selection, updatedAt };
    }
    return null;
}

/**
 * Merge session metadata at process startup (new session or resume attach).
 *
 * Key invariants:
 * - permissionMode is preserved unless an explicit override is provided.
 * - lifecycleState is set to running.
 */
export function mergeSessionMetadataForStartup(opts: {
    current: Metadata;
    next: Metadata;
    nowMs: number;
    permissionModeOverride?: PermissionModeOverride | null;
    sessionModeOverride?: SessionModeOverride | null;
    modelOverride?: ModelOverride | null;
    capturedTeamCredentialBinding?: SessionTeamCredentialBindingIntentV1 | null;
    acceptedTeamCredentialBinding?: SessionTeamCredentialBindingIntentV1 | null;
    metadataKeysToUnsetOnAttach?: readonly string[] | null;
    attachMetadataIdentityPolicy?: SessionAttachMetadataIdentityPolicy | null;
    appliedCapabilitySelection?: SessionCapabilitySelectionV1 | 'preserved_process';
    stackSkillMigration?: SessionStackSkillMigration;
    mode?: StartupMergeMode;
}): Metadata {
    const mode: StartupMergeMode = opts.mode ?? 'start';
    let merged: { -readonly [K in keyof Metadata]: Metadata[K] } = {
        ...opts.current,
        ...opts.next,
        // A runtime choice accepted by this Session is not a fresh process
        // default or a workspace identity. Resume/rejoin must keep it even
        // when the runtime moves to another machine/directory.
        ...(opts.current.runtimeDescriptorV1 !== undefined
            ? { runtimeDescriptorV1: opts.current.runtimeDescriptorV1 }
            : {}),
        lifecycleState: 'running',
        lifecycleStateSince: opts.nowMs,
    };
    // Plain-runner absence belongs to the stopped process. A newly admitted
    // runner must not inherit it and appear permanently absent after disconnect.
    if (opts.next.terminal === undefined && typeof opts.next.hostPid === 'number'
        && (opts.current.hostPid !== opts.next.hostPid
            || opts.current.hostProcessStartTimeMs !== opts.next.hostProcessStartTimeMs)
        && opts.current.terminal?.mode === 'plain'
        && opts.current.terminal.controlServiceabilityV1?.retired === true
        && opts.current.terminal.controlServiceabilityV1.attachmentId === undefined) {
        delete merged.terminal;
    }

    if (mode === 'attach') {
        const preserveCurrentCheckout = shouldPreserveCurrentIdentityOnAttach(opts.attachMetadataIdentityPolicy)
            || hasSameSessionCheckout(opts.current, opts.next);
        // A fresh committed birth also uses replacement policy. Keep its actual observation
        // when the physical checkout is unchanged; process defaults are never an observation.
        if (preserveCurrentCheckout && opts.current.branch !== undefined) merged.branch = opts.current.branch;
        else delete merged.branch;
        // Tool policy belongs to the retained Session, never runner defaults.
        for (const key of ['allowedTools', 'unlistedTools', 'workspaceWrites'] as const) {
            if (opts.current[key] === undefined) delete merged[key];
            else Object.assign(merged, { [key]: opts.current[key] });
        }
        // Process startup titles are birth seeds, not display-title mutations.
        // Keep the stored value and stamp, including an empty or removed title.
        if (opts.current.summary !== undefined) {
            merged.summary = opts.current.summary;
        } else {
            delete merged.summary;
        }

        // When attaching to an existing session, preserve machine/workspace identity fields from the
        // already-persisted metadata. The "next" metadata is derived from the currently-running CLI
        // process (often in a different working directory), and should not overwrite the session's
        // canonical workspace and host info.
        if (shouldPreserveCurrentIdentityOnAttach(opts.attachMetadataIdentityPolicy)) {
            const stableKeys: Array<keyof Metadata> = [
                'path',
                'host',
                'homeDir',
                'happyHomeDir',
                'happyLibDir',
                'happyToolsDir',
                'machineId',
                'os',
                'version',
                'profileId',
                'flavor',
            ];
            for (const key of stableKeys) {
                const value = opts.current[key];
                if (value !== undefined && value !== null) {
                (merged as Record<string, unknown>)[key] = value;
                }
            }
        }

        // Accepted checkout identity belongs to the retained Session. Process
        // defaults cannot replace it; a physical identity replacement must be
        // accepted again by the workspace registration owner.
        for (const key of ['workspaceId', 'projectId'] as const) {
            const value = opts.current[key];
            if (preserveCurrentCheckout && value !== undefined) {
                Object.assign(merged, { [key]: value });
            } else delete (merged as Record<string, unknown>)[key];
        }
        for (const key of ['workspaceLocationId', 'workspaceCheckoutId'] as const) {
            delete (merged as Record<string, unknown>)[key];
        }

        for (const key of opts.metadataKeysToUnsetOnAttach ?? []) {
            if (typeof key !== 'string' || !key.trim()) continue;
            delete (merged as Record<string, unknown>)[key];
        }

        // Host-owned retained choices are not fresh runtime defaults, even
        // when the process is replacing the physical workspace identity.
        if (opts.current.work !== undefined) merged.work = opts.current.work;
        else delete merged.work;
        const { bot: _bot, createdAsBot: _createdAsBot, ...retainedMetadata } = merged;
        merged = {
            ...retainedMetadata,
            ...(opts.current.bot !== undefined ? { bot: opts.current.bot } : {}),
            ...(opts.current.createdAsBot !== undefined ? { createdAsBot: opts.current.createdAsBot } : {}),
        };
    }

    const perm = resolvePermissionModeForStartup({
        current: opts.current,
        next: opts.next,
        nowMs: opts.nowMs,
        override: opts.permissionModeOverride,
        mode,
    });
    if (perm) {
        const permissionBase = clearPermissionModeIntentSessionMetadata(merged);
        merged = applyPermissionModeIntentSessionMetadata(permissionBase, {
            v: 1,
            permissionMode: perm.mode,
            updatedAt: perm.updatedAt,
        }) as Metadata;
    } else if (mode === 'attach') {
        // Attach safety: explicitly remove any next-derived permissionMode fields.
        merged = clearPermissionModeIntentSessionMetadata(merged) as Metadata;
    }

    const sessionMode = resolveSessionModeOverrideForStartup({
        current: opts.current,
        next: opts.next,
        nowMs: opts.nowMs,
        override: opts.sessionModeOverride,
        mode,
    });
    if (sessionMode) {
        const sessionModeBase = clearAcpSessionModeIntentSessionMetadata(merged);
        merged = applyAcpSessionModeIntentSessionMetadata(sessionModeBase, {
            v: 1,
            modeId: sessionMode.modeId,
            updatedAt: sessionMode.updatedAt,
        }) as Metadata;
    } else if (mode === 'attach') {
        // Attach safety: explicitly remove any next-derived override fields.
        merged = clearAcpSessionModeIntentSessionMetadata(merged) as Metadata;
    }

    const retainedModelV2 = restoreAcceptedSessionTeamCredentialModelIntent(
        readSessionModelSelectionV2FromMetadata(opts.current), opts.acceptedTeamCredentialBinding);
    const capturedModel = opts.modelOverride;
    const capturedBinding = opts.capturedTeamCredentialBinding;
    const acceptedBinding = opts.acceptedTeamCredentialBinding;
    const currentModel = capturedModel?.selection
        ? resolveModelSelectionIntentFromSessionMetadata(opts.current, capturedModel.selection.agentTargetKey) : null;
    // A legacy launch carrier cannot name its Team source. Qualify only the
    // exact captured birth intent while its accepted Home source is unchanged
    // on this CAS attempt. Revision is refreshable policy input, not source identity.
    // A newer native choice or cleared/replaced source stays V1.
    const capturedTeamModel = !retainedModelV2 && capturedModel?.selection?.providerConnectionId === null
        && currentModel?.updatedAt === capturedModel.updatedAt
        && JSON.stringify(currentModel.selection) === JSON.stringify(capturedModel.selection)
        && capturedBinding?.slot.kind === 'provider_model' && capturedBinding.resourceId !== null
        && capturedBinding.teamId && acceptedBinding?.slot.kind === 'provider_model' && acceptedBinding.resourceId !== null
        && acceptedBinding.resourceId === capturedBinding.resourceId && acceptedBinding.teamId === capturedBinding.teamId
        && acceptedBinding.deliveryMode === capturedBinding.deliveryMode
        ? SessionModelSelectionV2Schema.parse({ v: 2, updatedAt: capturedModel.updatedAt, ref: {
            source: 'team_resource', resourceId: acceptedBinding.resourceId, teamId: capturedBinding.teamId,
            expectedResourceRevision: acceptedBinding.expectedResourceRevision, deliveryMode: acceptedBinding.deliveryMode,
            agentTargetKey: capturedModel.selection.agentTargetKey, modelId: capturedModel.selection.modelId,
            ...(acceptedBinding.nativeDelivery ? { nativeDelivery: acceptedBinding.nativeDelivery } : {}),
        } }) : null;
    // Attach replays process configuration. Only the model-selection owner
    // can replace a retained Team route; defaults or carried V1 timestamps
    // cannot express an explicit source change.
    const preserveModelV2 = retainedModelV2 && ((mode === 'attach' && retainedModelV2.ref.source === 'team_resource') || !capturedModel || (
        capturedModel.updatedAt <= retainedModelV2.updatedAt
        && capturedModel.selection?.agentTargetKey === retainedModelV2.ref.agentTargetKey
        && capturedModel.selection.modelId === retainedModelV2.ref.modelId
        && capturedModel.selection.providerConnectionId === (retainedModelV2.ref.source === 'account_provider_connection'
            ? retainedModelV2.ref.providerConnectionId : null)
    ));
    const model = preserveModelV2 || capturedTeamModel ? null : resolveModelOverrideForStartup({
            current: opts.current,
            next: opts.next,
            nowMs: opts.nowMs,
            override: opts.modelOverride,
            mode,
        });
    if (capturedTeamModel) {
        // Representation normalization is not a newer person-authored choice.
        merged = { ...clearModelIntentSessionMetadata(merged), modelSelectionIntentV2: capturedTeamModel } as Metadata;
    } else if (preserveModelV2) {
        merged = { ...clearModelIntentSessionMetadata(merged), modelSelectionIntentV2: retainedModelV2 } as Metadata;
    } else if (model) {
        merged = applyModelIntentSessionMetadata(clearModelIntentSessionMetadata(merged), {
            v: 1,
            selection: model.selection,
            updatedAt: model.updatedAt,
        }) as Metadata;
    } else if (mode === 'attach') {
        // Attach safety: explicitly remove any next-derived override fields.
        merged = clearModelIntentSessionMetadata(merged) as Metadata;
    }

    const acpConfigOptionUpdates = [
        ...readAcpConfigOptionUpdates(opts.current),
        ...(mode === 'attach' ? [] : readAcpConfigOptionUpdates(opts.next)),
    ];
    if (acpConfigOptionUpdates.length > 0) {
        merged = replayAcpConfigOptionUpdates(merged, acpConfigOptionUpdates);
    } else if (mode === 'attach') {
        // Attach safety: explicitly remove any next-derived config option overrides.
        merged = clearAcpConfigOptionIntentSessionMetadata(merged) as Metadata;
    }

    const capabilitySelection = resolveSessionCapabilitySelectionForStartup({
        current: opts.current,
        next: opts.next,
        mode,
    });
    if (mode === 'attach') {
        for (const key of ['mcpSelectionV1', 'skillSelectionV1', 'mcpSelectionRestartRequiredV1', 'skillSelectionRestartRequiredV1'] as const) {
            delete (merged as Record<string, unknown>)[key];
            if (opts.current[key] !== undefined) Object.assign(merged, { [key]: opts.current[key] });
        }
    }
    if (capabilitySelection) Object.assign(merged, capabilitySelection);
    if (opts.stackSkillMigration && merged.work) {
        const currentSelection: unknown = Reflect.get(opts.current, 'skillSelectionV1');
        const selectionSource = currentSelection !== undefined ? currentSelection
            : mode === 'start' ? Reflect.get(opts.next, 'skillSelectionV1') : undefined;
        const selection = resolveSessionStackSkillSelectionForMigration({ work: merged.work, skillSelectionV1: selectionSource },
            opts.stackSkillMigration);
        // Malformed desired selection cannot authorize a migration write.
        if (selection.status === 'updated') {
            merged = { ...merged, work: { ...merged.work, promptStack: [...selection.promptStack] } };
            merged = writeSessionCapabilitySelectionToMetadataV1(merged, { skills: selection.selection }, {
                sessionActive: opts.appliedCapabilitySelection === 'preserved_process'
                    || mode === 'attach' && opts.appliedCapabilitySelection === undefined,
            });
        }
    }
    merged = resolveSelectionRestartMarkersForStartupV1({ current: merged,
        applied: opts.appliedCapabilitySelection ?? (mode === 'attach' ? 'preserved_process'
            : readSessionCapabilitySelectionFromMetadataV1(merged)),
    });

    return merged;
}
