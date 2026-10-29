import { PLUGIN_SETTINGS_INPUT_FIELDS } from './pluginSettingsInputHints.js';
import type { PreNormalizedActionSpec } from './definition.js';
import { readRecord } from '../../inputs/inputRecords.js';
import { PluginSettingsAdministrationActionInputSchemasV1, PluginSettingsAdministrationActionOutputV1Schema, resolvePluginSettingsAdministrationTargetV1, type PluginSettingsAdministrationActionIdV1 } from '../../plugins/settingsAdministration.js';


export const PLUGIN_SETTINGS_ADMINISTRATION_ACTION_TITLES: Readonly<Record<
  PluginSettingsAdministrationActionIdV1,
  string
>> = Object.freeze({
  'plugins.settings.list': 'List plugin settings',
  'plugins.settings.get': 'Get plugin setting',
  'plugins.settings.set': 'Set plugin setting',
  'plugins.settings.reset': 'Reset plugin setting',
  'plugins.settings.secret.status': 'Get plugin secret status',
  'plugins.settings.secret.bind': 'Bind existing saved secret',
  'plugins.settings.secret.unbind': 'Unbind plugin secret',
  'plugins.settings.secret.delete': 'Delete plugin secret',
});

export const PLUGIN_SETTINGS_ADMINISTRATION_ACTION_DESCRIPTIONS: Readonly<Record<
  PluginSettingsAdministrationActionIdV1,
  string
>> = Object.freeze({
  'plugins.settings.list': 'List declared plugin Settings for one exact Account or daemon scope.',
  'plugins.settings.get': 'Read one declared non-secret plugin Setting from one exact scope.',
  'plugins.settings.set': 'Compare-and-set one declared non-secret plugin Setting.',
  'plugins.settings.reset': 'Reset one declared non-secret plugin Setting to its owner default.',
  'plugins.settings.secret.status': 'Read safe configured status for one declared plugin secret.',
  'plugins.settings.secret.bind': 'Bind one plugin secret to an existing SavedSecret identity without exposing its value.',
  'plugins.settings.secret.unbind': 'Remove the binding for one plugin secret without exposing its value.',
  'plugins.settings.secret.delete': 'Delete one plugin secret through its declared custody owner without exposing its value.',
});

export function createPluginSettingsAdministrationActionSpec(
  actionId: PluginSettingsAdministrationActionIdV1,
): PreNormalizedActionSpec {
  const isRead = actionId === 'plugins.settings.list'
    || actionId === 'plugins.settings.get'
    || actionId === 'plugins.settings.secret.status';
  const isSecretMutation = !isRead && actionId.startsWith('plugins.settings.secret.');
  const isReversibleUiMutation = actionId === 'plugins.settings.set'
    || actionId === 'plugins.settings.secret.bind'
    || actionId === 'plugins.settings.secret.unbind';

  return {
    id: actionId, executionPlacement: 'machine', approvalPolicy: { uiConfirmation: isReversibleUiMutation ? 'direct' : 'policy', retainUiFieldIntent: true }, approval: isRead ? { result: 'required' } : { result: 'none' },
    title: PLUGIN_SETTINGS_ADMINISTRATION_ACTION_TITLES[actionId],
    ...(actionId === 'plugins.settings.secret.delete'
      ? { confirmVerb: { key: 'common.delete', fallback: 'Delete' }, irreversible: true as const } : {}),
    description: PLUGIN_SETTINGS_ADMINISTRATION_ACTION_DESCRIPTIONS[actionId],
    safety: isRead ? 'safe' : 'danger',
    executionPlacementForInput: (input: unknown) => resolvePluginSettingsAdministrationTargetV1(actionId, input).kind === 'account'
      ? 'account' : 'machine',
    bindings: { mcpToolName: actionId.replaceAll('.', '_') },
    placements: [],
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
      ...(isSecretMutation ? { api: false as const } : {}),
    },
    sideEffectClass: isRead ? 'read' : 'write',
    outputSchema: PluginSettingsAdministrationActionOutputV1Schema,
    inputSchema: PluginSettingsAdministrationActionInputSchemasV1[actionId],
    ...(actionId === 'plugins.settings.set' ? { projectObservationInput: (input: unknown) => {
      const { value: _privateValue, ...safeInput } = readRecord(input);
      return safeInput;
    }, approvalPresentation: {
      summary: () => null,
      // Declared-secret fields are refused before admission. The approver must see the ordinary
      // value being changed, while execution observations still omit private Settings content.
      projectInput: (input: unknown) => PluginSettingsAdministrationActionInputSchemasV1['plugins.settings.set'].parse(input),
    } } : {}),
    inputHints: { fields: PLUGIN_SETTINGS_INPUT_FIELDS[actionId] },
  };
}
