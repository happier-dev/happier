import { expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import files from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAgentSessionRuntimeHarness } from '@happier-dev/plugin-sdk/testing';
import { AgentRuntimeJsonValueSchema } from '@happier-dev/plugin-sdk/agents/runtime';
import { buildMentionRefForKindV1, MENTION_KIND_V1 } from '@happier-dev/protocol';
import { resolveStructuredInputProviderDispatchContext } from '@/agent/runtime/turns/resolveStructuredInputProviderContext';
import { createAdmittedMuseSessionFixture } from './testkit/admittedSession.test-support.js';

const fixturePath = (name: string) => fileURLToPath(new URL(`./testkit/fixtures/${name}.json`, import.meta.url));
const imageBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==';

it.each([false, true])('sends only host-verified image bytes (corrupt=%s)', async corrupt => {
  const cwd = await files.mkdtemp(join(tmpdir(), 'happier-muse-input-'));
  const path = '.happier/uploads/messages/muse-input/image.png';
  const absolutePath = join(cwd, path);
  const bytes = Buffer.from(imageBase64, 'base64');
  await files.mkdir(dirname(absolutePath), { recursive: true });
  await files.writeFile(absolutePath, bytes);
  // Observe the real OS read; ESM named consumers retain Node's synchronized binding.
  const reads = vi.spyOn(files, 'readFile');
  syncBuiltinESMExports();
  let fixture: Awaited<ReturnType<typeof createAdmittedMuseSessionFixture>> | undefined;
  const events = createAgentSessionRuntimeHarness();
  try {
    fixture = await createAdmittedMuseSessionFixture({ cwd, native: {
      recordingPath: fixturePath('isolated-echo-image'),
    } });
    const session = await fixture.open({ kind: 'create', sessionId: 'host-admitted-muse', cwd });
    session.watch(events.recordRuntimeEvent);
    const result = await session.send({ inputIds: ['image-input'], delivery: { kind: 'newTurn', turnId: 'image-turn' },
      input: { text: 'PEBBLE', structuredInput: { v: 1, imageInputs: [{ id: 'selected-image', kind: 'localImage',
        path, mimeType: 'image/png', sizeBytes: bytes.length,
        sha256: corrupt ? '0'.repeat(64) : createHash('sha256').update(bytes).digest('hex'),
        provenance: { kind: 'sessionAttachmentUpload' },
      }] } },
    });
    expect(result).toMatchObject({ status: corrupt ? 'unsupported' : 'admitted' });
    if (!corrupt) await events.until('turn-complete', { signal: new AbortController().signal });
    await fixture.closeSession();
    const audit = await fixture.readAudit();
    expect(audit.cwd).toBe(cwd);
    expect(audit.methods.filter(method => method === 'turn/start')).toHaveLength(corrupt ? 0 : 1);
    expect(reads.mock.calls.filter(args => String(args[0]) === absolutePath)).toHaveLength(1);
    expect(audit.turnInputs).toEqual(corrupt ? [] : [[{ type: 'text', text: 'PEBBLE' },
      { type: 'image', mediaType: 'image/png', base64Data: imageBase64 }]]);
    events.expectAllEventsValidated();
  } finally {
    events.dispose();
    try { await fixture?.dispose(); }
    finally {
      reads.mockRestore(); syncBuiltinESMExports();
      await files.rm(cwd, { recursive: true, force: true });
    }
  }
});

it('keeps the host-resolved staged file mention in the native text input', async () => {
  const cwd = await files.mkdtemp(join(tmpdir(), 'happier-muse-file-input-'));
  await files.writeFile(join(cwd, 'probe.txt'), 'Harmless isolated file fixture.\n');
  const fixture = await createAdmittedMuseSessionFixture({ cwd, native: {
    recordingPath: fixturePath('isolated-echo-file'),
  } });
  const events = createAgentSessionRuntimeHarness();
  try {
    const resolved = await resolveStructuredInputProviderDispatchContext({ structuredInput: { v: 1, mentions: [{
      kind: MENTION_KIND_V1.file, ref: buildMentionRefForKindV1(MENTION_KIND_V1.file, 'probe.txt'),
      token: '@probe.txt', start: 0, end: 10,
    }] } });
    const session = await fixture.open({ kind: 'create', sessionId: 'host-admitted-muse', cwd });
    session.watch(events.recordRuntimeEvent);
    expect(await session.send({ inputIds: ['file-input'], delivery: { kind: 'newTurn', turnId: 'file-turn' },
      input: { text: '@probe.txt PEBBLE', structuredInput: AgentRuntimeJsonValueSchema.parse(resolved.structuredInput) },
    })).toMatchObject({ status: 'admitted' });
    await events.until('turn-complete', { signal: new AbortController().signal });
    await fixture.closeSession();
    const audit = await fixture.readAudit();
    expect(audit.cwd).toBe(cwd);
    expect(audit.turnInputs).toEqual([[{ type: 'text', text: '@probe.txt PEBBLE' }]]);
    expect(audit.methods.filter(method => method === 'skill/list')).toHaveLength(0);
    events.expectAllEventsValidated();
  } finally { events.dispose(); await fixture.dispose(); await files.rm(cwd, { recursive: true, force: true }); }
});

it.each(['happier-isolated-probe', 'missing-native-skill'])('selects native skill %s from its actual Session catalog', async name => {
  const fixture = await createAdmittedMuseSessionFixture({ native: {
    recordingPath: fixturePath('isolated-echo-skill-arguments'),
  } });
  const events = createAgentSessionRuntimeHarness();
  try {
    const session = await fixture.open({ kind: 'create', sessionId: 'host-admitted-muse', cwd: process.cwd() });
    session.watch(events.recordRuntimeEvent);
    const result = await session.send({ inputIds: ['skill-input'], delivery: { kind: 'newTurn', turnId: 'skill-turn' },
      input: { text: 'PEBBLE', structuredInput: { v: 1, skillMentions: [{ origin: 'vendor', name, agentId: 'muse' }] } },
    });
    const supported = name === 'happier-isolated-probe';
    expect(result).toMatchObject({ status: supported ? 'admitted' : 'unsupported' });
    if (supported) await events.until('turn-complete', { signal: new AbortController().signal });
    await fixture.closeSession();
    const audit = await fixture.readAudit();
    expect(audit.methods.filter(method => method === 'skill/list')).toHaveLength(1);
    expect(audit.methods.filter(method => method === 'turn/start')).toHaveLength(supported ? 1 : 0);
    expect(audit.turnInputs).toEqual(supported ? [[{ type: 'skill', selector: name, source: 'user', arguments: 'PEBBLE' }]] : []);
    events.expectAllEventsValidated();
  } finally { events.dispose(); await fixture.dispose(); }
});
