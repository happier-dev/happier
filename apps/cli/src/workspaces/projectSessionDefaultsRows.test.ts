import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as projectRows from './projectAccountRows';
import { mockProjectAccountRowsHttpBoundary } from './projectAccountRows.testkit';

afterEach(() => { vi.restoreAllMocks(); projectRows.withdrawActiveProjectAccountRowsSnapshot(); });

const credentials = { token: 'project-defaults-token', encryption: null };
const address = { serverId: 'home-a', projectKey: 'project-a' };
const key = { kind: 'project-session-defaults' as const, ...address };
const defaults = { placement: { kind: 'machine' as const, target: { serverId: 'home-a', machineId: 'machine-a' } } };

describe('personal Project Session defaults row owner', () => {
  it('reads only the selected row and keeps absent, deleted and present revisions distinct', async () => {
    const rows: unknown[] = Array.from({ length: 1024 }, (_, index) => {
      const otherKey = { ...key, projectKey: `other-${index}` };
      return { key: otherKey, revision: 0, content: { t: 'plain', v: { key: otherKey, value: defaults } } };
    });
    const post = mockProjectAccountRowsHttpBoundary(rows);
    const input = { credentials, ...address };
    expect(await projectRows.readProjectSessionDefaults(input)).toBeNull();
    rows.push({ key, revision: 2, content: null });
    expect(await projectRows.readProjectSessionDefaults(input)).toEqual({ revision: 2, defaults: null });
    rows[rows.length - 1] = { key, revision: 3, content: { t: 'plain', v: { key, value: defaults } } };
    expect(await projectRows.readProjectSessionDefaults(input)).toEqual({ revision: 3, defaults });
    expect(post.mock.calls.map(([url, body]) => [url.split('/').at(-1), body]))
      .toEqual(Array.from({ length: 3 }, () => ['read', { key }]));
    expect(projectRows.getActiveProjectAccountRowsSnapshot()).toBeNull();
  });

  it('writes with explicit CAS without reading, preserves conflicts and revives a retained tombstone', async () => {
    const rows: unknown[] = [];
    const post = mockProjectAccountRowsHttpBoundary(rows);
    const input = { credentials, ...address };
    expect(await projectRows.mutateProjectSessionDefaults({ ...input, expectedRevision: 'absent', defaults }))
      .toEqual({ status: 'updated', revision: 0, value: defaults });
    expect(await projectRows.mutateProjectSessionDefaults({ ...input, expectedRevision: 'absent', defaults: null }))
      .toEqual({ status: 'conflict', revision: 0 });
    expect(await projectRows.mutateProjectSessionDefaults({ ...input, expectedRevision: 0, defaults: null }))
      .toEqual({ status: 'updated', revision: 1, value: null });
    expect(rows).toEqual([{ key, revision: 1, content: null }]);
    expect(await projectRows.mutateProjectSessionDefaults({ ...input, expectedRevision: 1, defaults }))
      .toEqual({ status: 'updated', revision: 2, value: defaults });
    expect(post.mock.calls.map(([url]) => url.split('/').at(-1))).toEqual(['mutate', 'mutate', 'mutate', 'mutate']);
    expect(projectRows.getActiveProjectAccountRowsSnapshot()).toBeNull();
  });

  it('uses the existing Account-mode cipher for encrypted defaults and refuses a plain envelope', async () => {
    const secret = new Uint8Array(32).fill(9);
    const encryptedCredentials = { token: 'encrypted-project-defaults-token', encryption: { type: 'legacy' as const, secret } };
    const rows: unknown[] = [];
    mockProjectAccountRowsHttpBoundary(rows);
    vi.mocked(axios.get).mockResolvedValue({ status: 200, data: { mode: 'e2ee', updatedAt: 0 } });
    const input = { credentials: encryptedCredentials, ...address };
    expect(await projectRows.mutateProjectSessionDefaults({ ...input, expectedRevision: 'absent', defaults }))
      .toEqual({ status: 'updated', revision: 0, value: defaults });
    const encryptedRow = rows[0];
    expect(encryptedRow).toMatchObject({ key, content: { t: 'encrypted' } });
    expect(JSON.stringify(encryptedRow)).not.toContain('machine-a');
    expect(await projectRows.readProjectSessionDefaults(input)).toEqual({ revision: 0, defaults });
    rows[0] = { key, revision: 1, content: { t: 'plain', v: { key, value: defaults } } };
    await expect(projectRows.readProjectSessionDefaults(input)).rejects.toMatchObject({ code: 'project_account_mode_mismatch' });
  });

  it('does not write after the captured Account authority retires', async () => {
    const post = mockProjectAccountRowsHttpBoundary([]);
    let current = true;
    vi.mocked(axios.get).mockImplementation(async () => {
      current = false;
      return { status: 200, data: { mode: 'plain', updatedAt: 0 } };
    });
    const assertCurrentAuthority = async () => {
      if (!current) throw Object.assign(new Error('Retired Account'), { code: 'project_requester_authority_unavailable' });
    };
    await expect(projectRows.mutateProjectSessionDefaults({ credentials, ...address, expectedRevision: 'absent', defaults, assertCurrentAuthority }))
      .rejects.toMatchObject({ code: 'project_requester_authority_unavailable' });
    expect(post).not.toHaveBeenCalled();
  });

  it('does not reopen the Project census or publish it for an undemanded defaults change hint', async () => {
    const post = mockProjectAccountRowsHttpBoundary([]);
    const installed = { credentials, serverId: address.serverId, publication: 'installed' as const };
    const accepted = await projectRows.readProjectAccountRows(installed);
    post.mockClear();
    const publications: unknown[] = [];
    const release = projectRows.subscribeActiveProjectAccountRowsSnapshot((_previous, next) => publications.push(next));
    try {
      await projectRows.readProjectAccountRows({ ...installed, changedKeys: [key] });
      expect(post).not.toHaveBeenCalled();
      expect(publications).toEqual([]);
      expect(projectRows.getActiveProjectAccountRowsSnapshot()).toBe(accepted);
    } finally { release(); }
  });
});
