import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import type { AgentSessionConfigurationUpdate } from '@happier-dev/plugin-sdk/agents/runtime';
import { createAdmittedMuseSessionFixture } from './testkit/admittedSession.test-support.js';
import { readMuseRecord } from './events.js';

// Regression verification of existing unsupported mappings, not new native policy semantics.
it.each(['yolo', 'read-only'] as const)('refuses explicit %s intent before native launch', async intent => {
  const fixture = await createAdmittedMuseSessionFixture();
  const configuration: AgentSessionConfigurationUpdate = {
    model: { value: null, updatedAtMs: 0 }, mode: { value: null, updatedAtMs: 0 },
    permissionIntent: { value: intent, updatedAtMs: 0 }, options: {},
  };
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
