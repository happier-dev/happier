import { describe, expect, it } from 'vitest';
import { loadProfileCatalogV1 } from './profileCatalogV1.js';
import type { ProfileRecordV1, ProfileRowsListResponseV1 } from './profileRecordV1.js';
import type { ProfileTransferRowReadResponseV1 } from './profileTransferV1.js';

const record = (id: string): ProfileRecordV1 => ({
  v: 1, id, enabled: true, promptStack: [], secretBindings: {},
  definition: { kind: 'artifact', artifactId: `artifact-${id}` },
});

describe('complete opened Profile catalog', () => {
  it('admits a captured native source only across the same census/control cut and skips stale raw source after activation', async () => {
    const active: ProfileTransferRowReadResponseV1 = { status: 'present', revision: 2, content: { t: 'plain', v: {
      v: 1, phase: 'active', sourceSettingsVersion: 4, migratedLogicalRevision: 4, inventory: [],
    } } };
    let transfer: ProfileTransferRowReadResponseV1 = { status: 'absent' };
    const input = { mode: 'plain' as const, material: null,
      readPage: async () => ({ status: 'listed' as const, rows: [], nextCursor: null, complete: true,
        diagnostics: [], referenceGuardRevision: 1, transferControl: transfer }),
      readReferenceGuard: async () => ({ status: 'ready' as const, revision: 1 }),
      readTransfer: async () => transfer,
      readSource: async () => ({}),
    };
    expect(await loadProfileCatalogV1(input)).toMatchObject({ status: 'ready', source: 'destination', authority: 'inactive' });
    expect(await loadProfileCatalogV1({ ...input, readSource: async () => { transfer = active; return {}; } }))
      .toEqual({ status: 'unavailable', reason: 'reference-conflict' });
    expect(await loadProfileCatalogV1({ ...input, readSource: async () => { throw new Error('stale_source_must_not_be_disclosed'); } }))
      .toMatchObject({ status: 'ready', source: 'destination', authority: 'active' });
  });
  it('opens the single active control and refuses a phase change during enumeration', async () => {
    const control = { status: 'present' as const, revision: 2, content: { t: 'plain' as const, v: {
      v: 1 as const, phase: 'active' as const, sourceSettingsVersion: 4, migratedLogicalRevision: 1, inventory: [],
    } } };
    const input = { mode: 'plain' as const, material: null,
      readPage: async () => ({ status: 'listed' as const, rows: [], nextCursor: null, complete: true,
        diagnostics: [], referenceGuardRevision: 1, transferControl: control }),
      readReferenceGuard: async () => ({ status: 'ready' as const, revision: 1 }),
      readTransfer: async () => control,
    };
    expect(await loadProfileCatalogV1(input)).toMatchObject({ status: 'ready', authority: 'active', controlRevision: 2,
      control: { record: { phase: 'active' }, revision: 2 } });
    expect(await loadProfileCatalogV1({ ...input, readTransfer: async () => ({ status: 'deleted', revision: 3 }) }))
      .toEqual({ status: 'unavailable', reason: 'reference-conflict' });
  });
  it('distinguishes authenticated absent transfer authority from an active empty catalog', async () => {
    const result = await loadProfileCatalogV1({ mode: 'plain', material: null,
      readPage: async () => ({ status: 'listed', rows: [], nextCursor: null, complete: true,
        diagnostics: [], referenceGuardRevision: 1, transferControl: { status: 'absent' } }),
      readReferenceGuard: async () => ({ status: 'ready', revision: 1 }),
      readTransfer: async () => ({ status: 'absent' }),
    });
    expect(result).toMatchObject({ status: 'ready', authority: 'inactive', control: null });
  });
  it('drains a 257-Profile inventory and rechecks its reference guard', async () => {
    const pages: ProfileRowsListResponseV1[] = [
      { status: 'listed', rows: Array.from({ length: 256 }, (_, index) => ({
        id: `profile-${index}`, revision: 1, content: { t: 'plain', v: record(`profile-${index}`) },
      })), nextCursor: 'last', complete: true, diagnostics: [], referenceGuardRevision: 9, transferControl: { status: 'absent' } },
      { status: 'listed', rows: [{ id: 'profile-256', revision: 3,
        content: { t: 'plain', v: record('profile-256') } }],
        nextCursor: null, complete: true, diagnostics: [], referenceGuardRevision: 9, transferControl: { status: 'absent' } },
    ];
    const result = await loadProfileCatalogV1({ mode: 'plain', material: null,
      readPage: async (cursor) => pages[cursor === undefined ? 0 : 1]!,
      readReferenceGuard: async () => ({ status: 'ready', revision: 9 }),
      readTransfer: async () => ({ status: 'absent' }),
    });
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') throw new Error('expected complete inventory');
    expect(result.records).toHaveLength(257);
    expect(result.records[256]).toMatchObject({ record: { id: 'profile-256' }, revision: 3 });
  });

  it('refuses a phantom insertion after enumeration instead of admitting an incomplete reference census', async () => {
    const result = await loadProfileCatalogV1({ mode: 'plain', material: null,
      readPage: async () => ({ status: 'listed', rows: [], diagnostics: [], nextCursor: null,
        complete: true, referenceGuardRevision: 9, transferControl: { status: 'absent' } }),
      readReferenceGuard: async () => ({ status: 'ready', revision: 10 }),
      readTransfer: async () => ({ status: 'absent' }),
    });
    expect(result).toEqual({ status: 'unavailable', reason: 'reference-conflict' });
  });
});
