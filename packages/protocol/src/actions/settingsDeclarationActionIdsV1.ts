
/** Action identity leaf: schema modules and the registry share these constants. */
export const SETTINGS_DECLARATION_ACTION_IDS_V1 = ['settings.list', 'settings.get', 'settings.set', 'settings.reset', 'settings.invoke'] as const;

export function isSettingsDeclarationWriteActionIdV1(actionId: string): actionId is 'settings.set' | 'settings.reset' {
  return actionId === 'settings.set' || actionId === 'settings.reset';
}
