import type { Metadata, PermissionMode } from '@/api/types';
import {
    clearSessionStateFieldFromMetadata,
    computeMonotonicUpdatedAt,
    readAcpSessionModeIntentFromMetadata,
    readModelIntentFromMetadata,
    readPermissionModeIntentFromMetadata,
} from '@happier-dev/agents';
import { applySessionStateFieldMetadataPatch } from '@happier-dev/agents/session/state/metadataPatch';
import {
    readSessionMcpSelectionV1FromMetadata,
    AcpConfigOptionOverridesV1Schema,
    type SessionAttachMetadataIdentityPolicy,
} from '@happier-dev/protocol';

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
    const record = metadata as Record<string, unknown>;
    const roots = [
        AcpConfigOptionOverridesV1Schema.safeParse(record.sessionConfigOptionOverridesV1),
        AcpConfigOptionOverridesV1Schema.safeParse(record.acpConfigOptionOverridesV1),
    ].filter((parsed) => parsed.success);

    const updatesByConfigId = new Map<string, AcpConfigOptionOverrideUpdate>();
    for (const root of roots) {
        if (!root.success) continue;
        for (const [configId, entry] of Object.entries(root.data.overrides)) {
            const normalizedConfigId = configId.trim();
            if (!normalizedConfigId) continue;
            const current = updatesByConfigId.get(normalizedConfigId);
            if (current && entry.updatedAt < current.updatedAt) continue;
            updatesByConfigId.set(normalizedConfigId, {
            configId: normalizedConfigId,
            value: entry.value,
            updatedAt: entry.updatedAt,
            });
        }
    }
    return Array.from(updatesByConfigId.values());
}

function replayAcpConfigOptionUpdates(
    metadata: Metadata,
    updates: readonly AcpConfigOptionOverrideUpdate[],
): Metadata {
    let nextMetadata = clearSessionStateFieldFromMetadata(metadata, 'intent.acpConfigOption') as Metadata;
    for (const update of updates) {
        nextMetadata = applySessionStateFieldMetadataPatch(nextMetadata, 'intent.acpConfigOption', {
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

export type ModelOverride = {
    modelId: string | null;
    updatedAt?: number | null;
};

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

function resolveModelOverrideForStartup(opts: {
    current: Metadata;
    next: Metadata;
    nowMs: number;
    override?: ModelOverride | null;
    mode: StartupMergeMode;
}): { modelId: string | null; updatedAt: number } | null {
    const currentOverride = readModelIntentFromMetadata(opts.current);
    const nextOverride = readModelIntentFromMetadata(opts.next);

    let modelId: string | null = null;
    let updatedAt: number | null = null;

    if (opts.mode === 'attach') {
        // Attach safety:
        // - Never seed override from "next" metadata (derived from local process defaults).
        if (currentOverride) {
            modelId = currentOverride.modelId;
            updatedAt = currentOverride.updatedAt;
        }
    } else {
        if (currentOverride) {
            modelId = currentOverride.modelId;
            updatedAt = currentOverride.updatedAt;
        } else if (nextOverride) {
            modelId = nextOverride.modelId;
            updatedAt = nextOverride.updatedAt;
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
        } else if (override.modelId === null) {
            const baselineAt = updatedAt ?? 0;
            const overrideAt = typeof override.updatedAt === 'number' ? override.updatedAt : opts.nowMs;
            const nextAt = computeMonotonicUpdatedAt({
                previousUpdatedAt: baselineAt,
                desiredUpdatedAt: overrideAt,
                previousValue: modelId ?? '',
                desiredValue: '',
                policy: 'force_update',
            });
            if (nextAt === null) {
                if (typeof updatedAt === 'number') return { modelId, updatedAt };
                return null;
            }
            return { modelId: null, updatedAt: nextAt };
        }
    }

    if (modelId === null) {
        return typeof updatedAt === 'number' ? { modelId, updatedAt } : null;
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
        const permissionBase = { ...merged };
        delete (permissionBase as Record<string, unknown>).permissionMode;
        delete (permissionBase as Record<string, unknown>).permissionModeUpdatedAt;
        merged = applySessionStateFieldMetadataPatch(permissionBase, 'intent.permissionMode', {
            v: 1,
            permissionMode: perm.mode,
            updatedAt: perm.updatedAt,
        }) as Metadata;
    } else if (mode === 'attach') {
        // Attach safety: explicitly remove any next-derived permissionMode fields.
        merged = clearSessionStateFieldFromMetadata(merged, 'intent.permissionMode') as Metadata;
    }

    const sessionMode = resolveSessionModeOverrideForStartup({
        current: opts.current,
        next: opts.next,
        nowMs: opts.nowMs,
        override: opts.sessionModeOverride,
        mode,
    });
    if (sessionMode) {
        const sessionModeBase = clearSessionStateFieldFromMetadata(merged, 'intent.acpSessionMode');
        merged = applySessionStateFieldMetadataPatch(sessionModeBase, 'intent.acpSessionMode', {
            v: 1,
            modeId: sessionMode.modeId,
            updatedAt: sessionMode.updatedAt,
        }) as Metadata;
    } else if (mode === 'attach') {
        // Attach safety: explicitly remove any next-derived override fields.
        merged = clearSessionStateFieldFromMetadata(merged, 'intent.acpSessionMode') as Metadata;
    }

    const model = resolveModelOverrideForStartup({
        current: opts.current,
        next: opts.next,
        nowMs: opts.nowMs,
        override: opts.modelOverride,
        mode,
    });
    if (model) {
        merged = applySessionStateFieldMetadataPatch(merged, 'intent.model', {
            v: 1,
            modelId: model.modelId,
            updatedAt: model.updatedAt,
        }) as Metadata;
    } else if (mode === 'attach') {
        // Attach safety: explicitly remove any next-derived override fields.
        merged = clearSessionStateFieldFromMetadata(merged, 'intent.model') as Metadata;
    }

    const acpConfigOptionUpdates = [
        ...readAcpConfigOptionUpdates(opts.current),
        ...(mode === 'attach' ? [] : readAcpConfigOptionUpdates(opts.next)),
    ];
    if (acpConfigOptionUpdates.length > 0) {
        merged = replayAcpConfigOptionUpdates(merged, acpConfigOptionUpdates);
    } else if (mode === 'attach') {
        // Attach safety: explicitly remove any next-derived config option overrides.
        merged = clearSessionStateFieldFromMetadata(merged, 'intent.acpConfigOption') as Metadata;
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
