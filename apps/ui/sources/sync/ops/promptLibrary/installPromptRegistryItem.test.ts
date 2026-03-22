import { beforeEach, describe, expect, it, vi } from 'vitest';

const machinePromptRegistriesDownloadItemMock = vi.hoisted(() => vi.fn(async () => ({
  ok: true as const,
  item: {
    sourceId: 'skills_sh:featured',
    itemId: 'skills_sh:featured:web-design-guidelines',
    title: 'web-design-guidelines',
    description: 'vercel-labs/agent-skills',
    bundleSchemaId: 'skills.skill_md_v1' as const,
    bundleBody: {
      v: 1 as const,
      entries: [
        {
          path: 'SKILL.md',
          contentBase64: Buffer.from('# Skill', 'utf8').toString('base64'),
          contentKind: 'utf8' as const,
        },
      ],
      createdAtMs: 1,
      updatedAtMs: 1,
    },
  },
})));
const machinePromptRegistriesInstallMock = vi.hoisted(() => vi.fn(async (): Promise<
  | {
      ok: true;
      externalRef: { skillName: string };
      digest: string;
      preview: { operation: 'write'; targetPath: string; fileCount: number };
    }
  | {
      ok: false;
      errorCode: 'conflict';
      error: string;
      currentDigest: string;
    }
> => ({
  ok: true as const,
  externalRef: { skillName: 'web-design-guidelines' },
  digest: 'digest-1',
  preview: {
    operation: 'write' as const,
    targetPath: '.agents/skills/web-design-guidelines',
    fileCount: 1,
  },
})));
const createPromptRegistrySkillArtifactFromFetchedItemMock = vi.hoisted(() => vi.fn(async () => ({
  ok: true as const,
  artifactId: 'bundle-1',
})));

vi.mock('@/sync/ops/machinePromptRegistries', () => ({
  machinePromptRegistriesDownloadItem: machinePromptRegistriesDownloadItemMock,
  machinePromptRegistriesInstall: machinePromptRegistriesInstallMock,
}));

vi.mock('./promptRegistrySkillImports', () => ({
  createPromptRegistrySkillArtifactFromFetchedItem: createPromptRegistrySkillArtifactFromFetchedItemMock,
}));

describe('installPromptRegistryItem', () => {
  beforeEach(() => {
    machinePromptRegistriesDownloadItemMock.mockClear();
    machinePromptRegistriesInstallMock.mockClear();
    createPromptRegistrySkillArtifactFromFetchedItemMock.mockClear();
  });

  it('imports to the library without calling machine install when installTarget is omitted', async () => {
    const { installPromptRegistryItem } = await import('./installPromptRegistryItem');

    const result = await installPromptRegistryItem({
      machineId: 'machine-1',
      sourceId: 'skills_sh:featured',
      itemId: 'skills_sh:featured:web-design-guidelines',
      configuredSources: [],
      promptExternalLinks: { v: 1, links: [] },
    });

    expect(result).toEqual({
      ok: true,
      artifactId: 'bundle-1',
      routeKind: 'bundle',
      exported: false,
    });
    expect(machinePromptRegistriesDownloadItemMock).toHaveBeenCalledTimes(1);
    expect(machinePromptRegistriesInstallMock).not.toHaveBeenCalled();
  });

  it('passes installMode through when installing to an external target', async () => {
    const { installPromptRegistryItem } = await import('./installPromptRegistryItem');

    await installPromptRegistryItem({
      machineId: 'machine-1',
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
      promptExternalLinks: { v: 1, links: [] },
    });

    expect(machinePromptRegistriesInstallMock).toHaveBeenCalledWith(
      'machine-1',
      expect.objectContaining({
        installTarget: expect.objectContaining({
          assetTypeId: 'agents.skill',
          scope: 'project',
          directory: '/tmp/project',
          targetName: 'web-design-guidelines',
          installMode: 'symlink',
        }),
      }),
      undefined,
    );
  });

  it('passes server routing through to registry fetch and install RPCs', async () => {
    const { installPromptRegistryItem } = await import('./installPromptRegistryItem');

    await installPromptRegistryItem({
      machineId: 'machine-1',
      sourceId: 'skills_sh:featured',
      itemId: 'skills_sh:featured:web-design-guidelines',
      configuredSources: [],
      installTarget: {
        assetTypeId: 'agents.skill',
        scope: 'project',
        directory: '/tmp/project',
        targetName: 'web-design-guidelines',
      },
      promptExternalLinks: { v: 1, links: [] },
      serverId: 'server-1',
    });

    expect(machinePromptRegistriesDownloadItemMock).toHaveBeenCalledWith(
      'machine-1',
      expect.objectContaining({
        sourceId: 'skills_sh:featured',
        itemId: 'skills_sh:featured:web-design-guidelines',
      }),
      { serverId: 'server-1' },
    );
    expect(machinePromptRegistriesInstallMock).toHaveBeenCalledWith(
      'machine-1',
      expect.objectContaining({
        sourceId: 'skills_sh:featured',
        itemId: 'skills_sh:featured:web-design-guidelines',
      }),
      { serverId: 'server-1' },
    );
  });

  it('passes previewOnly through and preserves conflict metadata from machine installs', async () => {
    machinePromptRegistriesInstallMock.mockResolvedValueOnce({
      ok: false as const,
      errorCode: 'conflict',
      error: 'prompt asset has changed on disk',
      currentDigest: 'digest-current',
    });

    const { installPromptRegistryItem } = await import('./installPromptRegistryItem');

    const result = await installPromptRegistryItem({
      machineId: 'machine-1',
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
      promptExternalLinks: { v: 1, links: [] },
      previewOnly: true,
    });

    expect(machinePromptRegistriesInstallMock).toHaveBeenCalledWith(
      'machine-1',
      expect.objectContaining({ previewOnly: true }),
      undefined,
    );
    expect(result).toEqual({
      ok: false,
      error: 'prompt asset has changed on disk',
      errorCode: 'conflict',
      currentDigest: 'digest-current',
    });
    expect(createPromptRegistrySkillArtifactFromFetchedItemMock).not.toHaveBeenCalled();
  });

  it('does not import a previewed registry install until the commit path runs', async () => {
    const { installPromptRegistryItem } = await import('./installPromptRegistryItem');

    const preview = await installPromptRegistryItem({
      machineId: 'machine-1',
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
      promptExternalLinks: { v: 1, links: [] },
      previewOnly: true,
    });

    expect(preview).toEqual({
      ok: true,
      routeKind: 'bundle',
      exported: false,
      response: {
        ok: true,
        externalRef: { skillName: 'web-design-guidelines' },
        digest: 'digest-1',
        preview: {
          operation: 'write',
          targetPath: '.agents/skills/web-design-guidelines',
          fileCount: 1,
        },
      },
    });
    expect(createPromptRegistrySkillArtifactFromFetchedItemMock).not.toHaveBeenCalled();

    const committed = await installPromptRegistryItem({
      machineId: 'machine-1',
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
      promptExternalLinks: { v: 1, links: [] },
      previewOnly: false,
    });

    expect(committed).toEqual(expect.objectContaining({
      ok: true,
      artifactId: 'bundle-1',
      routeKind: 'bundle',
      exported: true,
    }));
    expect(createPromptRegistrySkillArtifactFromFetchedItemMock).toHaveBeenCalledTimes(1);
  });
});
