
/** Action identity leaf: schema modules and the registry share these constants. */
export const MANAGED_IDENTITY_PROVIDER_ACTION_IDS_V1 = [
  'identity.providers.list',
  'identity.providers.create',
  'identity.providers.update',
  'identity.providers.secret.replace',
  'identity.providers.validate',
  'identity.providers.test.start',
  'identity.providers.test.consume',
  'identity.providers.enable',
  'identity.providers.disable',
  'identity.providers.remove.preview',
  'identity.providers.remove',
] as const;
