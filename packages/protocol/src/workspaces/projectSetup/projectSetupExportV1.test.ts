import { describe, expect, it } from 'vitest';
import { resolveProjectDefinitionV1 } from './projectDefinitionCompositionV1.js';
import { defaultProjectSetupExportSelectionV1, listProjectSetupExportUnitsV1, projectSetupExportV1,
  selectProjectSetupExportV1 } from './projectSetupExportV1.js';
import type { ProjectManifestV1 } from './projectManifestV1.js';

const repository: ProjectManifestV1 = { version: 1, toolchain: { kind: 'host' },
  environmentVariables: [{ name: 'DATABASE_URL', kind: 'config', required: true }],
  workspace: { setup: [{ kind: 'command', command: 'pnpm install' }] },
  scripts: { dev: { source: { kind: 'command', command: 'pnpm dev' } }, lint: { source: { kind: 'command', command: 'pnpm lint' } } } };
const personal: ProjectManifestV1 = { version: 1,
  environmentVariables: [{ name: 'STRIPE_TEST_KEY', kind: 'secret', required: true }],
  workspace: { teardown: [{ kind: 'command', command: './scripts/drop-db.sh' }] },
  scripts: { lint: { source: { kind: 'command', command: 'pnpm lint --fix' } }, seed: { source: { kind: 'command', command: './seed.sh' } } } };
const definition = resolveProjectDefinitionV1({ repositoryManifest: repository, setupOverrides: personal });

describe('Project setup export (plan A §2: shared + personal by default, repository by choice)', () => {
  it('lists one unit per deciding declaration with the layer that decides it', () => {
    expect(listProjectSetupExportUnitsV1(definition)).toEqual(expect.arrayContaining([
      { path: ['toolchain'], layer: 'repository' },
      { path: ['workspace', 'setup'], layer: 'repository' },
      { path: ['workspace', 'teardown'], layer: 'personal' },
      { path: ['scripts', 'dev'], layer: 'repository' },
      { path: ['scripts', 'lint'], layer: 'personal' },
      { path: ['scripts', 'seed'], layer: 'personal' },
      { path: ['environmentVariables', 'DATABASE_URL'], layer: 'repository' },
      { path: ['environmentVariables', 'STRIPE_TEST_KEY'], layer: 'personal' },
    ]));
    expect(listProjectSetupExportUnitsV1(definition)).toHaveLength(8);
  });

  it('selects everything but the repository by default and never copies a repository entry silently', () => {
    const units = listProjectSetupExportUnitsV1(definition);
    const selected = defaultProjectSetupExportSelectionV1(units);
    expect(selectProjectSetupExportV1(definition.effectiveManifest!, selected)).toEqual({ version: 1,
      environmentVariables: [{ name: 'STRIPE_TEST_KEY', kind: 'secret', required: true }],
      workspace: { teardown: [{ kind: 'command', command: './scripts/drop-db.sh' }] },
      scripts: { lint: personal.scripts!.lint, seed: personal.scripts!.seed } });
  });

  it('includes a repository declaration the person deliberately selects, and returns the exact bytes', () => {
    const exported = projectSetupExportV1(definition, [['scripts', 'dev'], ['environmentVariables', 'DATABASE_URL']]);
    expect(exported.manifest).toEqual({ version: 1, environmentVariables: repository.environmentVariables,
      scripts: { dev: repository.scripts!.dev } });
    expect(exported.bytes).toBe(`${JSON.stringify(exported.manifest, null, 2)}\n`);
    expect(projectSetupExportV1(definition).selected).toEqual(defaultProjectSetupExportSelectionV1(exported.units));
  });

  it('ignores a selected path the definition does not declare', () => {
    expect(selectProjectSetupExportV1(definition.effectiveManifest!, [['scripts', 'missing'], ['devcontainer']])).toEqual({ version: 1 });
  });
});
