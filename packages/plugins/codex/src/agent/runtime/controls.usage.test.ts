import { describe, expect, it, vi } from 'vitest';
import type { AgentSessionControlContext } from '@happier-dev/plugin-sdk/agents/runtime';

import { withCodexNativeAttachFixture } from './appServer/runtime.nativeAttach.test-support.js';
import { createCodexNativeSessionControls } from './controls.js';
import { createCodexAgentRuntime } from './engine.js';

describe('Codex Session usage checks', () => {
  it('reads fresh quota through the owning live client with zero new processes and retains it after failure', async () => {
    const engine = await createCodexAgentRuntime({
      plugin: { id: 'happier.agent.codex', version: '0.0.0' }, agent: { id: 'codex' }, signal: new AbortController().signal,
    });
    const sessions = engine.sessions!;
    let exhausted = false;
    let fail = false;
    await withCodexNativeAttachFixture(async fixture => {
      const session = await fixture.openConfiguredSession();
      const control = session.usageLimitRecovery ?? sessions.usageLimitRecovery!;
      const context = {
        signal: new AbortController().signal, services: { exec: fixture.exec },
        session: { id: 'actual-happier-session', cwd: fixture.directory, activity: 'active',
          providerSessionId: 'fresh-thread', connectedAccounts: [], launchEnvironment: fixture.launchEnvironment },
      } as unknown as AgentSessionControlContext;
      const spawn = vi.spyOn(fixture.exec, 'spawn');
      const run = vi.spyOn(fixture.exec, 'run');
      const spawnClient = vi.spyOn(fixture.exec.clients, 'spawn');
      const check = () => control.execute({ kind: 'checkNow' }, context);
      expect(await check()).toEqual({ status: 'ready' });
      // Count native launches, not quota reads: every explicit check stays fresh.
      expect(spawn.mock.calls.length + run.mock.calls.length + spawnClient.mock.calls.length).toBe(0);
      exhausted = true;
      expect(await check()).toMatchObject({ status: 'waiting' });
      fail = true;
      expect(await check()).toMatchObject({ status: 'unavailable', retryable: true });
      fail = false;
      exhausted = false;
      expect(await check()).toEqual({ status: 'ready' });
      const cancelled = new AbortController();
      cancelled.abort();
      expect(await control.execute({ kind: 'checkNow' }, { ...context, signal: cancelled.signal }))
        .toMatchObject({ status: 'unavailable' });
      expect(await check()).toEqual({ status: 'ready' });
      await session.dispose();
      expect(await check()).toMatchObject({ status: 'unavailable' });
      expect(spawn.mock.calls.length + run.mock.calls.length + spawnClient.mock.calls.length).toBe(0);
    }, {
      sessionFactory: sessions,
      rateLimitsRead: () => {
        if (fail) throw new Error('quota unavailable');
        return { rateLimits: { primary: { usedPercent: exhausted ? 100 : 20 } } };
      },
    });
  });

  it.each([
    [20, 120_000],
    [100, 120_000],
    [100, null],
  ])('reports the blocking reset through the inactive control (%s%% used, %s ms)', async (usedPercent, retryAfterMs) => {
    const now = 1_768_600_000_000;
    await withCodexNativeAttachFixture(async fixture => {
      const context = {
        signal: new AbortController().signal, services: { exec: fixture.exec },
        session: { id: 'inactive-target', cwd: fixture.directory, activity: 'inactive', connectedAccounts: [],
          launchEnvironment: fixture.launchEnvironment },
      } as unknown as AgentSessionControlContext;
      const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
      try {
        const result = await createCodexNativeSessionControls().usageLimitRecovery.execute({ kind: 'checkNow' }, context);
        expect(result).toEqual(retryAfterMs === null ? { status: 'waiting' } : { status: 'waiting', retryAfterMs });
      } finally {
        clock.mockRestore();
      }
    }, { rateLimitsRead: () => ({ rateLimits: {
      primary: { usedPercent, ...(retryAfterMs === null ? {} : { resetsAt: now / 1_000 + 60 }) },
      secondary: { usedPercent: 100, resetsAt: now / 1_000 + 120 },
    } }) });
  });

  it('uses one short-lived client in the admitted inactive target scope', async () => {
    const launches: Array<Readonly<{ argv: readonly string[]; env?: Readonly<Record<string, string | undefined>> }>> = [];
    await withCodexNativeAttachFixture(async fixture => {
      const context = {
        signal: new AbortController().signal, services: { exec: fixture.exec },
        session: { id: 'inactive-target', cwd: fixture.directory, activity: 'inactive', connectedAccounts: [],
          launchEnvironment: { values: { CODEX_HOME: fixture.directory, CODEX_SQLITE_HOME: `${fixture.directory}/usage-sqlite` }, unset: [] } },
      } as unknown as AgentSessionControlContext;
      expect(await createCodexNativeSessionControls().usageLimitRecovery.execute({ kind: 'checkNow' }, context))
        .toEqual({ status: 'ready' });
      expect(launches).toHaveLength(1);
      expect(launches[0]?.env).toMatchObject(context.session.launchEnvironment!.values);
      expect(launches[0]?.argv).toContain(`sqlite_home=${JSON.stringify(`${fixture.directory}/usage-sqlite`)}`);
    }, { observer: { recordAppServerRequest() {}, recordLaunch: input => { launches.push(input); } } });
  });
});
