import { mkdir, mkdtemp, readFile, readdir, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createVoiceDiagnosticStore, resolveVoiceDiagnosticRoot } from './store';

function createMonoPcm16Wav(durationMs: number, sampleRate = 16_000): Buffer {
  const dataBytes = Math.round(sampleRate * (durationMs / 1_000)) * 2;
  const wav = Buffer.alloc(44 + dataBytes);
  wav.write('RIFF', 0, 'ascii');
  wav.writeUInt32LE(36 + dataBytes, 4);
  wav.write('WAVE', 8, 'ascii');
  wav.write('fmt ', 12, 'ascii');
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36, 'ascii');
  wav.writeUInt32LE(dataBytes, 40);
  return wav;
}

const roots: string[] = [];

async function makeHome(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'happier-voice-diagnostics-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('voice diagnostic store', () => {
  it('writes the cache-directory tag, reports it as best-effort, and preserves it across deleteAll', async () => {
    const home = await makeHome();
    const store = createVoiceDiagnosticStore({
      happyHomeDir: home,
      policy: { enabled: true, consentVersion: 1, captureSttInput: true },
    });

    await store.prune();
    expect(await readFile(join(resolveVoiceDiagnosticRoot(home), 'CACHEDIR.TAG'), 'utf8'))
      .toBe('Signature: 8a477f597d28d172789f06886806bc55\n');
    expect(store.backupPolicy).toEqual({
      status: 'best_effort',
      storage: 'private_cache',
      mechanism: 'cachedir_tag',
      automaticSync: 'not_implemented',
    });

    const root = resolveVoiceDiagnosticRoot(home);
    const outsideTarget = join(home, 'outside-target');
    await writeFile(outsideTarget, 'must survive');
    await writeFile(join(root, 'abcdef12-deadbeef.wav.tmp-11111111-1111-4111-8111-111111111111'), 'partial-diagnostic');
    await writeFile(join(root, 'abcdef12-deadbeef.wav.tmp----------'), 'foreign malformed nonce');
    await symlink(outsideTarget, join(root, 'abcdef12-badface.json'));
    await writeFile(join(root, 'foreign.tmp-user'), 'preserve unrelated user file');
    await store.deleteAll();
    expect(await readdir(root)).toEqual([
      'CACHEDIR.TAG',
      'abcdef12-deadbeef.wav.tmp----------',
      'foreign.tmp-user',
    ]);
    expect(await readFile(outsideTarget, 'utf8')).toBe('must survive');
  });

  it('is inert without explicit current consent and keeps audio/metadata private and separate', async () => {
    const home = await makeHome();
    const disabled = createVoiceDiagnosticStore({ happyHomeDir: home, policy: { enabled: false, consentVersion: null } });
    expect(await disabled.capture({
      direction: 'stt_input', format: 'wav', bytes: Buffer.from('secret-audio'), durationMs: 20,
      sessionId: 'session/private', providerId: 'local_neural', attemptId: 'attempt:1',
    })).toBeNull();

    const store = createVoiceDiagnosticStore({ happyHomeDir: home, policy: { enabled: true, consentVersion: 1, captureSttInput: true } });
    const artifact = await store.capture({
      direction: 'stt_input', format: 'wav', bytes: Buffer.from('secret-audio'), durationMs: 20,
      sessionId: 'session/private', providerId: 'local_neural', attemptId: 'attempt:1',
    });
    expect(artifact).not.toBeNull();
    expect(await readFile(artifact!.audioPath, 'utf8')).toBe('secret-audio');
    const metadataText = await readFile(artifact!.metadataPath, 'utf8');
    expect(metadataText).not.toContain('secret-audio');
    expect(metadataText).not.toContain('session/private');
    expect(JSON.parse(metadataText)).toMatchObject({ v: 1, direction: 'stt_input', format: 'wav', durationMs: 20 });
    if (process.platform !== 'win32') {
      expect((await stat(artifact!.audioPath)).mode & 0o777).toBe(0o600);
      expect((await stat(resolveVoiceDiagnosticRoot(home))).mode & 0o777).toBe(0o700);
    }
  });

  it('uses a fixed canonical root and rejects a symlinked diagnostics directory', async () => {
    const home = await makeHome();
    const outside = await makeHome();
    await mkdir(join(home, 'voice', 'diagnostics'), { recursive: true });
    await symlink(outside, resolveVoiceDiagnosticRoot(home), process.platform === 'win32' ? 'junction' : 'dir');
    const store = createVoiceDiagnosticStore({ happyHomeDir: home, policy: { enabled: true, consentVersion: 1, captureTtsOutput: true } });
    await expect(store.capture({
      direction: 'tts_output', format: 'wav', bytes: Buffer.from([1]), durationMs: 1,
      sessionId: '../escape', providerId: '../../provider', attemptId: '/tmp/attempt',
    })).rejects.toThrow('voice_diagnostics_root_unsafe');
    expect((await readdir(outside)).length).toBe(0);
  });

  it('prunes by age/count/bytes, serializes concurrent writes, and deleteAll is immediate', async () => {
    const home = await makeHome();
    let now = 10_000;
    const store = createVoiceDiagnosticStore({
      happyHomeDir: home,
      now: () => now,
      policy: { enabled: true, consentVersion: 1, captureTtsOutput: true, maxAgeMs: 100, maxFiles: 2, maxBytes: 12, maxDurationMs: 1_000 },
    });
    const capture = (attemptId: string) => store.capture({
      direction: 'tts_output' as const, format: 'wav' as const, bytes: Buffer.from('123456'), durationMs: 50,
      sessionId: 'session', providerId: 'provider', attemptId,
    });
    await Promise.all([capture('a'), capture('b'), capture('c')]);
    expect((await store.list()).length).toBe(2);
    now += 101;
    await store.prune();
    expect(await store.list()).toEqual([]);
    await capture('d');
    await store.deleteAll();
    expect(await store.list()).toEqual([]);
  });

  it('prunes diagnostic-shaped orphan files left by an interrupted atomic commit', async () => {
    const home = await makeHome();
    const store = createVoiceDiagnosticStore({
      happyHomeDir: home,
      policy: { enabled: true, consentVersion: 1, captureTtsOutput: true },
    });
    await store.prune();
    const root = resolveVoiceDiagnosticRoot(home);
    await writeFile(join(root, 'abcdef12-deadbeef.wav'), Buffer.from('orphan-audio'));
    await writeFile(join(root, 'abcdef12-badface.json'), '{not-json');
    await writeFile(join(root, 'abcdef12-deadbeef.wav.tmp-11111111-1111-4111-8111-111111111111'), 'partial-diagnostic');
    await writeFile(join(root, 'abcdef12-deadbeef.wav.tmp----------'), 'foreign malformed nonce');
    await writeFile(join(root, 'foreign-note.txt'), 'preserve unrelated user file');
    await writeFile(join(root, 'foreign.tmp-user'), 'preserve unrelated temp-like file');

    await store.prune();

    expect(await readdir(root)).toEqual([
      'CACHEDIR.TAG',
      'abcdef12-deadbeef.wav.tmp----------',
      'foreign-note.txt',
      'foreign.tmp-user',
    ]);
  });

  it('fails explicit deletion and retention when diagnostic-owned files cannot be removed', async () => {
    const home = await makeHome();
    let now = 10_000;
    let denyRemoval = false;
    const removeFile = async (path: string): Promise<void> => {
      if (denyRemoval) throw new Error('simulated_remove_failure');
      await unlink(path);
    };
    const store = createVoiceDiagnosticStore({
      happyHomeDir: home,
      now: () => now,
      removeFile,
      policy: {
        enabled: true,
        consentVersion: 1,
        captureTtsOutput: true,
        maxAgeMs: 100,
      },
    });
    const artifact = await store.capture({
      direction: 'tts_output', format: 'wav', bytes: Buffer.from('sensitive-audio'), durationMs: 50,
      sessionId: 'session', providerId: 'provider', attemptId: 'attempt',
    });
    expect(artifact).not.toBeNull();

    denyRemoval = true;
    await expect(store.deleteAll()).rejects.toThrow('simulated_remove_failure');
    expect(await readFile(artifact!.audioPath, 'utf8')).toBe('sensitive-audio');

    now += 101;
    await expect(store.prune()).rejects.toThrow('simulated_remove_failure');
    expect(await readFile(artifact!.audioPath, 'utf8')).toBe('sensitive-audio');

    denyRemoval = false;
    await store.deleteAll();
  });

  it('does not release serialized deletion until every owned-file removal settles', async () => {
    const home = await makeHome();
    let artifactAudioPath = '';
    let artifactMetadataPath = '';
    let failDeletion = false;
    let markDelayedRemovalStarted!: () => void;
    const delayedRemovalStarted = new Promise<void>((resolve) => {
      markDelayedRemovalStarted = resolve;
    });
    let releaseDelayedRemoval!: () => void;
    const delayedRemoval = new Promise<void>((resolve) => {
      releaseDelayedRemoval = resolve;
    });
    const removeFile = async (path: string): Promise<void> => {
      if (!failDeletion) {
        await unlink(path);
        return;
      }
      if (path === artifactMetadataPath) throw new Error('simulated_remove_failure');
      if (path === artifactAudioPath) {
        markDelayedRemovalStarted();
        await delayedRemoval;
      }
      await unlink(path);
    };
    const store = createVoiceDiagnosticStore({
      happyHomeDir: home,
      removeFile,
      policy: { enabled: true, consentVersion: 1, captureTtsOutput: true },
    });
    const artifact = await store.capture({
      direction: 'tts_output', format: 'wav', bytes: Buffer.from('sensitive-audio'), durationMs: 50,
      sessionId: 'session', providerId: 'provider', attemptId: 'attempt',
    });
    expect(artifact).not.toBeNull();
    artifactAudioPath = artifact!.audioPath;
    artifactMetadataPath = artifact!.metadataPath;

    failDeletion = true;
    let deletionSettled = false;
    const deletion = store.deleteAll();
    void deletion.then(
      () => { deletionSettled = true; },
      () => { deletionSettled = true; },
    );
    await delayedRemovalStarted;
    await new Promise<void>((resolve) => setImmediate(resolve));
    const settledBeforeEveryRemoval = deletionSettled;
    releaseDelayedRemoval();

    await expect(deletion).rejects.toThrow('simulated_remove_failure');
    expect(settledBeforeEveryRemoval).toBe(false);
  });

  it('fails closed on duration/disk limits and removes partial artifacts after cancellation', async () => {
    const home = await makeHome();
    const store = createVoiceDiagnosticStore({
      happyHomeDir: home,
      statfs: async () => ({ bavail: 0, bsize: 4096 }),
      policy: { enabled: true, consentVersion: 1, captureSttInput: true, maxDurationMs: 10, minFreeBytes: 1 },
    });
    await expect(store.capture({
      direction: 'stt_input', format: 'pcm16', bytes: Buffer.from([1]), durationMs: 11,
      sessionId: 's', providerId: 'p', attemptId: 'a',
    })).rejects.toThrow('voice_diagnostics_duration_exceeded');
    await expect(store.capture({
      direction: 'stt_input', format: 'pcm16', bytes: Buffer.from([1]), durationMs: 1,
      sessionId: 's', providerId: 'p', attemptId: 'b',
    })).rejects.toThrow('voice_diagnostics_disk_headroom');

    const abort = new AbortController();
    abort.abort();
    const cancellable = createVoiceDiagnosticStore({ happyHomeDir: home, policy: { enabled: true, consentVersion: 1, captureSttInput: true } });
    await expect(cancellable.capture({
      direction: 'stt_input', format: 'pcm16', bytes: Buffer.from([1]), durationMs: 1,
      sessionId: 's', providerId: 'p', attemptId: 'c', signal: abort.signal,
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(await cancellable.list()).toEqual([]);
  });

  it('derives WAV duration and preserves null duration for honest compressed inputs', async () => {
    const home = await makeHome();
    const store = createVoiceDiagnosticStore({
      happyHomeDir: home,
      policy: { enabled: true, consentVersion: 1, captureSttInput: true, captureTtsOutput: true },
    });
    const wav = await store.capture({
      direction: 'tts_output', format: 'wav', bytes: createMonoPcm16Wav(1_000), durationMs: null,
      sessionId: 's', providerId: 'p', attemptId: 'wav',
    });
    const webm = await store.capture({
      direction: 'stt_input', format: 'webm', bytes: Buffer.from('webm-container'), durationMs: null,
      sessionId: 's', providerId: 'p', attemptId: 'webm',
    });

    expect(wav?.durationMs).toBe(1_000);
    expect(webm?.durationMs).toBeNull();
    expect(webm?.audioPath.endsWith('.webm')).toBe(true);
  });

  it('captures a staged WAV file without making the caller load its bytes', async () => {
    const home = await makeHome();
    const sourcePath = join(home, 'staged-input.wav');
    const sourceWav = createMonoPcm16Wav(250);
    await writeFile(sourcePath, sourceWav);
    const store = createVoiceDiagnosticStore({
      happyHomeDir: home,
      policy: { enabled: true, consentVersion: 1, captureSttInput: true },
    });

    const artifact = await store.captureFile({
      direction: 'stt_input',
      format: 'wav',
      filePath: sourcePath,
      durationMs: null,
      sessionId: 'session',
      providerId: 'local_neural',
      attemptId: 'attempt',
    });

    expect(await readFile(artifact!.audioPath)).toEqual(sourceWav);
    expect(await readFile(sourcePath)).toEqual(sourceWav);
    expect(artifact?.durationMs).toBe(250);
  });

  it('resolves only committed artifact ids for explicit export and never accepts paths', async () => {
    const home = await makeHome();
    const store = createVoiceDiagnosticStore({
      happyHomeDir: home,
      policy: { enabled: true, consentVersion: 1, captureSttInput: true },
    });
    const artifact = await store.capture({
      direction: 'stt_input', format: 'webm', bytes: Buffer.from('diagnostic'), durationMs: null,
      sessionId: 's', providerId: 'p', attemptId: 'a',
    });

    expect(await store.resolveArtifactForExport(artifact!.id)).toMatchObject({
      id: artifact!.id,
      byteLength: 10,
      audioPath: artifact!.audioPath,
    });
    expect(await store.resolveArtifactForExport('../../etc/passwd')).toBeNull();
    await writeFile(artifact!.audioPath, 'tampered');
    expect(await store.resolveArtifactForExport(artifact!.id)).toBeNull();
  });
});
