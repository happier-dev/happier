import type { IconName } from '@/components/ui/icons/Icon';

import type { TriggerSubject } from './accountTriggerRows';
import type { GuidedStarter } from './guidedAutomation';

/**
 * The one starter table every subject page's Triggers section suggests when it is empty: what usually needs
 * watching on a Machine, an Environment or a service. Pages add a subject's starters here (MACH-COMPOSE-1107 §0.2,
 * shared by the Machine service page and the Environment page) instead of keeping their own list.
 */
export const SUBJECT_TRIGGER_STARTERS: Readonly<Record<TriggerSubject['kind'], readonly GuidedStarter[]>> = {
  machine: ['healthFailed', 'nightly'],
  environment: ['deploymentFailed', 'healthFailed', 'nightly'],
  service: ['healthFailed', 'nightly'],
};

export const SUBJECT_TRIGGER_STARTER_GLYPH: Readonly<Record<GuidedStarter, IconName>> = {
  healthFailed: 'pulse',
  deploymentFailed: 'rocket-launch',
  nightly: 'moon',
};
