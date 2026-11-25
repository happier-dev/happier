import { t } from '@/text';

import type { PendingActivationBannerPresentation } from './resolvePendingActivationBanner';

/**
 * The words the composer's status line says for queued input waiting on this Session to start
 * (`resolvePendingActivationBanner` decides the kind). Offline kinds name the Machine, so the person
 * reads which computer the message waits for rather than "this machine".
 */
export function pendingActivationLineCopy(
  kind: PendingActivationBannerPresentation['kind'],
  machine: string,
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
        text: t('session.pendingActivation.held.title'),
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
