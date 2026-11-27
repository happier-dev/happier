import { defineProtocolLiteral, defineProtocolObject } from '@happier-dev/plugin-sdk/protocol';

import { TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1 } from './bounds.js';
import { TriageActionIdV1Schema } from './identity.js';

/** The local id of the one Triage app page; the manifest declares it and every opener names it. */
export const TRIAGE_APP_PAGE_LOCAL_ID_V1 = 'triage';

/** The Triage app page as a qualified destination. */
export const TRIAGE_APP_PAGE_DESTINATION_V1 = Object.freeze({
    pluginId: TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1,
    localId: TRIAGE_APP_PAGE_LOCAL_ID_V1,
});

/** The local id of the Tasks page: the Triage page one lens apart (its Tasks filter defaults to the reader's own). */
export const TRIAGE_TASKS_PAGE_LOCAL_ID_V1 = 'tasks';

/** The Tasks page as a qualified destination. */
export const TRIAGE_TASKS_PAGE_DESTINATION_V1 = Object.freeze({
    pluginId: TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1,
    localId: TRIAGE_TASKS_PAGE_LOCAL_ID_V1,
});

/**
 * Open the one configured-action editor (owner ruling 2026-11-07, "Agent actions: one shared flow": actions are
 * configurable records with one owner). Every surface that draws an agent action (core failure pages, the Triage list,
 * its detail and the standalone detail) opens the Triage app page with this launch, so there is one editor and one
 * way to reach it. Without `actionId` it opens on the catalog; with one, on that record.
 */
export const TriageActionEditorLaunchInputV1Schema = defineProtocolObject({
    v: defineProtocolLiteral(1),
    kind: defineProtocolLiteral('actionEditor'),
    actionId: TriageActionIdV1Schema.optional(),
}, { policy: 'closed' });
export type TriageActionEditorLaunchInputV1 = ReturnType<typeof TriageActionEditorLaunchInputV1Schema.parse>;

export function buildTriageActionEditorLaunchInputV1(actionId?: string): TriageActionEditorLaunchInputV1 {
    return actionId === undefined ? { v: 1, kind: 'actionEditor' } : { v: 1, kind: 'actionEditor', actionId };
}
