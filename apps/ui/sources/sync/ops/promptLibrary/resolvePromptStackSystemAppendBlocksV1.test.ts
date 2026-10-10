import { describe, expect, it } from 'vitest';

import { resolvePromptStackSystemAppendBlocksV1 } from './resolvePromptStackSystemAppendBlocksV1';

import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import type { PromptArtifactRefV1 } from '@happier-dev/protocol/prompts/library/promptArtifactRefsV1';

// Qualified Artifact transport is the boundary; parsing and composition remain real.
function artifactReader(artifacts: Record<string, DecryptedArtifact>) {
  return {
    readArtifact: async (ref: PromptArtifactRefV1) => {
      const artifact = artifacts[ref.artifactId];
      return artifact ? { id: artifact.id, header: artifact.header ?? null, body: typeof artifact.body === 'string' ? artifact.body : null,
        revision: { headerVersion: artifact.headerVersion, bodyVersion: artifact.bodyVersion ?? 0 } } : null;
    },
    readArtifactHeader: async (ref: PromptArtifactRefV1) => {
      const artifact = artifacts[ref.artifactId];
      return artifact ? { header: artifact.header ?? null } : null;
    },
  };
}

function createPromptDocArtifact(params: Readonly<{ id: string; markdown: string }>): DecryptedArtifact {
  return {
    id: params.id,
    header: { v: 1, kind: 'prompt_doc.v2', title: params.id },
    title: params.id,
    body: JSON.stringify({ v: 1, markdown: params.markdown, createdAtMs: 1, updatedAtMs: 1 }),
    headerVersion: 1,
    bodyVersion: 1,
    seq: 1,
    createdAt: 1,
    updatedAt: 1,
    isDecrypted: true,
  };
}

function createSkillBundleArtifact(params: Readonly<{ id: string; skillMarkdown: string }>): DecryptedArtifact {
  const skillBase64 = Buffer.from(params.skillMarkdown, 'utf8').toString('base64');
  return {
    id: params.id,
    header: { v: 1, kind: 'prompt_bundle.v2', title: params.id, bundleSchemaId: 'skills.skill_md_v1' },
    title: params.id,
    body: JSON.stringify({
      v: 1,
      entries: [{ path: 'SKILL.md', contentBase64: skillBase64, contentKind: 'utf8' }],
      createdAtMs: 1,
      updatedAtMs: 1,
    }),
    headerVersion: 1,
    bodyVersion: 1,
    seq: 1,
    createdAt: 1,
    updatedAt: 1,
    isDecrypted: true,
  };
}

