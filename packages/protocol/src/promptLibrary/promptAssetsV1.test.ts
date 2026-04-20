import { describe, expect, it } from 'vitest';

import {
  PromptAssetBundleRecordV1Schema,
  PromptAssetDocRecordV1Schema,
  PromptAssetDiscoveryItemV1Schema,
  PromptAssetMutationPreviewV1Schema,
  PromptAssetTypeDescriptorV1Schema,
  PromptAssetWriteDocRequestSchema,
  PromptAssetWriteBundleRequestSchema,
} from './promptAssetsV1.js';

describe('promptAssetsV1 schemas', () => {
  it('preserves additive fields across prompt asset payloads', () => {
    const descriptor = PromptAssetTypeDescriptorV1Schema.parse({
      id: 'agents.skill',
      providerId: 'agents',
      title: 'Agent skills (.agents)',
      description: 'Portable SKILL.md bundles discovered from .agents/skills.',
      libraryKind: 'bundle',
      supportsScope: { user: true, project: true },
      supportsFiles: true,
      formatId: 'skill_md_v1',
      defaultRoots: [
        { label: 'Project skills', scope: 'project', pathTemplate: '.agents/skills', futureRootField: 'keep-me' },
      ],
      capabilities: {
        supportsCatalogInstall: true,
        supportsSymlinkInstall: true,
        futureCapabilitiesField: true,
      },
      futureDescriptorField: 'keep-me',
    });
    const discovery = PromptAssetDiscoveryItemV1Schema.parse({
      assetTypeId: 'agents.skill',
      scope: 'project',
      externalRef: { skillName: 'reviewer' },
      title: 'Reviewer',
      libraryKind: 'bundle',
      bundleSchemaId: 'skills.skill_md_v1',
      digest: 'sha256:abc',
      displayPath: '.agents/skills/reviewer',
      futureDiscoveryField: 'keep-me',
    });
    const bundle = PromptAssetBundleRecordV1Schema.parse({
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
        entries: [{ path: 'SKILL.md', contentBase64: 'IyBoZWxsbw==', contentKind: 'utf8', futureEntryField: true }],
        createdAtMs: 1,
        updatedAtMs: 2,
        futureBundleField: 'keep-me',
      },
      futureBundleRecordField: 'keep-me',
    });
    const doc = PromptAssetDocRecordV1Schema.parse({
      assetTypeId: 'claude.command',
      scope: 'project',
      externalRef: { relativePath: 'review/code.md' },
      title: 'review/code',
      libraryKind: 'doc',
      digest: 'sha256:def',
      displayPath: '.claude/commands/review/code.md',
      markdown: '# Review code\n\nUse $ARGUMENTS',
      futureDocField: 'keep-me',
    });
    const preview = PromptAssetMutationPreviewV1Schema.parse({
      operation: 'write',
      targetPath: '.agents/skills/reviewer',
      fileCount: 2,
      futurePreviewField: 'keep-me',
    });
    const writeRequest = PromptAssetWriteBundleRequestSchema.parse({
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
        futureWriteBundleField: true,
      },
      installMode: 'symlink',
      previewOnly: true,
      expectedDigest: null,
      futureWriteRequestField: 'keep-me',
    });

    expect((descriptor as any).futureDescriptorField).toBe('keep-me');
    expect((descriptor.defaultRoots[0] as any)?.futureRootField).toBe('keep-me');
    expect((descriptor.capabilities as any)?.futureCapabilitiesField).toBe(true);
    expect((discovery as any).futureDiscoveryField).toBe('keep-me');
    expect((bundle as any).futureBundleRecordField).toBe('keep-me');
    expect((bundle.bundleBody as any).futureBundleField).toBe('keep-me');
    expect((bundle.bundleBody.entries[0] as any)?.futureEntryField).toBe(true);
    expect((doc as any).futureDocField).toBe('keep-me');
    expect((preview as any).futurePreviewField).toBe('keep-me');
    expect((writeRequest as any).futureWriteRequestField).toBe('keep-me');
    expect((writeRequest.bundleBody as any).futureWriteBundleField).toBe(true);
  });

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
