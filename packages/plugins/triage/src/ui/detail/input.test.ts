import { TriageDetailSurfaceInputV1Schema } from '@happier-dev/triage-protocol/v1';
import { createTriageSourceV1Fixture } from '@happier-dev/triage-protocol/testing/v1';
import { describe, expect, it } from 'vitest';

import { buildTriageDetailSurfaceInputV1 } from './input.js';
import type { TriageSurfaceSelectionV1 } from '../state/surface.js';

const FIXTURE = createTriageSourceV1Fixture();
const INSTANCE = FIXTURE.configuredInstance;
const OBSERVATION = FIXTURE.detailInput.observation;

const SELECTION: TriageSurfaceSelectionV1 = {
  sectionId: '2-open',
  entryRef: OBSERVATION.entryRef,
  sourceInstanceId: INSTANCE.instance.sourceInstanceId,
};

function build(overrides: Partial<Parameters<typeof buildTriageDetailSurfaceInputV1>[0]> = {}) {
  return buildTriageDetailSurfaceInputV1({
    selection: SELECTION,
    instance: INSTANCE,
    observation: OBSERVATION,
    linkedSessions: FIXTURE.detailInput.linkedSessions,
    ...overrides,
  });
}

describe('Triage detail surface input', () => {
  it('admits the exact closed contract value the source detail renderer receives', () => {
    const built = build();

    expect(built.kind).toBe('admitted');
    // Parsing back through the published schema is what proves no aggregate
    // freshness field, refresh marker, credential, DTO, registry, callback or
    // renderer id rode along: the object is closed.
    expect(built.kind === 'admitted' && TriageDetailSurfaceInputV1Schema.parse(built.input))
      .toEqual(built.kind === 'admitted' ? built.input : null);
    expect(built.kind === 'admitted' && Object.keys(built.input).sort())
      .toEqual(['instance', 'linkedSessions', 'observation', 'v']);
  });

  it('refuses an observation for a different entry than the one the user selected', () => {
    const otherEntry = { ...OBSERVATION, entryRef: { ...OBSERVATION.entryRef, entryId: '999' } };

    // Rendering a source body for an entry the row never named is the silent
    // wrong-detail failure this boundary exists to stop.
    expect(build({ observation: otherEntry })).toEqual({
      kind: 'refused',
      reason: 'entryMismatch',
    });
  });

  it('refuses an instance that is not the selected observing connection', () => {
    const otherInstance = {
      ...INSTANCE,
      instance: {
        ...INSTANCE.instance,
        sourceInstanceId: '9f0d4ab7-6c4a-4f9d-9b2e-0f1a2b3c4d5e',
      },
    };

    expect(build({ instance: otherInstance })).toEqual({
      kind: 'refused',
      reason: 'instanceMismatch',
    });
  });

  it('refuses an instance contributed by a different source than the entry', () => {
    const foreignSource = {
      ...INSTANCE,
      instance: {
        ...INSTANCE.instance,
        source: { ...INSTANCE.instance.source, localId: 'other-forge' },
      },
    };

    // Same stable id under a different admitted contribution would mount one
    // source's renderer against another source's entry.
    expect(build({ instance: foreignSource })).toEqual({
      kind: 'refused',
      reason: 'instanceMismatch',
    });
  });

  it('refuses rather than truncating a linked-Session projection the contract cannot carry', () => {
    const tooMany = Array.from({ length: 64 }, (_unused, index) => ({
      sessionId: `session-${index}`,
    }));

    const built = build({ linkedSessions: tooMany });

    expect(built.kind).toBe('refused');
    expect(built.kind === 'refused' && built.reason).toBe('invalidContractValue');
  });

  it('carries an empty linked-Session projection as the explicit "no links" fact', () => {
    const built = build({ linkedSessions: [] });

    expect(built.kind === 'admitted' && built.input.linkedSessions).toEqual([]);
  });
});
