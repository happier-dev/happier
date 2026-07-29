import { describe, expect, it } from 'vitest';

import {
  PromptRegistryAdapterDescriptorV1Schema,
  PromptRegistryConfiguredSourceV1Schema,
  PromptRegistryFetchedItemV1Schema,
  PromptRegistryInstallRequestV1Schema,
  PromptRegistryInstallResponseV1Schema,
  PromptRegistryItemSummaryV1Schema,
  PromptRegistrySourceDescriptorV1Schema,
  PromptRegistrySourcesV1Schema,
} from './promptRegistriesV1.js';

describe('promptRegistriesV1 schemas', () => {
  it('preserves additive fields across registry payloads', () => {
    const configured = PromptRegistryConfiguredSourceV1Schema.parse({
      id: 'local-skills',
      adapterId: 'git',
      title: 'Local skills repo',
      enabled: true,
      config: {
        repositoryUrl: 'file:///tmp/skills-repo',
        subdirectory: 'skills',
        futureConfigField: true,
      },
      futureConfiguredSourceField: 'keep-me',
    });
    const adapter = PromptRegistryAdapterDescriptorV1Schema.parse({
      id: 'skills_sh',
      title: 'skills.sh',
      description: 'Curated skills registry.',
      supportsConfiguredSources: false,
      supportsQuery: true,
      minimumQueryLength: 2,
      futureAdapterField: 'keep-me',
    });
    const source = PromptRegistrySourceDescriptorV1Schema.parse({
      id: 'skills_sh:featured',
      adapterId: 'skills_sh',
      title: 'Featured skills',
      subtitle: 'Popular skills from skills.sh',
      origin: 'built_in',
      futureSourceField: 'keep-me',
    });
    const summary = PromptRegistryItemSummaryV1Schema.parse({
      sourceId: 'git:local-skills',
      itemId: 'git:local-skills:reviewer',
      title: 'reviewer',
      description: 'Code review helper',
      bundleSchemaId: 'skills.skill_md_v1',
      displayPath: 'reviewer',
      providerHints: ['agents.skill', 'claude.skill'],
      futureSummaryField: 'keep-me',
    });
    const fetched = PromptRegistryFetchedItemV1Schema.parse({
      sourceId: 'git:local-skills',
      itemId: 'git:local-skills:reviewer',
      title: 'reviewer',
      description: 'Code review helper',
      bundleSchemaId: 'skills.skill_md_v1',
      bundleBody: {
        v: 1,
        entries: [{ path: 'SKILL.md', contentBase64: 'IyByZXZpZXdlcg==', contentKind: 'utf8', futureEntryField: true }],
        createdAtMs: 1,
        updatedAtMs: 2,
        futureBundleField: 'keep-me',
      },
      futureFetchedField: 'keep-me',
    });
    const request = PromptRegistryInstallRequestV1Schema.parse({
      sourceId: 'skills_sh:featured',
      itemId: 'skills_sh:featured:web-design-guidelines',
      configuredSources: [configured],
      installTarget: {
        assetTypeId: 'agents.skill',
        scope: 'project',
        directory: '/tmp/project',
        targetName: 'web-design-guidelines',
        installMode: 'symlink',
        futureInstallTargetField: 'keep-me',
      },
      previewOnly: true,
      expectedDigest: null,
      futureRequestField: 'keep-me',
    });
    const response = PromptRegistryInstallResponseV1Schema.parse({
      ok: true,
      externalRef: { skillName: 'web-design-guidelines', futureRefField: 'keep-me' },
      digest: 'abc123',
      preview: {
        operation: 'write',
        targetPath: '.agents/skills/web-design-guidelines',
        fileCount: 2,
        futurePreviewField: 'keep-me',
      },
      futureResponseField: 'keep-me',
    });

    expect((configured as any).futureConfiguredSourceField).toBe('keep-me');
    expect((configured.config as any).futureConfigField).toBe(true);
    expect((adapter as any).futureAdapterField).toBe('keep-me');
    expect((source as any).futureSourceField).toBe('keep-me');
    expect((summary as any).futureSummaryField).toBe('keep-me');
    expect((fetched as any).futureFetchedField).toBe('keep-me');
    expect((fetched.bundleBody as any).futureBundleField).toBe('keep-me');
    expect((fetched.bundleBody.entries[0] as any)?.futureEntryField).toBe(true);
    expect((request as any).futureRequestField).toBe('keep-me');
    expect((request.installTarget as any).futureInstallTargetField).toBe('keep-me');
    expect((response as any).futureResponseField).toBe('keep-me');
    if (response.ok) {
      expect((response.externalRef as any).futureRefField).toBe('keep-me');
      expect((response.preview as any).futurePreviewField).toBe('keep-me');
    }
  });

  it('parses configured git registry sources', () => {
    const parsed = PromptRegistryConfiguredSourceV1Schema.parse({
      id: 'local-skills',
      adapterId: 'git',
      title: 'Local skills repo',
      enabled: true,
      config: {
        repositoryUrl: 'file:///tmp/skills-repo',
        subdirectory: 'skills',
      },
    });

    expect(parsed.adapterId).toBe('git');
    expect(parsed.config).toEqual({
      repositoryUrl: 'file:///tmp/skills-repo',
      subdirectory: 'skills',
    });
  });

  it('defaults registry source settings to an empty list', () => {
    const parsed = PromptRegistrySourcesV1Schema.parse({});
    expect(parsed).toEqual({ v: 1, sources: [] });
  });

  it('parses registry adapter and source descriptors', () => {
    const adapter = PromptRegistryAdapterDescriptorV1Schema.parse({
      id: 'skills_sh',
      title: 'skills.sh',
      description: 'Curated skills registry.',
      supportsConfiguredSources: false,
      supportsQuery: true,
      minimumQueryLength: 2,
    });
    const source = PromptRegistrySourceDescriptorV1Schema.parse({
      id: 'skills_sh:featured',
      adapterId: 'skills_sh',
      title: 'Featured skills',
      subtitle: 'Popular skills from skills.sh',
      origin: 'built_in',
    });

    expect(adapter.id).toBe('skills_sh');
    expect(adapter.minimumQueryLength).toBe(2);
    expect(source.origin).toBe('built_in');
  });

  it('parses registry scan summaries and fetched bundle payloads', () => {
    const summary = PromptRegistryItemSummaryV1Schema.parse({
      sourceId: 'git:local-skills',
      itemId: 'git:local-skills:reviewer',
      title: 'reviewer',
      description: 'Code review helper',
      bundleSchemaId: 'skills.skill_md_v1',
      displayPath: 'reviewer',
      providerHints: ['agents.skill', 'claude.skill'],
    });
    const fetched = PromptRegistryFetchedItemV1Schema.parse({
      sourceId: 'git:local-skills',
      itemId: 'git:local-skills:reviewer',
      title: 'reviewer',
      description: 'Code review helper',
      bundleSchemaId: 'skills.skill_md_v1',
      bundleBody: {
        v: 1,
        entries: [{ path: 'SKILL.md', contentBase64: 'IyByZXZpZXdlcg==', contentKind: 'utf8' }],
        createdAtMs: 1,
        updatedAtMs: 2,
      },
    });

    expect(summary.providerHints).toEqual(['agents.skill', 'claude.skill']);
    expect(fetched.bundleBody.entries[0]?.path).toBe('SKILL.md');
  });

  it('parses registry install requests and responses', () => {
    const request = PromptRegistryInstallRequestV1Schema.parse({
      sourceId: 'skills_sh:featured',
      itemId: 'skills_sh:featured:web-design-guidelines',
      configuredSources: [],
      installTarget: {
        assetTypeId: 'agents.skill',
        scope: 'project',
        directory: '/tmp/project',
        targetName: 'web-design-guidelines',
        installMode: 'symlink',
      },
      previewOnly: true,
    });
    const response = PromptRegistryInstallResponseV1Schema.parse({
      ok: true,
      externalRef: { skillName: 'web-design-guidelines' },
      digest: 'abc123',
      preview: {
        operation: 'write',
        targetPath: '.agents/skills/web-design-guidelines',
        fileCount: 2,
      },
    });

    expect(request.installTarget.assetTypeId).toBe('agents.skill');
    expect(request.installTarget.installMode).toBe('symlink');
    expect(request.previewOnly).toBe(true);
    expect(response.ok).toBe(true);
    if (response.ok) {
      expect(response.externalRef).toEqual({ skillName: 'web-design-guidelines' });
    }
  });
});
