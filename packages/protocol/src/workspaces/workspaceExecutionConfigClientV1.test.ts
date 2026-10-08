import { describe, expect, it } from 'vitest';
import { createWorkspaceExecutionConfigClientV1, openWorkspaceExecutionConfigContentV1, sealWorkspaceExecutionConfigContentV1 } from './workspaceExecutionConfigClientV1.js';
import type { WorkspaceExecutionSettingsV1 } from './projectWorkerPreferencesV1.js';

const workspace = { serverId: 'home-a', refId: 'checkout-a' };
const preference = { enabled: false as const, unavailable: 'ask' as const, allowAdHoc: false, scriptOverrides: {} };

describe('workspace execution config client', () => {
  it('rebases the first finite edit over a service-only row without inventing finite policy provenance', async () => {
    const placement = { runsOn: { kind: 'workers' as const, destination: { kind: 'machine' as const, machineId: 'a' } }, unavailable: 'fail' as const };
    let value: WorkspaceExecutionSettingsV1 | null = null;
    let revision = 0;
    const client = createWorkspaceExecutionConfigClientV1({
      mode: 'plain', material: null, randomBytes: (length) => new Uint8Array(length), isCurrent: () => true,
      transport: {
        read: async () => value === null ? { status: 'absent' } : { status: 'present', revision, content: { t: 'plain', v: value } },
        mutate: async ({ content }) => { if (content?.t === 'plain') value = content.v; return { status: 'updated', revision: ++revision, cursor: revision }; },
      },
    });
    expect(await client.setService({ workspace, serviceName: 'web', expectedRevision: 'absent', expected: { kind: 'absent' }, value: placement }))
      .toMatchObject({ status: 'applied' });
    const observedFinite = await client.get({ workspace });
    const next = { ...preference, allowAdHoc: true };
    expect(await client.set({ workspace, expectedRevision: 'absent', expected: { kind: 'absent' }, next })).toMatchObject({ status: 'applied', preference: next });
    expect(observedFinite).toMatchObject({ status: 'ready', provenance: 'default', preference });
    expect(value).toMatchObject({ allowAdHoc: true, services: { web: placement } });
  });
  it('rebases only after a definite CAS conflict and keeps an unresolved acknowledgement unknown', async () => {
    const placement = { runsOn: { kind: 'primary' as const }, unavailable: 'primary' as const };
    let value: WorkspaceExecutionSettingsV1 = { ...preference, services: {} };
    let writes = 0;
    let revision = 1;
    const client = createWorkspaceExecutionConfigClientV1({
      mode: 'plain', material: null, randomBytes: (length) => new Uint8Array(length), isCurrent: () => true,
      transport: {
        read: async () => ({ status: 'present', revision, content: { t: 'plain', v: value } }),
        mutate: async ({ content }) => {
          writes += 1;
          if (writes === 1) { value = { ...value, allowAdHoc: true }; revision = 2; return { status: 'conflict', revision }; }
          if (content?.t === 'plain') value = content.v;
          return { status: 'updated', revision: ++revision, cursor: revision };
        },
      },
    });
    expect(await client.setService({ workspace, serviceName: 'web', expectedRevision: 1, expected: { kind: 'absent' }, value: placement }))
      .toMatchObject({ status: 'applied', revision: 3 });
    expect(value).toMatchObject({ allowAdHoc: true, services: { web: placement } });
    expect(writes).toBe(2);
    let unknownWrites = 0;
    const unknown = createWorkspaceExecutionConfigClientV1({
      mode: 'plain', material: null, randomBytes: (length) => new Uint8Array(length), isCurrent: () => true,
      transport: { read: async () => ({ status: 'absent' }), mutate: async () => { unknownWrites += 1; throw new Error('connection lost'); } },
    });
    expect(await unknown.setService({ workspace, serviceName: 'web', expectedRevision: 'absent', expected: { kind: 'absent' }, value: placement }))
      .toEqual({ status: 'outcomeUnknown' });
    expect(unknownWrites).toBe(1);
  });
  it('rebases one service entry over finite and other service edits and refuses a same-entry edit', async () => {
    const placement = { runsOn: { kind: 'workers' as const, destination: { kind: 'machine' as const, machineId: 'worker-a' } }, unavailable: 'fail' as const };
    let value: WorkspaceExecutionSettingsV1 = { ...preference, allowAdHoc: true, services: { api: { runsOn: { kind: 'primary' as const }, unavailable: 'primary' as const } } };
    let revision = 2;
    let writes = 0;
    const client = createWorkspaceExecutionConfigClientV1({
      mode: 'plain', material: null, randomBytes: (length) => new Uint8Array(length), isCurrent: () => true,
      transport: {
        read: async () => ({ status: 'present', revision, content: { t: 'plain', v: value } }),
        mutate: async ({ content, expectedRevision }) => {
          expect(expectedRevision).toBe(revision);
          writes += 1;
          if (content?.t === 'plain') value = content.v;
          return { status: 'updated', revision: ++revision, cursor: revision };
        },
      },
    });
    expect(await client.getService({ workspace, serviceName: 'web' })).toEqual({ status: 'ready', placement: { runsOn: { kind: 'primary' }, unavailable: 'fail' }, revision: 2, provenance: 'default' });
    expect(await client.setService({ workspace, serviceName: 'web', expectedRevision: 1, expected: { kind: 'absent' }, value: placement })).toMatchObject({ status: 'applied', placement, revision: 3 });
    expect(value).toMatchObject({ allowAdHoc: true, services: { api: { unavailable: 'primary' }, web: placement } });
    expect(await client.setService({ workspace, serviceName: 'web', expectedRevision: 1, expected: { kind: 'absent' }, value: { runsOn: { kind: 'primary' }, unavailable: 'fail' } })).toMatchObject({ status: 'conflict', placement });
    expect(writes).toBe(1);
  });

  it('observes a service save with an unknown acknowledgement without replay and never defaults invalid settings', async () => {
    const placement = { runsOn: { kind: 'workers' as const, destination: { kind: 'machine' as const, machineId: 'worker-a' } }, unavailable: 'fail' as const };
    let row: unknown = { ...preference, services: {} };
    let writes = 0;
    const client = createWorkspaceExecutionConfigClientV1({
      mode: 'plain', material: null, randomBytes: (length) => new Uint8Array(length), isCurrent: () => true,
      transport: {
        read: async () => ({ status: 'present', revision: writes + 1, content: { t: 'plain', v: row } }),
        mutate: async ({ content }) => { writes += 1; row = content?.t === 'plain' ? content.v : null; return { malformed: true }; },
      },
    });
    expect(await client.setService({ workspace, serviceName: 'web', expectedRevision: 1, expected: { kind: 'absent' }, value: placement })).toMatchObject({ status: 'satisfied', placement, revision: 2 });
    expect(writes).toBe(1);
    row = { ...preference, services: { web: { runsOn: { kind: 'workers' }, unavailable: 'fail' } } };
    expect(await client.getService({ workspace, serviceName: 'web' })).toEqual({ status: 'invalid' });
  });

  it('keeps plain Accounts keyless and binds encrypted content to the exact physical row', () => {
    const value: WorkspaceExecutionSettingsV1 = { ...preference, allowAdHoc: true, scriptOverrides: { build: 'workers' }, services: {
      web: { runsOn: { kind: 'workers', destination: { kind: 'machine', machineId: 'worker-a' } }, unavailable: 'fail' },
      api: { runsOn: { kind: 'primary' }, unavailable: 'primary' },
    } };
    const rowId = 'a'.repeat(64);
    const material = { type: 'legacy' as const, secret: new Uint8Array(32).fill(7) };
    const content = sealWorkspaceExecutionConfigContentV1({ rowId, mode: 'e2ee', material, value, randomBytes: (length) => new Uint8Array(length).fill(9) });
    expect(openWorkspaceExecutionConfigContentV1({ rowId, mode: 'e2ee', material, content })).toEqual(value);
    expect(() => openWorkspaceExecutionConfigContentV1({ rowId: 'b'.repeat(64), mode: 'e2ee', material, content })).toThrow('workspace_execution_config_invalid');
    expect(() => openWorkspaceExecutionConfigContentV1({ rowId, mode: 'plain', material: null, content })).toThrow('workspace_execution_config_invalid');
    expect(() => openWorkspaceExecutionConfigContentV1({ rowId, mode: 'e2ee', material: null, content })).toThrow('workspace_execution_config_locked');
    expect(sealWorkspaceExecutionConfigContentV1({ rowId, mode: 'plain', material: null, value, randomBytes: () => { throw new Error('plain must be keyless'); } })).toEqual({ t: 'plain', v: value });
    const opened = openWorkspaceExecutionConfigContentV1({ rowId, mode: 'e2ee', material, content });
    const plain = sealWorkspaceExecutionConfigContentV1({ rowId, mode: 'plain', material: null, value: opened, randomBytes: () => { throw new Error('plain must be keyless'); } });
    expect(openWorkspaceExecutionConfigContentV1({ rowId, mode: 'plain', material: null, content: plain })).toEqual(value);
  });
  it('projects additive stored service fields at the read boundary and preserves exact service names', async () => {
    const placement = { runsOn: { kind: 'workers', destination: { kind: 'machine', machineId: 'a', additive: true }, additive: true }, unavailable: 'fail', additive: true };
    const client = createWorkspaceExecutionConfigClientV1({
      mode: 'plain', material: null, randomBytes: (length) => new Uint8Array(length), isCurrent: () => true,
      transport: { read: async () => ({ status: 'present', revision: 1, content: { t: 'plain', v: {
        ...preference, additive: true, services: { ' web ': placement, web: { runsOn: { kind: 'primary' }, unavailable: 'primary' } },
      } } }), mutate: async () => { throw new Error('read must not write'); } },
    });
    expect(await client.getService({ workspace, serviceName: ' web ' })).toMatchObject({ status: 'ready', placement: {
      runsOn: { kind: 'workers', destination: { kind: 'machine', machineId: 'a' } }, unavailable: 'fail',
    }, provenance: 'saved' });
    expect(await client.getService({ workspace, serviceName: 'web' })).toMatchObject({ status: 'ready', placement: { runsOn: { kind: 'primary' }, unavailable: 'primary' } });
  });
  it('defaults only a successful absent read and refuses unavailable or wrong-mode content', async () => {
    const client = createWorkspaceExecutionConfigClientV1({
      mode: 'plain', material: null, randomBytes: (length) => new Uint8Array(length), isCurrent: () => true,
      transport: { read: async () => ({ status: 'absent' }), mutate: async () => { throw new Error('unexpected mutation'); } },
    });
    expect(await client.get({ workspace })).toMatchObject({ status: 'ready', provenance: 'default', preference });
    const unavailable = createWorkspaceExecutionConfigClientV1({
      mode: 'plain', material: null, randomBytes: (length) => new Uint8Array(length), isCurrent: () => true,
      transport: { read: async () => { throw new Error('Home unavailable'); }, mutate: async () => { throw new Error('unexpected mutation'); } },
    });
    expect(await unavailable.get({ workspace })).toMatchObject({ status: 'unavailable' });
  });

  it('observes an uncertain acknowledged write without replaying it', async () => {
    let mutations = 0;
    let value = { ...preference, services: {} };
    const next = { ...preference, allowAdHoc: true, destination: { kind: 'machine' as const, machineId: '  worker-a  ' }, scriptOverrides: { '  build  ': 'workers' as const } };
    const client = createWorkspaceExecutionConfigClientV1({
      mode: 'plain', material: null, randomBytes: (length) => new Uint8Array(length), isCurrent: () => true,
      transport: {
        read: async () => ({ status: 'present', revision: mutations ? 2 : 1, content: { t: 'plain', v: value } }),
        mutate: async ({ content }) => {
          mutations += 1;
          if (content?.t === 'plain') value = content.v;
          throw new Error('acknowledgement lost');
        },
      },
    });
    expect(await client.set({ workspace, expectedRevision: 1, expected: { kind: 'value', value: preference }, next }))
      .toMatchObject({ status: 'satisfied', revision: 2, preference: { ...next, destination: { kind: 'machine', machineId: 'worker-a' }, scriptOverrides: { '  build  ': 'workers' } } });
    expect(mutations).toBe(1);
  });

  it.each(['acknowledged', 'lost'] as const)('keeps an issued save disposition distinct from unissued cancellation (%s)', async outcome => {
    let current = true;
    let reads = 0;
    let writes = 0;
    const next = { ...preference, allowAdHoc: true };
    const client = createWorkspaceExecutionConfigClientV1({
      mode: 'plain', material: null, randomBytes: length => new Uint8Array(length), isCurrent: () => current,
      // Only the captured Home transport/lifetime is substituted. The semantic
      // CAS and acknowledgement parser remain real, with no projection store.
      transport: {
        read: async () => { reads += 1; return { status: 'absent' }; },
        mutate: async ({ content }) => {
          writes += 1;
          expect(content).toEqual({ t: 'plain', v: { ...next, services: {} } });
          current = false;
          if (outcome === 'lost') throw new Error('accepted save acknowledgement lost');
          return { status: 'updated', revision: 1, cursor: 1 };
        },
      },
    });
    const result = await client.set({ workspace, expectedRevision: 'absent', expected: { kind: 'absent' }, next });
    expect(result).toEqual(outcome === 'acknowledged'
      ? { status: 'applied', preference: next, revision: 1, provenance: 'saved' }
      : { status: 'outcomeUnknown' });
    expect(writes).toBe(1);
    expect(reads).toBe(1);
    expect(await client.get({ workspace })).toEqual({ status: 'unavailable' });
    expect(reads).toBe(1);
  });

  it('does not disclose or mutate a row returned after the captured Home lifetime retires', async () => {
    let current = true;
    let mutations = 0;
    const client = createWorkspaceExecutionConfigClientV1({
      mode: 'plain', material: null, randomBytes: (length) => new Uint8Array(length), isCurrent: () => current,
      transport: {
        read: async () => { current = false; return { status: 'present', revision: 1, content: { t: 'plain', v: { ...preference, services: {} } } }; },
        mutate: async () => { mutations += 1; return { status: 'updated', revision: 2, cursor: 1 }; },
      },
    });
    expect(await client.set({ workspace, expectedRevision: 1, expected: { kind: 'value', value: preference }, next: { ...preference, allowAdHoc: true } }))
      .toEqual({ status: 'cancelled' });
    expect(mutations).toBe(0);
  });
});
