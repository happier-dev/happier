import * as React from 'react';
import type { PublicProfileField } from '@happier-dev/protocol/account/publicProfile';

import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { t } from '@/text';
import type { PublicProfileConsentState } from './usePublicProfileConsent';

const ACTION_TEST_ID = 'public-data-consent-action';

/**
 * The one line that follows a published consent change: pending names the request without claiming
 * it is saved; an acknowledgement says what visitors now get and offers Undo; a refusal keeps the page
 * unchanged and offers the same change again; an uncertain dispatch asks to check before retrying.
 */
export function PublicProfileConsentStatus(
  props: Readonly<{
    state: PublicProfileConsentState;
    onUndo: () => void;
    onRetry: (field: PublicProfileField, shown: boolean) => void;
    onCheck: () => void;
  }>,
): React.ReactElement | null {
  const { state } = props;
  if (state.kind === 'idle') return null;
  const item = t(`publicIdentity.publicData.fields.${state.field}`);
  const line = (
    kind: 'loading' | 'success' | 'warning' | 'error',
    title: string,
    action?: Readonly<{ label: string; onPress: () => void }>,
  ) => (
    <SurfaceStateCard
      testID="public-data-consent-status"
      kind={kind}
      layout="inline"
      size="line"
      title={title}
      {...(action ? { action: { ...action, testID: ACTION_TEST_ID } } : {})}
    />
  );
  switch (state.kind) {
    case 'pending':
      return line(
        'loading',
        state.shown
          ? t('publicIdentity.publicData.consent.sharing', { item })
          : t('publicIdentity.publicData.consent.hiding', { item }),
      );
    case 'acknowledged': {
      const shownNow = !state.previousShown;
      const title = !shownNow
        ? t('publicIdentity.publicData.consent.hidden', { item })
        : t('publicIdentity.publicData.consent.shared', { item });
      return line('success', title, {
        label: t('publicIdentity.publicData.consent.undo'),
        onPress: props.onUndo,
      });
    }
    case 'failed':
      if (state.errorCode === 'action_uncertain') {
        return line(
          'warning',
          t('publicIdentity.publicData.consent.uncertain', { item }),
          {
            label: t('publicIdentity.publicData.consent.check'),
            onPress: props.onCheck,
          },
        );
      }
      return line(
        'error',
        state.shown
          ? t('publicIdentity.publicData.consent.failedShare', { item })
          : t('publicIdentity.publicData.consent.failedHide', { item }),
        {
          label: t('publicIdentity.publicData.consent.retry'),
          onPress: () => props.onRetry(state.field, state.shown),
        },
      );
  }
}
