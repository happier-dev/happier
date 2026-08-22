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
