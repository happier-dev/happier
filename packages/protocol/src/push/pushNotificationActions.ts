export const PUSH_NOTIFICATION_CATEGORY_IDS = {
  permissionRequestV1: 'happier.permissionRequest.v1',
  userActionRequestV1: 'happier.userActionRequest.v1',
} as const;

export const PUSH_NOTIFICATION_ACTION_IDS = {
  permissionAllowV1: 'HAPPIER_PERMISSION_ALLOW_V1',
  permissionDenyV1: 'HAPPIER_PERMISSION_DENY_V1',
  userActionOpenV1: 'HAPPIER_USER_ACTION_OPEN_V1',
} as const;

export const PUSH_NOTIFICATION_ANDROID_CHANNEL_IDS = {
  defaultV1: 'default',
  permissionRequestsV1: 'happier.permissionRequests.v1',
  userActionRequestsV1: 'happier.userActionRequests.v1',
} as const;
