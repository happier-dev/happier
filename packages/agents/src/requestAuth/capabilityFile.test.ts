import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_VERSION,
} from '@happier-dev/protocol/connect/connected-account-request-auth';

import {
  readConnectedAccountRequestAuthCapabilityFile,
  resolveConnectedAccountRequestAuthCapabilityPath,
} from './capabilityFile.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('connected-account request-auth child capability document', () => {
  it('resolves and strictly reads the daemon-owned private document', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-request-auth-reader-'));
    roots.push(root);
    const path = resolveConnectedAccountRequestAuthCapabilityPath(root);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({
      v: CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_VERSION,
      materializationId: 'managed-run-1',
      subjectScopeDigest: 'a'.repeat(64),
      capability: 'A'.repeat(43),
      httpPort: 43123,
    }), 'utf8');

    expect(await readConnectedAccountRequestAuthCapabilityFile(path)).toEqual({
      v: 2,
      materializationId: 'managed-run-1',
      subjectScopeDigest: 'a'.repeat(64),
      capability: 'A'.repeat(43),
      httpPort: 43123,
    });

    const exactUtf8BoundaryMaterializationId = '😀'.repeat(64);
    await writeFile(path, JSON.stringify({
      v: 2,
      materializationId: exactUtf8BoundaryMaterializationId,
      subjectScopeDigest: 'a'.repeat(64),
      capability: 'A'.repeat(43),
      httpPort: 43123,
    }), 'utf8');
    expect((await readConnectedAccountRequestAuthCapabilityFile(path))?.materializationId)
      .toBe(exactUtf8BoundaryMaterializationId);

    await writeFile(path, JSON.stringify({
      v: 2,
      materializationId: 'managed-run-1',
      subjectScopeDigest: 'a'.repeat(64),
      capability: 'A'.repeat(43),
      httpPort: 43123,
      unexpected: true,
    }), 'utf8');
    expect(await readConnectedAccountRequestAuthCapabilityFile(path)).toBeNull();

    await writeFile(path, JSON.stringify({
      v: 1,
      materializationId: 'managed-run-1',
      subjectScopeDigest: 'a'.repeat(64),
      capability: 'A'.repeat(43),
    }), 'utf8');
    expect(await readConnectedAccountRequestAuthCapabilityFile(path)).toBeNull();
  });

  it.each([
    {
      label: 'materialization id whitespace',
      patch: { materializationId: ' managed-run-1 ' },
    },
    {
      label: 'subject scope digest whitespace',
      patch: { subjectScopeDigest: ` ${'a'.repeat(64)} ` },
    },
    {
      label: 'capability whitespace',
      patch: { capability: ` ${'A'.repeat(43)} ` },
    },
    {
      label: 'a 257-byte materialization id',
      patch: { materializationId: 'm'.repeat(257) },
    },
    {
      label: 'a Unicode materialization id above 256 UTF-8 bytes',
      patch: { materializationId: '😀'.repeat(65) },
    },
  ])('rejects $label instead of normalizing the private document', async ({ patch }) => {
    const root = await mkdtemp(join(tmpdir(), 'happier-request-auth-reader-'));
    roots.push(root);
    const path = resolveConnectedAccountRequestAuthCapabilityPath(root);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({
      v: 2,
      materializationId: 'managed-run-1',
      subjectScopeDigest: 'a'.repeat(64),
      capability: 'A'.repeat(43),
      httpPort: 43123,
      ...patch,
    }), 'utf8');

    expect(await readConnectedAccountRequestAuthCapabilityFile(path)).toBeNull();
  });
});
