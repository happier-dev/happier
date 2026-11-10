import { expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { readMuseRecord } from './events.js';
import { createAgentSessionRuntimeHarness } from '@happier-dev/plugin-sdk/testing';
import { createAdmittedMuseSessionFixture } from './testkit/admittedSession.test-support.js';

async function assertSelectedMcp(strictMode: boolean) {
  // Exact captured sessionMcp grant and PEBBLE tool events; the harmless selected
  // command/environment and selected startup mode are schema-derived bindings.
  const fixture = await createAdmittedMuseSessionFixture({ sessionId: 'host-muse-selected-mcp', native: {
    recordingPath: fileURLToPath(new URL('./testkit/fixtures/mcp.json', import.meta.url)),
    expectedMcpServers: { probe: { transport: 'stdio', command: '/fixture/mcp-probe',
      args: ['--fixture'], env: { MUSE_FIXTURE_VALUE: 'PEBBLE' }, mode: strictMode ? 'required' : 'optional' } },
  } });
  const events = createAgentSessionRuntimeHarness();
  try {
    const session = await fixture.open({ kind: 'create', sessionId: 'host-muse-selected-mcp', cwd: process.cwd(),
      mcpServers: { probe: { command: '/fixture/mcp-probe', args: ['--fixture'], env: { MUSE_FIXTURE_VALUE: 'PEBBLE' } } },
      mcpServersStrictMode: strictMode });
    session.watch(events.recordRuntimeEvent);
    await session.send({ inputIds: ['mcp-input'], input: { text: 'Call the retained native MCP tool.' },
      delivery: { kind: 'newTurn', turnId: 'mcp-turn' } });
    await events.until('turn-complete');
    expect(events.canonicalEvents()).toContainEqual(expect.objectContaining({ kind: 'tool-result',
      isError: false }));
    expect(JSON.stringify(events.canonicalEvents().filter(event => event.kind === 'tool-result'))).toContain('PEBBLE');
    events.expectExactlyOneTerminalEvent({ turnId: 'mcp-turn' });
    await fixture.closeSession();
    const audit = await fixture.readAudit();
    expect(audit).toMatchObject({ initializeCount: 1, initializedCount: 1 });
    expect(audit.methods.filter(method => method === 'session/start')).toHaveLength(1);
    expect(audit.methods.filter(method => method === 'turn/start')).toHaveLength(1);
    expect(fixture.launchCount).toBe(1);
  } finally { events.dispose(); await fixture.dispose(); }
}

it('configures the selected MCP binding once and preserves the captured native tool result', async () => {
  await assertSelectedMcp(false);
});
it('configures required MCP startup once and preserves the captured native tool result', async () => {
  await assertSelectedMcp(true);
});

it('refuses a missing native sessionMcp grant before starting the configured Session', async () => {
  // Constructed grant refusal at the real native process boundary. The rest of
  // the observed native initialization/result frames remain unchanged.
  const source = readMuseRecord(JSON.parse(await readFile(new URL('./testkit/fixtures/mcp.json', import.meta.url), 'utf8')));
  if (!Array.isArray(source.rows)) throw new Error('Native MCP recording has no rows');
  const recording = { ...source, rows: source.rows.map(value => {
    const row = readMuseRecord(value);
    const message = readMuseRecord(row.message);
    const result = readMuseRecord(message.result);
    return Array.isArray(result.grantedCapabilities)
      ? { ...row, message: { ...message, result: { ...result, grantedCapabilities: [] } } } : row;
  }) };
  const fixture = await createAdmittedMuseSessionFixture({ native: { recording } });
  try {
    await expect(fixture.open({ kind: 'create', sessionId: 'host-muse-missing-mcp-grant', cwd: process.cwd(),
      mcpServers: { probe: { command: '/fixture/mcp-probe' } } })).rejects.toMatchObject({ code: 'unsupported' });
    expect(fixture.launchCount).toBe(1);
    const audit = await fixture.readAudit();
    expect(audit.initializeCount).toBe(1);
    expect(audit.methods.filter(method => method === 'session/start' || method === 'turn/start')).toEqual([]);
  } finally { await fixture.dispose(); }
});

it.each([{ enabledTools: [] }, { enabledTools: ['pebble'] }])('refuses filtered native MCP tools $enabledTools before any native effect', async ({ enabledTools }) => {
  const fixture = await createAdmittedMuseSessionFixture();
  try {
    await expect(fixture.open({ kind: 'create', sessionId: 'host-muse-filtered-mcp', cwd: process.cwd(),
      mcpServers: { probe: { command: '/fixture/mcp-probe', enabledTools } } })).rejects.toMatchObject({ code: 'unsupported' });
    expect(fixture.launchCount).toBe(0);
  } finally { await fixture.dispose(); }
});

it('refuses explicit native MCP tool policy before any native effect', async () => {
  const fixture = await createAdmittedMuseSessionFixture();
  try {
    await expect(fixture.open({ kind: 'create', sessionId: 'host-muse-policy-mcp', cwd: process.cwd(),
      mcpServers: { probe: { command: '/fixture/mcp-probe' } },
      mcpToolPolicy: { probe: { unlisted: 'deny', tools: { pebble: 'allow' } } } })).rejects.toMatchObject({ code: 'unsupported' });
    expect(fixture.launchCount).toBe(0);
  } finally { await fixture.dispose(); }
});

it.each(['required', 'optional'] as const)('preserves observed %s MCP startup failure policy at its owning turn', async mode => {
  // Exact native built-in echo failure/continuation frames. The harmless
  // unavailable command pathname is substituted at the process boundary.
  const fixture = await createAdmittedMuseSessionFixture({ native: {
    recordingPath: fileURLToPath(new URL(`./testkit/fixtures/isolated-mcp-${mode}-failure.json`, import.meta.url)),
    expectedMcpServers: { missing: { transport: 'stdio', command: '/fixture/unavailable-mcp', mode } },
  } });
  const events = createAgentSessionRuntimeHarness();
  try {
    const session = await fixture.open({ kind: 'create', sessionId: `host-muse-${mode}-mcp-failure`, cwd: process.cwd(),
      mcpServers: { missing: { command: '/fixture/unavailable-mcp' } }, mcpServersStrictMode: mode === 'required' });
    session.watch(events.recordRuntimeEvent);
    await session.send({ inputIds: ['mcp-failure-input'], input: { text: 'PEBBLE' },
      delivery: { kind: 'newTurn', turnId: 'mcp-failure-turn' } });
    await events.until(mode === 'required' ? 'turn-failed' : 'turn-complete');
    events.expectExactlyOneTerminalEvent({ turnId: 'mcp-failure-turn' });
    if (mode === 'required') {
      const capture = readMuseRecord(JSON.parse(await readFile(new URL('./testkit/fixtures/isolated-mcp-required-failure.json', import.meta.url), 'utf8')));
      const rows = Array.isArray(capture.rows) ? capture.rows.map(readMuseRecord) : [];
      const terminal = rows.map(row => readMuseRecord(row.message)).find(message => message.method === 'turn/completed');
      const nativeError = readMuseRecord(readMuseRecord(terminal?.params).error);
      if (typeof nativeError.message !== 'string') throw new Error('The native required-MCP failure has no message');
      expect(events.canonicalEvents()).toContainEqual(expect.objectContaining({ kind: 'turn-failed',
        diagnostic: expect.objectContaining({ code: 'PLUGIN_EXEC_FAILED', severity: 'error', message: nativeError.message }) }));
      expect(events.canonicalEvents().filter(event => event.kind === 'message-delta')).toEqual([]);
    } else {
      expect(events.canonicalEvents().filter(event => event.kind === 'message-delta').map(event => event.text).join('')).toBe('echo: PEBBLE');
    }
    await fixture.closeSession();
    const audit = await fixture.readAudit();
    expect(audit.initializeCount).toBe(1);
    expect(audit.methods.filter(method => method === 'session/start')).toHaveLength(1);
    expect(audit.methods.filter(method => method === 'turn/start')).toHaveLength(1);
  } finally { events.dispose(); await fixture.dispose(); }
});
