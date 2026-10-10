import { describe, expect, it } from 'vitest';
import { createUsageSourceActionPort } from './usageSourceActions.js';
import type { UsageSourceV1 } from '../../usage/usageSources.js';

const source: UsageSourceV1 = { serverId: 'home', machineId: 'machine', sourceId: 'opaque-root',
  agent: { pluginId: 'happier.agent.codex', localId: 'codex' },
  root: { kind: 'default', path: '/private/source' }, consent: 'disabled', status: 'found',
  coverage: 'unknown', pendingCount: 0, asOfMs: null };

describe('admitted Usage source transport', () => {
  it('enforces the captured Home even when invocation context omits its optional Home field', async () => {
    const transport = { serverId: 'home', assertCurrent: () => {},
      rpc: async () => ({ sources: [{ ...source, serverId: 'other' }] }) };
    const port = createUsageSourceActionPort(transport);
    expect(await port({ actionId: 'usage.sources.discover', input: { serverId: 'other', machineId: 'machine' } }, { surface: 'ui' }))
      .toMatchObject({ ok: false, errorCode: 'server_target_mismatch' });
  });

  it('rejects a mutation response for a different source while allowing root replacement identity', async () => {
    // Machine RPC is a genuine transport boundary; domain owners remain real.
    const port = createUsageSourceActionPort({ serverId: 'home', assertCurrent: () => {},
      rpc: async () => ({ source: { ...source, sourceId: 'other-root' } }) });
    const context = { surface: 'ui' as const, serverId: 'home' };
    const input = { serverId: 'home', machineId: 'machine', sourceId: 'opaque-root' };
    expect(await port({ actionId: 'usage.sources.stop', input }, context))
      .toMatchObject({ ok: false, errorCode: 'usage_source_mutation_outcome_unknown' });
    expect(await port({ actionId: 'usage.sources.root.set', input: { ...input, root: '/new/root' } }, context))
      .toMatchObject({ source: { sourceId: 'other-root' } });
  });

  it('rejects a retired Account read and acknowledges an applied stop without disclosing the old source card', async () => {
    const controller = new AbortController();
    const port = createUsageSourceActionPort({ serverId: 'home', assertCurrent: context => context.signal?.throwIfAborted(),
      rpc: async () => { controller.abort(); return { sources: [source] }; } });
    const context = { surface: 'ui' as const, serverId: 'home', signal: controller.signal };
    await expect(port({ actionId: 'usage.sources.get', input: { serverId: 'home', machineId: 'machine' } }, context)).rejects.toThrow();
    const stopController = new AbortController();
    const stop = createUsageSourceActionPort({ serverId: 'home', assertCurrent: context => context.signal?.throwIfAborted(),
      rpc: async () => { stopController.abort(); return { source }; } });
    expect(await stop({ actionId: 'usage.sources.stop', input: { serverId: 'home', machineId: 'machine', sourceId: source.sourceId } },
      { ...context, signal: stopController.signal })).toMatchObject({ ok: false,
        errorCode: 'usage_source_mutation_acknowledged_scope_retired', details: { mutationStatus: 'applied' } });
  });
});
