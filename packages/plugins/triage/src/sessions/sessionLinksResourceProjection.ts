import type { PluginUiResourceProjection } from '@happier-dev/plugin-ui';

import { TriageReadSourceSessionLinksResultV1Schema, normalizeTriageSourceSessionLinksCoverageV1, type TriageReadSourceSessionLinksResultV1 } from '../actions/sessionLinksProtocol.js';
import { entryReferenceComponents } from '../corpus/identity/components.js';

function retainRows<T>(rows: readonly T[], previous: readonly T[] | undefined, key: (row: T) => string): readonly T[] {
    if (previous === undefined) return rows;
    const baseline = new Map(previous.map(row => [key(row), row]));
    const retained = rows.map(row => {
        const prior = baseline.get(key(row));
        return prior !== undefined && JSON.stringify(prior) === JSON.stringify(row) ? prior : row;
    });
    return retained.length === previous.length && retained.every((row, index) => row === previous[index]) ? previous : retained;
}

type SessionLink = TriageReadSourceSessionLinksResultV1['links'][number];
const relationKey = (link: SessionLink) => JSON.stringify([...entryReferenceComponents(link.entryRef), link.sessionId]);
const laneKey = (source: SessionLink['entryRef']['source'], instanceId?: string) => JSON.stringify([source.pluginId, source.localId, instanceId ?? null]);

/** A failed slice cannot replace its last answer with absence. Missing lanes,
 * unlike failed lanes, have retired from this Resource's current source scope. */
function retainFailedLinks(result: TriageReadSourceSessionLinksResultV1, previous: TriageReadSourceSessionLinksResultV1 | undefined): readonly SessionLink[] {
    if (previous === undefined || previous.links.length === 0) return result.links;
    const failedKinds = new Map<string, Set<string>>();
    const unknownKinds = new Set<string>();
    const unavailableEntries = new Map<string, Set<string>>();
    for (const lane of result.lanes ?? []) {
        if (lane.health.kind === 'complete') continue;
        // An unqualified relationship can have been observed through any of
        // this source's configured instances. Preserve it while one is unreadable.
        for (const key of [laneKey(lane.source, lane.sourceInstanceId), laneKey(lane.source)]) {
            if (lane.health.kind === 'partial') {
                const entries = unavailableEntries.get(key) ?? new Set<string>();
                for (const entry of lane.health.unavailableRefs) entries.add(JSON.stringify(entryReferenceComponents(entry)));
                unavailableEntries.set(key, entries);
            } else if (lane.kindIds === undefined) unknownKinds.add(key);
            else {
                const kinds = failedKinds.get(key) ?? new Set<string>();
                for (const kind of lane.kindIds) kinds.add(kind);
                failedKinds.set(key, kinds);
            }
        }
    }
    const present = new Set(result.links.map(relationKey));
    const retained = previous.links.filter(link => {
        if (present.has(relationKey(link))) return false;
        // A prior producer omitted coverage entirely. It establishes neither
        // removal nor source retirement; the existing seam marks it incomplete.
        if (result.lanes === undefined) return true;
        const key = laneKey(link.entryRef.source, link.sourceInstanceId);
        return unknownKinds.has(key) || failedKinds.get(key)?.has(link.entryRef.kindId) === true
            || unavailableEntries.get(key)?.has(JSON.stringify(entryReferenceComponents(link.entryRef))) === true;
    });
    return retained.length === 0 ? result.links : [...result.links, ...retained];
}

/** One store-owned decode and keyed baseline for every mounted relation consumer. */
export const TRIAGE_SESSION_LINKS_RESOURCE_PROJECTION_V1: PluginUiResourceProjection<TriageReadSourceSessionLinksResultV1> = {
    decode(content, previous) {
        const result = normalizeTriageSourceSessionLinksCoverageV1(TriageReadSourceSessionLinksResultV1Schema.parse(
            JSON.parse(new TextDecoder().decode(content.bytes)),
        ));
        const links = retainRows(retainFailedLinks(result, previous), previous?.links, link => JSON.stringify([
            ...entryReferenceComponents(link.entryRef), link.sessionId, link.sourceInstanceId ?? null,
        ]));
        const lanes = result.lanes === undefined ? undefined : retainRows(result.lanes, previous?.lanes, lane => JSON.stringify([
            lane.source.pluginId, lane.source.localId, lane.sourceInstanceId, lane.kindIds ?? null,
        ]));
        const configureSources = result.configureSources === undefined ? undefined
            : retainRows(result.configureSources, previous?.configureSources,
                offer => JSON.stringify([offer.destination.pluginId, offer.destination.localId]));
        if (previous !== undefined && result.kind === previous.kind && result.nextCursor === previous.nextCursor
            && links === previous.links && lanes === previous.lanes && configureSources === previous.configureSources) return previous;
        return { ...result, links, ...(lanes === undefined ? {} : { lanes }),
            ...(configureSources === undefined ? {} : { configureSources }) };
    },
};
