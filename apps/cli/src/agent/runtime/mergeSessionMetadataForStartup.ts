import type { Metadata, PermissionMode } from '@/api/types';
import {
    computeMonotonicUpdatedAt,
    readAcpSessionModeIntentFromMetadata,
    readPermissionModeIntentFromMetadata,
    resolveModelSelectionIntentFromSessionMetadata,
} from '@happier-dev/agents';
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
import {
    readSessionMcpSelectionV1FromMetadata,
    buildBackendTargetKeyV2,
    SessionModelSelectionResolutionError,
    type ProviderBoundModelRef,
    type SessionModelSelectionIntentV1,
    type SessionAttachMetadataIdentityPolicy,
} from '@happier-dev/protocol';
import { resolveSessionConfigOptionOverridesFromMetadataSnapshot } from './sessionConfigOptionOverrideSync';
import { resolveBackendTargetFromSessionMetadata } from '@/session/backendTargets/resolveBackendTargetFromSessionMetadata';

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
        const nextAt = overrideAt > baselineAt
            ? overrideAt
            : override.mode === mode
                ? null
                : baselineAt + 1;
        if (nextAt === null) {
            if (!mode) return null;
            return { mode, updatedAt };
        }
        return { mode: override.mode, updatedAt: nextAt };
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

function resolveSessionMcpSelectionForStartup(opts: {
    current: Metadata;
    next: Metadata;
    mode: StartupMergeMode;
}): Record<string, unknown> | null {
    const currentSelection = readSessionMcpSelectionV1FromMetadata(opts.current);
    const nextSelection = readSessionMcpSelectionV1FromMetadata(opts.next);

    if (opts.mode === 'attach') {
        return currentSelection ? { mcpSelectionV1: currentSelection } : null;
    }

    if (currentSelection) return { mcpSelectionV1: currentSelection };
    if (nextSelection) return { mcpSelectionV1: nextSelection };
    return null;
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
    metadataKeysToUnsetOnAttach?: readonly string[] | null;
    attachMetadataIdentityPolicy?: SessionAttachMetadataIdentityPolicy | null;
    mode?: StartupMergeMode;
}): Metadata {
    const mode: StartupMergeMode = opts.mode ?? 'start';
    let merged: Metadata = {
        ...opts.current,
        ...opts.next,
        lifecycleState: 'running',
        lifecycleStateSince: opts.nowMs,
    };

    if (mode === 'attach') {
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

        for (const key of ['workspaceId', 'workspaceLocationId', 'workspaceCheckoutId'] as const) {
            delete (merged as Record<string, unknown>)[key];
        }

        for (const key of opts.metadataKeysToUnsetOnAttach ?? []) {
            if (typeof key !== 'string' || !key.trim()) continue;
            delete (merged as Record<string, unknown>)[key];
        }
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

    const model = resolveModelOverrideForStartup({
        current: opts.current,
        next: opts.next,
        nowMs: opts.nowMs,
        override: opts.modelOverride,
        mode,
    });
    if (model) {
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

    const mcpSelection = resolveSessionMcpSelectionForStartup({
        current: opts.current,
        next: opts.next,
        mode,
    });
    if (mcpSelection) {
        Object.assign(merged, mcpSelection);
    } else if (mode === 'attach') {
        delete (merged as Record<string, unknown>).mcpSelectionV1;
    }

    return merged;
}
