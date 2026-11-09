import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PluginServices } from '@happier-dev/plugin-sdk';
import type { SessionSendRequest } from '@happier-dev/plugin-sdk/sessions';
import { createChannelsJourneyFixture } from '../../channels/src/testkit/channelsJourney.js';
import { EMAIL_CHANNEL_ACTION_IDS as ids } from './constants.js';
import { createEmailTransportFixture as fixture, incoming, connection, delivery } from '../testkit/emailTransportFixture.js';

describe('Email parser runtime recovery', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  let journey: Awaited<ReturnType<typeof createChannelsJourneyFixture>>;
  let admitted: SessionSendRequest[];
  beforeEach(async () => {
    f = await fixture();
    admitted = [];
    const sessions = { async get() { return {
      async summary() { return { id: 'fixture-session', machineId: 'fixture-machine', state: 'idle',
        runtimeAvailability: { status: 'available' }, storagePolicy: 'optional', encryptionMode: 'plain', updatedAtMs: 1 }; },
      async send(request: SessionSendRequest) { admitted.push(request); return { status: 'accepted', localId: `input-${admitted.length}` }; },
    }; } } as unknown as PluginServices['sessions'];
    journey = await createChannelsJourneyFixture({ provider: f.email, state: f.state,
      connection: { id: connection.connectionId }, binding: {}, sessions,
      actions: { async execute() { throw new Error('Unexpected host Action'); } } as unknown as PluginServices['actions'],
      resolveCurrentProviderExecutionOrigin: () => ({ serverIdentityId: 'srv_plugin_testkit', materializationRef: f.materializationRef }),
    });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(f.receivedAtMs);
    f.setMessages([]);
    await expect(journey.poll()).resolves.toMatchObject({ kind: 'committed' });
  });
  afterEach(async () => { vi.doUnmock('mailparser'); vi.useRealTimers(); await journey?.dispose(); await f?.dispose(); });
  it.each(['Mon, 12 Oct 2020 07:00:00 +0000', 'Mon, 12 Oct 2032 07:00:00 +0000'])(
    'admits newly received mail once despite an authored Date outside the age window (%s)', async authoredDate => {
      f.setMessages([['opaque-incoming', Buffer.from(`Date: ${authoredDate}\r\n${incoming.toString()}`)]]);
      await expect(journey.poll()).resolves.toMatchObject({ kind: 'committed' });
      expect(admitted).toHaveLength(1);
      await expect(journey.poll()).resolves.toMatchObject({ kind: 'committed' });
      expect(admitted).toHaveLength(1);
    },
  );
  it('retries the entire poll after a module-load failure without anonymous observations or checkpoint loss', async () => {
    const checkpoint = () => [...f.state.rows.values()].find(row => row.value['record-kind'] === 'checkpoint')!.value;
    const baseline = checkpoint();
    // Only the module-loading boundary is faulted; the MIME parser stays real.
    // Email Actions, trust, Channels admission, Collection CAS and backoff stay real.
    // A throwing mock factory is wrapped by Vitest in an ordinary Error.
    // Fault the module export read so the native SyntaxError category survives;
    // the empty default mirrors the bundled CommonJS shape parse.ts also reads.
    vi.doMock('mailparser', () => ({ default: {}, get simpleParser() {
      throw new SyntaxError('Synthetic private module detail must never reach poll evidence');
    } }));
    f.setMessages([['opaque-incoming', incoming], ['second', Buffer.from(incoming.toString().replaceAll('incoming@example.com', 'second@example.com'))]]);
    await expect(journey.poll()).resolves.toMatchObject({ kind: 'retry' });
    const failed = (await f.state.get(connection.connectionId))!.value;
    expect(failed.payload).toMatchObject({ pollFailure: { phase: 'retryDue', attemptCount: 1,
      evidence: { kind: 'action', code: 'email_parser_syntax_error' } } });
    expect(JSON.stringify(failed.payload)).not.toContain('Synthetic private module detail');
    expect(checkpoint()).toEqual(baseline);
    expect(admitted).toEqual([]);
    expect([...f.state.rows.values()].filter(row => row.value['record-kind'] === 'ingress-census')).toEqual([]);
    await expect(f.invoke(ids.messageDeliver, delivery)).resolves.toMatchObject({ kind: 'notDelivered', retry: 'safe' });
    await expect(f.invoke(ids.attachmentFetch, { ...connection, messageId: '<incoming@example.com>', attachmentIds: ['mime:1'] }))
      .rejects.toMatchObject({ code: 'email_parser_syntax_error', retryable: true });
    expect(f.submissions).toEqual([]);
    const payload = failed.payload as { pollFailure: { retryNotBeforeMs: number } };
    vi.doUnmock('mailparser');
    vi.setSystemTime(payload.pollFailure.retryNotBeforeMs);
    await expect(journey.poll()).resolves.toMatchObject({ kind: 'committed' });
    expect(admitted).toHaveLength(2);
    expect((await f.state.get(connection.connectionId))!.value.payload).toMatchObject({ pollFailure: null });
    expect(checkpoint().payload).toMatchObject({ opaqueToken: { position: 1 } });
    await expect(journey.poll()).resolves.toMatchObject({ kind: 'committed' });
    expect(admitted).toHaveLength(2);
  });
  it('parks a missing parser module without advancing its checkpoint or repeatedly polling', async () => {
    const checkpoint = () => [...f.state.rows.values()].find(row => row.value['record-kind'] === 'checkpoint')!.value;
    const baseline = checkpoint();
    // Fault the genuine module-loading boundary; keep Channels classification,
    // persistence, admission and the provider Action path real.
    vi.doMock('mailparser', () => ({ default: {}, get simpleParser() {
      throw Object.assign(new Error('Private missing module path'), { code: 'MODULE_NOT_FOUND' });
    } }));
    f.setMessages([['opaque-incoming', incoming]]);
    await expect(journey.poll()).resolves.toMatchObject({ kind: 'blocked' });
    const failed = (await f.state.get(connection.connectionId))!.value;
    expect(failed.payload).toMatchObject({ pollFailure: { phase: 'blocked', attemptCount: 1,
      retryNotBeforeMs: null, evidence: { kind: 'action', code: 'email_parser_module_not_found' } } });
    expect(JSON.stringify(failed.payload)).not.toContain('Private missing module path');
    vi.setSystemTime(f.receivedAtMs + 60_000);
    await journey.poll();
    expect((await f.state.get(connection.connectionId))!.value).toEqual(failed);
    expect(checkpoint()).toEqual(baseline);
    expect(admitted).toEqual([]);
  });
});
