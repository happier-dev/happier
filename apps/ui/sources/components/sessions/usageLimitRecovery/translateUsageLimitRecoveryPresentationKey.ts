import { t, tLoose } from '@/text';

import type {
  SessionUsageLimitRecoveryTranslate,
  SessionUsageLimitRecoveryTranslationParams,
} from './sessionUsageLimitRecoveryPresentation';

/** The app translator for the usage-limit presenter: parameterized keys keep their typed params. */
export const translateUsageLimitRecoveryPresentationKey: SessionUsageLimitRecoveryTranslate =
  (key, ...params) => {
    if (key === 'session.usageLimitRecovery.banner.resetCreditSummary') {
      const [resetCreditSummaryParams] = params as [
        SessionUsageLimitRecoveryTranslationParams['session.usageLimitRecovery.banner.resetCreditSummary'],
      ];
      return t(
        'session.usageLimitRecovery.banner.resetCreditSummary',
        resetCreditSummaryParams,
      );
    }
    return tLoose(key);
  };
