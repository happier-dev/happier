import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  AGENT_IDS,
  CANONICAL_AGENT_IDS,
  getAllBackendDefinitionContracts,
  getAllProviderDefinitionContracts,
} from '@happier-dev/agents';

import { resolveBuiltInContributions } from './resolveBuiltInContributions';
import * as generatedBundledPlugins from './sources/generatedBundledPlugins';

function readResolverSource(): string {
  return readFileSync(new URL('./resolveBuiltInContributions.ts', import.meta.url), 'utf8');
}

function readGeneratedArray(name: string): readonly unknown[] {
  const value = (generatedBundledPlugins as Record<string, unknown>)[name];
  expect(Array.isArray(value)).toBe(true);
  return value as readonly unknown[];
}

describe('resolveBuiltInContributions', () => {
  it('stays a thin reader without host backend or executable plugin imports', () => {
    const resolverSource = readResolverSource();

    expect(resolverSource).toMatch(/generatedBundledPlugins/);
    expect(resolverSource).not.toMatch(/@\/backends\//);
    expect(resolverSource).not.toMatch(/\bBUILT_IN_AGENT_CATALOG_ENTRIES\b/);
    expect(resolverSource).not.toMatch(/\bOPENCODE_BUNDLED_ACTIVATION_TARGET\b/);
    expect(resolverSource).not.toMatch(/from ['"][^'"]*@happier-dev\/plugins-/);
    expect(resolverSource).not.toMatch(/require\(['"]@happier-dev\/plugins-/);
    expect(resolverSource).not.toMatch(/@happier-dev\/extensions-/);
  });

    it('assembles built-in providers and backends into separate contribution tables', () => {
        const contributes = resolveBuiltInContributions();
    const backendDefinitionIds = getAllBackendDefinitionContracts().map((entry) => entry.id).slice().sort();
    const providerDefinitionIds = getAllProviderDefinitionContracts().map((entry) => entry.id).slice().sort();
    const generatedProviderIds = readGeneratedArray('BUNDLED_FIRST_PARTY_PROVIDER_CONTRIBUTIONS')
      .map((entry) => (entry as { id?: unknown }).id)
      .slice()
      .sort();
    const generatedBackendIds = readGeneratedArray('BUNDLED_FIRST_PARTY_BACKEND_CONTRIBUTIONS')
      .map((entry) => (entry as { id?: unknown }).id)
      .slice()
      .sort();

    expect(contributes.providers.map((entry) => entry.id).slice().sort()).toEqual(providerDefinitionIds);
    expect(contributes.backends.map((entry) => entry.id).slice().sort()).toEqual(backendDefinitionIds);
    expect(contributes.providers.map((entry) => entry.id).slice().sort()).toEqual(generatedProviderIds);
    expect(contributes.backends.map((entry) => entry.id).slice().sort()).toEqual(generatedBackendIds);
    expect((contributes.catalogEntries ?? []).map((entry) => entry.id)).toEqual([]);
    expect(contributes.providers.map((entry) => entry.id).slice().sort()).toEqual([...CANONICAL_AGENT_IDS].slice().sort());
    expect(contributes.providers.map((entry) => entry.id).slice().sort()).toEqual([...AGENT_IDS].slice().sort());

    for (const provider of contributes.providers) {
      expect(provider.definition).toEqual(
        expect.objectContaining({
          kindVersion: 1,
          id: provider.id,
        }),
      );
      expect(provider.catalogEntry?.id).toBe(provider.id);
      expect(provider.catalogEntry?.cliSubcommand).toBe(provider.id);
      expect(provider.catalogEntry).not.toHaveProperty('getRuntimeCore');
    }

    for (const backend of contributes.backends) {
      expect(backend.definition).toEqual(
        expect.objectContaining({
          kindVersion: 1,
          id: backend.id,
          providerId: backend.providerId,
        }),
      );
      expect(backend).not.toHaveProperty('getRuntimeCore');
    }

    expect(contributes.activationTargets).toEqual(readGeneratedArray('BUNDLED_FIRST_PARTY_ACTIVATION_TARGETS'));
    const activationTargets = contributes.activationTargets;
    expect(activationTargets).toBeDefined();
    if (!activationTargets) {
      throw new Error('Expected built-in activation target contributions');
    }
        expect(activationTargets.map((target) => [target.pluginId, target.daemonEntryPath]).sort()).toEqual([
      ['happier.agent.claude', '@happier-dev/plugins-claude'],
      ['happier.agent.codex', '@happier-dev/plugins-codex'],
      ['happier.agent.opencode', '@happier-dev/plugins-opencode'],
      ['happier.scm.backend.git', '@happier-dev/plugins-scm-git'],
      ['happier.scm.backend.sapling', '@happier-dev/plugins-scm-sapling'],
      ['happier.scm.hosting.azure-devops', '@happier-dev/plugins-scm-azure-devops'],
      ['happier.scm.hosting.bitbucket', '@happier-dev/plugins-scm-bitbucket'],
      ['happier.scm.hosting.github', '@happier-dev/plugins-scm-github'],
      ['happier.scm.hosting.gitlab', '@happier-dev/plugins-scm-gitlab'],
        ]);
    });

    it('projects bundled SCM hosting providers from generated built-in plugin metadata', () => {
        const contributes = resolveBuiltInContributions();

        expect((contributes.scmHostingProviders ?? []).map((provider) => [
            provider.id,
            provider.pluginId,
            provider.definition.kind,
            provider.definition.baseUrl,
        ]).sort()).toEqual([
            ['scm.azure-devops', 'happier.scm.hosting.azure-devops', 'azure-devops', 'https://dev.azure.com'],
            ['scm.bitbucket', 'happier.scm.hosting.bitbucket', 'bitbucket', 'https://bitbucket.org'],
            ['scm.github', 'happier.scm.hosting.github', 'github', 'https://github.com'],
            ['scm.gitlab', 'happier.scm.hosting.gitlab', 'gitlab', 'https://gitlab.com'],
        ]);
    });

    it('projects bundled SCM backend and installable contributions from generated metadata', () => {
        const contributes = resolveBuiltInContributions();
        const generatedScmBackends = readGeneratedArray('BUNDLED_FIRST_PARTY_SCM_BACKEND_CONTRIBUTIONS');
        const generatedInstallables = readGeneratedArray('BUNDLED_FIRST_PARTY_INSTALLABLE_CONTRIBUTIONS');

        expect(contributes.scmBackends).toEqual(generatedScmBackends);
        expect(contributes.installables).toEqual(expect.arrayContaining(Array.from(generatedInstallables)));
        expect((contributes.scmBackends ?? []).map((backend) => [
            backend.id,
            backend.pluginId,
            backend.definition.installableDependencies,
        ])).toEqual(expect.arrayContaining([
            [
                'git',
                'happier.scm.backend.git',
                ['dep.git'],
            ],
            [
                'sapling',
                'happier.scm.backend.sapling',
                ['dep.sapling'],
            ],
        ]));
        expect((contributes.installables ?? []).map((installable) => [
            installable.pluginId,
            installable.definition.key,
            installable.definition.capabilityId,
            installable.definition.defaultPolicy.autoInstallWhenNeeded,
        ])).toEqual(expect.arrayContaining([
            [
                'happier.scm.backend.git',
                'dep.git',
                'dep.git',
                false,
            ],
            [
                'happier.scm.backend.sapling',
                'dep.sapling',
                'dep.sapling',
                false,
            ],
        ]));
    });

    it('publishes a runtime kind for every built-in backend contribution', () => {
        const contributes = resolveBuiltInContributions();

    expect(contributes.backends.map((backend) => [backend.id, backend.runtimeKind]).sort()).toEqual([
      ['auggie', 'native'],
      ['claude', 'native'],
      ['codex', 'appServer'],
      ['copilot', 'native'],
      ['gemini', 'native'],
      ['kilo', 'native'],
      ['kimi', 'native'],
      ['kiro', 'native'],
      ['ohMyPi', 'native'],
      ['opencode', 'server'],
      ['pi', 'native'],
      ['qwen', 'native'],
    ]);
  });

  it('does not project host-local runtimeCore hooks from static built-in backend contributions', () => {
    const contributes = resolveBuiltInContributions();

    for (const backend of contributes.backends) {
      expect(backend).not.toHaveProperty('getRuntimeCore');
    }
  });
});
