import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import type { AgentSessionConfigurationUpdate } from '@happier-dev/plugin-sdk/agents/runtime';
import { buildExecutionRunConfiguration } from '@/agent/runtime/bridges/executionRun/runtime/openInputs';
import { createAdmittedMuseSessionFixture } from './testkit/admittedSession.test-support.js';
import { readMuseRecord } from './events.js';

// An explicit workspace denial takes precedence over every launch intent.
it.each(['yolo', 'safe-yolo', 'plan'] as const)('keeps explicit %s read-only when workspace writes are denied', async intent => {
  const fixture = await createAdmittedMuseSessionFixture();
  try {
    await fixture.open({ kind: 'create', sessionId: fixture.context.session.id, cwd: process.cwd(),
      configuration: { model: { value: null, updatedAtMs: 0 }, mode: { value: null, updatedAtMs: 0 },
        permissionIntent: { value: intent, updatedAtMs: 0 }, workspaceWrites: 'deny', options: {} } });
    await fixture.closeSession();
    expect((await fixture.readAudit()).commandTargets).toMatchObject([
      { method: 'session/start', permissionProfile: ':read-only', approvalMode: 'promptUnmatched' },
    ]);
  } finally { await fixture.dispose(); }
});

// M4: the shared host normalizes read_only before it reaches the plugin. Muse's
// characterized :read-only profile also represents an explicit workspace-write denial.
it.each(['intent', 'workspaceWrites'] as const)('opens native read-only permissions from %s without inventing an in-place profile control', async source => {
  const fixture = await createAdmittedMuseSessionFixture();
  const configuration: AgentSessionConfigurationUpdate = {
    model: { value: null, updatedAtMs: 0 }, mode: { value: null, updatedAtMs: 0 },
    permissionIntent: { value: source === 'intent' ? 'read-only' : 'default', updatedAtMs: 0 }, options: {},
    ...(source === 'workspaceWrites' ? { workspaceWrites: 'deny' } : {}),
  };
  try {
    const session = await fixture.open({ kind: 'create', sessionId: fixture.context.session.id,
      cwd: process.cwd(), configuration });
    expect(await session.updateConfiguration?.(configuration)).toMatchObject({ status: 'applied' });
    expect(await session.updateConfiguration?.({ ...configuration,
      permissionIntent: { value: 'default', updatedAtMs: 1 }, workspaceWrites: 'allow',
    })).toMatchObject({ status: 'unsupported' });
    await fixture.closeSession();
    const audit = await fixture.readAudit();
    expect(audit.commandTargets).toMatchObject([{ method: 'session/start', permissionProfile: ':read-only' }]);
    expect(audit.methods).toEqual(['initialize', 'initialized', 'session/start']);
  } finally { await fixture.dispose(); }
});

it('applies read-only fork permissions through native release and resume before returning the child', async () => {
  const recording = JSON.parse(await readFile(new URL('./testkit/fixtures/fork-mcp.json', import.meta.url), 'utf8'));
  const fixture = await createAdmittedMuseSessionFixture({ native: { recording,
    playbackSteps: [{ requestRow: 5, receiveUntilRow: 9 }, { requestRow: 9, receiveUntilRow: 14 },
      { requestRow: 14, receiveUntilRow: 16 }] } });
  try {
    await fixture.open({ kind: 'fork', sessionId: fixture.context.session.id, cwd: process.cwd(),
      source: { sessionId: 'source-host-session', providerSessionId: recording.rows[4].message.result.session.sessionId, cwd: process.cwd() },
      configuration: { model: { value: null, updatedAtMs: 0 }, mode: { value: null, updatedAtMs: 0 },
        permissionIntent: { value: 'read-only', updatedAtMs: 0 }, options: {} } });
    await fixture.closeSession();
    const audit = await fixture.readAudit();
    expect(audit.commandTargets.find(command => command.method === 'session/resume'))
      .toMatchObject({ permissionProfile: ':read-only' });
    expect(audit.methods.indexOf('session/leave')).toBeLessThan(audit.methods.indexOf('session/resume'));
  } finally { await fixture.dispose(); }
});

it('refuses canonical no-tools configuration before native launch rather than widening it to read-only tools', async () => {
  const fixture = await createAdmittedMuseSessionFixture();
  const { configuration } = buildExecutionRunConfiguration({
    backendTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.muse', localId: 'muse' } },
    permissionMode: 'no_tools', updatedAtMs: 0,
  });
  try {
    await expect(fixture.open({ kind: 'create', sessionId: fixture.context.session.id,
      cwd: process.cwd(), configuration })).rejects.toMatchObject({ code: 'unsupported' });
    expect(fixture.launchCount).toBe(0);
  } finally { await fixture.dispose(); }
});

it.each(['allowedTools', 'unlistedTools'] as const)('refuses an explicit %s launch restriction that native profiles cannot represent', async field => {
  const fixture = await createAdmittedMuseSessionFixture();
  const { configuration } = buildExecutionRunConfiguration({
    backendTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.muse', localId: 'muse' } },
    permissionMode: 'default', updatedAtMs: 0,
    ...(field === 'allowedTools' ? { allowedTools: ['Read'] } : { unlistedTools: 'deny' }),
  });
  try {
    await expect(fixture.open({ kind: 'create', sessionId: fixture.context.session.id,
      cwd: process.cwd(), configuration })).rejects.toMatchObject({ code: 'unsupported' });
    expect(fixture.launchCount).toBe(0);
  } finally { await fixture.dispose(); }
});

it('refuses an explicit default model when the native catalog is answered empty', async () => {
  const capture = readMuseRecord(JSON.parse(await readFile(new URL('./testkit/fixtures/login-smoke.json', import.meta.url), 'utf8')));
  if (!Array.isArray(capture.rows)) throw new Error('Expected captured native rows');
  // Schema-derived native boundary vector: preserve the observed transport and
  // initialization while returning the valid empty model/list result.
  const recording = { ...capture, rows: capture.rows.map(row => {
    const frame = readMuseRecord(row);
    const message = readMuseRecord(frame.message);
    return Array.isArray(readMuseRecord(message.result).models)
      ? { ...frame, message: { ...message, result: { models: [] } } } : row;
  }) };
  const fixture = await createAdmittedMuseSessionFixture({ native: { recording } });
  const configuration: AgentSessionConfigurationUpdate = {
    model: { value: 'default', updatedAtMs: 0, selectionSource: 'explicit' },
    mode: { value: null, updatedAtMs: 0 }, permissionIntent: { value: null, updatedAtMs: 0 }, options: {},
  };
  try {
    await expect(fixture.open({ kind: 'create', sessionId: fixture.context.session.id,
      cwd: process.cwd(), configuration })).rejects.toMatchObject({ code: 'model_selection_required', retryable: false });
    const audit = await fixture.readAudit();
    expect(fixture.launchCount).toBe(1);
    expect(audit).toMatchObject({ initializeCount: 1, initializedCount: 1, commandCount: 0 });
    expect(audit.methods).toEqual(['initialize', 'initialized', 'model/list']);
  } finally { await fixture.dispose(); }
});
