import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { createOpenCodeExternalSessionObservationContribution } from './observation.js';
import { OPEN_CODE_HOOK_OBSERVATION_EVIDENCE } from './__fixtures__/hookObservationEvidence.test-support.js';

describe('OpenCode hook/observation evidence fixture', () => {
  it('keeps endpoint, auth generation, directory, and native session identity distinct', () => {
    const contribution = createOpenCodeExternalSessionObservationContribution({
      env: {
        HAPPIER_OPENCODE_SERVER_URL:
          OPEN_CODE_HOOK_OBSERVATION_EVIDENCE.identity.endpoint,
      },
    });
    const first = contribution.describeResource(
      OPEN_CODE_HOOK_OBSERVATION_EVIDENCE.identity.first,
    );
    const otherDirectory = contribution.describeResource(
      OPEN_CODE_HOOK_OBSERVATION_EVIDENCE.identity.otherDirectory,
    );

    expect(first.resourceKey).toBe(otherDirectory.resourceKey);
    expect(first.linkKey).not.toBe(otherDirectory.linkKey);
    expect(OPEN_CODE_HOOK_OBSERVATION_EVIDENCE.identity.resourceIncludes).toEqual([
      'endpoint',
      'auth_generation',
    ]);
    expect(OPEN_CODE_HOOK_OBSERVATION_EVIDENCE.identity.linkIncludes).toEqual([
      'directory',
      'native_session_id',
    ]);
  });

  it('pins successful absence to idle and failed retrieval to unknown', () => {
    expect(OPEN_CODE_HOOK_OBSERVATION_EVIDENCE.statusCases).toEqual([
      {
        fetch: 'successful',
        sessionPresent: false,
        admittedTurnPhase: 'idle',
      },
      {
        fetch: 'failed',
        sessionPresent: false,
        admittedTurnPhase: 'unknown',
      },
    ]);
  });

  it('prefers native observation without registering external-session hooks', async () => {
    const activateSource = await readFile(
      new URL('../../../../activate.ts', import.meta.url),
      'utf8',
    );

    expect(OPEN_CODE_HOOK_OBSERVATION_EVIDENCE.nativeObservation).toEqual({
      preferred: true,
      configRecipe: 'none',
      reconnectWithoutReplayId: 'reconcile',
    });
    expect(activateSource).not.toMatch(/\bregisterExternalSessionHooks\s*\(/u);
    expect(activateSource).not.toMatch(/\bregisterExternalSessionHookRecipes\s*\(/u);
  });

  it('reconciles replay uncertainty and keeps offline auto-link closed', () => {
    expect(OPEN_CODE_HOOK_OBSERVATION_EVIDENCE.autoLink.online).toMatchObject({
      requiresResolveSource: true,
      requiresResolveLinkIdentity: true,
      eligibleAfterBothResolvers: true,
    });
    expect(OPEN_CODE_HOOK_OBSERVATION_EVIDENCE.autoLink.offline).toMatchObject({
      requiresAuthoritativeCreatedAt: true,
      missingAuthoritativeCreatedAt: 'browse_only',
    });
  });
});
