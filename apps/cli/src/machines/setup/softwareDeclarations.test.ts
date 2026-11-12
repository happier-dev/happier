import { describe, expect, it } from 'vitest';
import { getMachineSetupDesiredV1 } from '@happier-dev/protocol';
import type { PluginJsonValueV2 } from '@happier-dev/protocol/plugins/contributions/jsonSchema';
import type { MachineSetupNativeCommand, MachineSetupNativeCommandResult } from '@happier-dev/cli-common/machineSetup';
import { prepareMachineSetupPlanV1 } from './prepareMachineSetupPlan';
import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';
import { projectLoadedPluginContributes } from '@/plugins/projection/registry/fullProjection';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { buildPluginProjectionFamilyV2 } from '@/plugins/projection/families';
import { machineRecipesProjectionFamily } from '@/plugins/projection/registry/machineRecipes';
import { createPluginRuntimeOccurrenceId } from '@/plugins/runtime/runtimeSlots';
import { installPackage } from '../../../../../packages/plugins/machine-recipes/src/installPackage';
import { googleChrome } from '../../../../../packages/plugins/machine-recipes/src/googleChrome';

const pluginId = 'happier.machine.recipes';
const ok = (stdout = ''): MachineSetupNativeCommandResult => ({ code: 0, stdout, stderr: '' });
const missing = (): MachineSetupNativeCommandResult => ({ code: null, errorCode: 'ENOENT', stdout: '', stderr: '' });

async function plan(inputs: PluginJsonValueV2, mode: 'available' | 'aptMissing' | 'denied' | 'pinMissing' | 'packageMissing' | 'allMissing' = 'available', recipeId = 'install-package') {
  const manifest = normalizePluginManifestV2({ schemaVersion: 2, id: pluginId, version: '0.0.0', displayName: 'Machine recipes',
    runtime: { apiVersion: 1 }, contributes: { machineRecipes: [
      { id: 'install-package', ...installPackage }, { id: 'google-chrome', ...googleChrome },
    ] } });
  const registry = createResolvedContributionRegistry({ ...projectLoadedPluginContributes({ provenance: 'external', loadResult: {
    loadedPlugins: [{ pluginId, pluginRootPath: '/plugins/machine-recipes', manifestPath: '/plugins/machine-recipes/plugin.json',
      daemonEntryPath: null, devDaemonEntryPath: null, sourceSpec: { kind: 'package', locator: pluginId, trustPolicy: 'local_trusted', installPolicy: 'copy' }, manifest }],
    diagnosticsByPluginId: {},
  } }), occurrenceIdsByPluginId: { [pluginId]: createPluginRuntimeOccurrenceId(pluginId) } });
  const current = await getMachineSetupDesiredV1({
    read: async () => ({ status: 'ready', metadata: {}, metadataVersion: 0 }),
    compareAndSwap: async () => { throw new Error('Planning cannot write desired setup'); },
  });
  const calls: MachineSetupNativeCommand[] = [];
  const result = await prepareMachineSetupPlanV1({ current,
    input: { homeId: 'home', machineId: 'guest', sources: [{ kind: 'direct', setup: { items: [{
      kind: 'softwareRecipe', selection: { ref: { pluginId, recipeId, revision: '1' }, inputs },
    }] } }] },
    readRecipes: async () => Object.values(buildPluginProjectionFamilyV2({ registry, generation: 1 }, machineRecipesProjectionFamily).entriesById),
    runNative: async command => {
      calls.push(command);
      if (command.executable === 'dpkg') return ok('amd64\n');
      if (command.executable === 'apt-get' && command.args[0] === '--version') {
        if (mode === 'aptMissing' || mode === 'allMissing') return missing();
        if (mode === 'denied') return { code: null, errorCode: 'EACCES', stdout: '', stderr: '' };
        return ok('apt 2.6\n');
      }
      if (command.executable === 'dpkg-query') return { code: 1, stdout: '', stderr: '' };
      if (command.executable === 'lslocks') return ok('{"locks":[]}');
      if (command.executable === 'apt-cache') {
        const name = String(command.args.at(-1)).split('=')[0];
        return ok(command.args[0] === 'policy'
          ? `${name}:\n  Candidate: ${mode === 'packageMissing' ? '(none)' : '1'}\n  Version table:\n     1 500\n`
          : `Package: ${name}\nVersion: 1\nArchitecture: amd64\n\n`);
      }
      if (command.executable === 'dnf') {
        if (mode === 'allMissing') return missing();
        return command.args[0] === '--version' ? ok('4.20.0\n') : ok('wanted\t0:1-1\tx86_64\n');
      }
      if (command.executable === 'rpm') return command.args[0] === '--eval' ? ok('x86_64\n')
        : { code: 1, stdout: `package ${command.args.at(-1)} is not installed\n`, stderr: '' };
      if (mode === 'allMissing' && (command.executable === 'brew' || command.executable === 'winget.exe')) return missing();
      throw new Error(`Unexpected native command: ${command.executable} ${command.args.join(' ')}`);
    },
  });
  return { result, calls };
}

