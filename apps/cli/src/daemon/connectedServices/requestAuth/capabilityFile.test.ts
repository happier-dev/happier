import { constants } from 'node:fs';
import { chmod, lstat, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  digestConnectedAccountRequestAuthCapability,
  inspectConnectedAccountRequestAuthCapabilityFile,
  readConnectedAccountRequestAuthCapabilityFile,
  removeConnectedAccountRequestAuthCapabilityFile,
  verifyConnectedAccountRequestAuthCapabilityFile,
  writeConnectedAccountRequestAuthCapabilityFile,
} from './capabilityFile';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('daemon-owned connected-account request-auth capability file', () => {
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
    })).rejects.toThrow('private_bearer_parent_unsafe');
    await expect(readFile(join(outside, 'capability.json'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
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
