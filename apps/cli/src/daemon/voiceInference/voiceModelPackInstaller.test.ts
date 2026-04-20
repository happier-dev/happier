import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { installVoiceModelPack, removeInstalledVoiceModelPack } from './voiceModelPackInstaller';

describe('voiceModelPackInstaller packId filesystem safety', () => {
  it('rejects pack ids that attempt to escape packsRootDir via path traversal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-voice-packid-'));
    const packsRootDir = join(root, 'packs');
    const outsideDir = join(root, 'outside');
    await mkdir(packsRootDir, { recursive: true });
    await mkdir(outsideDir, { recursive: true });

    const canaryPath = join(outsideDir, 'canary.txt');
    await writeFile(canaryPath, 'still-here', 'utf8');

    await expect(removeInstalledVoiceModelPack({
      packsRootDir,
      packId: '../outside',
    })).rejects.toThrow('voice_inference_invalid_pack_id');

    await expect(readFile(canaryPath, 'utf8')).resolves.toBe('still-here');
  });
});

describe('voiceModelPackInstaller download validation', () => {
  it('rejects downloads whose actual size does not match the manifest sizeBytes', async () => {
    const http = await import('node:http');
    const { createHash } = await import('node:crypto');
    const root = await mkdtemp(join(tmpdir(), 'happier-voice-pack-download-'));
    const packsRootDir = join(root, 'packs');
    await mkdir(packsRootDir, { recursive: true });

    const expectedBytes = Buffer.from('a'); // 1 byte
    const expectedSha = createHash('sha256').update(expectedBytes).digest('hex');
    const actualBytes = Buffer.from('aa'); // 2 bytes

    const server = http.createServer((req, res) => {
      if (!req.url) {
        res.statusCode = 404;
        res.end();
        return;
      }
      if (req.url === '/file.bin') {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/octet-stream');
        res.end(actualBytes);
        return;
      }
      res.statusCode = 404;
      res.end();
    });

    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    if (!address || typeof address === 'string') {
      server.close();
      throw new Error('server_failed_to_bind');
    }

    const fileUrl = `http://127.0.0.1:${address.port}/file.bin`;

    await expect(installVoiceModelPack({
      packsRootDir,
      manifest: {
        packId: 'example-pack',
        kind: 'tts_sherpa',
        model: 'kokoro',
        version: 'v1',
        files: [
          {
            path: 'file.bin',
            url: fileUrl,
            sha256: expectedSha,
            sizeBytes: 1,
          },
        ],
      } as any,
    })).rejects.toThrow('model_pack_size_mismatch');

    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
