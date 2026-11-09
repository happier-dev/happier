import { createTriageSourceSettingsSurface } from '@happier-dev/triage-sources/ui';

import {
    LEDGER_ACTION_IDS,
    LEDGER_ACCOUNT_PURPOSE,
    LEDGER_CONNECTED_ACCOUNT_ID,
    LEDGER_DISPLAY_NAME,
    LEDGER_PLUGIN_ID,
    LEDGER_CONTRIBUTION_LOCAL_ID,
} from './identity.mjs';

/** The canonical source settings page, bound only to this source's identities. */
export const renderSurface = createTriageSourceSettingsSurface({
    pluginId: LEDGER_PLUGIN_ID,
    sourceLocalId: LEDGER_CONTRIBUTION_LOCAL_ID,
    listInstancesLocalActionId: LEDGER_ACTION_IDS.listInstances,
    connectedAccountServiceLocalId: LEDGER_CONNECTED_ACCOUNT_ID,
    connectedAccountPurpose: LEDGER_ACCOUNT_PURPOSE,
    sourceDisplayName: LEDGER_DISPLAY_NAME,
});
