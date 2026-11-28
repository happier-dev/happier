import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getConnectedServiceRuntimeAuthAdapter, resolveConnectedServiceSwitchContinuity, verifyResumeReachableThroughCatalog } from '@/backends/catalog';
import type { ConnectedServiceSwitchContinuityParams } from '@/backends/types';
import { withTempDir } from '@/testkit/fs/tempDir';

function params(): ConnectedServiceSwitchContinuityParams {
  return {
    sessionId: 's', agentId: 'agy', serviceId: 'antigravity',
    previousBinding: { source: 'connected', selection: 'group', serviceId: 'antigravity', profileId: 'a', groupId: 'pool' },
    nextBinding: { source: 'connected', selection: 'group', serviceId: 'antigravity', profileId: 'b', groupId: 'pool' },
    fromBindings: { v: 1, bindingsByServiceId: { antigravity: { source: 'connected', selection: 'group', profileId: 'a', groupId: 'pool' } } },
    toBindings: { v: 1, bindingsByServiceId: { antigravity: { source: 'connected', selection: 'group', profileId: 'b', groupId: 'pool' } } },
  };
}

describe('AGY restart continuity through the provider catalog', () => {
  it('declares restart/rematerialize without live account-adoption proof', async () => {
    const adapter = await getConnectedServiceRuntimeAuthAdapter('agy');
    expect(adapter).not.toBeNull();
    expect(adapter!.canHotApply({ target: { agentId: 'agy' }, selection: null })).toMatchObject({ supported: false, recovery: 'restart_rematerialize' });
    await expect(adapter!.verifyActiveAccount!({ target: { agentId: 'agy' }, selection: null })).resolves.toMatchObject({ status: 'unavailable' });
  });
  it('requires shared state even for a same-pool member change rather than claiming hot adoption', async () => {
    await expect(resolveConnectedServiceSwitchContinuity('agy', params())).resolves.toMatchObject({
      mode: 'restart_shared_state_required', reason: 'agy_shared_state_required',
    });
  });
  it.each(['native_to_connected', 'connected_to_native'] as const)('continues %s through shared state like a pool change', async (transition) => {
    const native = {
      binding: { source: 'native', selection: 'native', serviceId: 'antigravity', profileId: null, groupId: null },
      bindings: { v: 1, bindingsByServiceId: { antigravity: { source: 'native' } } },
    } as const;
    const connected = { binding: params().nextBinding, bindings: params().toBindings };
    const [from, to] = transition === 'native_to_connected' ? [native, connected] : [connected, native];
    await expect(resolveConnectedServiceSwitchContinuity('agy', {
      ...params(), previousBinding: from.binding, nextBinding: to.binding, fromBindings: from.bindings, toBindings: to.bindings,
    })).resolves.toMatchObject({ mode: 'restart_shared_state_required', reason: 'agy_shared_state_required' });
  });

  it('proves only a conversation in the selected target profile; candidate hints cannot substitute', async () => {
    await withTempDir('agy-resume-', async (cwd) => {
      const home = join(cwd, 'target');
      const input = { targetMaterializedRoot: home, targetMaterializedEnv: { GEMINI_HOME: home }, cwd, vendorResumeId: 's', targetStrict: true };
      await expect(verifyResumeReachableThroughCatalog('agy', input)).resolves.toMatchObject({ ok: false });
      // The retired server's store is reachable because launch imports it into the CLI store.
      const legacy = join(home, 'antigravity-acp', 'conversations');
      await mkdir(legacy, { recursive: true });
      await writeFile(join(legacy, 's.db'), 'legacy-db');
      await expect(verifyResumeReachableThroughCatalog('agy', input)).resolves.toMatchObject({ ok: true, resolvedPath: join(legacy, 's.db') });
      const conversations = join(home, 'antigravity-cli', 'conversations');
      await mkdir(conversations, { recursive: true });
      await writeFile(join(conversations, 's.db'), 'fixture-db');
      await expect(verifyResumeReachableThroughCatalog('agy', input)).resolves.toMatchObject({ ok: true, resolvedPath: join(conversations, 's.db') });
      await expect(verifyResumeReachableThroughCatalog('agy', { ...input, vendorResumeId: '../s' })).resolves.toMatchObject({ ok: false });
      await expect(verifyResumeReachableThroughCatalog('agy', { ...input, targetMaterializedEnv: { GEMINI_HOME: join(cwd, 'empty') }, candidatePersistedSessionFile: join(conversations, 's.db') })).resolves.toMatchObject({ ok: false });
    });
  });
});
