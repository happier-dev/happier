import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { createAgentSessionRuntimeHarness } from '@happier-dev/plugin-sdk/testing';
import { createAdmittedMuseSessionFixture } from './testkit/admittedSession.test-support.js';

it.each(['released', 'failed'] as const)('configures a fork only after its native release outcome is %s', async outcome => {
  const recording = JSON.parse(await readFile(new URL('./testkit/fixtures/fork-mcp.json', import.meta.url), 'utf8'));
  if (outcome === 'failed') {
    // Schema-derived negative outcome at the same captured native boundary.
    recording.rows[13].message.params.outcome = 'failed';
    delete recording.rows[13].message.params.viewCursor;
  }
  const bridge = { command: 'fixture-happier-bridge', args: ['--fork'], env: { FIXTURE_BRIDGE: 'fork' } };
  const fixture = await createAdmittedMuseSessionFixture({ native: { recording,
    playbackSteps: [{ requestRow: 5, receiveUntilRow: 9 }, { requestRow: 9, receiveUntilRow: 14 },
      { requestRow: 14, receiveUntilRow: 16 }],
    expectedMcpServers: { happier: { ...bridge, transport: 'stdio', mode: 'required' } },
  } });
  const events = createAgentSessionRuntimeHarness();
  try {
    const opening = fixture.open({ kind: 'fork', sessionId: fixture.context.session.id, cwd: process.cwd(),
      source: { sessionId: 'fork-source-host', providerSessionId: recording.rows[4].message.result.session.sessionId,
        cwd: process.cwd() }, mcpServers: { happier: bridge } });
    if (outcome === 'failed') {
      await expect(opening).rejects.toMatchObject({ code: 'agent_startup_invalid_state', retryable: false,
        details: { failureCause: { phase: 'client_start' } } });
      expect(fixture.launchCount).toBe(1);
      expect((await fixture.readAudit()).methods).toEqual(['initialize', 'initialized', 'session/fork', 'session/leave']);
      return;
    }
    const session = await opening;
    session.watch(events.recordRuntimeEvent);
    expect(events.canonicalEvents().filter(event => event.kind === 'runtime-ended')).toEqual([]);
    expect(events.canonicalEvents()).toEqual(expect.arrayContaining([expect.objectContaining({
      kind: 'provider-session-id', providerSessionId: recording.rows[8].message.result.session.sessionId,
    })]));
    await fixture.closeSession();
    expect((await fixture.readAudit()).methods).toEqual(['initialize', 'initialized', 'session/fork', 'session/leave', 'session/resume']);
  } finally { events.dispose(); await fixture.dispose(); }
});
