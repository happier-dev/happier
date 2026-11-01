export const PUSH_NOTIFICATION_CATEGORY_IDS = {
  permissionRequestV1: 'happier.permissionRequest.v1',
  userActionRequestV1: 'happier.userActionRequest.v1',
  questionChoices1V1: 'happier.questionChoices1.v1',
  questionChoices2V1: 'happier.questionChoices2.v1',
  questionChoices3V1: 'happier.questionChoices3.v1',
  questionTextV1: 'happier.questionText.v1',
} as const;

export const PUSH_NOTIFICATION_ACTION_IDS = {
  permissionAllowV1: 'HAPPIER_PERMISSION_ALLOW_V1',
  permissionDenyV1: 'HAPPIER_PERMISSION_DENY_V1',
  userActionOpenV1: 'HAPPIER_USER_ACTION_OPEN_V1',
  questionChoice1V1: 'HAPPIER_QUESTION_CHOICE_1_V1',
  questionChoice2V1: 'HAPPIER_QUESTION_CHOICE_2_V1',
  questionChoice3V1: 'HAPPIER_QUESTION_CHOICE_3_V1',
  questionTextV1: 'HAPPIER_QUESTION_TEXT_V1',
} as const;

export const PUSH_NOTIFICATION_ANDROID_CHANNEL_IDS = {
  defaultV1: 'default',
  permissionRequestsV1: 'happier.permissionRequests.v1',
  userActionRequestsV1: 'happier.userActionRequests.v1',
} as const;
