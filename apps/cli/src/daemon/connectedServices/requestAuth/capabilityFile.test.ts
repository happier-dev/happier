import { constants } from 'node:fs';
import { chmod, lstat, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_MAX_SERIALIZED_UTF8_BYTES,
} from '@happier-dev/agents/request-auth';

import {
  digestConnectedAccountRequestAuthCapability,
  inspectConnectedAccountRequestAuthCapabilityFile,
  readConnectedAccountRequestAuthCapabilityFile,
  removeConnectedAccountRequestAuthCapabilityFile,
  verifyConnectedAccountRequestAuthCapabilityFile,
  writeConnectedAccountRequestAuthCapabilityFile,
} from './capabilityFile';
import type { ProtectedLocalStateOptions } from '@/utils/fs/protectedLocalState';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('daemon-owned connected-account request-auth capability file', () => {
  it('protects the Windows request-auth directory and empty temporary file before publishing capability bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-request-auth-windows-custody-'));
    roots.push(root);
    const capabilityPath = join(root, 'request-auth', 'capability.json');
    const events: string[] = [];
    const protectedLocalStateOptions: ProtectedLocalStateOptions = {
      platform: 'win32',
      windowsAclBoundary: {
        async applyAndVerify({ path, kind }) {
          if (kind === 'directory') {
            events.push(`directory-protected:${path}`);
            return;
          }
          expect(path).not.toBe(capabilityPath);
          await expect(readFile(path, 'utf8')).resolves.toBe('');
          events.push(`temporary-protected-empty:${path}`);
        },
        async verify({ path, kind }) {
          if (kind === 'directory') {
            events.push(`directory-verified:${path}`);
            return;
          }
          const contents = await readFile(path, 'utf8');
          expect(contents).toContain('"capability"');
          events.push(path === capabilityPath
            ? 'published-capability-verified'
            : `temporary-capability-verified:${path}`);
        },
      },
    };
    const descriptor = await writeConnectedAccountRequestAuthCapabilityFile({
      rootDir: root,
      materializationId: 'managed-run-windows-custody',
      subjectScopeDigest: 'a'.repeat(64),
      httpPort: 43_123,
      protectedLocalStateOptions,
    });

    expect(descriptor.path).toBe(capabilityPath);
    const temporaryProtected = events.findIndex((event) => event.startsWith('temporary-protected-empty:'));
    const temporaryVerified = events.findIndex((event) => event.startsWith('temporary-capability-verified:'));
    const publishedVerified = events.indexOf('published-capability-verified');
    expect(events.findIndex((event) => event.startsWith('directory-protected:'))).toBeGreaterThanOrEqual(0);
    expect(temporaryProtected).toBeGreaterThanOrEqual(0);
    expect(temporaryVerified).toBeGreaterThan(temporaryProtected);
    expect(publishedVerified).toBeGreaterThan(temporaryVerified);
  });

  it('fails closed when the Windows capability verifier cannot prove the protected ACL', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-request-auth-windows-verifier-'));
    roots.push(root);
    const descriptor = await writeConnectedAccountRequestAuthCapabilityFile({
      rootDir: root,
      materializationId: 'managed-run-windows-verifier',
      subjectScopeDigest: 'a'.repeat(64),
      httpPort: 43_123,
    });

    await expect(verifyConnectedAccountRequestAuthCapabilityFile({
      ...descriptor,
      materializedRootDir: root,
      protectedLocalStateOptions: {
        platform: 'win32',
        windowsAclBoundary: {
          async applyAndVerify() {
            throw new Error('not used by a verifier');
          },
          async verify() {
            throw new Error('inherited ACL');
          },
        },
      },
    })).resolves.toBeNull();
  });

  it('atomically writes and replaces one private opaque-scope capability', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-request-auth-'));
    roots.push(root);
    const first = await writeConnectedAccountRequestAuthCapabilityFile({
      rootDir: root,
      materializationId: 'managed-run-1',
      subjectScopeDigest: 'a'.repeat(64),
      httpPort: 43123,
    });
    const firstDocument = await readConnectedAccountRequestAuthCapabilityFile(first.path);
    const second = await writeConnectedAccountRequestAuthCapabilityFile({
      rootDir: root,
      materializationId: 'managed-run-1',
      subjectScopeDigest: 'a'.repeat(64),
      httpPort: 43123,
    });
    const secondDocument = await readConnectedAccountRequestAuthCapabilityFile(second.path);

    expect(second.path).toBe(join(root, 'request-auth', 'capability.json'));
    expect(secondDocument?.capability).not.toBe(firstDocument?.capability);
    expect(second.capabilityDigest).toBe(
      digestConnectedAccountRequestAuthCapability(secondDocument?.capability),
    );
    if (process.platform !== 'win32') {
      expect((await lstat(second.path)).mode & 0o777).toBe(0o600);
      expect((await lstat(join(root, 'request-auth'))).mode & 0o777).toBe(0o700);
    }
    expect(await verifyConnectedAccountRequestAuthCapabilityFile({
      ...second,
      materializedRootDir: root,
    })).toEqual(second);
    expect(await verifyConnectedAccountRequestAuthCapabilityFile({
      ...second,
      materializedRootDir: root,
      materializationId: 'other',
    })).toBeNull();
    expect(await readFile(second.path, 'utf8')).not.toContain(firstDocument?.capability ?? 'missing');
  });

  it.each([
    {
      label: 'materialization id whitespace',
      patch: { materializationId: ' managed-run-writer ' },
    },
    {
      label: 'subject scope digest whitespace',
      patch: { subjectScopeDigest: ` ${'a'.repeat(64)} ` },
    },
    {
      label: 'a 257-byte materialization id',
      patch: { materializationId: 'm'.repeat(257) },
    },
    {
      label: 'a Unicode materialization id above 256 UTF-8 bytes',
      patch: { materializationId: '😀'.repeat(65) },
    },
  ])('rejects $label instead of normalizing writer input', async ({ patch }) => {
    const root = await mkdtemp(join(tmpdir(), 'happier-request-auth-'));
    roots.push(root);

    await expect(writeConnectedAccountRequestAuthCapabilityFile({
      rootDir: root,
      materializationId: 'managed-run-writer',
      subjectScopeDigest: 'a'.repeat(64),
      httpPort: 43_123,
      ...patch,
    })).rejects.toThrow('connected_account_request_auth_capability_scope_invalid');
  });

  it('accepts a materialization id at the exact 256-byte UTF-8 boundary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-request-auth-'));
    roots.push(root);
    const materializationId = '😀'.repeat(64);

    await expect(writeConnectedAccountRequestAuthCapabilityFile({
      rootDir: root,
      materializationId,
      subjectScopeDigest: 'a'.repeat(64),
      httpPort: 43_123,
    })).resolves.toMatchObject({ materializationId });
  });

  it('accepts the exact maximum canonical escaped carrier', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-request-auth-'));
    roots.push(root);
    const materializationId = '\u0001'.repeat(256);
    const descriptor = await writeConnectedAccountRequestAuthCapabilityFile({
      rootDir: root,
      materializationId,
      subjectScopeDigest: 'a'.repeat(64),
      httpPort: 65_535,
    });

    expect((await readFile(descriptor.path)).byteLength)
      .toBe(CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_MAX_SERIALIZED_UTF8_BYTES);
    await expect(verifyConnectedAccountRequestAuthCapabilityFile({
      ...descriptor,
      materializedRootDir: root,
    })).resolves.toEqual(descriptor);
  });

  it('rejects noncanonical expected descriptor fields during exact verification', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-request-auth-'));
    roots.push(root);
    const descriptor = await writeConnectedAccountRequestAuthCapabilityFile({
      rootDir: root,
      materializationId: 'managed-run-verifier',
      subjectScopeDigest: 'a'.repeat(64),
      httpPort: 43_123,
    });

    for (const patch of [
      { materializationId: ' managed-run-verifier ' },
      { subjectScopeDigest: ` ${'a'.repeat(64)} ` },
      { capabilityDigest: ` ${descriptor.capabilityDigest} ` },
    ]) {
      await expect(verifyConnectedAccountRequestAuthCapabilityFile({
        ...descriptor,
        materializedRootDir: root,
        ...patch,
      })).resolves.toBeNull();
    }
  });

  it('rejects symlinks and unsafe permissions at the daemon verification boundary', async () => {
    if (typeof constants.O_NOFOLLOW !== 'number' || process.platform === 'win32') return;
    const root = await mkdtemp(join(tmpdir(), 'happier-request-auth-'));
    roots.push(root);
    const descriptor = await writeConnectedAccountRequestAuthCapabilityFile({
      rootDir: root,
      materializationId: 'managed-run-1',
      subjectScopeDigest: 'b'.repeat(64),
      httpPort: 43123,
    });
    await chmod(descriptor.path, 0o644);

    expect(await verifyConnectedAccountRequestAuthCapabilityFile({
      ...descriptor,
      materializedRootDir: root,
    })).toBeNull();
    expect(await inspectConnectedAccountRequestAuthCapabilityFile({
      path: descriptor.path,
      materializedRootDir: root,
    })).toBeNull();
  });

  it('rejects broad or foreign-owned materialization and capability directories', async () => {
    if (process.platform === 'win32') return;
    const root = await mkdtemp(join(tmpdir(), 'happier-request-auth-'));
    roots.push(root);
    const descriptor = await writeConnectedAccountRequestAuthCapabilityFile({
      rootDir: root,
      materializationId: 'managed-run-directory-security',
      subjectScopeDigest: 'f'.repeat(64),
      httpPort: 43123,
    });

    await chmod(root, 0o777);
    expect(await inspectConnectedAccountRequestAuthCapabilityFile({
      path: descriptor.path,
      materializedRootDir: root,
    })).toBeNull();
    await chmod(root, 0o700);
    await chmod(join(root, 'request-auth'), 0o777);
    expect(await inspectConnectedAccountRequestAuthCapabilityFile({
      path: descriptor.path,
      materializedRootDir: root,
    })).toBeNull();
    await chmod(join(root, 'request-auth'), 0o700);

    if (typeof process.getuid === 'function') {
      const actualUid = process.getuid();
      const originalGetuid = process.getuid;
      Object.defineProperty(process, 'getuid', {
        configurable: true,
        value: () => actualUid + 1,
      });
      try {
        expect(await inspectConnectedAccountRequestAuthCapabilityFile({
          path: descriptor.path,
          materializedRootDir: root,
        })).toBeNull();
      } finally {
        Object.defineProperty(process, 'getuid', {
          configurable: true,
          value: originalGetuid,
        });
      }
    }
  });

  it('inspects only non-secret recovery facts through the strict private-file verifier', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-request-auth-'));
    roots.push(root);
    const descriptor = await writeConnectedAccountRequestAuthCapabilityFile({
      rootDir: root,
      materializationId: 'managed-run-recovery',
      subjectScopeDigest: 'e'.repeat(64),
      httpPort: 43123,
    });

    const facts = await inspectConnectedAccountRequestAuthCapabilityFile({
      path: descriptor.path,
      materializedRootDir: root,
    });

    expect(facts).toEqual({
      path: descriptor.path,
      materializationId: 'managed-run-recovery',
      subjectScopeDigest: 'e'.repeat(64),
    });
    expect(facts).not.toHaveProperty('capability');
    expect(facts).not.toHaveProperty('capabilityDigest');
  });

  it('rejects a legacy V1 document before recovery facts can activate authority', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-request-auth-'));
    roots.push(root);
    const descriptor = await writeConnectedAccountRequestAuthCapabilityFile({
      rootDir: root,
      materializationId: 'managed-run-legacy-v1',
      subjectScopeDigest: 'e'.repeat(64),
      httpPort: 43_123,
    });
    await writeFile(descriptor.path, JSON.stringify({
      v: 1,
      materializationId: 'managed-run-legacy-v1',
      subjectScopeDigest: 'e'.repeat(64),
      capability: 'A'.repeat(43),
    }), { mode: 0o600 });

    await expect(
      readConnectedAccountRequestAuthCapabilityFile(descriptor.path),
    ).resolves.toBeNull();
    await expect(inspectConnectedAccountRequestAuthCapabilityFile({
      path: descriptor.path,
      materializedRootDir: root,
    })).resolves.toBeNull();
  });

  it.each([
    {
      label: 'materialization id whitespace',
      patch: { materializationId: ' managed-run-invalid-v2 ' },
    },
    {
      label: 'subject scope digest whitespace',
      patch: { subjectScopeDigest: ` ${'e'.repeat(64)} ` },
    },
    {
      label: 'capability whitespace',
      patch: { capability: ` ${'A'.repeat(43)} ` },
    },
    {
      label: 'a 257-byte materialization id',
      patch: { materializationId: 'm'.repeat(257) },
    },
  ])('rejects $label before recovery can rotate authority', async ({ patch }) => {
    const root = await mkdtemp(join(tmpdir(), 'happier-request-auth-'));
    roots.push(root);
    const descriptor = await writeConnectedAccountRequestAuthCapabilityFile({
      rootDir: root,
      materializationId: 'managed-run-invalid-v2',
      subjectScopeDigest: 'e'.repeat(64),
      httpPort: 43_123,
    });
    await writeFile(descriptor.path, JSON.stringify({
      v: 2,
      materializationId: 'managed-run-invalid-v2',
      subjectScopeDigest: 'e'.repeat(64),
      capability: 'A'.repeat(43),
      httpPort: 43_123,
      ...patch,
    }), { mode: 0o600 });

    await expect(
      readConnectedAccountRequestAuthCapabilityFile(descriptor.path),
    ).resolves.toBeNull();
    await expect(inspectConnectedAccountRequestAuthCapabilityFile({
      path: descriptor.path,
      materializedRootDir: root,
    })).resolves.toBeNull();
  });

  it('rejects an oversized capability carrier instead of parsing padded bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-request-auth-'));
    roots.push(root);
    const descriptor = await writeConnectedAccountRequestAuthCapabilityFile({
      rootDir: root,
      materializationId: 'managed-run-oversized-carrier',
      subjectScopeDigest: 'e'.repeat(64),
      httpPort: 43_123,
    });
    // Schema-valid five-field document padded to far beyond the canonical single-line
    // carrier bound the writer emits; the host must refuse the carrier, not parse it.
    const paddedDocument = `${JSON.stringify({
      v: 2,
      materializationId: 'managed-run-oversized-carrier',
      subjectScopeDigest: 'e'.repeat(64),
      capability: 'A'.repeat(43),
      httpPort: 43_123,
    })}${' '.repeat(8 * 1024)}`;
    await writeFile(descriptor.path, paddedDocument, { mode: 0o600 });

    await expect(
      inspectConnectedAccountRequestAuthCapabilityFile({
        path: descriptor.path,
        materializedRootDir: root,
      }),
    ).resolves.toBeNull();
    await expect(verifyConnectedAccountRequestAuthCapabilityFile({
      ...descriptor,
      materializedRootDir: root,
    })).resolves.toBeNull();
  });

  it('rejects an existing capability-parent symlink without writing outside the materialized root', async () => {
    if (process.platform === 'win32') return;
    const root = await mkdtemp(join(tmpdir(), 'happier-request-auth-'));
    const outside = await mkdtemp(join(tmpdir(), 'happier-request-auth-outside-'));
    roots.push(root, outside);
    await symlink(outside, join(root, 'request-auth'), 'dir');

    await expect(writeConnectedAccountRequestAuthCapabilityFile({
      rootDir: root,
      materializationId: 'managed-run-1',
      subjectScopeDigest: 'd'.repeat(64),
      httpPort: 43123,
    })).rejects.toThrow();
    // No capability byte — canonical or temporary — may land in the symlink target.
    await expect(readdir(outside)).resolves.toEqual([]);
    // The writer must refuse rather than replace the hostile parent.
    expect((await lstat(join(root, 'request-auth'))).isSymbolicLink()).toBe(true);
    // Control: the identical write against a real parent succeeds, so the refusal above is
    // attributable to the symlink and not to the fixture or an unrelated failure.
    const control = await mkdtemp(join(tmpdir(), 'happier-request-auth-control-'));
    roots.push(control);
    await expect(writeConnectedAccountRequestAuthCapabilityFile({
      rootDir: control,
      materializationId: 'managed-run-1',
      subjectScopeDigest: 'd'.repeat(64),
      httpPort: 43123,
    })).resolves.toMatchObject({ materializationId: 'managed-run-1' });
  });

  it('removes capability files idempotently', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-request-auth-'));
    roots.push(root);
    const descriptor = await writeConnectedAccountRequestAuthCapabilityFile({
      rootDir: root,
      materializationId: 'managed-run-1',
      subjectScopeDigest: 'c'.repeat(64),
      httpPort: 43123,
    });

    await removeConnectedAccountRequestAuthCapabilityFile(descriptor.path);
    await removeConnectedAccountRequestAuthCapabilityFile(descriptor.path);
    expect(await readConnectedAccountRequestAuthCapabilityFile(descriptor.path)).toBeNull();
  });
});
