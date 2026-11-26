/** Identities shared by the daemon declaration and the public UI entry. */
export const LEDGER_PLUGIN_ID = 'acme.ledger';
export const LEDGER_DISPLAY_NAME = 'Acme Ledger';
export const LEDGER_ACTION_IDS = Object.freeze({
    listInstances: 'ledger/discover-spaces',
    listCreationPlaces: 'ledger/list-creation-places',
    scan: 'ledger/walk-space',
    get: 'ledger/read-entry',
});
export const LEDGER_CONTRIBUTION_LOCAL_ID = 'acme-ledger';
export const LEDGER_CONNECTED_ACCOUNT_ID = 'acme-ledger-account';
// This is the HostAccess request id, not the service id. Action references
// require lower-case segments joined by '-' or '/', so a dotted purpose would
// be descriptor-valid but could not authorize these Actions' account listing.
export const LEDGER_ACCOUNT_PURPOSE = 'acme-ledger-api';
export const LEDGER_SETTINGS_PAGE_ID = 'ledger-sources';
export const LEDGER_SETTINGS_RENDERER_ID = 'ledger-source-settings';
export const LEDGER_SETTINGS_ARTIFACT_ID = 'ledger-sources-native';
