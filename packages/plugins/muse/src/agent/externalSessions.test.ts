import { expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { createServer } from 'node:http';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import { resolveAgentCliOverrideEnvKey } from '@happier-dev/cli-common/agents/resolution';
import { PluginAvailabilityActionHttpPathsV1, PluginAvailabilityIntentsListActionInputV1Schema } from '@happier-dev/protocol/plugins/availability';
import type { AgentExternalSessionsResult } from '@happier-dev/plugin-sdk/sessions/external';
import { AgentExternalSessionTranscriptRawRecordSchema } from '@happier-dev/plugin-sdk/sessions/external';
import * as credentialBoundary from '@/persistence';
import * as accountHttpBoundary from '@/api/client/connectedServiceCredentialApi';
import * as sessionHttpBoundary from '@/session/transport/http/sessionsHttp';
import { createAccountEncryptionCurrentnessFixture } from '@/testkit/backends/sessionFixtures';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { writeExecutableShimSync } from '@/testkit/fs/executableShim';
import { resolveExternalSessionSourceSurface } from '@/session/actions/externalSessions/providerOpsResolution';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createMuseMspProcessFixture, readMuseMspProcessAudit } from './testkit/mspProcess.js';
import { readMuseRecord } from './events.js';

function value<T>(result: AgentExternalSessionsResult<T>): T {
  expect(result.ok ? null : result).toBeNull();
  if (!result.ok) throw new Error(`Native external history refused: ${result.code}`);
  return result.value;
}

