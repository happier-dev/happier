import { DAEMON_PROJECTION_PLUGIN_SELECTABLE_SECTIONS, DAEMON_PROJECTION_SESSION_PLUGINS,
    daemonProjectionPluginSectionId } from '@happier-dev/protocol/daemon/contributionRegistryProjection';

// Presented UI needs destinations, their executable Actions, physical renderer facts,
// Account descriptors, Store registry sources, backup destinations, Voice catalog authority and translation Resource declarations.
// Other catalogues retain separate demand.
export const CONNECTED_ACCOUNT_PROJECTION_SECTIONS = ['familiesById.connectedAccounts'] as const;
export const THEME_PROJECTION_SECTIONS = ['familiesById.themes'] as const;
export const SKILL_PROJECTION_SECTIONS = ['familiesById.skills'] as const;
// A connected-account purpose declaration resolves through its consumer's Actions/Resources,
// managed provisioners and authentication descriptors (`readDeclaredConnectedAccountPurposeV1`).
export const CONNECTED_ACCOUNT_PURPOSE_DECLARATION_SECTIONS = ['actionsById', 'resourcesById',
    ...CONNECTED_ACCOUNT_PROJECTION_SECTIONS, 'familiesById.machineProvisioners'] as const;
export const PLUGIN_UI_SECTIONS = ['actionsById', 'familiesById.pluginUi', 'familiesById.pluginBrowser',
    ...CONNECTED_ACCOUNT_PROJECTION_SECTIONS, 'familiesById.inputTypes', 'familiesById.voiceProviders',
    'familiesById.subjectKinds', 'familiesById.storeKinds', 'familiesById.registrySources', ...THEME_PROJECTION_SECTIONS, 'familiesById.backupDestinations', 'resourcesById'] as const;
/**
 * Store registry source declarations alone (Deploy an app's starters). A Machine publishes them as soon as
 * this section is read; its other presentation sections are not waited on.
 */
export const REGISTRY_SOURCE_PROJECTION_SECTIONS = ['familiesById.registrySources'] as const;
/**
 * A Session presents only the plugins its surfaces render: the Machine's
 * manifest names them (`sessionPluginIds`). Actions, Resources and plugin UI
 * entries are read for those plugins; another plugin's slice is read when a
 * lookup needs it (`pluginSliceSections`), never treated as retired.
 */
const SESSION_SLICES: Readonly<Record<string, string>> = Object.fromEntries(DAEMON_PROJECTION_PLUGIN_SELECTABLE_SECTIONS
    .map(section => [section, daemonProjectionPluginSectionId(section, DAEMON_PROJECTION_SESSION_PLUGINS)]));
function sessionSlices(sections: readonly string[]): readonly string[] {
    return Object.freeze(sections.map(section => SESSION_SLICES[section] ?? section));
}
/** One plugin's slice of every selectable section. */
export function pluginSliceSections(pluginId: string): readonly string[] {
    return DAEMON_PROJECTION_PLUGIN_SELECTABLE_SECTIONS.map(section => daemonProjectionPluginSectionId(section, pluginId));
}
/** A demand's selectable sections narrowed to one plugin's slices; other sections are kept whole. */
export function slicePluginSections(sections: readonly string[], pluginId: string): readonly string[] {
    const selectable = new Set<string>(DAEMON_PROJECTION_PLUGIN_SELECTABLE_SECTIONS);
    return Object.freeze(sections.map(section => selectable.has(section)
        ? daemonProjectionPluginSectionId(section as (typeof DAEMON_PROJECTION_PLUGIN_SELECTABLE_SECTIONS)[number], pluginId)
        : section));
}
const pluginUiSectionsByPluginId = new Map<string, readonly string[]>();
/**
 * One mounted plugin surface's UI demand: its plugin's Action, Resource and UI slices plus the
 * shared UI families. AppShell presents that plugin from it; other plugins stay not loaded.
 */
export function pluginUiSections(pluginId: string): readonly string[] {
    let sections = pluginUiSectionsByPluginId.get(pluginId);
    if (!sections) {
        sections = slicePluginSections(PLUGIN_UI_SECTIONS, pluginId);
        pluginUiSectionsByPluginId.set(pluginId, sections);
    }
    return sections;
}
/** Session-tree plugin surfaces (header, panes, runtime, message Actions): the UI demand, Session plugins only. */
export const SESSION_PLUGIN_UI_SECTIONS = sessionSlices(PLUGIN_UI_SECTIONS);
// Message Actions resolve their Actions, UI entries and Resources for the Session's plugins.
export const SESSION_MESSAGE_ACTION_PROJECTION_SECTIONS = sessionSlices(['actionsById', 'familiesById.pluginUi', 'resourcesById']);
// Transcript Activities render their declared Resource rows from the UI family alone.
export const TRANSCRIPT_ACTIVITY_PROJECTION_SECTIONS = sessionSlices(['familiesById.pluginUi']);
// Administration ranks origin candidates from installed-package facts. `base` and
// `installedPackagesById` are always loaded, so the candidate question demands no family.
export const PLUGIN_EXECUTION_ORIGIN_CANDIDATE_SECTIONS = [] as const satisfies readonly string[];
// Search renders provider declarations and invokes their Actions. Package
// admission and base facts are included by the deferred-section owner.
export const PLUGIN_SEARCH_SECTIONS = ['searchProviders'] as const;
// Event authoring also presents setup Actions and their plugin UI/input facts.
export const PLUGIN_EVENT_AUTOMATION_SECTIONS = [...PLUGIN_UI_SECTIONS, 'automationEligibleEvents'] as const;
// A composer host presents Agent/model chips, Composer controls, regions,
// attachments, references and their Actions; unrelated catalogues load at their consumers.
export const COMPOSER_HOST_PROJECTION_SECTIONS = sessionSlices(['agentsById', 'actionsById', 'resourcesById', 'familiesById.pluginUi',
    'familiesById.providers', ...CONNECTED_ACCOUNT_PROJECTION_SECTIONS, 'familiesById.inputTypes',
    'familiesById.composerAttachments', 'familiesById.composerControls', 'familiesById.composerRegions',
    'contributionIntrospection', 'composerSurfaceCatalog']);
