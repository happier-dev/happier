import type { SharedSavedSecretHomeActionIdV1 } from './savedSecretResourceActionIdsV1.js';
/** Action identity leaf: schema modules and the registry share these constants. */
export const PERSONAL_SAVED_SECRET_ACTION_IDS_V1 = ['secrets.list', 'secrets.usedBy', 'secrets.create', 'secrets.update', 'secrets.delete', 'secrets.link', 'secrets.export'] as const;

export function isPersonalSavedSecretReadActionIdV1(value: string): boolean {
  return value === 'secrets.list' || value === 'secrets.usedBy';
}

/** Resource effects used by the private Saved Secret writer, never audience management. */
const PERSONAL_SAVED_SECRET_RESOURCE_MUTATIONS_V1 = {
  'secrets.create': 'secrets.shared.create',
  'secrets.update': 'secrets.shared.update',
  'secrets.delete': 'secrets.shared.delete',
  'secrets.link': 'secrets.shared.promote',
  'secrets.export': 'secrets.shared.update',
} as const satisfies Record<Exclude<typeof PERSONAL_SAVED_SECRET_ACTION_IDS_V1[number], 'secrets.list' | 'secrets.usedBy'>, SharedSavedSecretHomeActionIdV1>;

export function personalSavedSecretResourceMutationActionIdV1(actionId: string):
  typeof PERSONAL_SAVED_SECRET_RESOURCE_MUTATIONS_V1[keyof typeof PERSONAL_SAVED_SECRET_RESOURCE_MUTATIONS_V1] | undefined {
  return Object.hasOwn(PERSONAL_SAVED_SECRET_RESOURCE_MUTATIONS_V1, actionId)
    ? PERSONAL_SAVED_SECRET_RESOURCE_MUTATIONS_V1[actionId as keyof typeof PERSONAL_SAVED_SECRET_RESOURCE_MUTATIONS_V1]
    : undefined;
}
