import { TRIAGE_APP_PAGE_DESTINATION_V1, TRIAGE_TASKS_PAGE_DESTINATION_V1 } from './actionEditorLaunch.js';
import { isInternalTaskReferenceV1, TriageEntryRefV1Schema, type TriageEntryRefV1 } from './identity.js';

/** The selected-entry segment shared by Triage pages and retained deep links. */
export function buildTriageEntryRouteSegmentV1(entryRef: TriageEntryRefV1): string {
    const { source, kindId, collisionScope, entryId } = entryRef;
    return ['e', source.pluginId, source.localId, kindId, collisionScope, entryId]
        .map(encodeURIComponent).join(',');
}

export function readTriageEntryRouteSegmentV1(segment: string): TriageEntryRefV1 | null {
    const [key, ...components] = segment.split(',');
    if (key !== 'e' || components.length !== 5) return null;
    try {
        const [pluginId, localId, kindId, collisionScope, entryId] = components.map(decodeURIComponent);
        const parsed = TriageEntryRefV1Schema.safeParse({
            source: { pluginId, localId }, kindId, collisionScope, entryId,
        });
        return parsed.success ? parsed.data : null;
    } catch {
        return null;
    }
}

/**
 * The page that shows one entry's detail, as a qualified page and sub-path: a Happier Task opens in the Tasks page,
 * anything else in the Triage page, each with that entry selected. Both pages read the selection from this segment.
 */
export function buildTriageEntryPageV1(entryRef: TriageEntryRefV1): Readonly<{ pluginId: string; localId: string; subPath: string }> {
    const page = isInternalTaskReferenceV1(entryRef) ? TRIAGE_TASKS_PAGE_DESTINATION_V1 : TRIAGE_APP_PAGE_DESTINATION_V1;
    return { ...page, subPath: buildTriageEntryRouteSegmentV1(entryRef) };
}
