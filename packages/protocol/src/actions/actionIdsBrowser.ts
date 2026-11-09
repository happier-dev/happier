/** Browser mutation IDs are leaf data so admission can classify them during catalog loading. */
export const BROWSER_PROFILE_MUTATION_ACTION_IDS = ['browser.profile.create', 'browser.profile.select', 'browser.profile.delete'] as const;
export const BROWSER_PROFILE_ACTION_IDS = ['browser.profile.list', ...BROWSER_PROFILE_MUTATION_ACTION_IDS] as const;
export function isBrowserProfileActionIdV1(actionId: string): actionId is typeof BROWSER_PROFILE_ACTION_IDS[number] {
  return (BROWSER_PROFILE_ACTION_IDS as readonly string[]).includes(actionId);
}

export const BROWSER_EXTENSION_MUTATION_ACTION_IDS = [
  'browser.extensions.install', 'browser.extensions.update', 'browser.extensions.enable', 'browser.extensions.disable', 'browser.extensions.remove',
] as const;
export const BROWSER_EXTENSION_ACTION_IDS = [
  'browser.extensions.list', ...BROWSER_EXTENSION_MUTATION_ACTION_IDS,
  'browser.extensions.openActionPopup', 'browser.extensions.openOptions',
] as const;
export type BrowserExtensionActionIdV1 = typeof BROWSER_EXTENSION_ACTION_IDS[number];
export function isBrowserExtensionActionIdV1(actionId: string): actionId is BrowserExtensionActionIdV1 {
  return (BROWSER_EXTENSION_ACTION_IDS as readonly string[]).includes(actionId);
}
export function isBrowserExtensionMutationActionIdV1(actionId: string): boolean {
  return (BROWSER_EXTENSION_MUTATION_ACTION_IDS as readonly string[]).includes(actionId);
}
