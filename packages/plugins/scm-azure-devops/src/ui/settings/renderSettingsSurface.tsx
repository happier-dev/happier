/**
 * The Azure DevOps PRs & Issues settings surface artifact entry.
 *
 * The page itself is `@happier-dev/triage-sources`. Every source's page
 * reads the same three published contracts — this source's own `listInstances`,
 * the target's caller-scoped configured-instance read, and the target's single
 * administration Action — and reaches the same conclusions from the same bytes,
 * so it is written once. What Azure DevOps contributes is the three facts no shared page
 * can derive: which plugin is asking, which of its Actions enumerates what it
 * can reach, and what to call this source in a sentence.
 *
 * This file is that contribution AND the module the manifest's
 * `azure-devops-triage-sources-native` artifact is built from, so the exported name
 * stays `renderSurface`.
 */

import { createTriageSourceSettingsSurface } from '@happier-dev/triage-sources';

import { AZURE_DEVOPS_PLUGIN_ID } from '../../azureDevopsContracts.js';
import { AZURE_DEVOPS_TRIAGE_ACTION_IDS } from '../../triage/actions.js';
import { AZURE_DEVOPS_CONNECTED_ACCOUNT_ID, AZURE_DEVOPS_TRIAGE_DESCRIPTOR } from '../../triage/descriptor.js';

export const renderSurface = createTriageSourceSettingsSurface({
  pluginId: AZURE_DEVOPS_PLUGIN_ID,
  listInstancesLocalActionId: AZURE_DEVOPS_TRIAGE_ACTION_IDS.listInstances,
  connectedAccountServiceLocalId: AZURE_DEVOPS_CONNECTED_ACCOUNT_ID,
  sourceDisplayName: AZURE_DEVOPS_TRIAGE_DESCRIPTOR.displayName,
});
