import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { describe, expect, it } from 'vitest';
import { createActionExecutor, getMachineSetupDesiredV1 } from '@happier-dev/protocol';
import { createCanonicalJsonSigningInput } from '@happier-dev/protocol/crypto/canonicalJson';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { acquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import { createMachineSetupPlanAction } from './machineSetupAction';

describe('Machine setup declared removal through the public Plan Action', () => {
  it.each(['native-absent', 'unknown', 'retired-source-field'] as const)('plans declared removal only from native absence, without installing or mutating desired state (%s)', async scenario => {
    const pluginId = 'com.example.removal-tools';
    const ref = { pluginId, recipeId: 'owned-tool', revision: '1' };
    const item = { kind: 'softwareRecipe' as const, selection: { ref, inputs: {} } };
    const itemKey = createCanonicalJsonSigningInput(item);
    const direct = { kind: 'direct' as const, setup: {} };
    const sources = [{ kind: 'accountPreset' as const, presetId: 'tools', presetRevision: 1,
      setup: { items: [item] }, ...(scenario === 'retired-source-field' ? { alreadyPresentAtFirstApply: { [itemKey]: false } } : {}) }, direct];
    const sourceFacts = scenario === 'native-absent' ? { 'account:tools': { firstPresence: { [itemKey]: 'absent' } } } : undefined;
    const runtime = await createAuthoredAdmittedPluginRuntimeFixture({ coldStart: true, plugins: [{ files: {}, manifest: {
      schemaVersion: 2, id: pluginId, version: '1.0.0', displayName: 'Tools', runtime: { apiVersion: 1 },
      contributes: { machineRecipes: [{ id: ref.recipeId, revision: ref.revision, title: 'Owned tool', software: true,
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        steps: [{ id: 'install-owned', kind: 'command', executable: 'install', args: ['--', '/example/source', '/example/owned'],
          check: { executable: 'test', args: ['-e', '/example/owned'], unsatisfiedExitCodes: [1] } }],
        removeSteps: [{ id: 'remove-owned', kind: 'command', executable: 'rm', args: ['--', '/example/owned'],
          check: { executable: 'test', args: ['!', '-e', '/example/owned'], unsatisfiedExitCodes: [1] } }],
      }] },
    } }] });
    const nativeExecutables: string[] = [];
    let writes = 0;
    try {
      const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), machineSetupPlan: createMachineSetupPlanAction({ homeId: 'home', machineId: 'guest',
        apiMachine: { getMachineSetupDesiredSnapshot: () => getMachineSetupDesiredV1({
          read: async () => ({ status: 'ready', metadata: { setup: { version: 1, revision: 2, sources, exclusions: [],
            ...(sourceFacts ? { sourceFacts } : {}) } }, metadataVersion: 3 }),
          compareAndSwap: async () => { writes++; throw new Error('Plan must not publish desired state'); },
        }) }, acquirePluginRuntimeRegistryLease: () => acquireAuthoritativePluginRuntimeRegistryLease({
          controller: runtime.controller, happyHomeDir: runtime.happyHomeDir,
        }),
        // Substitute only the native process boundary. Real declaration loading,
        // Action parsing, source diff, expansion, observation and digest stay live.
        runNative: async command => {
          nativeExecutables.push(command.executable);
          if (command.executable !== 'test') throw new Error('Plan attempted a native effect');
          return { code: command.args.includes('!') ? 1 : 0, stdout: '', stderr: '' };
        },
      }) });
      const result = await executor.execute('machines.setup.plan', { homeId: 'home', machineId: 'guest', sources: [direct],
        mode: 'effects', removeItemKeys: [itemKey] }, { surface: 'cli', authority: 'present_user' });
      if (scenario !== 'native-absent') {
        expect(result).toMatchObject({ ok: false, errorCode: 'remove_unsupported' });
        expect(nativeExecutables).toEqual([]);
        expect(writes).toBe(0);
        return;
      }
      expect(result).toMatchObject({ ok: true, result: { sources: [direct], recipePlans: [],
        recipeTitles: [{ ref, title: 'Owned tool' }], removalPlans: [{ itemKey,
        plan: { basis: { kind: 'setup', machineId: 'guest', desiredRevision: 2, selection: item.selection },
          steps: [{ id: 'remove-owned', kind: 'command', executable: 'rm', args: ['--', '/example/owned'] }] },
      }] } });
      if (!result.ok || !result.result || typeof result.result !== 'object' || !('removalPlans' in result.result))
        throw new Error('Expected a declared removal plan');
      expect(result.result.removalPlans).toHaveLength(1);
      expect(nativeExecutables.length).toBeGreaterThan(0);
      expect(nativeExecutables.every(executable => executable === 'test')).toBe(true);
      expect(writes).toBe(0);
    } finally { await runtime.dispose(); }
  });
});
