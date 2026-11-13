import { describe, expect, it } from 'vitest';
import { loadProfileCatalogV1 } from './profileCatalogV1.js';
import { ProfileRecordV1Schema, StoredProfileRecordV1Schema, ProfileRowMutationV1Schema, ProfileRowsListResponseV1Schema, type ProfileRecordV1, type ProfileRowsListResponseV1 } from './profileRecordV1.js';
import type { ProfileTransferRowReadResponseV1 } from './profileTransferV1.js';
import capturedPicker from '../../fixtures/0.2-picker-skill-instructions-stack.json';

const record = (id: string): ProfileRecordV1 => ProfileRecordV1Schema.parse({
  v: 1, id, enabled: true, promptStack: [], secretBindings: {},
  definition: { kind: 'artifact', artifactId: `artifact-${id}` },
});

describe('complete opened Profile catalog', () => {
  it('ignores disabled and consumed unavailable migration candidates but refuses enabled unavailable content', async () => {
    let stored = ProfileRecordV1Schema.parse({ ...record('profile'), promptStack: [
      { id: 'disabled', enabled: false, placement: 'skill_instructions', ref: { kind: 'bundle', artifactId: 'missing' } },
      { id: 'consumed', enabled: true, skillMigrationV1: true, placement: 'system_append', ref: { kind: 'bundle', artifactId: 'consumed' } },
    ] });
    const reads: string[] = [];
    let writes = 0;
    const load = () => loadProfileCatalogV1({ mode: 'plain', material: null,
      readPage: async () => ProfileRowsListResponseV1Schema.parse({ status: 'listed', rows: [{ id: stored.id, revision: 1, content: { t: 'plain', v: stored } }],
        nextCursor: null, complete: true, diagnostics: [], referenceGuardRevision: 1, transferControl: { status: 'absent' } }),
      readReferenceGuard: async () => ({ status: 'ready', revision: 1 }), readTransfer: async () => ({ status: 'absent' }),
      readSource: async () => ({}), skillMigration: {
        readArtifact: async ref => { reads.push(ref.artifactId); return null; },
        writeRecord: async () => { writes++; return { status: 'updated', revision: 2 }; },
      },
    });
    expect(await load()).toMatchObject({ status: 'ready', records: [{ record: { skillSeeds: [], promptStack: stored.promptStack } }] });
    expect(reads).toEqual([]); expect(writes).toBe(0);
    stored = ProfileRecordV1Schema.parse({ ...stored, promptStack: stored.promptStack.map(entry => entry.id === 'disabled' ? { ...entry, enabled: true } : entry) });
    expect(await load()).toEqual({ status: 'unavailable', reason: 'invalid-stored-content' });
    expect(reads).toEqual(['missing']); expect(writes).toBe(0);
  });
  it('adds enabled Profile skill seeds at load while retaining the full legacy stack for Session exclusions', async () => {
    let stored = ProfileRecordV1Schema.parse({ ...record('profile'), skillSeeds: ['existing'], promptStack: [
      { id: 'skill-entry', enabled: true, placement: 'skill_instructions', ref: { kind: 'bundle', artifactId: 'skill' } },
      { id: 'repeated-skill', enabled: true, placement: 'system_append', ref: { kind: 'bundle', artifactId: 'skill' } },
      { id: 'disabled-skill', enabled: false, placement: 'system_append', ref: { kind: 'bundle', artifactId: 'disabled' } },
      { id: 'generic-entry', enabled: true, placement: 'system_append', ref: { kind: 'bundle', artifactId: 'generic' } },
      { id: 'doc-entry', enabled: true, placement: 'system_append', ref: { kind: 'doc', artifactId: 'doc' } },
    ] });
    const retainedStack = stored.promptStack;
    let revision = 4;
    let writes = 0;
    const input = { mode: 'plain' as const, material: null,
      readPage: async () => ({ status: 'listed' as const, rows: [{ id: stored.id, revision, content: { t: 'plain' as const, v: stored } }],
        nextCursor: null, complete: true, diagnostics: [], referenceGuardRevision: 1, transferControl: { status: 'absent' as const } }),
      readReferenceGuard: async () => ({ status: 'ready' as const, revision: 1 }),
      readTransfer: async () => ({ status: 'absent' as const }), readSource: async () => ({}),
      skillMigration: {
        readArtifact: async (ref: Readonly<{ artifactId: string }>) => ({ header: {
          v: 1, kind: 'prompt_bundle.v2', title: 'Bundle', bundleSchemaId: ref.artifactId === 'generic' ? 'bundle.generic_v1' : 'skills.skill_md_v1' } }),
        writeRecord: async (next: ProfileRecordV1, expectedRevision: number) => {
          expect(expectedRevision).toBe(revision);
          const mutation = ProfileRowMutationV1Schema.parse({ id: next.id, operation: 'update', expectedRevision,
            content: { t: 'plain', v: next }, referencedSavedSecretIds: [] });
          if (mutation.content?.t !== 'plain') throw new Error('Expected the real plaintext producer');
          stored = mutation.content.v; revision++; writes++;
          return { status: 'updated' as const, revision };
        },
      },
    };
    const catalog = await loadProfileCatalogV1(input);
    expect(catalog).toMatchObject({ status: 'ready', records: [{ revision: 5, record: { skillSeeds: ['existing', 'skill'] } }] });
    expect(stored.promptStack.map(entry => entry.id)).toEqual(retainedStack.map(entry => entry.id));
    expect((await loadProfileCatalogV1(input)).status).toBe('ready');
    expect(writes).toBe(1);
    // A user removes the seed without an explicit Off. Kept exclusion custody
    // must not act as a second seed writer on the next two catalog loads.
    stored = ProfileRecordV1Schema.parse({ ...stored, skillSeeds: ['existing'] });
    revision++;
    for (let pass = 0; pass < 2; pass++) {
      expect((await loadProfileCatalogV1(input)).status).toBe('ready');
      expect(stored.skillSeeds).toEqual(['existing']);
      expect(writes).toBe(1);
    }
    stored = ProfileRecordV1Schema.parse({ ...stored, promptStack: [{ id: 'unreadable', enabled: true,
      placement: 'system_append', ref: { kind: 'bundle', artifactId: 'missing' } }] });
    const unavailable = { ...input, skillMigration: { ...input.skillMigration, readArtifact: async () => null } };
    expect(await loadProfileCatalogV1(unavailable))
      .toMatchObject({ status: 'unavailable' });
    expect(writes).toBe(1);
  });
  it('consumes the real predecessor picker once even when its seed already exists', async () => {
    let stored = StoredProfileRecordV1Schema.parse({ ...record('golden'), skillSeeds: ['session-control-skill'],
      promptStack: capturedPicker.stacks.surfaces.coding });
    let revision = 1;
    let writes = 0;
    let artifactReadable = true;
    const load = () => loadProfileCatalogV1({ mode: 'plain', material: null,
      readPage: async () => ({ status: 'listed', rows: [{ id: stored.id, revision, content: { t: 'plain', v: stored } }],
        nextCursor: null, complete: true, diagnostics: [], referenceGuardRevision: revision, transferControl: { status: 'absent' } }),
      readReferenceGuard: async () => ({ status: 'ready', revision }), readTransfer: async () => ({ status: 'absent' }),
      readSource: async () => ({}), skillMigration: {
        readArtifact: async ref => artifactReadable ? capturedPicker.artifacts.find(artifact => artifact.id === ref.artifactId) ?? null : null,
        writeRecord: async (next, expectedRevision) => {
          expect(expectedRevision).toBe(revision);
          const mutation = ProfileRowMutationV1Schema.parse({ id: next.id, operation: 'update', expectedRevision,
            content: { t: 'plain', v: next }, referencedSavedSecretIds: [] });
          if (mutation.content?.t !== 'plain') throw new Error('Golden mutation must be plain');
          stored = mutation.content.v; writes++; revision++;
          return { status: 'updated', revision };
        },
      },
    });
    expect((await load()).status).toBe('ready');
    expect(writes).toBe(1);
    stored = ProfileRecordV1Schema.parse({ ...stored, skillSeeds: [] });
    revision++;
    artifactReadable = false;
    for (let pass = 0; pass < 2; pass++) {
      expect((await load()).status).toBe('ready');
      expect(stored.skillSeeds).toEqual([]);
      expect(writes).toBe(1);
      expect(stored.promptStack.map(entry => entry.id)).toEqual(capturedPicker.stacks.surfaces.coding.map(entry => entry.id));
    }
  });
  it('keeps a failed or partial source census read-only, including an otherwise migratable preceding row', async () => {
    const rows = ['available', 'missing'].map(id => ({ id, revision: 1, content: { t: 'plain' as const,
      v: ProfileRecordV1Schema.parse({ ...record(id), promptStack: [{ id: `${id}-entry`, enabled: true,
        placement: 'system_append', ref: { kind: 'bundle', artifactId: id } }] }) } }));
    let writes = 0;
    const input = { mode: 'plain' as const, material: null,
      readPage: async () => ProfileRowsListResponseV1Schema.parse({ status: 'listed', rows, nextCursor: null,
        complete: true, diagnostics: [], referenceGuardRevision: 1, transferControl: { status: 'absent' } }),
      readReferenceGuard: async () => ({ status: 'ready' as const, revision: 1 }),
      readTransfer: async () => ({ status: 'absent' as const }), readSource: async () => ({}),
      skillMigration: { readArtifact: async (ref: Readonly<{ artifactId: string }>) => ref.artifactId === 'missing' ? null
        : { header: { v: 1, kind: 'prompt_bundle.v2', title: 'Skill', bundleSchemaId: 'skills.skill_md_v1' } },
        writeRecord: async () => { writes++; return { status: 'updated' as const, revision: 2 }; } },
    };
    expect(await loadProfileCatalogV1(input)).toEqual({ status: 'unavailable', reason: 'invalid-stored-content' });
    expect(await loadProfileCatalogV1({ ...input, readPage: async () => ({ ...await input.readPage(), complete: false }) }))
      .toMatchObject({ status: 'partial' });
    expect(await loadProfileCatalogV1({ ...input, readSource: async () => ({ profiles: [] }) }))
      .toMatchObject({ status: 'ready', source: 'legacy' });
    expect(writes).toBe(0);
  });
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

  it('fences one census cut once: after the legacy source read when one follows, otherwise after enumeration', async () => {
    let guardReads = 0;
    let transferReads = 0;
    let guardRevision = 4;
    let transfer: ProfileTransferRowReadResponseV1 = { status: 'absent' };
    const input = { mode: 'plain' as const, material: null,
      readPage: async () => ({ status: 'listed' as const, rows: [], nextCursor: null, complete: true,
        diagnostics: [], referenceGuardRevision: 4, transferControl: { status: 'absent' as const } }),
      readReferenceGuard: async () => { guardReads++; return { status: 'ready' as const, revision: guardRevision }; },
      readTransfer: async () => { transferReads++; return transfer; },
      readSource: async () => ({}),
    };
    expect(await loadProfileCatalogV1(input)).toMatchObject({ status: 'ready', referenceGuardRevision: 4 });
    expect({ guardReads, transferReads }).toEqual({ guardReads: 1, transferReads: 1 });
    // A row or control change anywhere after the census cut is still refused.
    expect(await loadProfileCatalogV1({ ...input, readSource: async () => { guardRevision = 5; return {}; } }))
      .toEqual({ status: 'unavailable', reason: 'reference-conflict' });
    guardRevision = 4;
    expect(await loadProfileCatalogV1({ ...input, readSource: async () => { transfer = { status: 'deleted', revision: 1 }; return {}; } }))
      .toEqual({ status: 'unavailable', reason: 'reference-conflict' });
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
