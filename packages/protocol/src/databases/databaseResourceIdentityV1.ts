import { DATABASE_CAPTURE_STATUS_ACTION_ID_V1 } from '../actions/actionIdsDatabaseV1.js';

/** Neutral Resource identity; executable database grammar stays in database-protocol. */
export const DATABASE_CONNECTION_RESOURCE_ID_V1 = 'connection';

export const DATABASE_CAPTURE_RESOURCE_ID_V1 = 'capture-view' as const;
export const DATABASE_CAPTURE_RESOURCE_REF_V1 = Object.freeze({
  pluginId: DATABASE_CAPTURE_STATUS_ACTION_ID_V1.split('/actions/')[0]!,
  contributionId: DATABASE_CAPTURE_RESOURCE_ID_V1,
});
