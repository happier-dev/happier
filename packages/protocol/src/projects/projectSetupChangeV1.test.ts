import { describe, expect, it } from 'vitest';
import * as changeOwner from './projectSetupChangeV1.js';
import { projectSharedSetupDigestV1 } from './projectSetupV1.js';
import { resolveProjectDefinitionV1 } from '../workspaces/projectSetup/projectDefinitionCompositionV1.js';
import { ProjectManifestV1Schema, type ProjectManifestV1 } from '../workspaces/projectSetup/projectManifestV1.js';

const command = (command: string) => ({ kind: 'command' as const, command });
const definition = (manifest: ProjectManifestV1 | null) => resolveProjectDefinitionV1({
  repositoryManifest: manifest === null ? null : ProjectManifestV1Schema.parse(manifest),
});
const publication = (manifest: ProjectManifestV1, bodyVersion = 1) => ({
  sourceId: 'source', contentRevision: { headerVersion: 1, bodyVersion },
  digest: projectSharedSetupDigestV1(manifest), manifest,
});

describe('shared setup change presentation', () => {
  it('retains the existing effective before/after review control', () => {
    const repositoryManifest = { version: 1 as const, workspace: { teardown: [command('repo cleanup')] } };
    const result = changeOwner.reviewProjectSharedSetupChangeV1({ repositoryManifest,
      acceptedSetup: { kind: 'ready', acceptedSharedSetup: publication({ version: 1,
        workspace: { setup: [command('old setup')] } }) },
      publication: publication({ version: 1, workspace: { setup: [command('new setup')] } }, 2) });
    expect(result).toMatchObject({ kind: 'changed',
      before: { effectiveManifest: { workspace: { setup: [command('old setup')], teardown: [command('repo cleanup')] } } },
      after: { effectiveManifest: { workspace: { setup: [command('new setup')], teardown: [command('repo cleanup')] } } } });
  });

  it('projects ordered lifecycle edits and typed login, source, requirement and port declarations', () => {
    const before = definition({ version: 1, workspace: {
      setup: [command('keep'), command('old setup'), command('removed setup')], setupInputs: ['old.sh'],
    }, toolchain: { kind: 'toolchain', tool: 'mise', configPath: 'mise.toml' },
    devcontainer: { configPath: 'old/devcontainer.json' }, worktreePorts: { enabled: true, slots: 1 },
    environmentVariables: [{ name: 'TOKEN', kind: 'secret', required: true }, { name: 'OLD', kind: 'config', required: false }],
    scripts: { build: { source: command('old build') } },
    services: { web: { source: command('serve'), port: 3000, runtime: { autostart: true } } } });
    const after = definition({ version: 1, workspace: {
      setup: [command('keep'), command('new setup')], teardown: [command('new cleanup')], setupInputs: ['new.sh'],
    }, toolchain: { kind: 'toolchain', tool: 'flox', configPath: 'manifest.toml' },
    devcontainer: { configPath: 'new/devcontainer.json' }, worktreePorts: { enabled: true, slots: 2 },
    environmentVariables: [{ name: 'TOKEN', kind: 'config', required: false }, { name: 'REGION', kind: 'config', required: false }],
    scripts: { build: { source: command('new build') } },
    services: { web: { source: command('serve'), port: 4000, runtime: { autostart: false } } } });
    const rows = changeOwner.projectSharedSetupChangeRowsV1(before, after);
    expect(rows.map(row => [row.entry, row.key, row.op])).toEqual([
      ['step', 'setup:1', 'changed'], ['step', 'setup:2', 'removed'], ['step', 'teardown:0', 'added'],
      ['login', 'toolchain', 'changed'], ['input', 'setupInputs', 'changed'], ['tool', 'devcontainer', 'changed'],
      ['env', 'OLD', 'removed'], ['env', 'REGION', 'added'], ['env', 'TOKEN', 'changed'],
      ['ports', 'worktreePorts', 'changed'], ['script', 'build', 'changed'], ['service', 'web', 'changed'],
    ]);
    expect(rows[0]).toEqual({ entry: 'step', phase: 'setup', key: 'setup:1', op: 'changed',
      before: command('old setup'), after: command('new setup'), origin: {
        before: { path: ['workspace', 'setup'], layer: 'repository', overridden: false },
        after: { path: ['workspace', 'setup'], layer: 'repository', overridden: false },
      } });
    expect(rows.find(row => row.entry === 'env' && row.key === 'TOKEN')).toMatchObject({
      before: { name: 'TOKEN', kind: 'secret', required: true }, after: { name: 'TOKEN', kind: 'config', required: false },
    });
    expect(rows.find(row => row.entry === 'ports')).toMatchObject({ before: { enabled: true, slots: 1 }, after: { enabled: true, slots: 2 } });
    expect(rows.find(row => row.entry === 'service')).toMatchObject({
      before: { port: 3000, runtime: { autostart: true } }, after: { port: 4000, runtime: { autostart: false } },
    });
  });

  it('does not report publication, provenance, key order or overridden-only changes as effective edits', () => {
    const repositoryManifest = ProjectManifestV1Schema.parse({ version: 1, workspace: { setup: [command('repo')] } });
    const setupOverrides = ProjectManifestV1Schema.parse({ version: 1, workspace: { setup: [command('personal')] },
      environmentVariables: [{ name: 'TOKEN', kind: 'secret', required: true }] });
    const before = resolveProjectDefinitionV1({ repositoryManifest, setupOverrides,
      acceptedSharedSetup: publication({ version: 1, workspace: { setup: [command('old shared')] } }) });
    const after = resolveProjectDefinitionV1({ repositoryManifest, setupOverrides,
      acceptedSharedSetup: publication({ version: 1, workspace: { setup: [command('new shared')] },
        environmentVariables: [{ name: 'TOKEN', kind: 'config', required: false }] }, 2) });
    expect(changeOwner.projectSharedSetupChangeRowsV1(before, after)).toEqual([]);
    const first = definition({ version: 1, workspace: { setup: [{ kind: 'command', command: 'setup', cwd: '.' }] },
      environmentVariables: [{ name: 'A', kind: 'config', required: false }, { name: 'B', kind: 'secret', required: true }] });
    const reordered = definition({ version: 1, environmentVariables: [
      { required: true, kind: 'secret', name: 'B' }, { required: false, kind: 'config', name: 'A' },
    ], workspace: { setup: [{ cwd: '.', command: 'setup', kind: 'command' }] } });
    expect(changeOwner.projectSharedSetupChangeRowsV1(first, { ...reordered, origins: [] })).toEqual([]);
    expect(changeOwner.projectSharedSetupChangeRowsV1(definition(null), definition({ version: 1,
      workspace: { setup: [], teardown: [], setupInputs: [] }, environmentVariables: [], scripts: {}, services: {} }))).toEqual([]);
  });

  it('uses shared origins for additions and personal clear origins for removals without inventing prior facts', () => {
    const manifest = ProjectManifestV1Schema.parse({ version: 1, workspace: { setup: [command('shared setup')],
      teardown: [command('shared cleanup')], setupInputs: ['setup.sh'] }, toolchain: { kind: 'toolchain', tool: 'mise' },
      worktreePorts: { enabled: true, slots: 1 }, environmentVariables: [{ name: 'TOKEN', kind: 'secret', required: true }] });
    const shared = resolveProjectDefinitionV1({ repositoryManifest: null, acceptedSharedSetup: publication(manifest) });
    const added = changeOwner.projectSharedSetupChangeRowsV1(definition(null), shared);
    expect(added.map(row => [row.entry, row.op])).toEqual([
      ['step', 'added'], ['step', 'added'], ['login', 'added'], ['input', 'added'], ['env', 'added'], ['ports', 'added'],
    ]);
    expect(added.every(row => row.origin.before === null && row.origin.after?.layer === 'shared')).toBe(true);
    expect(added.every(row => !('before' in row) && 'after' in row)).toBe(true);
    const cleared = resolveProjectDefinitionV1({ repositoryManifest: null, acceptedSharedSetup: publication(manifest),
      setupOverrides: { version: 1, workspace: { setup: [], teardown: [], setupInputs: [] }, environmentVariables: [] } });
    const removed = changeOwner.projectSharedSetupChangeRowsV1(shared, cleared);
    expect(removed.map(row => [row.entry, row.op])).toEqual([
      ['step', 'removed'], ['step', 'removed'], ['input', 'removed'], ['env', 'removed'],
    ]);
    expect(removed.every(row => row.origin.before?.layer === 'shared' && row.origin.after?.layer === 'personal')).toBe(true);
    expect(removed.every(row => 'before' in row && !('after' in row))).toBe(true);
  });
});
