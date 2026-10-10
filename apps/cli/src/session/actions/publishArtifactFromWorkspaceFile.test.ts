import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { x25519 } from '@noble/curves/ed25519';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArtifactBlobWriteV1Schema, decodePlainArtifactStoredContent, decodeBase64, openEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol';
import { ARTIFACT_HTML_BUNDLE_MIME_V1, ArtifactHtmlBundleV1Schema } from '@happier-dev/protocol/artifacts/artifactHtmlV1';
import { decryptWithDataKey } from '@/api/encryption';
import { createAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import { readCarrierMutation } from '@/api/artifacts/accountArtifactStore.testkit';
import { publishArtifactFromWorkspaceFile, readArtifactWorkspaceFile } from './publishArtifactFromWorkspaceFile';

const http = vi.hoisted(() => ({ post: vi.fn(), get: vi.fn() }));
vi.mock('axios', () => ({ default: http }));

describe('explicit Artifact publication from the caller workspace', () => {
  let root: string;
  const secret = randomBytes(32);
  const store = (mode: 'plain' | 'e2ee' = 'plain') => createAccountArtifactStore({ credentials: { token: 'test-token', encryption: mode === 'plain' ? null : {
    type: 'dataKey', publicKey: x25519.getPublicKey(secret), machineKey: secret,
  } }, savedBy: { kind: 'agent', accountId: 'owner', sessionId: 'session' }, getAccountEncryptionMode: async () => mode });
  const open = (value: unknown, envelope?: unknown) => envelope
    ? decryptWithDataKey(decodeBase64(String(value)), openEncryptedDataKeyEnvelopeV1({ envelope: decodeBase64(String(envelope)), recipientSecretKeyOrSeed: secret })!)
    : decodePlainArtifactStoredContent(String(value));
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'artifact-publication-'));
    await mkdir(join(root, 'workspace'));
    http.post.mockReset();
    http.get.mockReset();
    http.post.mockImplementation(async (_url: string, wire: Record<string, unknown> | Buffer) => ({ status: 200,
      data: { id: readCarrierMutation(wire).id, headerVersion: 1, bodyVersion: 1 } }));
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it.each(['text/html', 'application/vnd.happier.html-bundle+json'])('publishes %s as exact html kind and preserves all source bytes', async (mime) => {
    const text = mime === 'text/html' ? '<h1>HTML</h1>' : JSON.stringify({ v: 1, entrypoint: 'pages/index.html', files: {
      'pages/index.html': { mime: 'text/html', contentBase64: Buffer.from('<img src="../assets/icon.svg">').toString('base64') },
      'assets/icon.svg': { mime: 'image/svg+xml', contentBase64: Buffer.from('<svg/>').toString('base64') },
    } });
    await writeFile(join(root, 'workspace', 'document'), text);
    http.get.mockImplementation(async (url: string) => ({ status: 200,
      data: { url: `https://isolated.example/a/${url.split('/').at(-2)}` } }));
    const result = await publishArtifactFromWorkspaceFile({ store: store(), caller: { sessionId: 'session', machineId: 'machine', directory: join(root, 'workspace') }, input: { path: 'document', mime } });
    expect(result).toEqual({ artifactId: expect.any(String), revision: { headerVersion: 1, bodyVersion: 1 } });
    const payload = readCarrierMutation(http.post.mock.calls[0]?.[1]);
    expect(decodePlainArtifactStoredContent(String(payload.header))).toMatchObject({ kind: 'html', mime });
    if (mime === 'text/html') expect(decodePlainArtifactStoredContent(String(payload.body))).toEqual({ body: text });
    else expect(ArtifactBlobWriteV1Schema.parse(payload.blob).content).toEqual({ t: 'plain', v: Buffer.from(text).toString('base64') });
  });

  it('infers HTML filenames only without conflicting caller declarations', async () => {
    await writeFile(join(root, 'workspace', 'document.HTML'), '<h1>HTML</h1>');
    http.get.mockImplementation(async (url: string) => ({ status: 200,
      data: { url: `https://isolated.example/a/${url.split('/').at(-2)}` } }));
    const caller = { sessionId: 'session', machineId: 'machine', directory: join(root, 'workspace') };
    for (const input of [{ path: 'document.HTML' }, { path: 'document.HTML', kind: 'published.v1' },
      { path: 'document.HTML', mime: 'text/plain' }, { path: 'document.HTML', mime: 'text/html; charset=utf-8' }]) {
      const result = await publishArtifactFromWorkspaceFile({ store: store(), caller, input });
      const header = decodePlainArtifactStoredContent(http.post.mock.calls.at(-1)?.[1].header);
      const isHtml = !('kind' in input) && (!('mime' in input) || input.mime?.startsWith('text/html'));
      expect(header).toMatchObject({ kind: isHtml ? 'html' : 'published.v1' });
      expect(result).not.toHaveProperty('previewUrl');
      expect(result).not.toHaveProperty('previewError');
    }
  });

  it('acquires a declared folder entrypoint with exact JS, CSS, image, font and resource bytes and publishes the same bundle', async () => {
    const directory = join(root, 'workspace', 'site');
    await mkdir(join(directory, 'pages'), { recursive: true });
    await mkdir(join(directory, 'assets'));
    const assets = {
      'pages/index.html': { mime: 'text/html', bytes: Buffer.from('<script type="module" src="../assets/main.mjs"></script>') },
      'assets/main.mjs': { mime: 'text/javascript', bytes: Buffer.from('import "./dep.js"; fetch("../data.json")') },
      'assets/dep.js': { mime: 'text/javascript', bytes: Buffer.from('document.body.dataset.loaded = "yes"') },
      'assets/style.css': { mime: 'text/css', bytes: Buffer.from('@font-face {src:url("./font.woff2")}') },
      'assets/icon.png': { mime: 'image/png', bytes: Buffer.from([137, 80, 78, 71, 0, 255]) },
      'assets/font.woff2': { mime: 'font/woff2', bytes: Buffer.from([119, 79, 70, 50, 0, 255]) },
      'data.json': { mime: 'application/json', bytes: Buffer.from('{"result":42}') },
    };
    for (const [path, asset] of Object.entries(assets)) await writeFile(join(directory, path), asset.bytes);
    const caller = { sessionId: 'session', machineId: 'machine', directory: join(root, 'workspace') };
    const acquired = await readArtifactWorkspaceFile({ caller, path: 'site', entrypoint: 'pages/index.html' });
    const expected = { v: 1, entrypoint: 'pages/index.html', files: Object.fromEntries(Object.entries(assets)
      .map(([path, asset]) => [path, { mime: asset.mime, contentBase64: asset.bytes.toString('base64') }])) };
    expect(acquired.bundle).toEqual(expected);
    expect(acquired.path).toBe('site');
    http.get.mockImplementation(async (url: string) => ({ status: 200,
      data: { url: `https://isolated.example/a/${url.split('/').at(-2)}` } }));
    const result = await publishArtifactFromWorkspaceFile({ store: store(), caller,
      input: { path: 'site', entrypoint: 'pages/index.html', title: 'Experiment' } });
    expect(result).toEqual({ artifactId: expect.any(String), revision: { headerVersion: 1, bodyVersion: 1 } });
    const payload = readCarrierMutation(http.post.mock.calls[0]?.[1]);
    expect(decodePlainArtifactStoredContent(String(payload.header))).toMatchObject({ title: 'Experiment', kind: 'html', mime: ARTIFACT_HTML_BUNDLE_MIME_V1 });
    const blob = ArtifactBlobWriteV1Schema.parse(payload.blob);
    expect(blob.content.t === 'plain' && ArtifactHtmlBundleV1Schema.parse(JSON.parse(Buffer.from(blob.content.v, 'base64').toString('utf8')))).toEqual(expected);
  });

  it('returns the canonical one-file bundle when acquiring HTML without creating an Artifact', async () => {
    await writeFile(join(root, 'workspace', 'index.html'), '<h1>Hello</h1>');
    const acquired = await readArtifactWorkspaceFile({ caller: { sessionId: 'session', machineId: 'machine', directory: join(root, 'workspace') }, path: 'index.html' });
    expect(acquired.bundle).toEqual({ v: 1, entrypoint: 'index.html', files: { 'index.html': {
      mime: 'text/html', contentBase64: Buffer.from('<h1>Hello</h1>').toString('base64'),
    } } });
    expect(http.post).not.toHaveBeenCalled();
  });

  it('refuses a missing or invalid folder entrypoint before publication', async () => {
    await mkdir(join(root, 'workspace', 'site'));
    await writeFile(join(root, 'workspace', 'site', 'index.html'), '<h1>Hello</h1>');
    await writeFile(join(root, 'workspace', 'site', 'main.js'), 'export {}');
    const caller = { sessionId: 'session', machineId: 'machine', directory: join(root, 'workspace') };
    for (const entrypoint of [undefined, '../site/index.html', '/index.html', 'pages\\index.html', 'missing.html', 'main.js']) {
      await expect(publishArtifactFromWorkspaceFile({ store: store(), caller, input: { path: 'site', entrypoint } }))
        .rejects.toMatchObject({ code: 'artifact_source_forbidden' });
    }
    expect(http.post).not.toHaveBeenCalled();
  });

  it('refuses folder symlinks, asset symlinks and symlink ancestors even when their destinations stay inside the workspace', async () => {
    await mkdir(join(root, 'workspace', 'site'));
    await writeFile(join(root, 'workspace', 'site', 'index.html'), '<h1>Hello</h1>');
    await symlink(join(root, 'workspace', 'site'), join(root, 'workspace', 'linked-site'), process.platform === 'win32' ? 'junction' : 'dir');
    const caller = { sessionId: 'session', machineId: 'machine', directory: join(root, 'workspace') };
    for (const input of [{ path: 'linked-site', entrypoint: 'index.html' }, { path: 'linked-site/index.html' }]) {
      await expect(publishArtifactFromWorkspaceFile({ store: store(), caller, input })).rejects.toMatchObject({ code: 'artifact_source_forbidden' });
    }
    await symlink(join(root, 'workspace', 'site', 'index.html'), join(root, 'workspace', 'site', 'linked.html'));
    await expect(publishArtifactFromWorkspaceFile({ store: store(), caller, input: { path: 'site', entrypoint: 'index.html' } }))
      .rejects.toMatchObject({ code: 'artifact_source_forbidden' });
    expect(http.post).not.toHaveBeenCalled();
  });

  it.each(['plain', 'e2ee'] as const)('publishes a completed %s multi-chunk text copy without public source disclosure', async mode => {
    const text = 'Published output\n'.repeat(40_000);
    await writeFile(join(root, 'workspace', 'result.md'), text);
    await expect(publishArtifactFromWorkspaceFile({ store: store(mode), caller: {
      sessionId: 'session', machineId: 'machine', directory: join(root, 'workspace'), runId: 'run',
    }, input: { path: 'result.md', title: 'Result', mime: 'text/markdown' } }))
      .resolves.toMatchObject({ revision: { headerVersion: 1, bodyVersion: 1 } });
    const payload = http.post.mock.calls[0]?.[1];
    expect(open(payload.header, mode === 'e2ee' ? payload.dataEncryptionKey : undefined)).toMatchObject({ title: 'Result', kind: 'published.v1', mime: 'text/markdown', sizeBytes: Buffer.byteLength(text) });
    expect(open(payload.header, mode === 'e2ee' ? payload.dataEncryptionKey : undefined)).not.toHaveProperty('source');
    expect(open(payload.provenance, mode === 'e2ee' ? payload.provenanceDataEncryptionKey : undefined)).toMatchObject({ provenance: { source: {
        sessionId: 'session', runId: 'run', machineId: 'machine', path: 'result.md',
        sha: createHash('sha256').update(text).digest('hex'),
      } } });
    expect(open(payload.body, mode === 'e2ee' ? payload.dataEncryptionKey : undefined)).toEqual({ body: text });
  });

  it('refuses parent traversal and symlink escapes before Artifact creation', async () => {
    await writeFile(join(root, 'private.txt'), 'outside');
    await symlink(join(root, 'private.txt'), join(root, 'workspace', 'escape.txt'));
    for (const path of ['../private.txt', 'escape.txt']) {
      await expect(publishArtifactFromWorkspaceFile({ store: store(), caller: {
        sessionId: 'session', machineId: 'machine', directory: join(root, 'workspace'),
      }, input: { path } })).rejects.toMatchObject({ code: 'artifact_source_forbidden' });
    }
    expect(http.post).not.toHaveBeenCalled();
  });

  it.each([{ mode: 'plain' as const, mime: 'image/png', bytes: Buffer.from([0xff, 0xfe, 0, 42]) },
    { mode: 'e2ee' as const, mime: 'image/png', bytes: Buffer.from([0xff, 0xfe, 0, 42]) },
    { mode: 'plain' as const, mime: 'application/pdf', bytes: Buffer.from('%PDF-1.7\n1 0 obj\nendobj\n%%EOF') }])
  ('publishes $mode $mime files as private blob content with workspace provenance', async ({ mode, bytes, mime }) => {
    await writeFile(join(root, 'workspace', 'binary'), bytes);
    await expect(publishArtifactFromWorkspaceFile({ store: store(mode), caller: {
      sessionId: 'session', machineId: 'machine', directory: join(root, 'workspace'),
    }, input: { path: 'binary', mime } })).resolves.toMatchObject({ revision: { bodyVersion: 1 } });
    const payload = readCarrierMutation(http.post.mock.calls[0]?.[1]);
    const blob = ArtifactBlobWriteV1Schema.parse(payload.blob);
    expect(blob.content).toMatchObject(mode === 'plain' ? { t: 'plain', v: bytes.toString('base64') } : { t: 'encrypted' });
    expect(open(payload.body, mode === 'e2ee' ? payload.dataEncryptionKey : undefined)).toMatchObject({ body: {
      blobId: blob.blobId, mime, sizeBytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    } });
    expect(open(payload.header, mode === 'e2ee' ? payload.dataEncryptionKey : undefined)).not.toHaveProperty('source');
    expect(open(payload.provenance, mode === 'e2ee' ? payload.provenanceDataEncryptionKey : undefined)).toMatchObject({ provenance: { source: { path: 'binary', sessionId: 'session' } } });
  });

  it('does not create an Artifact when transfer fails or cancellation precedes it', async () => {
    const caller = { sessionId: 'session', machineId: 'machine', directory: join(root, 'workspace') };
    await expect(publishArtifactFromWorkspaceFile({ store: store(), caller, input: { path: 'missing' } })).rejects.toBeDefined();
    await writeFile(join(root, 'workspace', 'binary'), Buffer.from([0xff, 0xfe]));
    const controller = new AbortController();
    controller.abort();
    await expect(publishArtifactFromWorkspaceFile({ store: store(), caller, input: { path: 'binary' }, signal: controller.signal }))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(http.post).not.toHaveBeenCalled();
  });
});
