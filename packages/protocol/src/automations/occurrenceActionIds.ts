/** Id-only leaf: Action catalog construction must not import Automation payload schemas. */
export const AUTOMATION_OCCURRENCE_ACTION_IDS = [
  'automation.run.cancel', 'automation.run.reply_handoff.retry', 'automation.run.result.redeliver',
] as const;
export type AutomationOccurrenceActionId = typeof AUTOMATION_OCCURRENCE_ACTION_IDS[number];
