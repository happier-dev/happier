import { describe, expect, it } from 'vitest';
import { getMachineSetupDesiredV1, type MachineSetupSourceV1 } from '@happier-dev/protocol/machines/setup/machineSetupSourcesV1';
import { prepareMachineSetupPlanV1 } from './prepareMachineSetupPlan';
import { prepareMachineSetupStages } from './applyMachineSetup';
import { prepareMachineSetupPreparationV1 } from './prepareMachineSetupPreparation';
import { observeMachineSetupInitialPresence } from './initialPresence';

describe('Team preset Agent declarations in Machine Setup Plan', () => {
  it.each(['script-only control', 'review declared Agent', 'read declared Agent observation'] as const)(
    '%s preserves the copied setup without treating Agents as recipes', async scenario => {
      // Same Team-owned preset shape as the loaded Team setup failure; its
      // declaration belongs to the Agent installer, not the recipe catalog.
      const sources: MachineSetupSourceV1 = [{ kind: 'accountPreset',
        presetId: '6f74f585-178a-471b-9d46-66dcb13ba865', presetRevision: 0,
        setupRevision: 0, contentEncryptionMode: 'e2ee', setup: {
          ...(scenario === 'script-only control' ? {} : { items: [{ kind: 'agent' as const, agentId: 'pi' }] }),
          scripts: [{ body: 'printf TS-WAVE-D-TEAM-BATCH', affects: 'none' }],
        } }, { kind: 'direct', setup: {} }];
      const current = await getMachineSetupDesiredV1({
        read: async () => ({ status: 'ready', metadataVersion: 1,
          metadata: { setup: { version: 1, revision: 0, sources, exclusions: [] } } }),
        compareAndSwap: async () => { throw new Error('Planning cannot publish desired state'); },
      });
      const observing = scenario === 'read declared Agent observation';
      const result = await prepareMachineSetupPlanV1({ current,
        input: { homeId: 'home', machineId: 'member',
          ...(observing ? {} : { sources, mode: 'effects' as const }) },
        ...(observing ? { observation: { version: 1 as const, desiredRevision: 0,
          status: 'unverifiable' as const, recipes: [] } } : {}),
        runNative: async () => { throw new Error('An Agent declaration cannot execute a native recipe'); },
      });
      expect(result).toMatchObject({ desiredRevision: 0, sources, exclusions: [],
        support: scenario === 'script-only control' ? [] : [
          { sourceIndex: 0, itemIndex: 0, status: 'unverifiable', reason: 'required_fact_unavailable' },
        ] });
      expect(result).not.toHaveProperty('recipeTitles');
      if (!observing) expect(result).toHaveProperty('recipePlans', []);
    });

  it('retains the Agent for its installer when preparing reviewed native recipe stages', () => {
    const setup = { items: [{ kind: 'agent' as const, agentId: 'pi' }] };
    expect(prepareMachineSetupStages([setup], [])).toMatchObject({ ok: true, setup, sources: [setup] });
    expect(observeMachineSetupInitialPresence([{ kind: 'direct', setup }], [])).toEqual({});
  });

  it('defers an Agent declaration instead of trying to bake a recipe for it', () => {
    const setup = { items: [{ kind: 'agent' as const, agentId: 'pi' }] };
    expect(prepareMachineSetupPreparationV1({ operationId: 'team-setup', setup, recipes: [] }))
      .toEqual({ deferredSetup: setup });
  });
});
