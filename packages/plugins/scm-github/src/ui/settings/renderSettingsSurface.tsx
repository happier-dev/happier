import * as React from 'react';
import { Form, Stack, Text, usePluginTranslation } from '@happier-dev/plugin-ui';
import { createTriageSourceSettingsSurface, type TriageSourceSettingsDraftFieldsPropsV1 } from '@happier-dev/triage-sources/ui';
import { GITHUB_CONNECTED_ACCOUNT_ID, GITHUB_CONNECTED_ACCOUNT_PURPOSE, GITHUB_PLUGIN_ID } from '../../observations/githubProviderContracts.js';
import { GITHUB_TRIAGE_ACTION_IDS_V1, GITHUB_TRIAGE_SOURCE_DESCRIPTOR_V1 } from '../../triage/contribution.js';
import {
  decodeGithubTriageConfiguration,
  encodeGithubTriageConfiguration,
  GITHUB_TRIAGE_INSTANCE_KEY_STABILITY_V1,
  readGithubTriageAlertFamilies,
  writeGithubTriageAlertFamiliesDraft,
} from '../../triage/configuration.js';

/**
 * Security alerts are opt-in beside the repository scope (plan 07, lab `forge-ci/b5` Source settings): one switch
 * per family inside the shared editor, saved by its one Save. Nothing is read from GitHub until a family is on.
 */
function GithubAlertFamilyFields({ draft, busy, onChange }: TriageSourceSettingsDraftFieldsPropsV1): React.ReactElement | null {
  const text = usePluginTranslation();
  const decoded = decodeGithubTriageConfiguration(draft.configuration.token);
  if (!decoded.ok) return null;
  const families = readGithubTriageAlertFamilies(decoded.configuration);
  const change = (next: typeof families) => {
    const written = writeGithubTriageAlertFamiliesDraft(draft, next);
    if (written !== null) onChange(written);
  };
  return (
    <Stack gap="small">
      <Stack gap="xsmall">
        <Text variant="heading" value={text('plugins.github.settings.alerts.title', 'Security alerts')} />
        <Text variant="meta" tone="secondary" value={text('plugins.github.settings.alerts.description',
          'Show Dependabot and code scanning alerts for these repositories in PRs & Issues, beside everything else. Nothing is read until you turn a family on.')} />
      </Stack>
      <Form.Toggle label={text('plugins.github.settings.alerts.dependabot', 'Dependabot alerts')} value={families.dependabot}
        disabled={busy} onChange={(value) => change({ ...families, dependabot: value })} />
      <Form.Toggle label={text('plugins.github.settings.alerts.codeScanning', 'Code scanning alerts')} value={families.codeScanning}
        disabled={busy} onChange={(value) => change({ ...families, codeScanning: value })} />
      {decoded.configuration.selection.kind === 'all' && (families.dependabot || families.codeScanning) ? (
        <Text variant="micro" tone="secondary" value={text('plugins.github.settings.alerts.allCost',
          'With all repositories chosen, alerts are read for every repository you can reach. Selected repositories keep this quick.')} />
      ) : null}
    </Stack>
  );
}

/** The shared page owns the control and lifecycle; GitHub owns only its private token. */
export const renderSurface = createTriageSourceSettingsSurface({
  pluginId: GITHUB_PLUGIN_ID,
  listInstancesLocalActionId: GITHUB_TRIAGE_ACTION_IDS_V1.listInstances,
  connectedAccountServiceLocalId: GITHUB_CONNECTED_ACCOUNT_ID,
  connectedAccountPurpose: GITHUB_CONNECTED_ACCOUNT_PURPOSE,
  sourceDisplayName: GITHUB_TRIAGE_SOURCE_DESCRIPTOR_V1.displayName,
  scopeSelection: {
    unitLabel: 'repositories',
    listScopeUnitsLocalActionId: GITHUB_TRIAGE_ACTION_IDS_V1.listScopeUnits,
    readSelection: (draft) => {
      const decoded = decodeGithubTriageConfiguration(draft.configuration.token);
      return decoded.ok ? decoded.configuration.selection : null;
    },
    writeSelection: (draft, selection, units) => {
      const decoded = decodeGithubTriageConfiguration(draft.configuration.token);
      if (!decoded.ok) return null;
      const token = encodeGithubTriageConfiguration({ ...decoded.configuration, selection, units });
      return token === null ? null : { ...draft, configuration: { v: 1, token } };
    },
  },
  DraftFields: GithubAlertFamilyFields,
  configuredInstanceKeyStability: GITHUB_TRIAGE_INSTANCE_KEY_STABILITY_V1,
  nativeLoginLabel: { key: 'plugins.github.settings.nativeLogin', fallback: 'Use this machine’s GitHub CLI login' },
  nativeAuthenticationFailureLabel: { key: 'plugins.github.settings.nativeLoginUnavailable', fallback: 'Sign in with gh CLI on this machine.' },
});
