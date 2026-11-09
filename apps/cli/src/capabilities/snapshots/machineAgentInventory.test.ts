import { describe, expect, it } from 'vitest';
import { createMachineAgentInventoryPublication, projectMachineAgentInventoryFromCliSnapshot } from './machineAgentInventory';
import type { DetectCliSnapshot } from './cliSnapshot';

const snapshot = (clis: DetectCliSnapshot['clis']): DetectCliSnapshot => ({
  path: null, clis, tmux: { available: false }, windowsTerminal: { available: false },
});

describe('Machine Agent install-fact publication', () => {
  it('never treats a failed full census as exhaustive, while complete removal observations remain authoritative', () => {
    const publish = createMachineAgentInventoryPublication();
    const admitted = { checkedAt: 1, installedAgentIds: ['acme.native/agent', 'codex'] };
    let published = admitted;
    let membershipChanges = 0;
    for (let arrival = 0; arrival < 128; arrival++) {
      const next = publish({ checkedAt: arrival + 2, snapshot: snapshot({ codex: {
        available: false, detectionError: { code: 'cli-detection-failed', message: 'Runtime unavailable' },
      } }) }, published)!;
      if (next !== published) membershipChanges++;
      published = next;
    }
    expect(membershipChanges).toBe(0);
    expect(published).toBe(admitted);
    // A successfully read catalog can confirm plugin removal; a successful CLI
    // negative still confirms a real uninstall rather than retaining it forever.
    const removedPlugin = publish({ checkedAt: 200,
      snapshot: snapshot({ codex: { available: true, installed: true } }) }, published);
    expect(removedPlugin).toEqual({ checkedAt: 200, installedAgentIds: ['codex'] });
    expect(publish({ checkedAt: 201,
      snapshot: snapshot({ codex: { available: false, installed: false } }) }, removedPlugin))
      .toEqual({ checkedAt: 201, installedAgentIds: [] });
  });

  it('retains the published observation when a later probe confirms the same installed Agents', () => {
    const current = { checkedAt: 10, installedAgentIds: ['codex'] };
    expect(projectMachineAgentInventoryFromCliSnapshot({ current, checkedAt: 20,
      snapshot: snapshot({ codex: { available: true, installed: true } }) })).toBe(current);
  });

  it('advances private observation ordering on equal facts and refuses older contradictory results', () => {
    const publish = createMachineAgentInventoryPublication();
    const current = { checkedAt: 10, installedAgentIds: ['codex'] };
    expect(publish({ checkedAt: 20, snapshot: snapshot({ codex: { available: true, installed: true } }) }, current)).toBe(current);
    expect(publish({ checkedAt: 15, snapshot: snapshot({ codex: { available: false, installed: false } }) }, current)).toBe(current);
    const removed = publish({ checkedAt: 30, snapshot: snapshot({ codex: { available: false, installed: false } }) }, current);
    expect(removed).toEqual({ checkedAt: 30, installedAgentIds: [] });
    expect(publish({ checkedAt: 25, snapshot: snapshot({ codex: { available: true, installed: true } }) }, removed)).toBe(removed);
  });

  it('merges overlapping partial observations before their previous publication is acknowledged', () => {
    const publish = createMachineAgentInventoryPublication();
    const installed = publish({ checkedAt: 10, observedAgentIds: ['codex'],
      snapshot: snapshot({ codex: { available: true, installed: true } }) });
    expect(installed).toEqual({ checkedAt: 10, installedAgentIds: ['codex'] });
    const combined = publish({ checkedAt: 20, observedAgentIds: ['claude'],
      snapshot: snapshot({ claude: { available: true, installed: true } }) });
    expect(combined).toEqual({ checkedAt: 20, installedAgentIds: ['claude', 'codex'] });
    expect(publish({ checkedAt: 15, snapshot: snapshot({ codex: { available: false, installed: false } }) }, combined)).toBe(combined);
    expect(publish({ checkedAt: 20, observedAgentIds: ['claude'],
      snapshot: snapshot({ claude: { available: true, installed: true } }) }, installed)).toEqual(combined);
  });

  it('rebases ordering from newer retained metadata and preserves a positive fact when a probe fails', () => {
    const publish = createMachineAgentInventoryPublication();
    const current = { checkedAt: 30, installedAgentIds: ['codex'] };
    expect(publish({ checkedAt: 20, snapshot: snapshot({ codex: { available: false, installed: false } }) }, current)).toBe(current);
    expect(publish({ checkedAt: 40, observedAgentIds: ['codex'], snapshot: snapshot({ codex: {
      available: false, detectionError: { code: 'cli-detection-failed', message: 'Unavailable' },
    } }) }, current)).toBe(current);
    expect(publish({ checkedAt: 35, snapshot: snapshot({ codex: { available: false, installed: false } }) }, current)).toBe(current);
  });

  it('retries unpublished install facts after a failed metadata write, including a newer equal observation', () => {
    const publish = createMachineAgentInventoryPublication();
    const published = { checkedAt: 10, installedAgentIds: ['codex'] };
    const removed = publish({ checkedAt: 20, snapshot: snapshot({ codex: { available: false, installed: false } }) }, published);
    expect(removed).toEqual({ checkedAt: 20, installedAgentIds: [] });
    // The CAS failed: the next probe must compare with the actual retained metadata, not its previous desired write.
    const retry = publish({ checkedAt: 30, snapshot: snapshot({ codex: { available: false, installed: false } }) }, published);
    expect(retry).toEqual({ checkedAt: 30, installedAgentIds: [] });
    expect(retry).not.toBe(published);
    expect(publish({ checkedAt: 25, snapshot: snapshot({ codex: { available: true, installed: true } }) }, retry)).toBe(retry);
    const remote = { checkedAt: 40, installedAgentIds: ['claude'] };
    expect(publish({ checkedAt: 35, snapshot: snapshot({ codex: { available: true, installed: true } }) }, remote)).toBe(remote);
    expect(publish({ checkedAt: 50, observedAgentIds: ['codex'],
      snapshot: snapshot({ codex: { available: true, installed: true } }) }, remote))
      .toEqual({ checkedAt: 50, installedAgentIds: ['claude', 'codex'] });
  });
});
