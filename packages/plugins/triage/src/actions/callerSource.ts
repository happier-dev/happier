import type { PluginCancellationOptions, PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { PluginContributionIdentity } from '@happier-dev/plugin-sdk/manifest';

import { TRIAGE_SOURCES_CONTRIBUTION_POINT_REF_V1 } from '../definition.js';
import type { TriageAdmittedSourceV1 } from './listEntries.js';

type TriageCallerContext = Pick<PluginInvocationContext, 'caller' | 'surface' | 'signal'> & Readonly<{
    services: Pick<PluginInvocationContext['services'], 'targetedContributions'>;
}>;

/**
 * The one owner of "who is calling a caller-bound Triage Action".
 *
 * Explicit reads select any admitted source in the invoking Account. Writes
 * retain their caller-bound source provenance; an address is never provenance.
 */

export type TriageCallerSourceV1 = Readonly<{
    contribution: TriageAdmittedSourceV1;
    /** The admitted contribution identity that owns the caller's rows. */
    source: PluginContributionIdentity;
    declaredPurpose: string;
}>;

export type TriageCallerSourceResolutionV1 =
    | Readonly<{ kind: 'source'; caller: TriageCallerSourceV1 }>
    | Readonly<{ kind: 'invalidCaller' }>;

const INVALID_CALLER: TriageCallerSourceResolutionV1 = Object.freeze({ kind: 'invalidCaller' });

export function isTriageHostActionCaller(context: TriageCallerContext): boolean {
    return context.caller === undefined
        && (context.surface === 'ui' || context.surface === 'voice' || context.surface === 'agent'
            || context.surface === 'mcp' || context.surface === 'cli' || context.surface === 'api');
}

type TriageCallerSourcesResolutionV1 =
    | Readonly<{ kind: 'sources'; callers: readonly TriageCallerSourceV1[] }>
    | Readonly<{ kind: 'invalidCaller' }>;

function sameSource(left: PluginContributionIdentity, right: PluginContributionIdentity): boolean {
    return left.pluginId === right.pluginId && left.localId === right.localId;
}

function callerSourcesFrom(
    context: TriageCallerContext,
    admitted: readonly TriageAdmittedSourceV1[],
    requestedSource?: PluginContributionIdentity,
): readonly TriageCallerSourceV1[] | null {
    const caller = context.caller;
    const hostCaller = isTriageHostActionCaller(context);
    if (!requestedSource && !hostCaller && caller?.kind !== 'plugin') return null;
    const callerPluginId = caller?.kind === 'plugin' ? caller.pluginId : undefined;
    const matches = requestedSource || hostCaller ? admitted : admitted.filter((entry) => entry.contributor.pluginId === callerPluginId);
    if (!requestedSource && !hostCaller && matches.length !== 1) return null;
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
 * Select a named admitted source for any Account reader, retaining the existing
 * host inventory and caller-bound defaults when no source is named.
 */
export async function resolveTriageCallerSources(
    context: TriageCallerContext,
    options?: PluginCancellationOptions,
    requestedSource?: PluginContributionIdentity,
): Promise<TriageCallerSourcesResolutionV1> {
    const observation = context.services.targetedContributions.observeForSelf(
        TRIAGE_SOURCES_CONTRIBUTION_POINT_REF_V1,
        { onInvalidated: () => {} },
    );
    try {
        const snapshot = await observation.readCurrent(options);
        const callers = callerSourcesFrom(context, snapshot.contributions, requestedSource);
        if (!callers) return { kind: 'invalidCaller' };
        return Object.freeze({ kind: 'sources', callers });
    } finally {
        observation.dispose();
    }
}

/** Write provenance stays bound to the plugin's own admitted contribution. */
export async function resolveTriageCallerSource(
    context: TriageCallerContext,
    options?: PluginCancellationOptions,
    requestedSource?: PluginContributionIdentity,
): Promise<TriageCallerSourceResolutionV1> {
    const hostCaller = isTriageHostActionCaller(context);
    if (hostCaller && requestedSource === undefined) return INVALID_CALLER;
    const resolution = await resolveTriageCallerSources(context, options, hostCaller ? requestedSource : undefined);
    if (resolution.kind !== 'sources') return { kind: resolution.kind };
    const caller = resolution.callers[0];
    return caller && resolution.callers.length === 1 && (hostCaller || !requestedSource || sameSource(caller.source, requestedSource))
        ? { kind: 'source', caller } : INVALID_CALLER;
}
