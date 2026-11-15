import { describe, expect, it } from 'vitest';

import { t } from '@/text';
import { publicProfileMutationNotice, settlePublicProfileMutation } from './publicProfileMutation';

describe('publicProfileMutationNotice', () => {
  it('acknowledges a prepared update with its private-project omission fact', () => {
    let acknowledged: unknown;
    expect(settlePublicProfileMutation({ kind: 'updated', record: null, omittedPrivateProjectCount: 2 },
      (record, omittedPrivateProjectCount) => { acknowledged = { record, omittedPrivateProjectCount }; })).toBeNull();
    expect(acknowledged).toEqual({ record: null, omittedPrivateProjectCount: 2 });
  });
  it('preserves the preparation cause of a refused publish instead of reporting a generic mutation failure', () => {
    const notice = (reason: string) => publicProfileMutationNotice({ ok: false,
      errorCode: 'public_profile_preparation_unavailable', error: 'Preparation unavailable', details: { reason } });
    expect(notice('no_eligible_personal_usage')).toBe(t('publicIdentity.profile.reasons.no_eligible_personal_usage'));
    expect(notice('source_time_unavailable')).toBe(t('publicIdentity.profile.reasons.source_time_unavailable'));
    expect(notice('no_eligible_personal_usage')).not.toBe(notice('source_time_unavailable'));
    expect(notice('private diagnostic')).toBe(t('publicIdentity.profile.actionFailed'));
    expect(publicProfileMutationNotice({ ok: false, errorCode: 'public_profile_preparation_unavailable',
      error: 'Preparation unavailable', details: { reason: 'no_eligible_personal_usage' },
      operationCredentialUses: [],
    })).toBe(t('publicIdentity.profile.reasons.no_eligible_personal_usage'));
  });

  it('settles an acknowledged update without a follow-on refresh, and preserves a refused preparation cause', () => {
    expect(publicProfileMutationNotice({ kind: 'updated', record: null })).toBeNull();
    expect(publicProfileMutationNotice({ kind: 'unavailable', reason: 'not_published' }))
      .toBe(t('publicIdentity.profile.reasons.not_published'));
  });
});
