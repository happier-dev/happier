import { describe, expect, it } from 'vitest';
import { ModuleKind, transpileModule } from 'typescript';
import { renderCliBundledActionCliHelpAssets, renderCliBundledPluginManifestEntriesTs } from './registry';
import { projectActionCliHelpDeclaration } from '../../../src/cli/actions/commandHelp';
import { actionCliCommandPattern, listCompiledActionCliCommands } from '../../../src/cli/actions/compiledCommands';
import { loadActionCliPresentation } from '../../../src/cli/actions/commandPresentation';

describe('bundled manifest locator publication', () => {
  it('publishes demand-only help from the same canonical compiled models', async () => {
    const assets = renderCliBundledActionCliHelpAssets({ pluginPackages: [] });
    const help = assets.find((asset) => asset.relativePath.endsWith('generatedBundledActionCliHelp.ts'))!;
    const exports: Record<string, unknown> = {};
    new Function('exports', transpileModule(help.out, { compilerOptions: { module: ModuleKind.CommonJS } }).outputText)(exports);
    const expected = await Promise.all(listCompiledActionCliCommands().map(async (command) => (
      projectActionCliHelpDeclaration(command, (await loadActionCliPresentation(command.actionId))?.envelopeKind?.(command))
    )));
    expect(JSON.stringify(exports.BUNDLED_ACTION_CLI_HELP)).toBe(JSON.stringify(expected));
    expect((exports.BUNDLED_ACTION_CLI_HELP as readonly { path: readonly string[]; envelopeKind?: string }[])
      .find((command) => command.path.length === 1 && command.path[0] === 'list')?.envelopeKind).toBe('session_list');
    expect(assets.some((asset) => asset.relativePath.endsWith('generatedBundledCliHelpFacts.ts'))).toBe(true);
  });
  it('keeps declarations out of the imported locator module', () => {
    const output = renderCliBundledPluginManifestEntriesTs({ pluginPackages: [{
      pluginId: 'happier.fixture', pluginPackageId: 'fixture', packageName: '@happier-dev/plugins-fixture',
      packageVersion: '0.0.0', manifest: { schemaVersion: 2, id: 'happier.fixture', version: '0.0.0',
        runtime: { apiVersion: 1 }, contributes: {
          actions: [{ id: 'echo', title: 'Echo fixture', scopes: ['global'], surfaces: ['cli'], execution: { target: 'daemon' }, dangerLevel: 'safe', inputSchema: { type: 'object' }, cli: { path: ['fixture-notes', 'echo'] } }],
        } },
    }] });
    const exports: Record<string, unknown> = {};
    const emitted = transpileModule(output, { compilerOptions: { module: ModuleKind.CommonJS } }).outputText;
    new Function('exports', emitted)(exports);
    const locators = exports.BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS as readonly Record<string, unknown>[];
    expect(locators).toHaveLength(1);
    expect(locators[0]).not.toHaveProperty('manifest');
    expect(locators[0]).toMatchObject({ pluginId: 'happier.fixture',
      manifestRelativePath: 'assets/bundled-plugin-manifests/fixture.json' });
    const commands = listCompiledActionCliCommands();
    expect(commands.some((command) => command.positionalsBeforeLastSegment.length > 0)).toBe(true);
    expect(exports.BUNDLED_ACTION_CLI_COMMAND_PATHS).toEqual(commands.map((command) => ({
      actionId: command.actionId,
      path: command.path,
      visibility: command.visibility,
      pattern: actionCliCommandPattern(command),
    })));
    expect(exports.BUNDLED_FIRST_PARTY_PLUGIN_COMMAND_METADATA).toEqual([{
      pluginId: 'happier.fixture',
      agents: [],
      actions: [expect.objectContaining({
        pluginId: 'happier.fixture',
        definition: expect.objectContaining({ id: 'echo' }),
        admittedTarget: { declaration: expect.objectContaining({ cli: { path: ['fixture-notes', 'echo'] } }) },
        availability: { outcome: 'visible', code: 'plugin_contribution_available' },
      })],
    }]);
  });
});
