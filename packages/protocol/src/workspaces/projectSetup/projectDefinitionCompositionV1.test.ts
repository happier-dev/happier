import { describe, expect, it } from 'vitest';
import { resolveProjectDefinitionV1 } from './projectDefinitionCompositionV1.js';
import { ProjectManifestV1Schema, type ProjectManifestV1 } from './projectManifestV1.js';

const command = (command: string) => ({ kind: 'command' as const, command });
const sharedBasis = { sourceId: 'source', contentRevision: { headerVersion: 1, bodyVersion: 2 }, digest: 'a'.repeat(64) };

describe('effective Project definition', () => {
  it('uses ordered complete-entry replacement, preserves inherited fields and records overridden origins', () => {
    const repositoryManifest: ProjectManifestV1 = { version: 1, toolchain: { kind: 'host' },
      workspace: { setup: [command('repo')], teardown: [command('cleanup')], setupInputs: ['repo.sh'] },
      environmentVariables: [{ name: 'TOKEN', kind: 'secret', required: true }, { name: 'REGION', kind: 'config', required: false }],
      scripts: { build: { source: command('repo build'), execution: 'portable' }, test: { source: command('test') } },
      services: { web: { source: command('repo web'), port: 3000 }, worker: { source: command('worker') } } };
    const shared: ProjectManifestV1 = { version: 1, workspace: { setup: [command('shared')], setupInputs: [] },
      scripts: { build: { source: command('shared build') } },
      services: { web: { source: command('shared web') } },
      environmentVariables: [{ name: 'TOKEN', kind: 'config', required: false }] };
    const result = resolveProjectDefinitionV1({ repositoryManifest,
      acceptedSharedSetup: { ...sharedBasis, manifest: shared },
      setupOverrides: { version: 1, workspace: { setup: [] }, scripts: { personal: { source: command('personal') } } } });
    expect(result.effectiveManifest).toEqual({ version: 1, toolchain: { kind: 'host' },
      workspace: { setup: [], teardown: [command('cleanup')], setupInputs: [] },
      environmentVariables: [{ name: 'TOKEN', kind: 'config', required: false }, { name: 'REGION', kind: 'config', required: false }],
      scripts: { build: { source: command('shared build') }, test: { source: command('test') }, personal: { source: command('personal') } },
      services: { web: { source: command('shared web') }, worker: { source: command('worker') } } });
    expect(result.sharedBasis).toEqual(sharedBasis);
    expect(result.origins).toContainEqual({ path: ['workspace', 'setup'], layer: 'repository', overridden: true });
    expect(result.origins).toContainEqual({ path: ['workspace', 'setup'], layer: 'personal', overridden: false });
  });

  it('supports a shared-only Project and explicitly clears keyed collections', () => {
    const acceptedSharedSetup = { ...sharedBasis, manifest: { version: 1 as const,
      scripts: { run: { source: command('shared run') } }, environmentVariables: [{ name: 'TOKEN', kind: 'secret' as const, required: true }] } };
    expect(resolveProjectDefinitionV1({ repositoryManifest: null, acceptedSharedSetup }).effectiveManifest)
      .toEqual(acceptedSharedSetup.manifest);
    expect(resolveProjectDefinitionV1({ repositoryManifest: null, acceptedSharedSetup,
      setupOverrides: { version: 1, scripts: {}, environmentVariables: [] } }).effectiveManifest)
      .toEqual({ version: 1, scripts: {}, environmentVariables: [] });
    expect(resolveProjectDefinitionV1({ repositoryManifest: null }).effectiveManifest).toBeNull();
  });

  it('refuses colliding effective service slots after all authored layers have composed', () => {
    const repositoryManifest = ProjectManifestV1Schema.parse({ version: 1, worktreePorts: { enabled: true, slots: 2 },
      services: { web: { source: command('web'), runtime: { primary: true } } } });
    const acceptedSharedSetup = { ...sharedBasis, manifest: ProjectManifestV1Schema.parse({ version: 1,
      services: { api: { source: command('api'), runtime: { portSlot: 0 } } } }) };
    const setupOverrides = ProjectManifestV1Schema.parse({ version: 1,
      services: { web: { source: command('web'), runtime: { portSlot: 1 } } } });
    const repaired = resolveProjectDefinitionV1({ repositoryManifest, acceptedSharedSetup, setupOverrides });
    expect(repaired.effectiveManifest?.services).toEqual({
      web: setupOverrides.services!.web, api: acceptedSharedSetup.manifest.services!.api,
    });
    expect(() => resolveProjectDefinitionV1({ repositoryManifest, acceptedSharedSetup }))
      .toThrow(expect.objectContaining({ code: 'invalid_manifest' }));
  });
});
