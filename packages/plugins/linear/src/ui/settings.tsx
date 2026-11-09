import * as React from 'react';
import { Item, ItemGroup, Select, usePluginTranslation } from '@happier-dev/plugin-ui';
import { TriageSourceInstanceConfigurationV1Schema } from '@happier-dev/triage-protocol/v1';
import { createTriageSourceSettingsSurface, type TriageSourceSettingsDraftFieldsPropsV1 } from '@happier-dev/triage-sources/ui';
import { LINEAR_PLUGIN_ID, LINEAR_SOURCE_ID, LINEAR_SERVICE_ID, LINEAR_PURPOSE, LINEAR_ACTIONS, LinearConfigurationSchema,
  readLinearConfiguration, writeLinearScopeSelection } from '../contracts.js';

function DraftFields({ draft, busy, onChange }: TriageSourceSettingsDraftFieldsPropsV1): React.ReactElement {
  const text = usePluginTranslation();
  const configuration = React.useMemo(() => readLinearConfiguration(draft.configuration.token), [draft.configuration.token]);
  return <>
    <ItemGroup><Item title={text('plugins.linear.settings.issues', 'Issues')} fieldAccessory accessoryOutsidePressable accessory={<Select
      presentation="field" label={text('plugins.linear.settings.issues', 'Issues')} disabled={busy} value={configuration.involvement}
      options={[
        { value: 'mine', label: text('plugins.linear.settings.mine', 'My issues') },
        { value: 'assignee', label: text('plugins.linear.settings.assignee', 'Assigned to me') },
        { value: 'author', label: text('plugins.linear.settings.author', 'Created by me') },
        { value: 'subscribed', label: text('plugins.linear.settings.subscribed', 'Subscribed') },
        { value: 'everyone', label: text('plugins.linear.settings.everyone', 'All team issues') },
      ]} onChange={(value) => {
        const parsed = LinearConfigurationSchema.safeParse({ ...configuration, involvement: value });
        if (parsed.success) onChange({ ...draft, configuration: TriageSourceInstanceConfigurationV1Schema.parse({ v: 1, token: JSON.stringify(parsed.data) }) });
      }}
    />} /></ItemGroup>
  </>;
}

export const renderSurface = createTriageSourceSettingsSurface({
  pluginId: LINEAR_PLUGIN_ID, connectedAccountServiceLocalId: LINEAR_SERVICE_ID,
  sourceLocalId: LINEAR_SOURCE_ID,
  connectedAccountPurpose: LINEAR_PURPOSE,
  listInstancesLocalActionId: LINEAR_ACTIONS.listInstances, sourceDisplayName: 'Linear',
  configuredInstanceKeyStability: 'stable',
  DraftFields,
  scopeSelection: {
    unitLabel: 'Teams', listScopeUnitsLocalActionId: LINEAR_ACTIONS.listScopeUnits,
    readSelection(draft) {
      try { return readLinearConfiguration(draft.configuration.token).teams; } catch { return null; }
    },
    writeSelection(draft, teams, units) {
      try { return writeLinearScopeSelection(draft, teams, units); } catch { return null; }
    },
  },
});
