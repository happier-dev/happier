import type { PluginCancellationOptions, PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { PluginContributionIdentity } from '@happier-dev/plugin-sdk/manifest';
import { TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1 } from '@happier-dev/triage-protocol/v1';

import { TRIAGE_SOURCES_CONTRIBUTION_POINT_REF_V1 } from '../manifest.js';
import type { TriageAdmittedSourceV1 } from './listEntries.js';

/**
 * The one owner of "who is calling a caller-bound Triage Action".
 *
 * Plugin callers remain bound to their own admitted contribution. Authenticated
 * host agent/MCP/CLI invocations may select an admitted source address; that
 * address is never caller provenance. Nested plugin calls cannot inherit host
 * authority merely by claiming an origin surface.
 */

export type TriageCallerSourceV1 = Readonly<{
    contribution: TriageAdmittedSourceV1;
    /** The admitted contribution identity that owns the caller's rows. */
    source: PluginContributionIdentity;
    declaredPurpose: string;
}>;

export type TriageCallerSourceResolutionV1 =
    | Readonly<{ kind: 'source'; caller: TriageCallerSourceV1 }>
    | Readonly<{ kind: 'invalidCaller' }>
    /**
     * The admitted view moved under this invocation, so the caller just
     * resolved is no longer the one the answer would belong to.
     */
    | Readonly<{ kind: 'currentnessConflict' }>;

const INVALID_CALLER: TriageCallerSourceResolutionV1 = Object.freeze({ kind: 'invalidCaller' });

export function isTriageHostActionCaller(context: PluginInvocationContext): boolean {
    return context.caller === undefined
        && (context.surface === 'agent' || context.surface === 'mcp' || context.surface === 'cli');
}

export function isTriageAccountCaller(context: PluginInvocationContext): boolean {
    return isTriageSelfCaller(context) || isTriageHostActionCaller(context);
}

type TriageCallerSourcesResolutionV1 =
    | Readonly<{ kind: 'sources'; callers: readonly TriageCallerSourceV1[] }>
    | Readonly<{ kind: 'invalidCaller' }>
    | Readonly<{ kind: 'currentnessConflict' }>;

function sameSource(left: PluginContributionIdentity, right: PluginContributionIdentity): boolean {
    return left.pluginId === right.pluginId && left.localId === right.localId;
}

function callerSourcesFrom(
    context: PluginInvocationContext,
    admitted: readonly TriageAdmittedSourceV1[],
    requestedSource?: PluginContributionIdentity,
): readonly TriageCallerSourceV1[] | null {
    const caller = context.caller;
    const hostCaller = isTriageHostActionCaller(context);
    if (!hostCaller && caller?.kind !== 'plugin') return null;
    const callerPluginId = caller?.kind === 'plugin' ? caller.pluginId : undefined;
    const matches = hostCaller ? admitted : admitted.filter((entry) => entry.contributor.pluginId === callerPluginId);
    if (!hostCaller && matches.length !== 1) return null;
    const sources = matches.flatMap((contribution): TriageCallerSourceV1[] => {
        const declaredPurpose = contribution.descriptor?.purpose;
        if (typeof declaredPurpose !== 'string') return [];
        const source = { pluginId: contribution.contributor.pluginId, localId: contribution.contributor.contributionId };
        if (requestedSource && !sameSource(source, requestedSource)) return [];
        return [{ contribution, source, declaredPurpose }];
    });
    return (requestedSource || !hostCaller) && sources.length !== 1 ? null : sources;
}

/**
 * Read the caller's own admitted source contribution from the live admitted
 * view, holding an invalidation watch for the length of the read.
 */
export async function resolveTriageCallerSources(
    context: PluginInvocationContext,
    options?: PluginCancellationOptions,
    requestedSource?: PluginContributionIdentity,
): Promise<TriageCallerSourcesResolutionV1> {
    let invalidated = false;
    const observation = context.services.targetedContributions.observeForSelf(
        TRIAGE_SOURCES_CONTRIBUTION_POINT_REF_V1,
        { onInvalidated: () => { invalidated = true; } },
    );
    try {
        const snapshot = await observation.readCurrent(options);
        const callers = callerSourcesFrom(context, snapshot.contributions, requestedSource);
        if (!callers) return { kind: 'invalidCaller' };
        if (invalidated) return { kind: 'currentnessConflict' };
        return Object.freeze({ kind: 'sources', callers });
    } finally {
        observation.dispose();
    }
}

export async function resolveTriageCallerSource(
    context: PluginInvocationContext,
    options?: PluginCancellationOptions,
    requestedSource?: PluginContributionIdentity,
): Promise<TriageCallerSourceResolutionV1> {
    if (isTriageHostActionCaller(context) && requestedSource === undefined) return INVALID_CALLER;
    const resolution = await resolveTriageCallerSources(context, options, requestedSource);
    if (resolution.kind !== 'sources') return { kind: resolution.kind };
    const caller = resolution.callers[0];
    return caller && resolution.callers.length === 1 ? { kind: 'source', caller } : INVALID_CALLER;
}

/**
 * Whether the invocation came from this target's own mounted surfaces.
 *
 * The aggregate's own page reaches its Collections the only way a mounted
 * surface can — through an Action — so an Action that returns the private
 * configured payload has to separate "the target reading its own data" from
 * "a source plugin reading somebody else's". The aggregate list Action already
 * withholds the account binding and configuration token from its summaries;
 * this keeps the exact-instance read from becoming the way around that.
 */
export function isTriageSelfCaller(context: PluginInvocationContext): boolean {
    const caller = context.caller;
    return caller?.kind === 'plugin' && caller.pluginId === TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1;
}
