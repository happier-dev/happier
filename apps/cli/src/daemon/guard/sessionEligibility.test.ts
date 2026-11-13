import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TrackedSession } from '../types';
import type { LiveWorkInventoryV1 } from '../lifecycle/managedActivity';
import { evaluateSessionEligibility } from './sessionEligibility';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { legacyPidSessionTrackingKey } from '@/daemon/sessions/sessionTrackingKey';

let runtime: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>>;
beforeAll(async () => { runtime = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
  runtimeOptions: { pluginIds: ['happier.agent.codex'] } }); });
afterAll(async () => { await runtime?.dispose(); });

const tracked: TrackedSession = { trackingKey: legacyPidSessionTrackingKey(42), pid: 42, happySessionId: 'session-1', startedBy: 'daemon' };
const resume = { sessionId: 'session-1', rawSession: { machineId: 'machine-1', path: '/project' },
  metadata: { runtimeDescriptorV1: { v: 1 as const, agentId: 'codex', agent: { backendMode: 'appServer' } }, machineId: 'machine-1', path: '/project', flavor: 'codex', codexSessionId: 'native-1' } };
const inventory: LiveWorkInventoryV1 = { coverage: 'complete', items: ['session', 'input', 'agents', 'attention'].map(category => ({
  category: category as 'session' | 'input' | 'agents' | 'attention', ownerRef: tracked,
  attribution: { kind: 'unknown' }, state: 'settled', settledAt: 20,
})) };

describe('automatic session stop eligibility', () => {
  it('uses the canonical resume builder and the runner settlement, not aggregate machine idleness', async () => {
    expect((await evaluateSessionEligibility({ tracked, inventory: { ...inventory, idleSince: 999 }, draft: { status: 'absent' }, resume })))
      .toMatchObject({ eligible: true, settledAt: 20, resumeOptions: { existingSessionId: 'session-1', directory: '/project' } });
    expect((await evaluateSessionEligibility({ tracked, inventory, draft: { status: 'absent' }, resume: { ...resume, metadata: {} } })))
      .toMatchObject({ eligible: false, reasons: [{ kind: 'not_resumable' }] });
  });
  it('fails closed when the vendor resume decision lacks canonical runtime mode', async () => {
    const { runtimeDescriptorV1: _descriptor, ...metadata } = resume.metadata;
    expect(await evaluateSessionEligibility({ tracked, inventory, draft: { status: 'absent' }, resume: { ...resume, metadata } }))
      .toMatchObject({ eligible: false, reasons: [{ kind: 'not_resumable' }] });
  });
  it('keeps a supported runtime without native resume identity', async () => {
    const { codexSessionId: _nativeId, ...metadata } = resume.metadata;
    expect(await evaluateSessionEligibility({ tracked, inventory, draft: { status: 'absent' }, resume: { ...resume, metadata } }))
      .toMatchObject({ eligible: false, reasons: [{ kind: 'not_resumable' }] });
  });
  it.each(['present', 'unknown'] as const)('never stops a session with %s draft truth', async status => {
    expect((await evaluateSessionEligibility({ tracked, inventory, draft: status === 'present' ? { status, updatedAt: 1 } : { status }, resume })))
      .toMatchObject({ eligible: false, reasons: [{ kind: status === 'present' ? 'unsent_draft' : 'draft_unknown' }] });
  });
  it.each(['input', 'setup', 'session', 'agents', 'attention'] as const)('keeps active %s work and its typed reason', async category => {
    const items = [...inventory.items, { category, ownerRef: tracked, attribution: { kind: 'unknown' as const }, state: 'active' as const,
      activeCount: 2 }];
    expect((await evaluateSessionEligibility({ tracked, inventory: { coverage: 'complete', items }, draft: { status: 'absent' }, resume })))
      .toMatchObject({ eligible: false, reasons: [{ kind: category === 'agents' ? 'subagents_running' : category === 'attention' ? 'waiting_for_you' : 'working',
        ...(category === 'agents' ? { count: 2 } : {}) }] });
  });
  it('fails closed for missing coverage, retired sessions, unknown work, and protected or stopping processes', async () => {
    for (const candidate of [
      { inventory: { ...inventory, coverage: 'unknown' as const }, tracked },
      { inventory: { ...inventory, items: [] }, tracked },
    ]) expect((await evaluateSessionEligibility({ ...candidate, draft: { status: 'absent' }, resume })).eligible).toBe(false);
    for (const [candidate, reason] of [
      [{ ...tracked, reattachedFromDiskMarker: true }, 'kill_protected'],
      [{ ...tracked, stopRequestedAtMs: 10 }, 'working'],
    ] as const) {
      const current = { ...inventory, items: inventory.items.map(item => ({ ...item, ownerRef: candidate })) };
      expect((await evaluateSessionEligibility({ tracked: candidate, inventory: current, draft: { status: 'absent' }, resume })))
        .toMatchObject({ eligible: false, reasons: [{ kind: reason }] });
    }
  });
});
