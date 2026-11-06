/** Shared fallback messages; native plugins merge this into their declared locale bundle. */
export const FORGE_CI_ENGLISH_V1 = Object.freeze({
  'forgeCi.state.rateLimited.title': '{forge} request limit',
  'forgeCi.state.rateLimited.reset': '{forge} is limiting requests from {who}. Requests can resume after {time}.',
  'forgeCi.state.rateLimited.waitingTitle': 'Waiting on {forge}',
  'forgeCi.state.rateLimited.waiting': '{forge} is limiting requests from {who}. Try again when the limit has eased.',
  'forgeCi.state.retry': 'Retry',
  'forgeCi.state.tryAgain': 'Try again',
  'forgeCi.count.running': 'Running',
  'forgeCi.count.failed': 'Failed',
  'forgeCi.count.population': 'Recent branch runs',
  'forgeCi.credentialsExpired': 'Reconnect account',
  'forgeCi.uncertainWriteOutcome': 'Result unknown — check status',
  'forgeCi.safeStatusRefresh': 'Refresh status',
  'forgeCi.annotationsCountUnknown': 'Annotations — count unknown',
});

export const FORGE_CI_TRANSLATIONS_V1 = Object.freeze({ en: FORGE_CI_ENGLISH_V1 });