it('discovers, links and pages native history through all six admitted callbacks without attaching a conversation', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'happier-muse-external-'));
  async function recording(name: string) {
    const bytes = await readFile(new URL(`./testkit/fixtures/${name}.json.gz`, import.meta.url));
    const result = readMuseRecord(JSON.parse(gunzipSync(bytes).toString('utf8').replaceAll('[TEMP]/isolated-long-history', scratch)));
    if (!Array.isArray(result.rows)) throw new Error('Sanitized native recording is missing');
    return result.rows;
  }
  const reader = await recording('isolated-long-history-reader');
  const reopened = await recording('isolated-long-history-reopen');
  const audits: string[] = [];
  const credentials = vi.spyOn(credentialBoundary, 'readStoredCredentials').mockResolvedValue({ token: 'muse-history-boundary-token', encryption: null });
  const currentness = vi.spyOn(accountHttpBoundary, 'fetchAccountEncryptionCurrentness').mockResolvedValue(createAccountEncryptionCurrentnessFixture());
  const linkedLookup = vi.spyOn(sessionHttpBoundary, 'lookupSessionsByTags').mockImplementation(async ({ tags }) => ({ state: 'available', tags, sessions: [] }));
  // A real CLI entrypoint keeps native executable identity distinct from the
  // JavaScript runner selected by the canonical host launch owner.
  const nativeScript = join(scratch, 'muse-playback.cjs');
  const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
  const nativeCli = writeExecutableShimSync({ dir: scratch,
    fileName: process.platform === 'win32' ? 'muse.cmd' : 'muse',
    contents: process.platform === 'win32'
      ? `@echo off\r\n"${process.execPath}" "${nativeScript}" %*\r\n`
      : `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(nativeScript)} "$@"\n`,
  });
  vi.stubEnv(resolveAgentCliOverrideEnvKey('muse'), nativeCli);
  vi.stubEnv('PATH', `${scratch}${delimiter}${process.env.PATH ?? ''}`);
  // The Account census is a real HTTP boundary, independent of the native
  // history process. Keep its canonical admission and source owners active.
  const http = createServer(async (request, response) => {
    const send = (status: number, body: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const absentIntent = { availabilityCursor: 1, hostingCapability: { enabled: false },
        intent: null, release: null, uiArtifacts: [], packageAssets: [] };
      if (request.method === 'POST' && request.url === PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intents.list']) {
        const ids = PluginAvailabilityIntentsListActionInputV1Schema.parse(body).knownPluginIds ?? [];
        return send(200, { availabilityCursor: 1, pluginIds: ids, failedPluginIds: [],
          intentReads: ids.map(pluginId => ({ pluginId, response: absentIntent })) });
      }
      if (request.method === 'POST' && request.url === PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intent.read']) {
        return send(200, absentIntent);
      }
      return send(404, {});
    } catch { return send(500, { error: 'fixture_boundary_refused' }); }
  });
  let fixture: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>> | undefined;
  async function phase(rows: readonly JsonValue[], requestRows: readonly number[] = []) {
    const auditPath = join(scratch, `native-${audits.length}.json`);
    audits.push(auditPath);
    const recordingPath = join(scratch, `recording-${audits.length}.json`);
    await writeFile(recordingPath, JSON.stringify({ rows }));
    const native = await createMuseMspProcessFixture({ recordingPath, auditPath, requireDataDirectory: true,
      playbackSteps: requestRows.map(requestRow => ({ requestRow, receiveUntilRow: requestRow + 2 })),
    });
    const launch = await native.resolveExecutable();
    const script = `Object.assign(process.env,${JSON.stringify(launch.env)});\n${launch.args[1]}`;
    await writeFile(nativeScript, script);
  }
  try {
    await new Promise<void>((resolve, reject) => { http.once('error', reject); http.listen(0, '127.0.0.1', resolve); });
    const address = http.address();
    if (!address || typeof address === 'string') throw new Error('Expected loopback Account HTTP boundary');
    await runWithServerHttpBaseUrl(`http://127.0.0.1:${address.port}`, async () => {
    fixture = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
      runtimeOptions: {
      scopedActionRuntime: { credentials: null, actionsSettingsProvider: createActionSettingsProvider() } } });
    expect(fixture.registry.agentRuntimesByAgentId.has('muse')).toBe(false);
    expect(fixture.registry.contributes.agents.map(agent => agent.id)).toContain('muse');
    // Exercise product admission before any Session or Run has been opened.
    const admitted = await resolveExternalSessionSourceSurface('muse', { kind: 'museNative' });
    expect(admitted).toMatchObject({ ok: true });
    const callbacks = fixture.registry.agentRuntimesByAgentId.get('muse')?.externalSessions;
    if (!callbacks) throw new Error('Admitted external history contribution is unavailable');
    const invocation = { signal: new AbortController().signal, maxSerializedBytes: 16 * 1024 * 1024 };
    const id = '00000000-0000-7000-8000-000000000001';
    await phase(reopened);
    const source = value(await callbacks.resolveSource({ ...invocation, source: { kind: 'museNative' }, includeAccountingSource: false })).source;
    expect(source).toEqual({ kind: 'museNative', museHome: join(scratch, 'data/muse') });

    await phase(reopened, [3]);
    const listed = value(await callbacks.listCandidates({ ...invocation, source, maxItems: 7 }));
    expect(listed.candidates).toEqual(expect.arrayContaining([expect.objectContaining({ remoteSessionId: id })]));
    expect(listed.nextCursor).toBeNull();

    await phase(reopened, [9]);
    const linked = value(await callbacks.resolveLinkIdentity({ ...invocation, source, remoteSessionId: id }));
    expect(linked.linkData).toMatchObject({ museHome: source.museHome, sessionId: id });
    await phase(reopened, [9]);
    expect(value(await callbacks.resolveLinkedIdentity({ ...invocation, source: linked.source,
      remoteSessionId: id, linkData: linked.linkData }))).toEqual(linked);

    await phase(reader, [7]);
    const full = value(await callbacks.pageTranscript({ ...invocation, source, remoteSessionId: id, direction: 'older', maxItems: 5000 }));
    expect(full.items.filter(item => item.raw.role === 'user')).toHaveLength(260);
    expect(new Set(full.items.map(item => item.id.split(':')[0])).size).toBe(1300);
    expect(new Set(full.items.map(item => item.id)).size).toBe(full.items.length);
    for (const item of full.items) expect(AgentExternalSessionTranscriptRawRecordSchema.safeParse(item.raw).success).toBe(true);
    expect(full).toMatchObject({ nextCursor: null, hasMore: false, tailCursor: expect.any(String) });

    await phase(reader, [7, 17]);
    const backward = value(await callbacks.pageTranscript({ ...invocation, source, remoteSessionId: id, direction: 'older', maxItems: 7 }));
    expect(backward.items.length).toBeGreaterThan(0);
    expect(backward).toMatchObject({ hasMore: true, tailCursor: full.tailCursor });

    await phase(reader, [21]);
    expect(value(await callbacks.readAfterTranscript({ ...invocation, source, remoteSessionId: id,
      cursor: full.tailCursor!, maxItems: 1000 }))).toEqual({ outcome: 'already_current' });

    // Schema-derived history-mode extension: original native folded Items and
    // all four captured page windows are unchanged; only mode becomes unknown.
    const unknown = structuredClone(reader);
    const reply = readMuseRecord(unknown[8]);
    const message = readMuseRecord(reply.message);
    unknown[8] = { ...reply, message: { ...message, result: { ...readMuseRecord(message.result),
      history: { mode: 'futureSnapshot', items: null, snapshot: null } } } };
    await phase(unknown, [7, 9, 11, 13, 15]);
    const paged = value(await callbacks.pageTranscript({ ...invocation, source, remoteSessionId: id, direction: 'newer', maxItems: 5000 }));
    // Inline Items are already folded: a completed Tool emits its call/result
    // together. Stored view events preserve interleaved native start/completion
    // chronology instead. Both representations must retain the same final
    // source identities and content without imposing folded adjacency on events.
    const contentById = (items: typeof full.items) => items.map(({ id, raw }) => ({ id, raw }))
      .sort((left, right) => left.id.localeCompare(right.id));
    expect(new Set(paged.items.map(item => item.id)).size).toBe(paged.items.length);
    expect(contentById(paged.items)).toEqual(contentById(full.items));
    expect(paged.items.filter(item => item.raw.role === 'user').map(item => item.raw))
      .toEqual(full.items.filter(item => item.raw.role === 'user').map(item => item.raw));
    // Captured row10 events[3,5,9]: reminder child starts, the foreground
    // message completes, then that same child completes (native IDs retained).
    const childCall = '00000000-0000-7000-8000-000000000005:tool-call';
    const childResult = '00000000-0000-7000-8000-000000000005:tool-result';
    const foregroundMessage = '00000000-0000-7000-8000-000000000007:message';
    const interleaved = new Set([childCall, childResult, foregroundMessage]);
    expect(paged.items.map(item => item.id).filter(id => interleaved.has(id)))
      .toEqual([childCall, foregroundMessage, childResult]);
    expect(full.items.map(item => item.id).filter(id => interleaved.has(id)))
      .toEqual([childCall, childResult, foregroundMessage]);
    expect(paged).toMatchObject({ nextCursor: null, hasMore: false });

    // Native ErrorData.kind is an open enum. This retained-cursor loss vector
    // is schema-derived, not a claim that the healthy capture was truncated.
    const gap = structuredClone(reader);
    const gapRow = readMuseRecord(gap[22]);
    gap[22] = { ...gapRow, message: { id: readMuseRecord(gapRow.message).id ?? null,
      error: { code: -32040, message: 'View retention boundary', data: { kind: 'viewTruncated', earliestCursor: null } } } };
    await phase(gap, [21]);
    expect(value(await callbacks.readAfterTranscript({ ...invocation, source, remoteSessionId: id,
      cursor: full.tailCursor!, maxItems: 1000 }))).toEqual({ outcome: 'gap_or_cursor_expired' });

    // Schema-derived replacement: keep the admitted source/cursor scope while
    // the independent native reader reports a different home at initialize.
    const replaced = structuredClone(reopened);
    const initialized = readMuseRecord(replaced[1]);
    const initializedMessage = readMuseRecord(initialized.message);
    replaced[1] = { ...initialized, message: { ...initializedMessage,
      result: { ...readMuseRecord(initializedMessage.result), museHome: `${source.museHome}/replaced` } } };
    await phase(replaced);
    expect(value(await callbacks.readAfterTranscript({ ...invocation, source,
      remoteSessionId: id, cursor: full.tailCursor!, maxItems: 1000 }))).toEqual({ outcome: 'source_replaced' });

    // Exact short capture: 15 native stored-view events over eight forward
    // windows. Each two-event window can project four Tool rows, so admit four
    // outward rows while retaining the captured smaller native responses.
    // The dedicated bounds suite exercises split-Tool continuations.
    const short = readMuseRecord(JSON.parse((await readFile(new URL('./testkit/fixtures/history.json', import.meta.url), 'utf8'))
      .replaceAll('[TEMP]/history', scratch)));
    if (!Array.isArray(short.rows)) throw new Error('Short captured history is missing');
    const shortId = readMuseRecord(readMuseRecord(short.rows[3]).message).params;
    const shortSession = readMuseRecord(shortId).sessionId;
    if (typeof shortSession !== 'string') throw new Error('Short native Session identity is missing');
    const shortSource = { kind: 'museNative', museHome: join(scratch, 'data/muse') };
    await phase(short.rows, [5]);
    const shortInitial = value(await callbacks.pageTranscript({ ...invocation, source: shortSource,
      remoteSessionId: shortSession, direction: 'older', maxItems: 100 }));
    if (!shortInitial.tailCursor) throw new Error('Short native history did not establish a tail');
    let cursor = shortInitial.tailCursor;
    const userIds: string[] = [];
    for (const requestRow of [37, 39, 41, 43, 45, 47, 49, 51]) {
      await phase(short.rows, [requestRow]);
      const after = value(await callbacks.readAfterTranscript({ ...invocation, source: shortSource,
        remoteSessionId: shortSession, cursor, maxItems: 4 }));
      expect(after.outcome).toBe('advanced');
      if (after.outcome !== 'advanced') throw new Error('Captured native continuation did not advance');
      expect(after.nextCursor).not.toBe(cursor);
      cursor = after.nextCursor;
      userIds.push(...after.items.filter(item => item.raw.role === 'user').map(item => item.id));
      expect(after.hasMore).toBe(requestRow !== 51);
    }
    expect(cursor).not.toBe(shortInitial.tailCursor);
    expect(userIds).toHaveLength(1);
    expect(new Set(userIds).size).toBe(1);
    expect(audits).toHaveLength(19);
    for (const path of audits) {
      const audit = await readMuseMspProcessAudit(path);
      expect(audit.initializeCount).toBe(1);
      expect(audit.initializedCount).toBe(1);
      expect(audit.commandCount).toBe(0);
      expect(audit.methods.every(method => ['initialize', 'initialized', 'session/list', 'session/read', 'view/page'].includes(method))).toBe(true);
    }
    const pages = await readMuseMspProcessAudit(audits[7]!);
    expect(pages.methods.filter(method => method === 'view/page')).toHaveLength(4);
    });
  } finally {
    await fixture?.dispose(); credentials.mockRestore(); currentness.mockRestore(); linkedLookup.mockRestore();
    vi.unstubAllEnvs();
    await new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve()));
    await rm(scratch, { recursive: true, force: true });
  }
});
