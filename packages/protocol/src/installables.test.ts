import { describe, expect, it } from 'vitest';

import {
  CODEX_ACP_DEP_ID,
  CODEX_ACP_DIST_TAG,
  GH_DEP_ID,
  GH_GITHUB_REPO,
  GH_INSTALLABLE_DESCRIPTOR,
  INSTALLABLES_CATALOG,
  INSTALLABLE_KEYS,
} from './installables.js';
import * as installables from './installables.js';

describe('installables catalog', () => {
  it('has unique keys', () => {
    const keys = INSTALLABLES_CATALOG.map((e) => e.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('has unique capability ids', () => {
    const ids = INSTALLABLES_CATALOG.map((e) => e.capabilityId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('registers gh as an optional generic installable dependency', () => {
    const ghCatalogEntry = INSTALLABLES_CATALOG.find((entry) => entry.key === INSTALLABLE_KEYS.GH);

    expect(ghCatalogEntry).toEqual(expect.objectContaining({
      key: INSTALLABLE_KEYS.GH,
      kind: 'dep',
      capabilityId: GH_DEP_ID,
      sourceKind: 'github_release_binary',
      defaultPolicy: { autoInstallWhenNeeded: false, autoUpdateMode: 'notify' },
      experimental: false,
    }));
    expect(GH_INSTALLABLE_DESCRIPTOR).toEqual(expect.objectContaining({
      key: INSTALLABLE_KEYS.GH,
      kind: 'dep',
      capabilityId: GH_DEP_ID,
      description: expect.stringMatching(/github cli/i),
      source: { kind: 'github_release_binary', repo: GH_GITHUB_REPO, distTag: 'latest' },
      binary: expect.objectContaining({
        commands: ['gh'],
        systemFirst: true,
        managedFallback: true,
      }),
      consent: {
        install: 'required',
        update: 'required',
      },
    }));
    expect(GH_GITHUB_REPO).toBe('cli/cli');
  });

  it('registers az as an optional system-first Azure DevOps dependency without managed install', () => {
    const azCatalogEntry = INSTALLABLES_CATALOG.find((entry) => entry.key === 'az');
    const azDescriptor = Reflect.get(installables, 'AZ_INSTALLABLE_DESCRIPTOR');

    expect(azCatalogEntry).toEqual(expect.objectContaining({
      key: 'az',
      kind: 'dep',
      capabilityId: 'dep.az',
      sourceKind: 'manual_only',
      defaultPolicy: { autoInstallWhenNeeded: false, autoUpdateMode: 'notify' },
      experimental: false,
    }));
    expect(azDescriptor).toEqual(expect.objectContaining({
      key: 'az',
      kind: 'dep',
      capabilityId: 'dep.az',
      description: expect.stringMatching(/azure cli/i),
      source: {
        kind: 'manual_only',
        setupUrl: expect.stringMatching(/^https:\/\/learn\.microsoft\.com\//),
      },
      binary: expect.objectContaining({
        commands: ['az'],
        systemFirst: true,
        managedFallback: false,
      }),
      consent: {
        install: 'required',
        update: 'required',
      },
    }));
  });

  it('preserves the legacy dist-tag export for public consumers', () => {
    expect(CODEX_ACP_DIST_TAG).toBe('latest');
  });

  it('exports descriptor schemas for every FD-0041 installable source kind', () => {
    expect(typeof installables.InstallableDependencyDescriptorSchema?.parse).toBe('function');

    const base = {
      id: 'example-tool',
      key: 'example-tool',
      kind: 'dep',
      version: '1',
      capabilityId: 'dep.example-tool',
      display: {
        name: 'Example Tool',
      },
      description: 'Example dependency used by a plugin',
      binary: {
        commands: ['example-tool'],
        systemFirst: true,
      },
      defaultPolicy: {
        autoInstallWhenNeeded: false,
        autoUpdateMode: 'notify',
      },
      consent: {
        install: 'required',
        update: 'required',
      },
    };

    const sourceByKind = {
      github_release_binary: {
        kind: 'github_release_binary',
        repo: 'owner/repo',
        distTag: 'latest',
      },
      managed_package: {
        kind: 'managed_package',
        packageName: '@scope/example-tool',
        packageManager: 'managed_js_runtime',
      },
      vendor_recipe: {
        kind: 'vendor_recipe',
        recipeId: 'example.vendor.recipe',
        commandsPreview: ['brew install example-tool'],
      },
      manual_only: {
        kind: 'manual_only',
        setupUrl: 'https://example.com/setup',
      },
    } as const;

    for (const source of Object.values(sourceByKind)) {
      expect(installables.InstallableDependencyDescriptorSchema.parse({
        ...base,
        source,
      }).source.kind).toBe(source.kind);
    }
  });

  it('accepts shared plugin descriptor base metadata on installable descriptors', () => {
    expect(installables.InstallableDependencyDescriptorSchema.parse({
      id: 'example-tool',
      key: 'example-tool',
      kind: 'dep',
      version: '1',
      capabilityId: 'dep.example-tool',
      displayKey: 'installables.exampleTool.name',
      descriptionKey: 'installables.exampleTool.description',
      groupId: 'developer-tools',
      order: 10,
      capabilityGates: ['scm.installables'],
      permissionGates: ['scm.read'],
      redaction: 'masked',
      hidden: false,
      clearWhenEmpty: 'omit',
      display: {
        name: 'Example Tool',
      },
      description: 'Example dependency used by a plugin',
      source: {
        kind: 'manual_only',
        setupUrl: 'https://example.com/setup',
      },
      binary: {
        commands: ['example-tool'],
        systemFirst: true,
      },
      defaultPolicy: {
        autoInstallWhenNeeded: false,
        autoUpdateMode: 'notify',
      },
      consent: {
        install: 'required',
        update: 'required',
      },
    })).toEqual(expect.objectContaining({
      key: 'example-tool',
      displayKey: 'installables.exampleTool.name',
      capabilityGates: ['scm.installables'],
      clearWhenEmpty: 'omit',
    }));
  });

  it('applies shared plugin descriptor base secret-key validation to installable descriptors', () => {
    expect(installables.InstallableDependencyDescriptorSchema.safeParse({
      id: 'example-tool',
      key: 'example-tool',
      kind: 'dep',
      version: '1',
      capabilityId: 'dep.example-tool',
      display: {
        name: 'Example Tool',
      },
      description: 'Example dependency used by a plugin',
      source: {
        kind: 'manual_only',
        setupUrl: 'https://example.com/setup',
      },
      binary: {
        commands: ['example-tool'],
        systemFirst: true,
      },
      defaultPolicy: {
        autoInstallWhenNeeded: false,
        autoUpdateMode: 'notify',
      },
      consent: {
        install: 'required',
        update: 'required',
      },
      token: 'must-not-be-inline',
    }).success).toBe(false);
  });

  it('resolves installables with deterministic built-in, bundled, external precedence and diagnostics', () => {
    expect(typeof installables.resolveInstallablesRegistry).toBe('function');

    const builtIn = installables.InstallableDependencyDescriptorSchema.parse({
      id: INSTALLABLE_KEYS.CODEX_ACP,
      key: INSTALLABLE_KEYS.CODEX_ACP,
      kind: 'dep',
      version: '1',
      capabilityId: CODEX_ACP_DEP_ID,
      display: {
        name: 'Codex ACP',
      },
      description: 'Codex ACP dependency',
      source: {
        kind: 'github_release_binary',
        repo: 'zed-industries/codex-acp',
        distTag: CODEX_ACP_DIST_TAG,
      },
      binary: {
        commands: ['codex-acp'],
        systemFirst: true,
      },
      defaultPolicy: {
        autoInstallWhenNeeded: true,
        autoUpdateMode: 'auto',
      },
      consent: {
        install: 'not_required',
        update: 'not_required',
      },
      stability: {
        experimental: true,
      },
    });

    const externalShadow = installables.InstallableDependencyDescriptorSchema.parse({
      ...builtIn,
      display: {
        name: 'Shadow Codex ACP',
      },
    });

    const registry = installables.resolveInstallablesRegistry({
      builtIns: [{
        owner: {
          provenance: 'built_in',
          ownerId: 'happier.core',
        },
        descriptor: builtIn,
      }],
      externalPlugins: [{
        owner: {
          provenance: 'external_plugin',
          ownerId: 'acme.shadow',
          pluginId: 'acme.shadow',
        },
        descriptor: externalShadow,
      }],
    });

    expect(registry.descriptors.map((entry) => entry.descriptor.key)).toEqual([INSTALLABLE_KEYS.CODEX_ACP]);
    expect(registry.descriptorsByKey[INSTALLABLE_KEYS.CODEX_ACP]?.owner.ownerId).toBe('happier.core');
    expect(registry.diagnostics).toEqual([
      expect.objectContaining({
        code: 'installable_duplicate_key',
        disabledOwnerId: 'acme.shadow',
        disabledProvenance: 'external_plugin',
        existingOwnerId: 'happier.core',
        existingProvenance: 'built_in',
        conflictedField: 'key',
      }),
    ]);
  });

  it('diagnoses same shared-group duplicates when nested descriptor fields differ', () => {
    const builtIn = installables.InstallableDependencyDescriptorSchema.parse({
      id: 'shared-tool',
      key: 'shared-tool',
      kind: 'dep',
      version: '1',
      capabilityId: 'dep.shared-tool',
      display: {
        name: 'Shared Tool',
      },
      description: 'Shared dependency',
      source: {
        kind: 'manual_only',
        setupUrl: 'https://example.com/shared-tool',
      },
      binary: {
        commands: ['shared-tool'],
        systemFirst: true,
      },
      defaultPolicy: {
        autoInstallWhenNeeded: false,
        autoUpdateMode: 'notify',
      },
      consent: {
        install: 'required',
        update: 'required',
      },
    });

    const nestedChange = installables.InstallableDependencyDescriptorSchema.parse({
      ...builtIn,
      display: {
        name: 'Shared Tool Plugin Variant',
      },
    });

    const registry = installables.resolveInstallablesRegistry({
      builtIns: [{
        owner: {
          provenance: 'built_in',
          ownerId: 'happier.core',
          sharedGroupId: 'shared-tool-family',
        },
        descriptor: builtIn,
      }],
      bundledFirstPartyPlugins: [{
        owner: {
          provenance: 'bundled_first_party_plugin',
          ownerId: 'happier.shared-tool-plugin',
          pluginId: 'happier.shared-tool-plugin',
          sharedGroupId: 'shared-tool-family',
        },
        descriptor: nestedChange,
      }],
    });

    expect(registry.diagnostics).toEqual([
      expect.objectContaining({
        code: 'installable_duplicate_key',
        disabledOwnerId: 'happier.shared-tool-plugin',
      }),
    ]);
  });
});
