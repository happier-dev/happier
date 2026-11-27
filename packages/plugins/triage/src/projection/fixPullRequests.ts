import { pluginJsonValuesEqual } from '@happier-dev/plugin-sdk/protocol';
import type { TriageFixPullRequestV1, TriageReadFixPullRequestsResultV1 } from '@happier-dev/triage-protocol/v1';
import { entryReferenceComponents } from '../corpus/identity/components.js';

function key(candidate: TriageFixPullRequestV1): string {
    return JSON.stringify(entryReferenceComponents(candidate.entryRef));
}

/** The Action ingress publishes admitted candidates against this mount's existing answer. */
export function projectTriageFixPullRequestsRead(
    next: TriageReadFixPullRequestsResultV1,
    previous?: TriageReadFixPullRequestsResultV1,
): TriageReadFixPullRequestsResultV1 {
    if (previous === undefined) {
        const reportedPrimary = next.primary;
        const primary = reportedPrimary === null ? null : next.candidates.find((candidate) => key(candidate) === key(reportedPrimary)) ?? reportedPrimary;
        return primary === next.primary ? next : Object.freeze({ ...next, primary });
    }
    const baseline = new Map(previous.candidates.map((candidate) => [key(candidate), candidate]));
    const current = new Map<string, TriageFixPullRequestV1>();
    let orderChanged = previous.candidates.length !== next.candidates.length;
    const projected = next.candidates.map((candidate, index) => {
        const candidateKey = key(candidate);
        const prior = baseline.get(candidateKey);
        let value = candidate;
        if (prior !== undefined) {
            const display = prior.display.title === candidate.display.title
                && prior.display.scopeLabel === candidate.display.scopeLabel
                && prior.display.displayPath === candidate.display.displayPath ? prior.display : candidate.display;
            const origins = prior.origins.length === candidate.origins.length
                && prior.origins.every((origin, index) => origin === candidate.origins[index]) ? prior.origins : candidate.origins;
            let sourceContext = candidate.sourceContext;
            if (prior.sourceContext !== undefined && sourceContext !== undefined) {
                const before = prior.sourceContext.lastKnownLocator;
                const after = sourceContext.lastKnownLocator;
                const locator = before.v === after.v && before.webUrl === after.webUrl
                    && before.displayPath === after.displayPath && before.routingToken === after.routingToken ? before : after;
                sourceContext = prior.sourceContext.sourceInstanceId === sourceContext.sourceInstanceId
                    && locator === before ? prior.sourceContext
                    : locator === after ? sourceContext : { ...sourceContext, lastKnownLocator: locator };
            }
            value = candidate.status === prior.status && display === prior.display && origins === prior.origins
                && sourceContext === prior.sourceContext ? prior : {
                    ...candidate, entryRef: prior.entryRef, display, origins,
                    ...(sourceContext === undefined ? {} : { sourceContext }),
                };
        }
        if (value !== previous.candidates[index]) orderChanged = true;
        current.set(candidateKey, value);
        return value;
    });
    const candidates = orderChanged ? Object.freeze(projected) : previous.candidates;
    const primary = next.primary === null ? null : current.get(key(next.primary)) ?? next.primary;
    if (candidates === previous.candidates && primary === previous.primary && next.incomplete === previous.incomplete
        && (next.nativeFailure === previous.nativeFailure || pluginJsonValuesEqual(next.nativeFailure, previous.nativeFailure))) return previous;
    return Object.freeze({ ...next, candidates, primary });
}
