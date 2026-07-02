import { describe, expect, it } from 'vitest';

import { verifyResumeReachableGemini } from './verifyResumeReachableGemini';

describe('verifyResumeReachableGemini', () => {
  it('fails closed because Gemini shared-state resume reachability is unsupported', async () => {
    await expect(verifyResumeReachableGemini({
      targetMaterializedRoot: '/tmp/fake',
      targetMaterializedEnv: {},
      vendorResumeId: 'vendor-session-1',
      cwd: '/tmp/fake',
    })).resolves.toEqual({
      ok: false,
      reason: 'gemini_state_not_shared',
    });
  });
});
