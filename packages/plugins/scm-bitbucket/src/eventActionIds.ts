export const BITBUCKET_EVENT_ACTION_IDS = {
  setup: 'bitbucket/setup-repository-event',
  receive: 'bitbucket/accept-webhook',
  resetHistoryGap: 'bitbucket/reset-event-history-gap',
} as const;
