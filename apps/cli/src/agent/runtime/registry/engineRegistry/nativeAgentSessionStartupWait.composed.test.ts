import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AgentStateSchema } from '@happier-dev/session-core/state';
import { projectSessionAwarenessV1 } from '@happier-dev/protocol/sessions/awareness/projectV1';
import { readSessionAwarenessWorkStatusV1 } from '@happier-dev/protocol/sessions/awareness/presentationV1';
import type { AgentState } from '@/api/types';
import { createNativeAgentSessionPublications } from './nativeAgentSessionPublications';
import { withCodexNativeStartupLock } from '../../../../../../../packages/plugins/codex/src/agent/runtime/appServer/nativeStartupLock';

// Isolate only the OS-user lock location; acquisition/publication/projection remain real.
const osBoundary = vi.hoisted(() => ({ home: '' }));
vi.mock('node:os', async importOriginal => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, userInfo: () => ({ ...actual.userInfo(), homedir: osBoundary.home }) };
});

describe('native Session startup wait publication', () => {
  it.each(['acquired', 'cancelled', 'failed'] as const)('shows a held startup lock and clears when %s', async outcome => {
    osBoundary.home = await mkdtemp(join(tmpdir(), 'session-startup-wait-'));
    let release = () => {};
    const held = new Promise<void>(resolve => { release = resolve; });
    const controller = new AbortController();
    let state: AgentState = {};
    let writes = 0;
    const publications = createNativeAgentSessionPublications({
      agentId: 'codex', signal: controller.signal,
      isCurrent: () => true, supportsInFlightSteer: false,
      session: { updateAgentState(updater) { state = updater(state); writes++; } },
    });
    const status = () => readSessionAwarenessWorkStatusV1({ awareness: projectSessionAwarenessV1({
      sessionId: 'session-wait', nowMs: Date.now(), lifecycle: {},
      runtime: { presence: 'online', active: true, workStatus: AgentStateSchema.parse(state).workStatus },
      pending: { queuedInputCount: 1 }, content: { mode: 'plain' },
      currentness: { lifecycle: 'observed', runtime: 'observed', pending: 'observed' },
    }) });
    let firstEntered = false;
    let turnRan = false;
    const first = withCodexNativeStartupLock(async () => { firstEntered = true; await held; });
    let second: Promise<unknown> | undefined;
    try {
      await vi.waitFor(() => expect(firstEntered).toBe(true));
      second = withCodexNativeStartupLock(async () => {
        expect(status().state).not.toBe('waiting_for_startup_lock');
        if (outcome === 'failed') throw new Error('Native initialization failed');
      }, controller.signal, undefined, undefined,
      waiting => publications.services.publishWorkStatus?.(waiting ? 'waiting_for_startup_lock' : null))
        .then(() => { turnRan = true; });
      // Cancellation is asserted below; attach a handler before aborting the wait.
      second.catch(() => {});
      await vi.waitFor(() => expect(status()).toMatchObject({ state: 'waiting_for_startup_lock', bucket: 'working' }));
      expect(turnRan).toBe(false);
      expect(writes).toBe(1);
      if (outcome === 'cancelled') {
        controller.abort();
        await expect(second).rejects.toThrow();
        expect(turnRan).toBe(false);
      } else {
        release();
        if (outcome === 'failed') {
          await expect(second).rejects.toThrow('Native initialization failed');
          expect(turnRan).toBe(false);
        } else {
          await second;
          expect(turnRan).toBe(true);
        }
      }
      expect(status().state).not.toBe('waiting_for_startup_lock');
      expect(writes).toBe(2);
    } finally {
      controller.abort(); release();
      await Promise.allSettled([first, ...(second ? [second] : [])]);
      publications.dispose();
      await rm(osBoundary.home, { recursive: true, force: true });
    }
  });
});
