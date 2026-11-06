// Presented UI needs destinations, their executable Actions, physical renderer facts,
// Account descriptors, Voice catalog authority and translation Resource declarations.
// Other catalogues retain separate demand.
export const CONNECTED_ACCOUNT_PROJECTION_SECTIONS = ['familiesById.connectedAccounts'] as const;
export const PLUGIN_UI_SECTIONS = ['actionsById', 'familiesById.pluginUi', 'familiesById.pluginBrowser',
    ...CONNECTED_ACCOUNT_PROJECTION_SECTIONS, 'familiesById.inputTypes', 'familiesById.voiceProviders',
    'familiesById.storeKinds', 'resourcesById'] as const;
// Administration ranks origin candidates from installed-package facts. `base` and
// `installedPackagesById` are always loaded, so the candidate question demands no family.
export const PLUGIN_EXECUTION_ORIGIN_CANDIDATE_SECTIONS = [] as const satisfies readonly string[];
// Search renders provider declarations and invokes their Actions. Package
// admission and base facts are included by the deferred-section owner.
export const PLUGIN_SEARCH_SECTIONS = ['searchProviders'] as const;
// Event authoring also presents setup Actions and their plugin UI/input facts.
export const PLUGIN_EVENT_AUTOMATION_SECTIONS = [...PLUGIN_UI_SECTIONS, 'automationEligibleEvents'] as const;
