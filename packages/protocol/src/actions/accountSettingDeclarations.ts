/** Shared Account bindings consumed by the UI declaration and the headless Action host. */
export const DELEGATION_SETTING_DECLARATIONS_V1 = {
  approvalReviewerEnabled: {
    anchor: 'delegation.approvalReviewerEnabled', pageId: 'delegation',
    storage: { scope: 'account', key: 'approvalReviewerEnabled', access: 'read_write' },
    titleKey: 'roles.delegation.approvalReviewer',
    descriptionKey: 'roles.delegation.approvalReviewerDescription',
    presentUserOnly: true,
  },
  workDepthLimit: {
    anchor: 'delegation.workDepthLimit', pageId: 'delegation',
    storage: { scope: 'account', key: 'workDepthLimit', access: 'read_write' },
    titleKey: 'roles.delegation.depthSetting',
    keywordKeys: ['roles.delegation.ladderRefused'],
    presentUserOnly: false,
  },
} as const;

export function readAccountSettingDeclarationV1(anchor: unknown) {
  return Object.values(DELEGATION_SETTING_DECLARATIONS_V1).find(declaration => declaration.anchor === anchor) ?? null;
}

export function isPresentUserSettingWriteV1(actionId: string, input: unknown): boolean {
  return actionId === 'settings.set' && typeof input === 'object' && input !== null
    && 'anchor' in input && readAccountSettingDeclarationV1(input.anchor)?.presentUserOnly === true;
}
