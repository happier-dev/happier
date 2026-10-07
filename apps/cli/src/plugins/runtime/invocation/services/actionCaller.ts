import { AutomationRunCauseSchema } from '@happier-dev/protocol/automations/run-cause';
import { PluginMachineMaterializationRefV1Schema } from '@happier-dev/protocol/plugins/availability/materializationRefV1';
import { PluginSourceCustodyV1Schema } from '@happier-dev/protocol/plugins/runtime/sourceCustody';
import type { PluginMachineMaterializationRefV1 } from '@happier-dev/protocol';
import type { ActionCaller, ActionPluginCaller } from '@happier-dev/protocol/actions';
import type { PluginInvocationCaller } from '@happier-dev/plugin-sdk';

// The broker owns a delivery scope, including an explicitly independent event.
// This keeps callback Actions causal without changing their authorization caller.
const pluginEventActionOrigin = new AsyncLocalStorage<Readonly<{ caller: ActionCaller | undefined }>>();

export function withPluginEventActionOrigin<T>(caller: ActionCaller | undefined, operation: () => T): T {
    return pluginEventActionOrigin.run({ caller }, operation);
}

type PluginActionCallerSeed = Readonly<{
    plugin: Readonly<{ id: string }>;
    /** Host-private original Action provenance, never plugin input or authorization. */
    initiatingActionCaller?: ActionCaller;
    /** Bounded host-control provenance; immediate authorization identity stays unchanged. */
    startedBy?: ActionPluginCaller['startedBy'];
    caller?: PluginInvocationCaller;
    /** Immediate host-stamped contribution. It is never accepted from plugin input. */
    contribution?: Readonly<{ id: string }>;
    /** Exact process-local occurrence, supplied by the runtime owner only. */
    occurrenceId?: string;
    /** Durable source custody, supplied by the runtime owner only. */
    sourceCustody?: unknown;
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
 * The runtime owner compares an already host-stamped immutable occurrenceId
 * against its current admitted occurrenceId. It never returns a replacement.
 */
export type RevalidatePluginActionCallerOccurrence = (
    caller: Readonly<{ pluginId: string; occurrenceId: string }>,
) => boolean | Promise<boolean>;

export type PluginActionCallerCurrentness = Readonly<{
    kind: 'current' | 'materializationUnavailable' | 'occurrenceUnavailable';
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
        occurrenceId?: string;
        materialization?: PluginMachineMaterializationRefV1;
    }>;
    revalidateMaterialization: RevalidatePluginActionCallerMaterialization;
    revalidateOccurrence?: RevalidatePluginActionCallerOccurrence;
}>): () => Promise<PluginActionCallerCurrentness> {
    const { caller } = params;
    return async () => {
        if (caller.materialization !== undefined) {
            try {
                if (!await params.revalidateMaterialization(caller.materialization)) {
                    return { kind: 'materializationUnavailable' };
                }
            } catch {
                return { kind: 'materializationUnavailable' };
            }
        }
        const occurrenceId = caller.occurrenceId;
        if (occurrenceId === undefined) return { kind: 'current' };
        if (!params.revalidateOccurrence) {
            return { kind: 'occurrenceUnavailable' };
        }
        try {
            return await params.revalidateOccurrence({
                pluginId: caller.pluginId,
                occurrenceId,
            })
                ? { kind: 'current' }
                : { kind: 'occurrenceUnavailable' };
        } catch {
            return { kind: 'occurrenceUnavailable' };
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
    const materialization = rawMaterialization == null
        ? undefined
        : PluginMachineMaterializationRefV1Schema.safeParse(rawMaterialization);
    if (materialization !== undefined && (
        !materialization.success || materialization.data.pluginId !== seed.plugin.id
    )) {
        return null;
    }
    const occurrenceId = typeof seed.occurrenceId === 'string' && seed.occurrenceId.trim().length > 0
        ? seed.occurrenceId.trim()
        : undefined;
    if (seed.occurrenceId !== undefined && occurrenceId === undefined) return null;
    const sourceCustody = seed.sourceCustody === undefined
        ? undefined
        : PluginSourceCustodyV1Schema.safeParse(seed.sourceCustody);
    if (sourceCustody !== undefined && !sourceCustody.success) return null;
    const eventOrigin = pluginEventActionOrigin.getStore();
    let initiatingCaller: ActionCaller | undefined = eventOrigin ? eventOrigin.caller : seed.initiatingActionCaller;
    if (eventOrigin === undefined && seed.caller?.kind === 'automationRun') {
        // SDK declarations are brand-free; canonical parsing owns the host representation.
        const cause = AutomationRunCauseSchema.safeParse(seed.caller.cause);
        if (!cause.success) return null;
        initiatingCaller = {
            kind: 'automationRun',
            runId: seed.caller.runId,
            automationId: seed.caller.automationId,
            cause: cause.data,
        };
    }
    return Object.freeze({
        kind: 'plugin' as const,
        pluginId: seed.plugin.id,
        ...(seed.contribution ? { contributionLocalId: seed.contribution.id } : {}),
        ...(occurrenceId === undefined ? {} : { occurrenceId }),
        ...(sourceCustody === undefined ? {} : { sourceCustody: sourceCustody.data }),
        ...(materialization?.success === true ? { materialization: materialization.data } : {}),
        ...(initiatingCaller ? { initiatingCaller } : {}),
        // An explicit admitting caller, including Automation cause, takes precedence over a transported display fact.
        ...(!initiatingCaller && seed.startedBy ? { startedBy: seed.startedBy } : {}),
    });
}
import { AsyncLocalStorage } from 'node:async_hooks';
