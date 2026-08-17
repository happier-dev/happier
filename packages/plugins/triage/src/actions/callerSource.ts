import type { PluginCancellationOptions, PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { PluginContributionIdentity } from '@happier-dev/plugin-sdk/manifest';
import { TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1 } from '@happier-dev/triage-protocol/v1';

import { TRIAGE_SOURCES_CONTRIBUTION_POINT_REF_V1 } from '../manifest.js';
import type { TriageAdmittedSourceV1 } from './listEntries.js';

/**
 * The one owner of "who is calling a caller-bound Triage Action".
 *
 * Two Actions ask this question — source administration writes what the answer
 * owns, and the configured-instance read returns it — and a second copy of the
 * resolution would be a second authority over which rows a source may reach.
 * The rule is deliberately not a filter the caller supplies: the host stamps the
 * caller, this resolves that caller's own currently admitted V1 contribution at
 * this target's own point, and the point admits at most one contribution per
 * contributor, so the caller's plugin id resolves it exactly.
 *
 * A caller with none, one whose contribution is retired, one whose descriptor
 * declares no purpose, and a non-plugin caller are all the same answer: no
 * source. Every consumer turns that into the published `invalidCaller` refusal.
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
const CURRENTNESS_CONFLICT: TriageCallerSourceResolutionV1 = Object.freeze({
    kind: 'currentnessConflict',
});

function callerSourceFrom(
    context: PluginInvocationContext,
    admitted: readonly TriageAdmittedSourceV1[],
): TriageCallerSourceV1 | null {
    const caller = context.caller;
    if (!caller || caller.kind !== 'plugin') return null;
    const matches = admitted.filter((entry) => entry.contributor.pluginId === caller.pluginId);
    const contribution = matches.length === 1 ? matches[0] : undefined;
    if (!contribution) return null;
    const declaredPurpose = contribution.descriptor?.purpose;
    if (typeof declaredPurpose !== 'string') return null;
    return {
        contribution,
        source: {
            pluginId: contribution.contributor.pluginId,
            localId: contribution.contributor.contributionId,
        },
        declaredPurpose,
    };
}

/**
 * Read the caller's own admitted source contribution from the live admitted
 * view, holding an invalidation watch for the length of the read.
 */
export async function resolveTriageCallerSource(
    context: PluginInvocationContext,
    options?: PluginCancellationOptions,
): Promise<TriageCallerSourceResolutionV1> {
    let invalidated = false;
    const observation = context.services.targetedContributions.observeForSelf(
        TRIAGE_SOURCES_CONTRIBUTION_POINT_REF_V1,
        { onInvalidated: () => { invalidated = true; } },
    );
    try {
        const snapshot = await observation.readCurrent(options);
        const caller = callerSourceFrom(context, snapshot.contributions);
        if (!caller) return INVALID_CALLER;
        if (invalidated) return CURRENTNESS_CONFLICT;
        return Object.freeze({ kind: 'source', caller });
    } finally {
        observation.dispose();
    }
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
