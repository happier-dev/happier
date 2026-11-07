export const BOT_TEMPLATE_DRAFT_ACTION_ID_V1 = 'template.draft';
export const BOT_TEMPLATE_OPEN_ACTION_ID_V1 = 'template.open';
export const BOT_TEMPLATE_INSTANTIATE_ACTION_ID_V1 = 'template.instantiate';
export const BOT_TEMPLATE_SETUP_APPLY_ROLE_V1 = 'template_setup_apply';
const BOT_TEMPLATE_RETAINED_EXECUTION_ROOT_ACTION_IDS_V1 = [BOT_TEMPLATE_INSTANTIATE_ACTION_ID_V1,
  'template.updates.diff', 'template.updates.apply', 'template.updates.skip', 'template.follow.stop'] as const;
export const BOT_TEMPLATE_ACTION_IDS_V1 = [BOT_TEMPLATE_DRAFT_ACTION_ID_V1, 'template.release', BOT_TEMPLATE_OPEN_ACTION_ID_V1, 'template.preview', 'template.export_file',
  ...BOT_TEMPLATE_RETAINED_EXECUTION_ROOT_ACTION_IDS_V1] as const;

export function isBotTemplateRetainedExecutionRootActionIdV1(actionId: string): boolean {
  return BOT_TEMPLATE_RETAINED_EXECUTION_ROOT_ACTION_IDS_V1.some((candidate) => candidate === actionId);
}

/** These Actions can acquire a selected Plugin template from a Machine npm profile. */
export function isBotTemplatePluginReadActionIdV1(actionId: string): boolean {
  return actionId === 'template.preview' || actionId === 'template.export_file'
    || actionId === 'template.instantiate'
    || actionId === 'template.updates.diff' || actionId === 'template.updates.apply';
}

export function isBotTemplateRestrictedPatHttpPurposeRootActionIdV1(actionId: string): boolean {
  return actionId !== BOT_TEMPLATE_OPEN_ACTION_ID_V1 && BOT_TEMPLATE_ACTION_IDS_V1.some((candidate) => candidate === actionId);
}

/** Copy and update retain token-only confinement for restricted API credentials. */
export function isBotTemplateCopyOrUpdateActionIdV1(actionId: string): actionId is 'template.instantiate' | 'template.updates.apply' {
  return actionId === 'template.instantiate' || actionId === 'template.updates.apply';
}

