import { t } from '@/text';

import type { ObservedWorkerSettingNotice } from './useObservedWorkerSetting';

/** Shared worker-setting copy; Service placement keeps its own domain wording. */
export function describeObservedWorkerSettingNotice(notice: ObservedWorkerSettingNotice): string | null {
  switch (notice) {
    case 'saving':
      return t('projectWorkers.saving');
    case 'approval':
      return t('projectWorkers.approvalPending');
    case 'unknown':
      return t('projectWorkers.writeUnknown');
    case 'changed':
      return t('projectWorkers.changed');
    case 'failed':
      return t('projectWorkers.saveFailed');
    case 'locked':
      return t('projectWorkers.settingsLocked');
    default:
      return null;
  }
}
