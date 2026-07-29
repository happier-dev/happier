import { describe, expect, it } from 'vitest';

import {
  SessionContinuationRecoveryIdentityV1Schema,
  SessionContinuationResumePromptModeV1Schema,
} from './recoveryV1.js';

describe('continuation recovery live contracts', () => {
  it('accepts only the supported resume prompt modes', () => {
    expect(SessionContinuationResumePromptModeV1Schema.options).toEqual([
      'standard',
      'off',
      'custom',
    ]);
    expect(SessionContinuationResumePromptModeV1Schema.safeParse('automatic').success).toBe(false);
  });

  it('requires the selector identity owned by each selection kind', () => {
    expect(SessionContinuationRecoveryIdentityV1Schema.safeParse({
      serviceId: 'openai-codex',
      selectionKind: 'group',
      groupId: 'codex-main',
      profileId: 'primary',
    }).success).toBe(true);
    expect(SessionContinuationRecoveryIdentityV1Schema.safeParse({
      serviceId: 'openai-codex',
      selectionKind: 'group',
    }).success).toBe(false);

    expect(SessionContinuationRecoveryIdentityV1Schema.safeParse({
      serviceId: 'openai-codex',
      selectionKind: 'profile',
      profileId: 'primary',
    }).success).toBe(true);
    expect(SessionContinuationRecoveryIdentityV1Schema.safeParse({
      serviceId: 'openai-codex',
      selectionKind: 'profile',
      groupId: 'codex-main',
      profileId: 'primary',
    }).success).toBe(false);
  });
});
