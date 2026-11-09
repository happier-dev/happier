import { describe, expect, it } from 'vitest';
import { z } from 'zod/mini';

import { createStoredReadSchema } from '../../json/storedReadSchema.js';
import { PluginManifestV2LoadSchema } from '../manifest/load.js';
import { PluginManifestV2Schema } from '../manifest/v2.js';
import { PluginAvailabilityReleasePublishActionInputV1Schema } from './actions.js';
import {
  PluginAccountAvailabilityReleaseReadResponseV1Schema,
  PluginReleaseFactsV1LoadSchema,
  PluginReleaseFactsV1Schema,
} from './v1.js';

function manifest(contributes: Record<string, unknown>) {
  return { schemaVersion: 2, id: 'com.acme.fixture', version: '1.2.3', displayName: 'Fixture',
    engines: { happier: '^1.0.0' }, runtime: { apiVersion: 1 }, contributes };
}

function facts(normalizedManifest: unknown) {
  return { ref: { pluginId: 'com.acme.fixture', version: '1.2.3' },
    archiveDigestSha256: `sha256:${'a'.repeat(64)}`, normalizedManifest,
    collectionContracts: [], uiSlots: [],
    packageAssetArchive: { archiveDigestSha256: `sha256:${'d'.repeat(64)}`, resources: [] } };
}

describe('Availability stored manifest admission', () => {
  it('keeps new publication strict while stored response reads withdraw retired families', () => {
    expect(PluginAvailabilityReleasePublishActionInputV1Schema.safeParse({ facts: facts(manifest({})),
      sourceClass: 'registryPackage' }).success).toBe(true);
    for (const retired of [[], [{ id: 'retired' }]]) {
      const input = facts(manifest({ tools: retired, commands: retired }));
      expect(PluginReleaseFactsV1Schema.safeParse(input).success).toBe(false);
      expect(PluginAvailabilityReleasePublishActionInputV1Schema.safeParse({ facts: input,
        sourceClass: 'registryPackage' }).success).toBe(false);
      for (const schema of [PluginReleaseFactsV1LoadSchema, createStoredReadSchema(PluginReleaseFactsV1Schema)]) {
        const read = schema.parse(input);
        expect(read.normalizedManifest.contributes).not.toHaveProperty('tools');
        expect(read.normalizedManifest.contributes).not.toHaveProperty('commands');
      }
      // Persistence drops future record fields; wire and manifest envelopes stay closed.
      const stored = createStoredReadSchema(PluginReleaseFactsV1Schema).parse({ ...input, storedExtension: true });
      expect(stored).not.toHaveProperty('storedExtension');
      expect(PluginReleaseFactsV1LoadSchema.safeParse({ ...input, storedExtension: true }).success).toBe(false);
      const response = PluginAccountAvailabilityReleaseReadResponseV1Schema.parse({ availabilityCursor: 1, facts: input });
      expect(response.facts.normalizedManifest.contributes).not.toHaveProperty('tools');
    }
  });

  it('preserves canonical admission through generic stored readers without mutating typed leaves', () => {
    const healthy = Object.freeze({ id: 'healthy', title: 'Healthy', scopes: ['global'], surfaces: ['ui'],
      placementBindings: [], execution: { target: 'daemon' }, dangerLevel: 'safe',
      inputSchema: Object.freeze({ type: 'string', enum: undefined }) });
    const restricted = Object.freeze({ ...healthy, id: 'restricted', unknownRestriction: true });
    const contributes = Object.freeze({ actions: Object.freeze([healthy, restricted]),
      tools: Object.freeze([]), commands: Object.freeze([]) });
    const input = Object.freeze(manifest(contributes));
    const before = JSON.stringify(input);
    for (const schema of [PluginManifestV2LoadSchema, z.optional(PluginManifestV2LoadSchema)]) {
      expect(schema.parse(input)?.contributes.actions.map(action => action.id)).toEqual(['healthy']);
      expect(schema.safeParse({ ...input, unknownEnvelope: true }).success).toBe(false);
    }
    const stored = createStoredReadSchema(PluginReleaseFactsV1Schema);
    expect(stored.parse(facts(input)).normalizedManifest.contributes.actions.map(action => action.id)).toEqual(['healthy']);
    expect(stored.safeParse(facts({ ...input, unknownEnvelope: true })).success).toBe(false);
    expect(JSON.stringify(input)).toBe(before);
    expect(healthy.inputSchema).toHaveProperty('enum', undefined);
  });

  it('preserves the canonical output schema projection', () => {
    expect(z.toJSONSchema(PluginManifestV2LoadSchema, { unrepresentable: 'any' }))
      .toEqual(z.toJSONSchema(PluginManifestV2Schema, { unrepresentable: 'any' }));
  });
});
