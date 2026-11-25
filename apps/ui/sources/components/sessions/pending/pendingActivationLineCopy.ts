import { t } from '@/text';

import type { PendingActivationBannerPresentation } from './resolvePendingActivationBanner';

/**
 * The words the composer's status line says for queued input waiting on this Session to start
 * (`resolvePendingActivationBanner` decides the kind and action). The line names the Machine
 * while offline and when a held message can resume.
 */
export function pendingActivationLineCopy(
  kind: PendingActivationBannerPresentation['kind'],
  machine: string,
  primaryAction: PendingActivationBannerPresentation['primaryAction'] = null,
): Readonly<{ text: string; detail: string }> {
  switch (kind) {
    case 'queued_offline':
      return {
        text: t('session.pendingActivation.queued_offline.title', { machine }),
        detail: t('session.pendingActivation.queued_offline.body'),
      };
    case 'held_offline':
      return {
        text: t('session.pendingActivation.held_offline.title', { machine }),
        detail: t('session.pendingActivation.held_offline.body', { machine }),
      };
    case 'waiting_offline':
      return {
        text: t('session.pendingActivation.waiting_offline.title', { machine }),
        detail: t('session.pendingActivation.waiting_offline.body', { machine }),
      };
    case 'queued':
      return {
        text: t('session.pendingActivation.queued.title'),
        detail: t('session.pendingActivation.queued.body'),
      };
    case 'held':
      return {
        text: primaryAction === 'resume'
          ? t('session.pendingActivation.held.machineBackTitle', { machine })
          : t('session.pendingActivation.held.title'),
        detail: t('session.pendingActivation.held.body'),
      };
    case 'waiting':
      return {
        text: t('session.pendingActivation.waiting.title'),
        detail: t('session.pendingActivation.waiting.body'),
      };
    case 'failed':
      return {
        text: t('session.pendingActivation.failed.title'),
        detail: t('session.pendingActivation.failed.body'),
      };
  }
}