describe('first-party software data through the canonical setup planner', () => {
  it('does not bind or probe omitted earlier managers, and selects only the first supported supplied manager', async () => {
    const later = await plan({ dnf: [{ name: 'wanted' }] });
    expect(later.result).toMatchObject({ support: [{ status: 'drifted' }], recipePlans: [{ plan: {
      steps: [{ kind: 'package', manager: 'dnf', packages: [{ name: 'wanted' }] }], checks: [{ id: 'manager-dnf' }],
    } }] });
    expect(later.calls.some(command => command.executable === 'apt-get' || command.executable === 'dpkg')).toBe(false);
    const first = await plan({ apt: [{ name: 'wanted' }], dnf: [{ name: 'wanted' }] });
    expect(first.result).toMatchObject({ support: [{ status: 'drifted' }], recipePlans: [{ plan: {
      steps: [{ kind: 'package', manager: 'apt' }], checks: [{ id: 'manager-apt' }],
    } }] });
    expect(first.calls.some(command => command.executable === 'dnf' || command.executable === 'systemctl')).toBe(false);
  });

  it('selects a later manager only from a genuine earlier manager absence fact', async () => {
    const { result } = await plan({ apt: [{ name: 'wanted' }], dnf: [{ name: 'wanted' }] }, 'aptMissing');
    expect(result).toMatchObject({ support: [{ status: 'drifted' }], recipePlans: [{ plan: {
      steps: [{ manager: 'dnf' }], checkFacts: [
        { stepId: 'manager-apt', status: 'unsupported', reason: 'required_fact_unavailable', facts: { manager: 'apt', requiredFact: 'packageManager' } },
        { stepId: 'manager-dnf', status: 'satisfied' },
      ],
    } }] });
  });

  it('refuses denied inspection and keeps unresolved apt candidates with their selected manager for Apply to refresh', async () => {
    for (const mode of ['denied', 'pinMissing', 'packageMissing'] as const) {
      const { result, calls } = await plan({ apt: [{ name: 'wanted', ...(mode === 'pinMissing' ? { version: '2' } : {}) }], dnf: [{ name: 'wanted' }] }, mode);
      expect(result).toMatchObject({ support: [{ status: mode === 'denied' ? 'unavailable' : 'drifted' }] });
      if (mode !== 'denied') expect(result).toMatchObject({ recipePlans: [{ plan: { nativeFacts: [
        { status: 'drifted', facts: { manager: 'apt', unresolvedPackages: ['wanted'] } },
      ] } }] });
      expect(calls.some(command => command.executable === 'dnf')).toBe(false);
    }
    const invalid = await plan({ apt: [{ name: '--injected' }], dnf: [{ name: 'wanted' }] });
    expect(invalid.result).toMatchObject({ ok: false, errorCode: 'invalid_machine_recipe_inputs' });
    expect(invalid.calls).toEqual([]);
  });

  it('does not manufacture a manager or Chrome repository when native prerequisites are absent', async () => {
    const generic = await plan({ apt: [{ name: 'wanted' }], dnf: [{ name: 'wanted' }] }, 'allMissing');
    expect(generic.result).toMatchObject({ support: [{ status: 'unsupported' }], recipePlans: [{ plan: { steps: [] } }] });
    const chrome = await plan({}, 'packageMissing', 'google-chrome');
    expect(chrome.result).toMatchObject({ support: [{ status: 'drifted' }], recipePlans: [{ plan: {
      steps: [{ kind: 'package', manager: 'apt', packages: [{ name: 'google-chrome-stable' }] }],
      nativeFacts: [{ status: 'drifted', facts: { unresolvedPackages: ['google-chrome-stable'] } }],
    } }] });
    expect(chrome.calls.some(command => command.executable === 'dnf' || command.executable === 'curl')).toBe(false);
  });
});
