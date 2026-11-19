import type { SupportedLanguage } from '../_all';

export const deploymentMoveTranslations = {
  "en": {
    "service": "Service to check",
    "dataReviewLead": "Review the source services to stop and the app changes. The Workflow stops writes, verifies a final backup, restores and checks the destination, then deploys the app. The original data stays on the source. An uncertain cutover needs your decision in the run before continuing.",
    "writers": "Services to stop",
    "writerReviewRequired": "The source writers could not be identified. Review the source services and their running state, then try again.",
    "noRunningWriter": "Start the app services that should use the moved database, then review Move again.",
    "noConnectedServices": "No service in this Environment connects to this database.",
    "stopped": "Already stopped · stays stopped",
    "menu": "Move to another Machine…",
    "title": "Move to another Machine",
    "description": "Uses the same commit. The source stays online until the destination is healthy; its local data is retained.",
    "restriction": "Only repository apps without Domains or local data can move here.",
    "stateless": "This app has no local data to move",
    "source": "From",
    "destination": "To",
    "run": "Move"
  },
} satisfies Pick<Record<SupportedLanguage, Readonly<Record<'menu' | 'title' | 'description' | 'restriction' | 'stateless' | 'service' | 'source' | 'destination' | 'run' | 'dataReviewLead' | 'writers' | 'writerReviewRequired' | 'noRunningWriter' | 'noConnectedServices' | 'stopped', string>>>, 'en'>;
