import { z } from 'zod';

import {
  PluginPermissionGrantDismissRequestActionInputV1Schema,
  PluginPermissionGrantDismissRequestActionOutputV1Schema,
  PluginPermissionGrantGrantActionInputV1Schema,
  PluginPermissionGrantGrantActionOutputV1Schema,
  PluginPermissionGrantListActionInputV1Schema,
  PluginPermissionGrantListActionOutputV1Schema,
  PluginPermissionGrantRequestActionInputV1Schema,
  PluginPermissionGrantRequestActionOutputV1Schema,
  PluginPermissionGrantRevokeActionInputV1Schema,
  PluginPermissionGrantRevokeActionOutputV1Schema,
} from './grants.js';

export const PLUGIN_PERMISSION_GRANT_ACTION_IDS_V1 = Object.freeze([
  'plugins.permissions.grants.list',
  'plugins.permissions.grants.request',
  'plugins.permissions.grants.grant',
  'plugins.permissions.grants.revoke',
  'plugins.permissions.grants.dismissRequest',
] as const);

export const PluginPermissionGrantActionIdV1Schema = z.enum(PLUGIN_PERMISSION_GRANT_ACTION_IDS_V1);
export type PluginPermissionGrantActionIdV1 = z.infer<typeof PluginPermissionGrantActionIdV1Schema>;

export const PluginPermissionGrantActionInputSchemasV1 = Object.freeze({
  'plugins.permissions.grants.list': PluginPermissionGrantListActionInputV1Schema,
  'plugins.permissions.grants.request': PluginPermissionGrantRequestActionInputV1Schema,
  'plugins.permissions.grants.grant': PluginPermissionGrantGrantActionInputV1Schema,
  'plugins.permissions.grants.revoke': PluginPermissionGrantRevokeActionInputV1Schema,
  'plugins.permissions.grants.dismissRequest': PluginPermissionGrantDismissRequestActionInputV1Schema,
});

export const PluginPermissionGrantActionOutputSchemasV1 = Object.freeze({
  'plugins.permissions.grants.list': PluginPermissionGrantListActionOutputV1Schema,
  'plugins.permissions.grants.request': PluginPermissionGrantRequestActionOutputV1Schema,
  'plugins.permissions.grants.grant': PluginPermissionGrantGrantActionOutputV1Schema,
  'plugins.permissions.grants.revoke': PluginPermissionGrantRevokeActionOutputV1Schema,
  'plugins.permissions.grants.dismissRequest': PluginPermissionGrantDismissRequestActionOutputV1Schema,
});
