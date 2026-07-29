import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { createOhMyPiExternalSessionObservationContribution } from './observation.js';
import { OH_MY_PI_HOOK_OBSERVATION_EVIDENCE } from './__fixtures__/hookObservationEvidence.test-support.js';

describe('Oh My Pi hook/observation evidence fixture', () => {
  it('keeps observation reconcile-only until an exact event and installed version are pinned', async () => {
    const contribution = createOhMyPiExternalSessionObservationContribution({
      env: { PI_CODING_AGENT_DIR: '/fixture/omp' },
      readFileState: async () => ({
        dev: 1,
        ino: 2,
        birthtimeMs: 3,
        mtimeMs: 4,
      }),
    });
    const descriptor = contribution.describeResource(
      OH_MY_PI_HOOK_OBSERVATION_EVIDENCE.linkedSource,
    );
    const activateSource = await readFile(
      new URL('../../../../activate.ts', import.meta.url),
      'utf8',
    );

    await expect(contribution.reconcileResource({
      purpose: 'resource_descriptors',
      resourceKey: descriptor.resourceKey,
      links: [{
        linkKey: descriptor.linkKey,
        linkedSource: OH_MY_PI_HOOK_OBSERVATION_EVIDENCE.linkedSource,
      }],
      signal: new AbortController().signal,
    })).resolves.toEqual({
      purpose: 'resource_descriptors',
      outcomes: [{
        kind: 'described',
        descriptor: {
          ...descriptor,
          changeObservation: 'reconcile_only',
        },
      }],
    });
    expect(OH_MY_PI_HOOK_OBSERVATION_EVIDENCE.recipe).toEqual({
      disposition: 'none',
      installedVersion: 'unproven',
      exactEventContract: 'unproven',
      borrowedPiEventNames: false,
    });
    expect(activateSource).not.toMatch(/\bregisterExternalSessionHooks\s*\(/u);
    expect(activateSource).not.toMatch(/\bregisterExternalSessionHookRecipes\s*\(/u);
  });

  it('does not promote path or mtime to lifecycle, boundary, identity, or creation time', () => {
    expect(OH_MY_PI_HOOK_OBSERVATION_EVIDENCE.fileEvidence).toEqual({
      mayProve: ['recent_activity_after_successful_qualified_read'],
      mayNotProve: [
        'liveness',
        'working',
        'idle',
        'retrying',
        'completed_boundary',
        'interrupt',
        'process_exit',
        'identity',
        'authoritative_created_at',
      ],
    });
    expect(OH_MY_PI_HOOK_OBSERVATION_EVIDENCE.autoLink).toEqual({
      online: 'ineligible_until_both_resolvers_have_authoritative_identity',
      offline: 'ineligible_without_authoritative_identity_and_created_at',
    });
  });
});
