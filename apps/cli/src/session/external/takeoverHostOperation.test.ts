import { describe, expect, it, vi } from 'vitest';

import {
  createExternalSessionTakeoverHostOperation,
} from './takeoverHostOperation';

const request = {
  pluginId: 'acme.plugin',
  contributionId: 'codex',
  generationId: 'generation-1',
  accountRevision: 'account-1',
  sessionId: 'current-session-1',
  machineId: 'machine-1',
  ref: { agentId: 'codex', sourceId: 'source-1', remoteSessionId: 'remote-1' },
  source: { kind: 'codexHome', home: 'user' },
  isCurrent: () => true,
} as const;

describe('external-session takeover host operation', () => {
  it('qualifies link resolution without synthesizing destructive stop authority', async () => {
    const ensureLink = vi.fn(async () => ({ ok: true, sessionId: 'linked-1', created: true }));
    const takeover = vi.fn(async () => ({
      ok: true as const,
      sessionId: 'linked-1',
      targetRuntimeMode: 'terminal' as const,
      storageMode: 'external-linked' as const,
      converted: false,
      takeoverStatus: 'takenOver' as const,
    }));
    const operation = createExternalSessionTakeoverHostOperation({ ensureLink, takeover });

    await expect(operation.execute(request)).resolves.toEqual({
      sessionId: 'linked-1',
      status: 'takenOver',
    });
    expect(ensureLink).toHaveBeenCalledWith({
      machineId: 'machine-1',
      agentId: 'codex',
      remoteSessionId: 'remote-1',
      source: { kind: 'codexHome', home: 'user' },
    });
    expect(takeover).toHaveBeenCalledWith({
      linkedSessionId: 'linked-1',
      targetRuntimeMode: 'terminal',
      storageMode: 'external-linked',
      machineId: 'machine-1',
    });
  });

  it('fences retirement after link resolution but preserves a successful committed action result', async () => {
    let current = true;
    const ensureLink = vi.fn(async () => {
      current = false;
      return { ok: true, sessionId: 'linked-1' };
    });
    const takeover = vi.fn();
    const operation = createExternalSessionTakeoverHostOperation({ ensureLink, takeover: takeover as never });
    await expect(operation.execute({ ...request, isCurrent: () => current }))
      .rejects.toMatchObject({ code: 'plugin_generation_retired' });
    expect(takeover).not.toHaveBeenCalled();

    const controller = new AbortController();
    let resolveTakeover!: (value: {
      ok: true;
      sessionId: string;
      targetRuntimeMode: 'terminal';
      storageMode: 'external-linked';
      converted: false;
      takeoverStatus: 'attached';
    }) => void;
    const committed = new Promise<Parameters<typeof resolveTakeover>[0]>((resolve) => { resolveTakeover = resolve; });
    const committedTakeover = vi.fn(async () => await committed);
    const committedOperation = createExternalSessionTakeoverHostOperation({
      ensureLink: async () => ({ ok: true, sessionId: 'linked-2' }),
      takeover: committedTakeover,
    });
    const pending = committedOperation.execute({ ...request, signal: controller.signal });
    await vi.waitFor(() => expect(committedTakeover).toHaveBeenCalledOnce());
    controller.abort();
    resolveTakeover({
      ok: true,
      sessionId: 'linked-2',
      targetRuntimeMode: 'terminal',
      storageMode: 'external-linked',
      converted: false,
      takeoverStatus: 'attached',
    });
    await expect(pending).resolves.toEqual({ sessionId: 'linked-2', status: 'attached' });
  });
});
