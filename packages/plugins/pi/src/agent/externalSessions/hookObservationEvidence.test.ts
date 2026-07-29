import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { classifyPiAgentEndBoundary } from '../runtime/rpc/lifecycle.js';
import { PI_HOOK_OBSERVATION_EVIDENCE } from './__fixtures__/hookObservationEvidence.test-support.js';

describe('Pi hook/observation evidence fixture', () => {
  it('treats agent_end as an attempt boundary and respects willRetry', () => {
    expect(
      PI_HOOK_OBSERVATION_EVIDENCE.lifecycle.map(({ input }) =>
        classifyPiAgentEndBoundary(input)),
    ).toEqual(
      PI_HOOK_OBSERVATION_EVIDENCE.lifecycle.map(({ expected }) => expected),
    );
  });

  it('does not assume agent_settled, derive file busy, or register an external-session hook or takeover', async () => {
    const activateSource = await readFile(
      new URL('../../activate.ts', import.meta.url),
      'utf8',
    );

    expect(PI_HOOK_OBSERVATION_EVIDENCE.agentSettled).toEqual({
      installedVersion: '0.75.5',
      exposedByPinnedInstalledVersion: false,
      disposition: 'ignored_unless_a_future_pinned_version_exposes_it',
    });
    expect(PI_HOOK_OBSERVATION_EVIDENCE.fileOnly).toEqual({
      observation: 'reconcile_only',
      mayProveWorking: false,
      mayProveCompletedBoundary: false,
    });
    expect(activateSource).not.toMatch(/\bregisterExternalSessionHooks\s*\(/u);
    expect(activateSource).not.toMatch(/\bregisterExternalSessionTakeover\s*\(/u);
  });

  it('keeps auto-link closed until identity and authoritative time are proven', () => {
    expect(PI_HOOK_OBSERVATION_EVIDENCE.autoLink).toEqual({
      online: 'ineligible_until_persisted_identity_passes_both_resolvers',
      offline: 'ineligible_until_identity_and_authoritative_created_at_are_pinned',
    });
  });
});
