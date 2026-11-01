import { afterEach, describe, expect, it, vi } from 'vitest';

import { withRealForegroundAdmissionFixture } from './foregroundAdmission.testkit';
import { createClaudeForegroundConnectedAccountFixture } from './prepareForegroundAdmission.codexConnectedServices.testkit';

describe('connected Claude foreground launch', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each(['absent', 'another-account'] as const)('commits the admitted connected Claude account when the saved default is %s', async savedDefault => {
    const account = await createClaudeForegroundConnectedAccountFixture(['work', 'personal']);
    try {
      // --auth is a one-start selection, independent of a saved purpose default.
      await account.store.update(current => ({
        ...current, bindings: savedDefault === 'absent' ? [] : [{
          purpose: account.purpose,
          target: { kind: 'account', account: { service: account.service, accountId: 'personal' } },
        }],
      }));
      await withRealForegroundAdmissionFixture({ runtimeOptions: account.runtimeOptions }, async fixture => {
        const admission = await fixture.prepare({
          agentId: 'claude',
          backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
          connectedServices: account.connectedServices,
        }, await account.dependenciesFor(fixture.runtime.registry, fixture.directory));
        expect(admission).toMatchObject({ ok: true });
        if (!admission.ok) throw new Error(admission.error.code);
        const claimed = await admission.prepared.claim({
          canonicalSessionId: 'claude-connected-session', httpPort: 40123,
          foregroundSatisfiedProfileSecretRequirementNames: [],
        });
        expect(claimed).toMatchObject({ ok: true });
        if (!claimed.ok) throw new Error(claimed.error.code);
        expect(claimed.sessionConnectedAccounts).toContainEqual(expect.objectContaining({
          purpose: 'model_upstream', account: { service: account.service, accountId: 'work' },
        }));
        expect(claimed.connectedServiceRuntimeTarget?.exactPurposeBindingSubjectId).toBe('agent-session:claude-connected-session');
      });
    } finally { await account.cleanup(); }
  });

});
