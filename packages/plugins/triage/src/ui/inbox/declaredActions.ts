import { TRIAGE_SUBJECT_ACTION_DECLARATIONS_V1 } from '@happier-dev/triage-protocol/v1';

/** Native first-paint rows derive from the same declarations as the configured catalog. */
export const TRIAGE_DECLARED_FAILURE_ACTIONS = TRIAGE_SUBJECT_ACTION_DECLARATIONS_V1.map(declaration => ({
  subjects: [...declaration.appliesTo],
  actionId: declaration.actionId,
  label: declaration.label,
  launchMode: declaration.launchMode,
  startable: true,
}));
