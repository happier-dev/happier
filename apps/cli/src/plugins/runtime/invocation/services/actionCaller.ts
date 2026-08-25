import {
    PluginMachineMaterializationRefV1Schema,
} from '@happier-dev/protocol';
import {
    PluginUiImmutableGenerationIdV1Schema,
} from '@happier-dev/protocol/plugins/ui';
import type {
    PluginMachineMaterializationRefV1,
} from '@happier-dev/protocol';
import type { ActionPluginCaller } from '@happier-dev/protocol/actions';

type PluginActionCallerSeed = Readonly<{
    plugin: Readonly<{ id: string }>;
    /** Immediate host-stamped contribution. It is never accepted from plugin input. */
    contribution?: Readonly<{ id: string }>;
    /** Exact admitted plugin bytes, supplied by the runtime owner only. */
    immutableGenerationId?: string;
    /** The resolved runtime registry supplies this live lookup at dispatch. */
    resolveCurrentPluginMaterializationRef?(): PluginMachineMaterializationRefV1 | null;
}>;

/**
 * Host-private exact-reference revalidation supplied by the resolved runtime
 * registry. Callers may ask whether their stamped reference is still current;
 * they never receive a replacement materialization.
 */
export type RevalidatePluginActionCallerMaterialization = (
    reference: PluginMachineMaterializationRefV1,
) => boolean | Promise<boolean>;

/**
 * The runtime owner compares an already host-stamped immutable generation
 * against its current admitted generation. It never returns a replacement.
 */
export type RevalidatePluginActionCallerImmutableGeneration = (
    caller: Readonly<{ pluginId: string; immutableGenerationId: string }>,
) => boolean | Promise<boolean>;

export type PluginActionCallerCurrentness = Readonly<{
    kind: 'current' | 'materializationUnavailable' | 'generationUnavailable';
}>;

/**
 * One composition of the host-private exact-reference revalidators for an
 * Action owner that must prove its host-stamped caller is still current
 * immediately before a durable outward effect. The outer dispatcher rechecks
 * the caller only after the owner returns, which is already past that effect.
 *
 * It rechecks the exact stamped bytes: it never substitutes a replacement
 * reference, resolves a caller by plugin ID, or treats an unavailable
 * revalidator as currentness.
 */
export function createPluginActionCallerCurrentnessCheck(params: Readonly<{
    caller: Readonly<{
        pluginId: string;
        /** Absent only for a legacy in-process caller the host never stamped. */
        immutableGenerationId?: string;
        materialization: PluginMachineMaterializationRefV1;
    }>;
    revalidateMaterialization: RevalidatePluginActionCallerMaterialization;
    revalidateImmutableGeneration?: RevalidatePluginActionCallerImmutableGeneration;
}>): () => Promise<PluginActionCallerCurrentness> {
    const { caller } = params;
    return async () => {
        try {
            if (!await params.revalidateMaterialization(caller.materialization)) {
                return { kind: 'materializationUnavailable' };
            }
        } catch {
            return { kind: 'materializationUnavailable' };
        }
        const immutableGenerationId = caller.immutableGenerationId;
        if (immutableGenerationId === undefined) return { kind: 'current' };
        if (!params.revalidateImmutableGeneration) {
            return { kind: 'generationUnavailable' };
        }
        try {
            return await params.revalidateImmutableGeneration({
                pluginId: caller.pluginId,
                immutableGenerationId,
            })
                ? { kind: 'current' }
                : { kind: 'generationUnavailable' };
        } catch {
            return { kind: 'generationUnavailable' };
        }
    };
}

/**
 * Projects host-owned plugin invocation provenance onto the canonical Action
 * caller contract. Legacy invocations without a contribution remain valid but
 * cannot gain a contribution identity later in the action pipeline.
 */
export function resolvePluginActionCaller(
    seed: PluginActionCallerSeed,
): ActionPluginCaller | null {
    let rawMaterialization: PluginMachineMaterializationRefV1 | null | undefined;
    try {
        rawMaterialization = seed.resolveCurrentPluginMaterializationRef?.();
    } catch {
        return null;
    }
    const materialization = PluginMachineMaterializationRefV1Schema.safeParse(
        rawMaterialization,
    );
    if (!materialization.success || materialization.data.pluginId !== seed.plugin.id) {
        return null;
    }
    const immutableGeneration = seed.immutableGenerationId === undefined
        ? undefined
        : PluginUiImmutableGenerationIdV1Schema.safeParse(seed.immutableGenerationId);
    if (immutableGeneration !== undefined && !immutableGeneration.success) return null;
    return Object.freeze({
        kind: 'plugin' as const,
        pluginId: seed.plugin.id,
        ...(seed.contribution ? { contributionLocalId: seed.contribution.id } : {}),
        ...(immutableGeneration === undefined ? {} : {
            immutableGenerationId: immutableGeneration.data,
        }),
        materialization: materialization.data,
    });
}
