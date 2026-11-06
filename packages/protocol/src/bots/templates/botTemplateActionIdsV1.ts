export const BOT_TEMPLATE_OPEN_ACTION_ID_V1 = 'template.open';
export const BOT_TEMPLATE_ACTION_IDS_V1 = ['template.draft', 'template.release', 'template.open', 'template.preview', 'template.export_file', 'template.instantiate',
  'template.updates.diff', 'template.updates.apply', 'template.updates.skip', 'template.follow.stop'] as const;

export function isBotTemplateRestrictedPatHttpPurposeRootActionIdV1(actionId: string): boolean {
  return actionId !== BOT_TEMPLATE_OPEN_ACTION_ID_V1 && BOT_TEMPLATE_ACTION_IDS_V1.some((candidate) => candidate === actionId);
}
