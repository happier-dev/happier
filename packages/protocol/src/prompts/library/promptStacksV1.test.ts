import { describe, expect, it } from 'vitest';

import predecessorPickerStack from '../../../fixtures/0.2-picker-skill-instructions-stack.json';
import { decodeBase64 } from '../../crypto/base64.js';
import { PromptBundleBodyV1Schema } from './promptBundleSchemas.js';
import { PromptStackEntryV1Schema, PromptStacksV1Schema } from './promptStacksV1.js';
import { resolvePromptStackSystemAppendBlocksV1 } from './resolvePromptStackSystemAppendBlocksV1.js';

describe('PromptStacksV1Schema', () => {
  it('defaults to empty stacks when missing', () => {
    const parsed = PromptStacksV1Schema.parse({});
    expect(parsed).toEqual({
      v: 1,
      surfaces: {
        coding: [],
        voice: [],
        profilesById: {},
      },
    });
  });

  it('parses stack entries with defaults', () => {
    const parsed = PromptStacksV1Schema.parse({
      v: 1,
      surfaces: {
        coding: [
          {
            id: 'e1',
            ref: { kind: 'doc', artifactId: 'a1' },
          },
        ],
      },
    });

    expect(parsed.surfaces.coding[0]).toEqual({
      id: 'e1',
      ref: { kind: 'doc', artifactId: 'a1' },
      enabled: true,
      placement: 'system_append',
    });
  });

  it('reopens the predecessor picker skill placement and drops only the retired edit annotation', () => {
    const parsed = PromptStacksV1Schema.parse({ v: 1, surfaces: { coding: [
      { id: 'skill', ref: { kind: 'bundle', artifactId: 'skill-doc' }, enabled: true,
        placement: 'skill_instructions', editPolicy: 'agent_may_propose_requires_approval' },
      { id: 'required', ref: { kind: 'doc', artifactId: 'instructions', serverId: 'home' },
        enabled: true, placement: 'system_append', required: true },
    ] } });
    expect(parsed.surfaces.coding.map(entry => entry.placement)).toEqual(['skill_instructions', 'system_append']);
    expect(parsed.surfaces.coding[0]).not.toHaveProperty('editPolicy');
    expect(parsed.surfaces.coding[1]).toMatchObject({ required: true, ref: { serverId: 'home' } });
  });

  it('reads, migrates, writes and reopens the captured 0.2 picker skill between its neighboring documents', async () => {
    // The vector comes from the real predecessor picker callback, not current types.
    const migrated = PromptStacksV1Schema.parse(predecessorPickerStack.stacks);
    const expectedEntries = predecessorPickerStack.stacks.surfaces.coding.map(({ editPolicy: _retired, ...entry }) => entry);
    expect(migrated.surfaces.coding).toEqual(expectedEntries);

    // Exercise strict current entry admission before the persisted JSON round trip.
    const currentWrite = {
      ...migrated,
      surfaces: {
        ...migrated.surfaces,
        coding: migrated.surfaces.coding.map(entry => PromptStackEntryV1Schema.parse(entry)),
      },
    };
    const reopened = PromptStacksV1Schema.parse(JSON.parse(JSON.stringify(currentWrite)));
    expect(reopened).toEqual({
      ...predecessorPickerStack.stacks,
      surfaces: { ...predecessorPickerStack.stacks.surfaces, coding: expectedEntries },
    });
    expect(reopened.surfaces.coding.map(entry => entry.placement))
      .toEqual(['system_append', 'skill_instructions', 'system_append']);
    expect(PromptStackEntryV1Schema.safeParse(predecessorPickerStack.stacks.surfaces.coding[1]).success).toBe(false);

    const bundle = predecessorPickerStack.artifacts[1];
    const bundleBody = PromptBundleBodyV1Schema.parse(JSON.parse(bundle.body));
    const skillMarkdown = new TextDecoder().decode(decodeBase64(bundleBody.entries[0].contentBase64, 'base64')).trim();
    expect(skillMarkdown).toContain('# Happier Session Control (CLI JSON)');
    const expectedBlocks = [
      'Before the skill: preserve the working tree.',
      skillMarkdown,
      'After the skill: report the checks actually run.',
    ];
    for (const stacks of [migrated, reopened]) {
      const blocks = await resolvePromptStackSystemAppendBlocksV1({
        surface: 'coding',
        promptStacksV1: stacks,
        readArtifact: async ref => predecessorPickerStack.artifacts.find(artifact => artifact.id === ref.artifactId) ?? null,
      });
      expect(blocks.blocks).toEqual(expectedBlocks);
    }
  });
});
