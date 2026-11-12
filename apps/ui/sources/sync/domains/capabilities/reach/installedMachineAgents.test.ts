import { expect, it } from 'vitest';
import { createMachineAgentInventoryStore } from '@/agents/machineAgents/machineAgentInventoryStore';
import type { MachineAgentInventoryItem } from '@happier-dev/protocol/capabilities';
import { buildConfiguredAcpAgentSelectionV1 } from '@happier-dev/protocol/agents/executionTargetV1';
import { readInstalledMachineAgentIds, readInstalledMachineAgentInventory } from './installedMachineAgents';

const facts = (agentId: string, installed: boolean): MachineAgentInventoryItem => ({ agentId, title: agentId,
  installed, version: null, latestVersion: null, update: { supported: false, command: null },
  signIn: { status: 'unknown', loginSupport: 'unsupported' }, platform: { supported: true },
  install: { available: false, mode: 'none', sizeBytes: null, guideUrl: null }, dependencies: [] });

it('reads published facts on a fresh device and an empty current publication supersedes stale cache', () => {
  const published = { checkedAt: 2, installedAgentIds: ['codex'] };
  expect(readInstalledMachineAgentIds(published, undefined)).toEqual(['codex']);
  expect(readInstalledMachineAgentInventory(published, undefined, []).complete).toBe(true);
  const store = createMachineAgentInventoryStore();
  store.publish('machine', { status: 'offline', lastCheckedAt: 1, items: [facts('claude', true)] });
  expect(readInstalledMachineAgentIds({ checkedAt: 2, installedAgentIds: [] }, store.read('machine'))).toEqual([]);
  expect(readInstalledMachineAgentIds(undefined, store.read('machine'))).toEqual(['claude']);
});

it('keeps the daemon publication authoritative when a device has a newer partial cache', () => {
  const store = createMachineAgentInventoryStore();
  store.publish('machine', { status: 'ready', lastCheckedAt: 3,
    items: [facts('codex', false), facts('claude', true)],
    descriptors: [{ agentId: 'codex', title: 'Codex' }, { agentId: 'claude', title: 'Claude' },
      { agentId: 'gemini', title: 'Gemini' }],
    unavailable: [{ agentId: 'gemini', reason: 'probe_failed' }],
  });
  expect(readInstalledMachineAgentIds({ checkedAt: 2, installedAgentIds: ['codex', 'gemini', 'pi'] },
    store.read('machine'))).toEqual(['codex', 'gemini', 'pi']);
});

it.each(['custom-acp', buildConfiguredAcpAgentSelectionV1('review').agentId])(
  'requires concrete installed definitions from %s before a definition-only Agent contributes to reach', (inventoryAgentId) => {
  const published = { checkedAt: 2, installedAgentIds: ['codex', 'custom-acp'] };
  expect(readInstalledMachineAgentIds(published, undefined)).toEqual(['codex']);
  expect(readInstalledMachineAgentInventory(published, undefined).complete).toBe(false);
  expect(readInstalledMachineAgentInventory(published, undefined, []).complete).toBe(true);
  const store = createMachineAgentInventoryStore();
  store.publish('machine', { status: 'ready', lastCheckedAt: 3, items: [
    { ...facts(inventoryAgentId, true), definitionId: 'review', title: 'Review agent' },
    { ...facts(inventoryAgentId, true), definitionId: 'build', title: 'Build agent' },
    { ...facts(inventoryAgentId, false), definitionId: 'absent', title: 'Absent agent' },
  ] });
  expect(readInstalledMachineAgentIds(published, store.read('machine'), ['review', 'build', 'absent'])).toEqual(['codex', 'custom-acp']);
  expect(readInstalledMachineAgentInventory(published, store.read('machine'), ['review', 'build', 'absent']).complete).toBe(true);
  expect(readInstalledMachineAgentIds(undefined, store.read('machine'), ['review', 'build', 'absent'])).toEqual([inventoryAgentId]);
  expect(readInstalledMachineAgentIds(published, store.read('machine'), [])).toEqual(['codex']);
  expect(readInstalledMachineAgentIds({ checkedAt: 4, installedAgentIds: [] }, store.read('machine'))).toEqual([]);
});
