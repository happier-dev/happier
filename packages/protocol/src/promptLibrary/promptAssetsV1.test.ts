import { describe, expect, it } from 'vitest';

import {
  PromptAssetBundleRecordV1Schema,
  PromptAssetDocRecordV1Schema,
  PromptAssetDiscoveryItemV1Schema,
  PromptAssetTypeDescriptorV1Schema,
  PromptAssetWriteDocRequestSchema,
  PromptAssetWriteBundleRequestSchema,
} from './promptAssetsV1.js';

describe('promptAssetsV1 schemas', () => {
  it('parses a prompt asset type descriptor for Agent skills', () => {
    const parsed = PromptAssetTypeDescriptorV1Schema.parse({
      id: 'agents.skill',
      providerId: 'agents',
      title: 'Agent skills (.agents)',
      description: 'Portable SKILL.md bundles discovered from .agents/skills.',
      libraryKind: 'bundle',
      supportsScope: { user: true, project: true },
      supportsFiles: true,
      formatId: 'skill_md_v1',
      defaultRoots: [
        { label: 'Project skills', scope: 'project', pathTemplate: '.agents/skills' },
        { label: 'User skills', scope: 'user', pathTemplate: '~/.agents/skills' },
      ],
      capabilities: {
        supportsCatalogInstall: true,
        supportsSymlinkInstall: true,
      },
    });

    expect(parsed.id).toBe('agents.skill');
    expect(parsed.libraryKind).toBe('bundle');
    expect(parsed.supportsScope.project).toBe(true);
  });

  it('parses a discovered prompt asset item', () => {
    const parsed = PromptAssetDiscoveryItemV1Schema.parse({
      assetTypeId: 'agents.skill',
      scope: 'project',
      externalRef: { skillName: 'reviewer' },
      title: 'Reviewer',
      libraryKind: 'bundle',
      bundleSchemaId: 'skills.skill_md_v1',
      digest: 'sha256:abc',
      displayPath: '.agents/skills/reviewer',
    });

    expect(parsed.externalRef).toEqual({ skillName: 'reviewer' });
    expect(parsed.bundleSchemaId).toBe('skills.skill_md_v1');
  });

  it('parses a bundle record payload', () => {
    const parsed = PromptAssetBundleRecordV1Schema.parse({
      assetTypeId: 'agents.skill',
      scope: 'project',
      externalRef: { skillName: 'reviewer' },
      title: 'Reviewer',
      libraryKind: 'bundle',
      bundleSchemaId: 'skills.skill_md_v1',
      digest: 'sha256:abc',
      displayPath: '.agents/skills/reviewer',
      bundleBody: {
        v: 1,
        entries: [{ path: 'SKILL.md', contentBase64: 'IyBoZWxsbw==', contentKind: 'utf8' }],
        createdAtMs: 1,
        updatedAtMs: 2,
      },
    });

    expect(parsed.bundleBody.entries).toHaveLength(1);
    expect(parsed.bundleBody.entries[0]?.path).toBe('SKILL.md');
  });

  it('parses a doc record payload', () => {
    const parsed = PromptAssetDocRecordV1Schema.parse({
      assetTypeId: 'claude.command',
      scope: 'project',
      externalRef: { relativePath: 'review/code.md' },
      title: 'review/code',
      libraryKind: 'doc',
      digest: 'sha256:def',
      displayPath: '.claude/commands/review/code.md',
      markdown: '# Review code\n\nUse $ARGUMENTS',
    });

    expect(parsed.libraryKind).toBe('doc');
    expect(parsed.markdown).toContain('$ARGUMENTS');
  });

  it('parses a bundle write request', () => {
    const parsed = PromptAssetWriteBundleRequestSchema.parse({
      assetTypeId: 'agents.skill',
      scope: 'project',
      directory: '/repo',
      targetName: 'reviewer',
      title: 'Reviewer',
      bundleSchemaId: 'skills.skill_md_v1',
      bundleBody: {
        v: 1,
        entries: [{ path: 'SKILL.md', contentBase64: 'IyBoZWxsbw==', contentKind: 'utf8' }],
        createdAtMs: 1,
        updatedAtMs: 2,
      },
      installMode: 'symlink',
      previewOnly: true,
      expectedDigest: null,
    });

    expect(parsed.targetName).toBe('reviewer');
    expect(parsed.installMode).toBe('symlink');
    expect(parsed.previewOnly).toBe(true);
  });

  it('parses a doc write request', () => {
    const parsed = PromptAssetWriteDocRequestSchema.parse({
      assetTypeId: 'claude.command',
      scope: 'project',
      directory: '/repo',
      externalRef: null,
      targetPath: 'review/code.md',
      title: 'review/code',
      markdown: '# Review code\n\nUse $ARGUMENTS',
      previewOnly: true,
      expectedDigest: null,
    });

    expect(parsed.targetPath).toBe('review/code.md');
    expect(parsed.previewOnly).toBe(true);
  });
});
