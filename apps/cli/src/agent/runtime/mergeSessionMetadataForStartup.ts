import type { Metadata, PermissionMode } from '@/api/types';
import { computeMonotonicUpdatedAt } from '@happier-dev/agents';
import { buildAcpSessionModeOverrideV1, buildModelOverrideV1 } from '@happier-dev/protocol';

export type PermissionModeOverride = {
    mode: PermissionMode;
    updatedAt?: number | null;
};

export type StartupMergeMode = 'start' | 'attach';

function resolvePermissionModeForStartup(opts: {
    current: Metadata;
    next: Metadata;
    nowMs: number;
    override?: PermissionModeOverride | null;
    mode: StartupMergeMode;
}): { mode: PermissionMode; updatedAt: number | null } | null {
    const currentMode = opts.current.permissionMode;
    const currentAt = typeof opts.current.permissionModeUpdatedAt === 'number' ? opts.current.permissionModeUpdatedAt : null;

    const nextMode = opts.next.permissionMode;
    const nextAt = typeof opts.next.permissionModeUpdatedAt === 'number' ? opts.next.permissionModeUpdatedAt : null;

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
        const nextAt = computeMonotonicUpdatedAt({
            previousUpdatedAt: baselineAt,
            desiredUpdatedAt: overrideAt,
            previousValue: mode ?? '',
            desiredValue: override.mode,
            policy: 'force_update',
        });
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

export type AcpSessionModeOverride = {
    modeId: string;
    updatedAt?: number | null;
};

export type ModelOverride = {
    modelId: string;
    updatedAt?: number | null;
};

function resolveAcpSessionModeOverrideForStartup(opts: {
    current: Metadata;
    next: Metadata;
    nowMs: number;
    override?: AcpSessionModeOverride | null;
    mode: StartupMergeMode;
}): { modeId: string; updatedAt: number } | null {
    const currentOverride = (opts.current as any).acpSessionModeOverrideV1 as
        | { v: 1; updatedAt: number; modeId: string }
        | undefined;
    const nextOverride = (opts.next as any).acpSessionModeOverrideV1 as
        | { v: 1; updatedAt: number; modeId: string }
        | undefined;

    let modeId: string | null = null;
    let updatedAt: number | null = null;

    if (opts.mode === 'attach') {
        // Attach safety:
        // - Never seed override from "next" metadata (derived from local process defaults).
        if (currentOverride?.modeId) {
            modeId = currentOverride.modeId;
            updatedAt = typeof currentOverride.updatedAt === 'number' ? currentOverride.updatedAt : null;
        }
    } else {
        if (currentOverride?.modeId) {
            modeId = currentOverride.modeId;
            updatedAt = typeof currentOverride.updatedAt === 'number' ? currentOverride.updatedAt : null;
        } else if (nextOverride?.modeId) {
            modeId = nextOverride.modeId;
            updatedAt = typeof nextOverride.updatedAt === 'number' ? nextOverride.updatedAt : null;
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
        }
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

function resolveModelOverrideForStartup(opts: {
    current: Metadata;
    next: Metadata;
    nowMs: number;
    override?: ModelOverride | null;
    mode: StartupMergeMode;
}): { modelId: string; updatedAt: number } | null {
    const currentOverride = (opts.current as any).modelOverrideV1 as
        | { v: 1; updatedAt: number; modelId: string }
        | undefined;
    const nextOverride = (opts.next as any).modelOverrideV1 as
        | { v: 1; updatedAt: number; modelId: string }
        | undefined;

    let modelId: string | null = null;
    let updatedAt: number | null = null;

    if (opts.mode === 'attach') {
        // Attach safety:
        // - Never seed override from "next" metadata (derived from local process defaults).
        if (currentOverride?.modelId) {
            modelId = currentOverride.modelId;
            updatedAt = typeof currentOverride.updatedAt === 'number' ? currentOverride.updatedAt : null;
        }
    } else {
        if (currentOverride?.modelId) {
            modelId = currentOverride.modelId;
            updatedAt = typeof currentOverride.updatedAt === 'number' ? currentOverride.updatedAt : null;
        } else if (nextOverride?.modelId) {
            modelId = nextOverride.modelId;
            updatedAt = typeof nextOverride.updatedAt === 'number' ? nextOverride.updatedAt : null;
        }
    }

    const override = opts.override;
    if (override) {
        const normalized = typeof override.modelId === 'string' ? override.modelId.trim() : '';
        if (normalized) {
            const baselineAt = updatedAt ?? 0;
            const overrideAt = typeof override.updatedAt === 'number' ? override.updatedAt : opts.nowMs;
            const nextAt = computeMonotonicUpdatedAt({
                previousUpdatedAt: baselineAt,
                desiredUpdatedAt: overrideAt,
                previousValue: modelId ?? '',
                desiredValue: normalized,
                policy: 'force_update',
            });
            if (nextAt === null) {
                if (!modelId) return null;
                if (updatedAt === null && opts.mode === 'start') {
                    return { modelId, updatedAt: opts.nowMs };
                }
                if (typeof updatedAt === 'number') {
                    return { modelId, updatedAt };
                }
                return null;
            }
            return { modelId: normalized, updatedAt: nextAt };
        }
    }

    if (!modelId) return null;

    if (updatedAt === null && opts.mode === 'start') {
        return { modelId, updatedAt: opts.nowMs };
    }

    if (typeof updatedAt === 'number') {
        return { modelId, updatedAt };
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
    acpSessionModeOverride?: AcpSessionModeOverride | null;
    modelOverride?: ModelOverride | null;
    mode?: StartupMergeMode;
}): Metadata {
    const mode: StartupMergeMode = opts.mode ?? 'start';
    const merged: Metadata = {
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
                (merged as any)[key] = value;
            }
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
        merged.permissionMode = perm.mode;
        if (typeof perm.updatedAt === 'number') {
            merged.permissionModeUpdatedAt = perm.updatedAt;
        } else {
            delete (merged as any).permissionModeUpdatedAt;
        }
    } else if (mode === 'attach') {
        // Attach safety: explicitly remove any next-derived permissionMode fields.
        delete (merged as any).permissionMode;
        delete (merged as any).permissionModeUpdatedAt;
    }

    const acpMode = resolveAcpSessionModeOverrideForStartup({
        current: opts.current,
        next: opts.next,
        nowMs: opts.nowMs,
        override: opts.acpSessionModeOverride,
        mode,
    });
    if (acpMode) {
        (merged as any).acpSessionModeOverrideV1 = buildAcpSessionModeOverrideV1({ updatedAt: acpMode.updatedAt, modeId: acpMode.modeId });
    } else if (mode === 'attach') {
        // Attach safety: explicitly remove any next-derived override fields.
        delete (merged as any).acpSessionModeOverrideV1;
    }

    const model = resolveModelOverrideForStartup({
        current: opts.current,
        next: opts.next,
        nowMs: opts.nowMs,
        override: opts.modelOverride,
        mode,
    });
    if (model) {
        (merged as any).modelOverrideV1 = buildModelOverrideV1({ updatedAt: model.updatedAt, modelId: model.modelId });
    } else if (mode === 'attach') {
        // Attach safety: explicitly remove any next-derived override fields.
        delete (merged as any).modelOverrideV1;
    }

    return merged;
}
