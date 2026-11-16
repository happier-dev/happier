/** The client-placed theme library and preview Actions. Store and plugin authoring own their extensions. */
export const THEME_ACTION_IDS = {
  list: 'appearance.themes.list', get: 'appearance.themes.get',
  tryOn: 'appearance.themes.tryOn', revert: 'appearance.themes.revert', keep: 'appearance.themes.keep',
  save: 'appearance.themes.save', duplicate: 'appearance.themes.duplicate', apply: 'appearance.themes.apply',
  undo: 'appearance.themes.undo', delete: 'appearance.themes.delete',
  storeGet: 'appearance.themes.store.get', install: 'appearance.themes.install', uninstall: 'appearance.themes.uninstall',
  import: 'appearance.themes.import', export: 'appearance.themes.export',
  sharePlugin: 'appearance.themes.sharePlugin',
} as const;
export const THEME_ACTION_ID_LIST = Object.freeze(Object.values(THEME_ACTION_IDS));
export type ThemeActionId = typeof THEME_ACTION_IDS[keyof typeof THEME_ACTION_IDS];
export function isThemeActionId(value: string): value is ThemeActionId {
  return (THEME_ACTION_ID_LIST as readonly string[]).includes(value);
}
