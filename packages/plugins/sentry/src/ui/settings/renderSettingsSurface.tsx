/**
 * The Sentry PRs & Issues settings surface artifact entry.
 *
 * The page itself is `@happier-dev/triage-sources`. Every source's page
 * reads the same three published contracts — this source's own `listInstances`,
 * the target's caller-scoped configured-instance read, and the target's single
 * administration Action — and reaches the same conclusions from the same bytes,
 * so it is written once. What Sentry contributes is the three facts no shared page
 * can derive: which plugin is asking, which of its Actions enumerates what it
 * can reach, and what to call this source in a sentence.
 *
 * This file is that contribution AND the module the manifest's
 * `sentry-triage-sources-native` artifact is built from, so the exported name
 * stays `renderSurface`.
 */

import { createTriageSourceSettingsSurface } from '@happier-dev/triage-sources/ui';
import { decodeSentryInstanceConfiguration, encodeSentryInstanceConfiguration } from '../../instances/sentryInstanceConfiguration.js';

import {
  SENTRY_ACTION_IDS,
  SENTRY_CONNECTED_ACCOUNT_ID,
  SENTRY_CONNECTED_ACCOUNT_PURPOSE,
  SENTRY_PLUGIN_ID,
  SENTRY_SOURCE_DISPLAY_NAME,
} from '../../sentryContracts.js';

export const renderSurface = createTriageSourceSettingsSurface({
  pluginId: SENTRY_PLUGIN_ID,
  listInstancesLocalActionId: SENTRY_ACTION_IDS.listInstances,
  connectedAccountServiceLocalId: SENTRY_CONNECTED_ACCOUNT_ID,
  connectedAccountPurpose: SENTRY_CONNECTED_ACCOUNT_PURPOSE,
  sourceDisplayName: SENTRY_SOURCE_DISPLAY_NAME,
  configuredInstanceKeyStability: 'locatorDerived',
  scopeSelection: {
    unitLabel: 'Projects',
    listScopeUnitsLocalActionId: SENTRY_ACTION_IDS.listScopeUnits,
    readSelection: (draft) => {
      const decoded = decodeSentryInstanceConfiguration(draft.configuration.token);
      return decoded.ok ? decoded.configuration.projectScope : null;
    },
    writeSelection: (draft, selection, units) => {
      const decoded = decodeSentryInstanceConfiguration(draft.configuration.token);
      if (!decoded.ok) return null;
      try {
        return {
          ...draft,
          configuration: { v: 1, token: encodeSentryInstanceConfiguration({
            ...decoded.configuration,
            projectScope: selection,
            ...(selection.kind === 'selected' ? { projectUnits: units } : {}),
          }) },
        };
      } catch {
        return null;
      }
    },
  },
});
