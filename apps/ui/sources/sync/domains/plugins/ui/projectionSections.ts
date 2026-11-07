// Presented UI needs destinations, their executable Actions, physical renderer facts,
// Account descriptors, Voice catalog authority and translation Resource declarations.
// Other catalogues retain separate demand.
export const CONNECTED_ACCOUNT_PROJECTION_SECTIONS = ['familiesById.connectedAccounts'] as const;
// A connected-account purpose declaration resolves through its consumer's Actions/Resources,
// managed provisioners and authentication descriptors (`readDeclaredConnectedAccountPurposeV1`).
export const CONNECTED_ACCOUNT_PURPOSE_DECLARATION_SECTIONS = ['actionsById', 'resourcesById',
    ...CONNECTED_ACCOUNT_PROJECTION_SECTIONS, 'familiesById.machineProvisioners'] as const;
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
// A composer host presents Agent/model chips, Composer controls, regions,
// attachments, references and their Actions; unrelated catalogues load at their consumers.
export const COMPOSER_HOST_PROJECTION_SECTIONS = ['agentsById', 'actionsById', 'resourcesById', 'familiesById.pluginUi',
    'familiesById.providers', ...CONNECTED_ACCOUNT_PROJECTION_SECTIONS, 'familiesById.inputTypes',
    'familiesById.composerAttachments', 'familiesById.composerControls', 'familiesById.composerRegions',
    'contributionIntrospection', 'composerSurfaceCatalog'] as const;
