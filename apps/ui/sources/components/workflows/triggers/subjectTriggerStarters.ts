import type { IconName } from '@/components/ui/icons/Icon';

import type { TriggerSubject } from './accountTriggerRows';
import type { GuidedStarter } from './guidedAutomation';

/**
 * A subject page's suggested entries: a guided automation starter, or `addCheck`, which opens the trigger editor at
 * the service's own health form (a service can have several checks, so it is always offered).
 */
export type SubjectTriggerStarter = GuidedStarter | 'addCheck';

/**
 * The one starter table every subject page's Triggers section suggests when it is empty: what usually needs
 * watching on a Machine, an Environment or a service. Pages add a subject's starters here (MACH-COMPOSE-1107 §0.2,
 * shared by the Machine service page and the Environment page) instead of keeping their own list.
 */
export const SUBJECT_TRIGGER_STARTERS: Readonly<Record<TriggerSubject['kind'], readonly SubjectTriggerStarter[]>> = {
  machine: ['healthFailed', 'nightly'],
  environment: ['deploymentFailed', 'healthFailed', 'nightly'],
  service: ['addCheck', 'healthFailed', 'nightly'],
};

/**
 * The starters that stay under a subject's triggers once it has some (O-MACH 11-07): a service keeps Add a check and
 * Investigate when health fails, because the section can't know which checks already exist (checks can be observed
 * from another Machine); the editor asks which health source to use.
 */
export const SUBJECT_TRIGGER_PERSISTENT_STARTERS: Readonly<Record<TriggerSubject['kind'], readonly SubjectTriggerStarter[]>> = {
  machine: [],
  environment: [],
  service: ['addCheck', 'healthFailed'],
};

export const SUBJECT_TRIGGER_STARTER_GLYPH: Readonly<Record<SubjectTriggerStarter, IconName>> = {
  addCheck: 'plus',
  healthFailed: 'pulse',
  deploymentFailed: 'rocket-launch',
  nightly: 'moon',
};
