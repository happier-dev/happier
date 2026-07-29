import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createNpmRegistryProfileStore } from './store';

describe('npm registry profile store', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
  });

  async function makeStore() {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-npm-registry-profiles-'));
    roots.push(happyHomeDir);
    return { happyHomeDir, store: createNpmRegistryProfileStore({ happyHomeDir }) };
  }

  it('serializes revisioned idempotent mutations and survives restart', async () => {
    const { happyHomeDir, store } = await makeStore();
    const first = await store.mutate({
      expectedRevision: 0,
      mutationId: 'mutation-add-acme',
      fingerprint: 'add-acme-v1',
      apply: (current) => ({
        ...current,
        profiles: [{
          profileId: 'registry_acme', displayName: 'Acme', origin: 'https://registry.acme.test',
          scopes: ['@acme'], useAsDefault: false, allowPrivateNetwork: true,
          credentialSecretRef: null, credentialRevision: 0, availability: 'unknown',
          lastSuccessfulCheckAtMs: null, updatedAtMs: 10,
        }],
      }),
    });
    expect(first.revision).toBe(1);

    await expect(store.mutate({
      expectedRevision: 0,
      mutationId: 'mutation-add-acme',
      fingerprint: 'add-acme-v1',
      apply: () => { throw new Error('must not reapply'); },
    })).resolves.toMatchObject({ revision: 1, profiles: [{ profileId: 'registry_acme' }] });

    await expect(store.mutate({
      expectedRevision: 0,
      mutationId: 'mutation-stale',
      fingerprint: 'stale',
      apply: (value) => value,
    })).rejects.toMatchObject({ code: 'revision_conflict', currentRevision: 1 });

    await expect(createNpmRegistryProfileStore({ happyHomeDir }).read()).resolves.toMatchObject({
      revision: 1,
      profiles: [{ profileId: 'registry_acme', credentialSecretRef: null }],
    });
  });

  it('never persists credential material and bounds mutation receipts', async () => {
    const { happyHomeDir, store } = await makeStore();
    let revision = 0;
    for (let index = 0; index < 140; index += 1) {
      const next = await store.mutate({
        expectedRevision: revision,
        mutationId: `mutation-${String(index).padStart(4, '0')}`,
        fingerprint: `fingerprint-${index}`,
        apply: (value) => value,
      });
      revision = next.revision;
    }
    const raw = await readFile(join(happyHomeDir, 'plugins', 'plugins', 'state', 'npm-registry-profiles.v1.json'), 'utf8');
    expect(raw).not.toContain('boundary-secret');
    expect((JSON.parse(raw) as { mutations: unknown[] }).mutations.length).toBeLessThanOrEqual(128);
  });

  it('rejects a reused mutation id with different intent', async () => {
    const { store } = await makeStore();
    await store.mutate({ expectedRevision: 0, mutationId: 'mutation-same-id', fingerprint: 'one', apply: (value) => value });
    await expect(store.mutate({
      expectedRevision: 1,
      mutationId: 'mutation-same-id',
      fingerprint: 'two',
      apply: (value) => value,
    })).rejects.toMatchObject({ code: 'mutation_conflict' });
  });
});
