import { describe, expect, it } from 'vitest';

import {
  PROMPT_BUNDLE_SCHEMA_LIMITS_V1,
  validatePromptBundleBodyV1AgainstSchemaId,
  type PromptBundleBodyV1,
} from './promptBundleSchemas.js';

describe('validatePromptBundleBodyV1AgainstSchemaId', () => {
  it('accepts a minimal skill bundle with SKILL.md', () => {
    const body: PromptBundleBodyV1 = {
      v: 1,
      entries: [
        {
          path: 'SKILL.md',
          contentBase64: Buffer.from('# Skill', 'utf8').toString('base64'),
          contentKind: 'utf8',
        },
      ],
      createdAtMs: 1,
      updatedAtMs: 2,
    };

    const res = validatePromptBundleBodyV1AgainstSchemaId({ bundleSchemaId: 'skills.skill_md_v1', body });
    expect(res.ok).toBe(true);
  });

  it('rejects skill bundles missing SKILL.md', () => {
    const body: PromptBundleBodyV1 = {
      v: 1,
      entries: [
        {
          path: 'README.md',
          contentBase64: Buffer.from('x', 'utf8').toString('base64'),
          contentKind: 'utf8',
        },
      ],
      createdAtMs: 1,
      updatedAtMs: 2,
    };

    const res = validatePromptBundleBodyV1AgainstSchemaId({ bundleSchemaId: 'skills.skill_md_v1', body });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errorCode).toBe('missing_required_entry');
  });

  it('rejects traversal paths', () => {
    const body: PromptBundleBodyV1 = {
      v: 1,
      entries: [
        {
          path: '../SKILL.md',
          contentBase64: Buffer.from('x', 'utf8').toString('base64'),
          contentKind: 'utf8',
        },
      ],
      createdAtMs: 1,
      updatedAtMs: 2,
    };

    const res = validatePromptBundleBodyV1AgainstSchemaId({ bundleSchemaId: 'skills.skill_md_v1', body });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errorCode).toBe('invalid_path');
  });

  it('rejects bundles with too many entries', () => {
    const body: PromptBundleBodyV1 = {
      v: 1,
      entries: Array.from({ length: PROMPT_BUNDLE_SCHEMA_LIMITS_V1.maxEntries + 1 }, (_, index) => ({
        path: index === 0 ? 'SKILL.md' : `docs/file-${index}.md`,
        contentBase64: Buffer.from('x', 'utf8').toString('base64'),
        contentKind: 'utf8' as const,
      })),
      createdAtMs: 1,
      updatedAtMs: 2,
    };

    const res = validatePromptBundleBodyV1AgainstSchemaId({ bundleSchemaId: 'skills.skill_md_v1', body });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errorCode).toBe('size_limit_exceeded');
  });

  it('rejects bundles exceeding the total decoded byte budget', () => {
    const oversizedSkillMarkdown = '# Skill\n' + 'a'.repeat(PROMPT_BUNDLE_SCHEMA_LIMITS_V1.maxTotalBytes);
    const body: PromptBundleBodyV1 = {
      v: 1,
      entries: [
        {
          path: 'SKILL.md',
          contentBase64: Buffer.from(oversizedSkillMarkdown, 'utf8').toString('base64'),
          contentKind: 'utf8',
        },
      ],
      createdAtMs: 1,
      updatedAtMs: 2,
    };

    const res = validatePromptBundleBodyV1AgainstSchemaId({ bundleSchemaId: 'skills.skill_md_v1', body });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errorCode).toBe('size_limit_exceeded');
  });

  it('reports invalid_request for malformed bundle bodies', () => {
    const res = validatePromptBundleBodyV1AgainstSchemaId({
      bundleSchemaId: 'skills.skill_md_v1',
      body: {
        v: 1,
        entries: [],
      } as unknown as PromptBundleBodyV1,
    });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errorCode).toBe('invalid_request');
  });
});
