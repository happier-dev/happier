import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { MACHINE_PROVISIONER_PUT_FILE_BASE64_MAX_LENGTH_V1 } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { ManagedMachineControllerError } from './controllerErrors';
import type { ManagedNativeBootstrapIO } from './enrollment';
import { deliverManagedNativeFile } from './nativeFileDelivery';

const execFileAsync = promisify(execFile);
// Native guest shell/filesystem IO is the system boundary. No internal delivery,
// schema, cancellation or assembly logic is mocked.
const localNative: ManagedNativeBootstrapIO = {
  exec: async ({ command, signal }) => {
    const result = await execFileAsync('/bin/sh', ['-c', command], { signal });
    return { status: 0, stdout: result.stdout, stderr: result.stderr };
  },
  putFile: async ({ path, bytes }) => { await writeFile(path, bytes, { mode: 0o600 }); },
};

describe.skipIf(process.platform === 'win32')('atomic managed native file delivery', () => {
  it('delivers identical raw bytes across fragment boundaries before publishing the destination', async () => {
    const root = await mkdtemp(join(tmpdir(), 'managed-file-identical-'));
    try {
      const localPath = join(root, 'source');
      const guestPath = join(root, "guest's raw file");
      const resource = { id: 'guest-世界' };
      const size = MACHINE_PROVISIONER_PUT_FILE_BASE64_MAX_LENGTH_V1 + 17;
      const file = await open(localPath, 'w');
      try {
        await file.truncate(size);
        await file.write(Buffer.from([0, 255, 128, 13, 10]), 0, 5, 0);
        await file.write(Buffer.from([255, 0, 254]), 0, 3, size - 3);
      } finally { await file.close(); }
      await writeFile(guestPath, 'previous complete file');
      let deliveredBytes = 0;
      let calls = 0;
      const progress: Array<{ transferredBytes: number; totalBytes: number }> = [];
      await deliverManagedNativeFile({ localPath, guestPath, resource, onProgress: value => {
        progress.push(value);
      } }, {
        ...localNative,
        putFile: async request => {
          calls++;
          deliveredBytes += request.bytes.byteLength;
          const metadata = Buffer.byteLength(JSON.stringify({ resource, guestPath: request.path, bytesBase64: '' }));
          expect(metadata + 4 * Math.ceil(request.bytes.byteLength / 3)).toBeLessThanOrEqual(MACHINE_PROVISIONER_PUT_FILE_BASE64_MAX_LENGTH_V1);
          expect(await readFile(guestPath, 'utf8')).toBe('previous complete file');
          await localNative.putFile(request);
        },
      });
      const digest = async (path: string) => {
        const hash = createHash('sha256');
        for await (const bytes of createReadStream(path)) hash.update(bytes);
        return hash.digest('hex');
      };
      expect(await digest(guestPath)).toBe(await digest(localPath));
      expect((await stat(guestPath)).size).toBe(size);
      expect(deliveredBytes).toBe(size);
      expect(calls).toBe(2);
      expect(progress[0]).toEqual({ transferredBytes: 0, totalBytes: size });
      expect(progress.at(-1)).toEqual({ transferredBytes: size, totalBytes: size });
      expect(progress).toHaveLength(calls + 1);
      expect(progress[1]!.transferredBytes).toBeGreaterThan(0);
      expect(progress[1]!.transferredBytes).toBeLessThan(size);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each(['cancel', 'refuse', 'unknown'] as const)('keeps the previous destination after a partial native %s, with no further effects', async failure => {
    const root = await mkdtemp(join(tmpdir(), 'managed-file-delivery-'));
    try {
      const localPath = join(root, 'source');
      const guestPath = join(root, "guest's archive");
      const file = await open(localPath, 'w');
      await file.truncate(MACHINE_PROVISIONER_PUT_FILE_BASE64_MAX_LENGTH_V1);
      await file.close();
      await writeFile(guestPath, 'previous complete delivery');
      const abort = new AbortController();
      let calls = 0;
      const refusal = new ManagedMachineControllerError(failure === 'refuse' ? 'credential_unavailable' : 'provider_unavailable');
      const delivered = deliverManagedNativeFile({ localPath, guestPath, resource: {}, signal: abort.signal }, {
        ...localNative,
        putFile: async request => {
          calls++;
          await localNative.putFile(request);
          if (failure === 'cancel' && calls === 1) return;
          if (failure === 'cancel') abort.abort();
          else throw refusal;
        },
      });
      if (failure === 'cancel') await expect(delivered).rejects.toMatchObject({ name: 'AbortError' });
      else await expect(delivered).rejects.toBe(refusal);
      expect(calls).toBe(failure === 'cancel' ? 2 : 1);
      expect(await readFile(guestPath, 'utf8')).toBe('previous complete delivery');
      if (failure === 'cancel') expect((await stat(`${guestPath}.partial`)).size).toBeGreaterThan(0);
      else expect((await stat(`${guestPath}.partial`)).size).toBe(0);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('atomically publishes an empty file without issuing a byte Action', async () => {
    const root = await mkdtemp(join(tmpdir(), 'managed-file-empty-'));
    try {
      const localPath = join(root, 'empty');
      const guestPath = join(root, 'guest');
      await writeFile(localPath, '');
      await writeFile(guestPath, 'previous complete file');
      await deliverManagedNativeFile({ localPath, guestPath, resource: {} }, {
        ...localNative, putFile: async () => { throw new Error('Empty files need no byte Action'); },
      });
      expect((await stat(guestPath)).size).toBe(0);
      expect((await stat(guestPath)).mode & 0o777).toBe(0o600);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
