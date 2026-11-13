import type { PluginCancellationOptions, PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { PluginContributionIdentity } from '@happier-dev/plugin-sdk/manifest';
import type { TriageSourceAdministrationActionResultV1 } from '@happier-dev/triage-protocol/v1';

import { TRIAGE_SOURCES_CONTRIBUTION_POINT_REF_V1 } from '../targetedContributions.js';
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
    | Readonly<{ kind: 'invalidCaller'; admission: CallerAdmission }>;

type CallerAdmission = NonNullable<Extract<TriageSourceAdministrationActionResultV1, { kind: 'invalidCaller' }>['admission']>;

function invalidCaller(context: TriageCallerContext, candidateCount: number): Extract<TriageCallerSourceResolutionV1, { kind: 'invalidCaller' }> {
    const caller = context.caller;
    return { kind: 'invalidCaller', admission: {
        caller: caller?.kind === 'plugin'
            ? { kind: 'plugin', pluginId: caller.pluginId, contributionId: caller.contribution.id }
            : { kind: caller?.kind ?? 'absent' },
        surface: context.surface, candidateCount,
    } };
}

export function isTriageHostActionCaller(context: TriageCallerContext): boolean {
    return context.caller === undefined
        && (context.surface === 'ui' || context.surface === 'voice' || context.surface === 'agent'
            || context.surface === 'mcp' || context.surface === 'cli' || context.surface === 'api');
}

type TriageCallerSourcesResolutionV1 =
    | Readonly<{ kind: 'sources'; callers: readonly TriageCallerSourceV1[] }>
    | Extract<TriageCallerSourceResolutionV1, { kind: 'invalidCaller' }>;

function sameSource(left: PluginContributionIdentity, right: PluginContributionIdentity): boolean {
    return left.pluginId === right.pluginId && left.localId === right.localId;
}

function callerSourcesFrom(
    context: TriageCallerContext,
    admitted: readonly TriageAdmittedSourceV1[],
    requestedSource?: PluginContributionIdentity,
): TriageCallerSourcesResolutionV1 {
    const caller = context.caller;
    const hostCaller = isTriageHostActionCaller(context);
    if (!requestedSource && !hostCaller && caller?.kind !== 'plugin') return invalidCaller(context, 0);
    const callerPluginId = caller?.kind === 'plugin' ? caller.pluginId : undefined;
    const matches = requestedSource || hostCaller ? admitted : admitted.filter((entry) => entry.contributor.pluginId === callerPluginId);
    if (!requestedSource && !hostCaller && matches.length !== 1) return invalidCaller(context, matches.length);
    const sources = matches.flatMap((contribution): TriageCallerSourceV1[] => {
        const declaredPurpose = contribution.descriptor?.purpose;
        if (typeof declaredPurpose !== 'string') return [];
        const source = { pluginId: contribution.contributor.pluginId, localId: contribution.contributor.contributionId };
        if (requestedSource && !sameSource(source, requestedSource)) return [];
        return [{ contribution, source, declaredPurpose }];
    });
    return (requestedSource || !hostCaller) && sources.length !== 1
        ? invalidCaller(context, matches.length) : { kind: 'sources', callers: sources };
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
        return callerSourcesFrom(context, snapshot.contributions, requestedSource);
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
    if (hostCaller && requestedSource === undefined) return invalidCaller(context, 0);
    const resolution = await resolveTriageCallerSources(context, options, hostCaller ? requestedSource : undefined);
    if (resolution.kind !== 'sources') return resolution;
    const caller = resolution.callers[0];
    return caller && resolution.callers.length === 1 && (hostCaller || !requestedSource || sameSource(caller.source, requestedSource))
        ? { kind: 'source', caller } : invalidCaller(context, resolution.callers.length);
}