describe('resolvePromptStackSystemAppendBlocksV1', () => {
  it('uses the current Artifact body for each preparation rather than the display cache', async () => {
    const current = { current: createPromptDocArtifact({ id: 'current', markdown: 'First current text' }) };
    const args = {
      surface: 'coding' as const,
      promptStacksV1: { v: 1, surfaces: { coding: [{ id: 'current-entry', ref: { kind: 'doc', artifactId: 'current' }, enabled: true, placement: 'system_append' }], voice: [], profilesById: {} } },
      profileId: null,
      ...artifactReader(current),
    };
    expect((await resolvePromptStackSystemAppendBlocksV1(args)).blocks).toEqual(['First current text']);
    current.current = createPromptDocArtifact({ id: 'current', markdown: 'Second current text' });
    expect((await resolvePromptStackSystemAppendBlocksV1(args)).blocks).toEqual(['Second current text']);
  });
  it('returns coding + profile blocks in order', async () => {
    const artifactsById: Record<string, DecryptedArtifact> = {
      d1: createPromptDocArtifact({ id: 'd1', markdown: 'Hello from coding' }),
      d2: createPromptDocArtifact({ id: 'd2', markdown: 'Hello from profile' }),
    };

    const blocks = await resolvePromptStackSystemAppendBlocksV1({
      surface: 'coding',
      promptStacksV1: {
        v: 1,
        surfaces: {
          coding: [
            {
              id: 'e1',
              ref: { kind: 'doc', artifactId: 'd1' },
              enabled: true,
              placement: 'system_append',
              editPolicy: 'user_only',
            },
          ],
          voice: [],
          profilesById: {
            p1: [
              {
                id: 'e2',
                ref: { kind: 'doc', artifactId: 'd2' },
                enabled: true,
                placement: 'system_append',
                editPolicy: 'user_only',
              },
            ],
          },
        },
      },
      profileId: 'p1',
      ...artifactReader(artifactsById),
    });

    expect(blocks.blocks).toEqual(['Hello from coding', 'Hello from profile']);
  });

  it('skips disabled entries and non-system placements', async () => {
    const artifactsById: Record<string, DecryptedArtifact> = {
      d1: createPromptDocArtifact({ id: 'd1', markdown: 'Hello from coding' }),
    };

    const blocks = await resolvePromptStackSystemAppendBlocksV1({
      surface: 'coding',
      promptStacksV1: {
        v: 1,
        surfaces: {
          coding: [
            {
              id: 'e1',
              ref: { kind: 'doc', artifactId: 'd1' },
              enabled: false,
              placement: 'system_append',
              editPolicy: 'user_only',
            },
            {
              id: 'e2',
              ref: { kind: 'doc', artifactId: 'd1' },
              enabled: true,
              placement: 'composer_insert',
              editPolicy: 'user_only',
            },
          ],
          voice: [],
          profilesById: {},
        },
      },
      profileId: null,
      ...artifactReader(artifactsById),
    });

    expect(blocks.blocks).toEqual([]);
  });

  it('supports skill bundles via SKILL.md', async () => {
    const artifactsById: Record<string, DecryptedArtifact> = {
      b1: createSkillBundleArtifact({ id: 'b1', skillMarkdown: '# Skill' }),
    };

    const blocks = await resolvePromptStackSystemAppendBlocksV1({
      surface: 'coding',
      promptStacksV1: {
        v: 1,
        surfaces: {
          coding: [
            {
              id: 'e1',
              ref: { kind: 'bundle', artifactId: 'b1' },
              enabled: true,
              placement: 'skill_instructions',
              editPolicy: 'user_only',
            },
          ],
          voice: [],
          profilesById: {},
        },
      },
      profileId: null,
      ...artifactReader(artifactsById),
    });

    expect(blocks.blocks).toEqual(['# Skill']);
  });

  it('truncates blocks when maxChars is set', async () => {
    const artifactsById: Record<string, DecryptedArtifact> = {
      d1: createPromptDocArtifact({ id: 'd1', markdown: 'Hello world' }),
    };

    const blocks = await resolvePromptStackSystemAppendBlocksV1({
      surface: 'coding',
      promptStacksV1: {
        v: 1,
        surfaces: {
          coding: [
            {
              id: 'e1',
              ref: { kind: 'doc', artifactId: 'd1' },
              enabled: true,
              placement: 'system_append',
              maxChars: 5,
              editPolicy: 'user_only',
            },
          ],
          voice: [],
          profilesById: {},
        },
      },
      profileId: null,
      ...artifactReader(artifactsById),
    });

    expect(blocks.blocks).toEqual(['Hello']);
  });

  it('returns voice blocks without mixing in coding entries and appends matching profile entries', async () => {
    const artifactsById: Record<string, DecryptedArtifact> = {
      coding: createPromptDocArtifact({ id: 'coding', markdown: 'Hello from coding' }),
      voice: createPromptDocArtifact({ id: 'voice', markdown: 'Hello from voice' }),
      profile: createPromptDocArtifact({ id: 'profile', markdown: 'Hello from profile' }),
    };

    const blocks = await resolvePromptStackSystemAppendBlocksV1({
      surface: 'voice',
      promptStacksV1: {
        v: 1,
        surfaces: {
          coding: [
            {
              id: 'coding-entry',
              ref: { kind: 'doc', artifactId: 'coding' },
              enabled: true,
              placement: 'system_append',
              editPolicy: 'user_only',
            },
          ],
          voice: [
            {
              id: 'voice-entry',
              ref: { kind: 'doc', artifactId: 'voice' },
              enabled: true,
              placement: 'system_append',
              editPolicy: 'user_only',
            },
          ],
          profilesById: {
            p1: [
              {
                id: 'profile-entry',
                ref: { kind: 'doc', artifactId: 'profile' },
                enabled: true,
                placement: 'system_append',
                editPolicy: 'user_only',
              },
            ],
          },
        },
      },
      profileId: 'p1',
      ...artifactReader(artifactsById),
    });

    expect(blocks.blocks).toEqual(['Hello from voice', 'Hello from profile']);
  });
});
