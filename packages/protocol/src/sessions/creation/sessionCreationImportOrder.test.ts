import { describe, expect, it, vi } from 'vitest';

function assertManagedBirthAdmission(spawn: typeof import('./sessionSpawnNewInputV2.js')) {
  const managedCreation = { homeId: 'home', managedId: 'managed',
    controller: { machineId: 'controller', installationId: 'installation' } };
  expect(spawn.SessionSpawnNewInputV2Schema.parse({
    executionTarget: { serverId: 'home', machineId: 'guest' }, directory: { kind: 'managed' },
    agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } }, managedCreation,
  }).managedCreation).toEqual(managedCreation);
}

async function importCreationAfterAutomation() {
  await import('../../automations/automationRunExecutionRecipeV1.js');
  const spawn = await import('./sessionSpawnNewInputV2.js');
  const preparation = await import('./sessionCreationTargetPreparationV1.js');
  return { spawn, preparation };
}

async function importCreationSettlementAfterActionSpecs() {
  await import('../../actions/actionSpecs.js');
  return await import('./sessionSpawnNewResultV1.js');
}

async function importAutomationAfterCreation() {
  const preparation = await import('./sessionCreationTargetPreparationV1.js');
  const spawn = await import('./sessionSpawnNewInputV2.js');
  await import('../../automations/automationRunExecutionRecipeV1.js');
  return { spawn, preparation };
}

describe('Session creation source import order', () => {
  it('initializes creation schemas after the Automation recipe graph', async () => {
    vi.resetModules();
    const { spawn, preparation } = await importCreationAfterAutomation();
    expect(spawn.SessionAuthoringCheckoutCreationDraftV1Schema).toBeDefined();
    expect(spawn.SessionServerStartSpawnDraftV1Schema).toBeDefined();
    expect(preparation.SessionCreationTargetPreparationRequestV1Schema).toBeDefined();
    assertManagedBirthAdmission(spawn);
    // Each case resets the module registry and re-imports the Automation recipe
    // graph cold, which is seconds of work under directory-level parallelism.
    // The budget matches the settlement case below rather than the 5 s default.
  }, 30_000);

  it('initializes the Automation recipe graph after creation schemas', async () => {
    vi.resetModules();
    const { spawn, preparation } = await importAutomationAfterCreation();
    expect(spawn.SessionAuthoringCheckoutCreationDraftV1Schema).toBeDefined();
    expect(spawn.SessionServerStartSpawnDraftV1Schema).toBeDefined();
    expect(preparation.SessionCreationTargetPreparationRequestV1Schema).toBeDefined();
    assertManagedBirthAdmission(spawn);
  }, 30_000);

  it('initializes creation settlement after the Action-spec graph', async () => {
    vi.resetModules();
    const settlement = await importCreationSettlementAfterActionSpecs();
    expect(settlement.SessionSpawnNewResultV1Schema).toBeDefined();
  }, 30_000);
});
