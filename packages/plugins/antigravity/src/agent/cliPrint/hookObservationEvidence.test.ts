import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { ANTIGRAVITY_HOOK_OBSERVATION_EVIDENCE } from './__fixtures__/hookObservationEvidence.test-support.js';

describe('Antigravity hook/observation evidence fixture', () => {
  it('keeps PreInvocation as the earliest correlation candidate, not a lifecycle fact', () => {
    expect(ANTIGRAVITY_HOOK_OBSERVATION_EVIDENCE.preInvocation).toEqual({
      event: 'PreInvocation',
      carriesConversationId: true,
      evidence: 'correlation_candidate',
      proves: [],
      perToolAllowedOnlyWhenNoLowerCadenceEvent: true,
    });
  });

  it('does not promote Stop/interrupt semantics or register an external-session hook or takeover without a pinned fixture', async () => {
    const activateSource = await readFile(
      new URL('../../activate.ts', import.meta.url),
      'utf8',
    );

    expect(ANTIGRAVITY_HOOK_OBSERVATION_EVIDENCE.stop).toEqual({
      fullyIdleMeaning: 'unproven',
      interruptCoverage: 'unproven',
      admittedFacts: [],
    });
    expect(activateSource).not.toMatch(/\bregisterExternalSessionHooks\s*\(/u);
    expect(activateSource).not.toMatch(/\bregisterExternalSessionTakeover\s*\(/u);
  });

  it('requires both canonical resolvers before online auto-link eligibility', () => {
    const { autoLink } = ANTIGRAVITY_HOOK_OBSERVATION_EVIDENCE;
    expect(autoLink.onlineRequirements).toEqual([
      'pinned_conversation_source_correlation',
      'resolveSource',
      'resolveLinkIdentity',
    ]);
    expect(autoLink.offline).toBe(
      'ineligible_until_stable_identity_and_authoritative_created_at_are_proven',
    );
  });
});
