import { expect, it } from 'vitest';
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNativeAgentSessionInteractionOperations } from '@/agent/runtime/registry/engineRegistry/nativeAgentSession';
import { readAgentSessionCapabilities } from '@/plugins/projection/registry/agentContributionDefinition';
import { MUSE_PLUGIN } from '../manifest.js';
import { createAdmittedMuseSessionFixture } from './testkit/admittedSession.test-support.js';
import { readMuseLoginRecording } from './testkit/mspProcess.js';
import { createMuseEventProjection, readMuseRecord } from './events.js';

it('publishes matching native skill changes through the real Session host without reading a closed catalog', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'happier-muse-skills-'));
  const nativeNotificationPath = join(scratch, 'notifications.json');
  const captured = readMuseRecord(await readMuseLoginRecording());
  if (!Array.isArray(captured.rows)) throw new Error('Expected captured native startup');
  const rows = captured.rows.slice(0, 14);
  const nativeSession = readMuseRecord(readMuseRecord(readMuseRecord(rows[12]).message).params).session;
  const nativeSessionId = readMuseRecord(nativeSession).sessionId;
  if (typeof nativeSessionId !== 'string') throw new Error('Expected native Session identity');
  const fixture = await createAdmittedMuseSessionFixture({ native: { recording: { rows },
    playbackSteps: [{ requestRow: 11, receiveUntilRow: 14 }], nativeNotificationPath } });
  const definition = MUSE_PLUGIN.manifest.contributes.agents?.find(agent => agent.id === 'muse');
  const capabilities = readAgentSessionCapabilities(definition);
  if (!capabilities) throw new Error('Expected Muse declaration');
  const readToken = () => fixture.host.getAgentStateSnapshot()?.nativeCatalogChangesV1;
  async function notify(sessionId: string) {
    await writeFile(`${nativeNotificationPath}.complete`, JSON.stringify([
      { jsonrpc: '2.0', method: 'skill/changed', params: { sessionId } },
      { jsonrpc: '2.0', method: 'session/statusChanged', params: { sessionId: nativeSessionId, status: 'idle' } },
    ]));
    await rename(`${nativeNotificationPath}.complete`, nativeNotificationPath);
  }
  let unsubscribe: (() => void) | undefined;
  try {
    const session = await fixture.open({ kind: 'create', sessionId: fixture.context.session.id, cwd: process.cwd() });
    const operations = createNativeAgentSessionInteractionOperations({ session, sessionId: fixture.context.session.id,
      context: fixture.context, cwd: process.cwd(), capabilities, publications: fixture.publications });
    let idleEvents = 0;
    unsubscribe = operations.subscribeRuntimeEvents?.(event => { if (event.kind === 'runtime-activity-snapshot') idleEvents++; });
    const beforeForeign = idleEvents;
    await notify('unrelated-native-session');
    await expect.poll(() => idleEvents).toBeGreaterThan(beforeForeign);
    expect(readToken()).toBeUndefined();
    await notify(nativeSessionId);
    await expect.poll(readToken).toMatchObject({ skills: expect.any(String) });
    const first = readToken();
    fixture.publications.dispose();
    const beforeRetired = idleEvents;
    await notify(nativeSessionId);
    await expect.poll(() => idleEvents).toBeGreaterThan(beforeRetired);
    expect(readToken()).toEqual(first);
    const audit = await fixture.readAudit();
    expect(audit.methods.filter(method => method === 'skill/list')).toEqual([]);
  } finally { unsubscribe?.(); await fixture.dispose(); await rm(scratch, { recursive: true, force: true }); }
});

// Finite Runs have no Session catalog publication authority or consumer.
it('keeps native skill changes out of finite Run event envelopes', () => {
  const projection = createMuseEventProjection({});
  const kinds: string[] = [];
  projection.watch(event => kinds.push(event.kind));
  projection.observeSession({ sessionId: 'native-run' });
  const before = [...kinds];
  projection.observe({ method: 'skill/changed', params: { sessionId: 'native-run' } });
  expect(kinds).toEqual(before);
  projection.dispose();
});
