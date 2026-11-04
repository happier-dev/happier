import { describe, expect, it } from 'vitest';
import { artifactActionListSelectionV1, listArtifactHeadersV1 } from './artifactListSelectionV1.js';
import { ArtifactListInputV1Schema } from './artifactActionsV1.js';
import { createRoleSourceReaderV1 } from '../prompts/roles/accountRoleActions.js';
import { BUILT_IN_ROLES_V1 } from '../prompts/roles/builtInRolesV1.js';
import { readCompleteSkillLibraryInventoryV1 } from '../prompts/library/skills/readSkillLibraryCatalog.js';

const skill = { artifactId: 'skill', header: { kind: 'prompt_bundle.v2', bundleSchemaId: 'skills.skill_md_v1' }, createdAt: 1, updatedAt: 3 };
const legacy = { ...skill, artifactId: 'legacy', updatedAt: 2 };
const prompt = { artifactId: 'prompt', header: { kind: 'prompt_doc.v2' }, createdAt: 1, updatedAt: 1 };
type PageOptions = Readonly<{ cursor?: string; coarseKind?: string }>;
const encodeCursor = (row: Readonly<{ artifactId: string }>) => row.artifactId;
const completeKindCoverage = { status: 'complete', unclassifiedCount: 0 } as const;

describe('Artifact coarse selection', () => {
  it('keeps received template discovery to one structural header page, including sparse searches and partial coverage', async () => {
    const input = ArtifactListInputV1Schema.parse({ audience: 'received', kinds: ['bot_template.v1'], limit: 2, search: 'chosen' });
    const options = artifactActionListSelectionV1(input);
    const requests: unknown[] = [];
    const partial = { status: 'partial', unclassifiedCount: 1, reason: 'unclassified_legacy_rows' } as const;
    const result = await listArtifactHeadersV1({ options, encodeCursor,
      readPage: async request => { requests.push(request); return { items: [
        { artifactId: 'first', header: { kind: 'bot_template.v1', title: 'Other' }, createdAt: 1, updatedAt: 3 },
        { artifactId: 'frontier', header: { kind: 'bot_template.v1', title: 'Other too' }, createdAt: 1, updatedAt: 2 },
      ], nextCursor: 'frontier', kindCoverage: partial }; },
      readBodies: async () => { throw new Error('Received discovery must not open bodies'); },
    });
    expect(result).toEqual({ items: [], nextCursor: 'frontier', coverage: 'partial', kindCoverage: partial });
    expect(requests).toEqual([{ audience: 'received', kinds: ['bot_template.v1'], limit: 2 }]);
  });
  it('keeps relevant legacy approvals with unknown state partial without opening settled or unrelated bodies', async () => {
    const rows = [
      { artifactId: 'unknown', header: { kind: 'approval_request.v1', approvalStatus: 'invalid', approvalSubjectKey: 'managed-delete:subject' }, createdAt: 1, updatedAt: 3 },
      { artifactId: 'settled', header: { kind: 'approval_request.v1', approvalStatus: 'executed', approvalSubjectKey: 'managed-delete:subject' }, createdAt: 1, updatedAt: 2 },
      { artifactId: 'other-subject', header: { kind: 'approval_request.v1', approvalStatus: 'invalid', approvalSubjectKey: 'managed-delete:other' }, createdAt: 1, updatedAt: 1 },
    ];
    const partial = { status: 'partial', unclassifiedCount: rows.length, reason: 'unclassified_legacy_rows' } as const;
    const list = (legacyRows: typeof rows) => listArtifactHeadersV1({ options: {
      indexedKinds: ['approval_request.v1#managed-delete:subject'], approvalStates: ['open'], includeBody: true }, encodeCursor,
      readPage: async options => ({ items: options?.unclassified ? legacyRows : [], kindCoverage: partial }),
      readBodies: async () => { throw new Error('No pending body is readable from unknown or settled headers'); },
    });
    expect(await list(rows)).toMatchObject({ items: [], coverage: 'partial' });
    expect(await list(rows.slice(1))).toMatchObject({ items: [], coverage: 'complete' });
    const unknown = rows[0]!;
    const fresh = await listArtifactHeadersV1({ options: { kinds: ['approval_request.v1'], approvalStates: ['open'], includeBody: true }, encodeCursor,
      readPage: async () => ({ items: [{ ...unknown, header: { ...unknown.header, approvalStatus: 'open' } }], kindCoverage: completeKindCoverage }),
      readBodies: async () => [unknown],
    });
    expect(fresh).toMatchObject({ items: [], coverage: 'partial' });
  });
  it('selects linked approval Sessions as one set and does no work for empty Session demand', async () => {
    const rows = ['first', 'second', 'unrelated'].map((sessionId, index) => ({ artifactId: sessionId,
      header: { kind: 'approval_request.v1', approvalStatus: 'executed', sessionId }, createdAt: 1, updatedAt: 3 - index }));
    const requests: unknown[] = [];
    const result = await listArtifactHeadersV1({ options: { approvalSessionIds: ['first', 'second'] }, encodeCursor,
      readPage: async options => { requests.push(options); return { items: rows, kindCoverage: completeKindCoverage }; },
    });
    expect(result.items.map(row => row.artifactId)).toEqual(['first', 'second']);
    expect(requests).toEqual([{ limit: 500, approvalSessionIds: ['first', 'second'] }]);
    const empty = await listArtifactHeadersV1({ options: { approvalSessionIds: [] }, encodeCursor,
      readPage: async () => { throw new Error('Empty demand must not scan inventory'); },
    });
    expect(empty).toEqual({ items: [], coverage: 'complete' });
  });
  it('resolves legacy managed approvals through exact indexed state selection without opening other receipts', async () => {
    const selected = { artifactId: 'legacy-subject', createdAt: 1, updatedAt: 2,
      header: { kind: 'approval_request.v1', approvalStatus: 'open', approvalSubjectKey: 'managed-delete:subject' } };
    const other = { ...selected, artifactId: 'other-subject', header: { ...selected.header, approvalSubjectKey: 'managed-delete:other' } };
    const settled = { ...selected, artifactId: 'settled-subject', header: { ...selected.header, approvalStatus: 'executed' } };
    const partial = { status: 'partial', unclassifiedCount: 3, reason: 'unclassified_legacy_rows' } as const;
    const requests: unknown[] = [];
    const bodies: string[] = [];
    const result = await listArtifactHeadersV1({ options: { indexedKinds: ['approval_request.v1#managed-delete:subject'],
      approvalStates: ['open'], includeBody: true }, encodeCursor,
      readPage: async options => { requests.push(options); return { items: options?.unclassified ? [selected, other, settled] : [], kindCoverage: partial }; },
      readBodies: async items => { bodies.push(...items.map(row => row.artifactId)); return items; },
    });
    expect(result.items).toEqual([selected]);
    expect(bodies).toEqual(['legacy-subject']);
    expect(requests).toEqual([{ limit: 500, indexedKinds: ['approval_request.v1#managed-delete:subject'], approvalStates: ['open'] },
      { limit: 500, unclassified: 'approval' }]);
  });
  it('selects open approvals before paging settled receipts while preserving notices and legacy membership', async () => {
    const rows = [
      { artifactId: 'open', header: { kind: 'approval_request.v1', approvalStatus: 'open', sessionId: 'session' }, createdAt: 1, updatedAt: 4 },
      { artifactId: 'settled', header: { kind: 'approval_request.v1', approvalStatus: 'executed', sessionId: 'session' }, createdAt: 1, updatedAt: 3 },
      { artifactId: 'notice', header: { kind: 'account_notice.v1' }, createdAt: 1, updatedAt: 2 },
    ];
    const requests: unknown[] = [];
    const result = await listArtifactHeadersV1({ options: { kinds: ['approval_request.v1', 'account_notice.v1'], approvalStates: ['open'] }, encodeCursor,
      readPage: async options => { requests.push(options); return { items: rows, kindCoverage: completeKindCoverage }; },
    });
    expect(result.items.map(row => row.artifactId)).toEqual(['open', 'notice']);
    expect(requests).toEqual([{ limit: 500, kinds: ['account_notice.v1', 'approval_request.v1'], approvalStates: ['open'] }]);
    const partial = { status: 'partial', unclassifiedCount: 1, reason: 'unclassified_legacy_rows' } as const;
    const legacyRequests: unknown[] = [];
    const selected = await listArtifactHeadersV1({ options: { approvalSessionIds: ['session'] }, encodeCursor,
      readPage: async options => { legacyRequests.push(options); return { items: options?.unclassified ? rows : [], kindCoverage: partial }; },
    });
    expect(selected.items.map(row => row.artifactId)).toEqual(['open', 'settled']);
    expect(legacyRequests).toEqual([{ limit: 500, approvalSessionIds: ['session'] }, { limit: 500, unclassified: 'approval' }]);
  });
  it('keeps private exact kinds literal when they resemble encoded storage', async () => {
    const rows = ['foo', 'v1:other:foo'].map((kind, index) => ({ artifactId: kind,
      header: { kind }, createdAt: 1, updatedAt: 2 - index }));
    const requests: unknown[] = [];
    const result = await listArtifactHeadersV1({ options: { kinds: ['v1:other:foo'] }, encodeCursor,
      readPage: async options => { requests.push(options); return { items: rows, kindCoverage: completeKindCoverage }; },
    });
    expect(result.items).toEqual([rows[1]]);
    expect(requests).toEqual([{ limit: 500, kinds: ['v1:other:foo'] }]);
  });
  it.each([{ kind: 'role.v1' }, { kinds: ['role.v1'] }, { indexedKinds: ['role.v1'] }, { coarseKind: 'other' as const }])(
    'rejects browser membership combined with %j', async competing => {
      await expect(listArtifactHeadersV1({ options: { browserListed: true, ...competing }, encodeCursor,
        readPage: async () => ({ items: [], kindCoverage: completeKindCoverage }),
      })).rejects.toBeInstanceOf(TypeError);
    },
  );

  it('requires the typed witness for browser membership', async () => {
    await expect(listArtifactHeadersV1({ options: { browserListed: true, limit: 10 }, encodeCursor,
      readPage: async () => ({ items: [], hasUnclassified: false }),
    })).rejects.toMatchObject({ code: 'artifact_content_unavailable' });
  });

  it('reads the browser complement once and resolves readable legacy membership without a second pass', async () => {
    const unrelated = Array.from({ length: 2500 }, (_, index) => ({ artifactId: `approval-${index}`,
      header: { kind: 'approval_request.v1' }, createdAt: 1, updatedAt: 3000 - index }));
    const listed = [
      { artifactId: 'future-kind', header: { kind: 'future.document.v3' }, createdAt: 1, updatedAt: 4 },
      { artifactId: 'untyped', header: {}, createdAt: 1, updatedAt: 3 },
      { artifactId: 'legacy-document', header: { kind: 'document' }, createdAt: 1, updatedAt: 2 },
    ];
    const legacyPrivate = { artifactId: 'legacy-approval', header: { kind: 'approval_request.v1' }, createdAt: 1, updatedAt: 1 };
    const kindCoverage = { status: 'partial', unclassifiedCount: 2, reason: 'unclassified_legacy_rows' } as const;
    const requests: unknown[] = [];
    const physicalHeaders: string[] = [];
    const result = await listArtifactHeadersV1({ options: { browserListed: true }, encodeCursor,
      readPage: async options => {
        requests.push(options);
        const candidates = options?.browserListed ? [...listed, legacyPrivate] : [...unrelated, ...listed, legacyPrivate];
        const offset = options?.cursor ? candidates.findIndex(row => row.artifactId === options.cursor) + 1 : 0;
        const items = candidates.slice(offset, offset + (options?.limit ?? 500));
        physicalHeaders.push(...items.map(row => row.artifactId));
        return { items, hasUnclassified: true, kindCoverage,
          ...(offset + items.length < candidates.length ? { nextCursor: items.at(-1)!.artifactId } : {}) };
      },
    });
    expect(result).toEqual({ items: listed, coverage: 'complete', kindCoverage });
    expect(requests).toEqual([{ limit: 500, browserListed: true }]);
    expect(physicalHeaders).toHaveLength(4);
  });

  it('keeps unreadable browser membership partial and rechecks fresh body headers against the policy', async () => {
    const item = { artifactId: 'changed-document', header: { kind: 'document' }, createdAt: 1, updatedAt: 1 };
    const kindCoverage = { status: 'partial', unclassifiedCount: 1, reason: 'unclassified_legacy_rows' } as const;
    const result = await listArtifactHeadersV1({ options: { browserListed: true, includeBody: true }, encodeCursor,
      readPage: async () => ({ items: [item], coverage: 'partial', hasUnclassified: true, kindCoverage }),
      readBodies: async items => items.map(row => ({ ...row, header: { kind: 'approval_request.v1' } })),
    });
    expect(result).toEqual({ items: [], coverage: 'partial', kindCoverage });
  });

  it('keeps an unknown ordinary kind when its hint collides with an annotated approval hint', async () => {
    const approval = { artifactId: 'approval', header: { kind: 'approval_request.v1', approvalSubjectKey: 'managed-delete:contract' },
      createdAt: 1, updatedAt: 2 };
    const ordinary = { artifactId: 'ordinary', header: { kind: 'approval_request.v1#managed-delete:contract' }, createdAt: 1, updatedAt: 1 };
    const result = await listArtifactHeadersV1({ options: { browserListed: true }, encodeCursor,
      readPage: async () => ({ items: [approval, ordinary], kindCoverage: completeKindCoverage }),
    });
    expect(result).toEqual({ items: [ordinary], coverage: 'complete', kindCoverage: completeKindCoverage });
  });

  it.each([false, true])('rejects exact membership without a typed witness even when hasUnclassified is %s', async hasUnclassified => {
    await expect(listArtifactHeadersV1({ options: { kinds: ['profile.v1'] }, encodeCursor,
      readPage: async () => ({ items: [], hasUnclassified }),
    })).rejects.toMatchObject({ code: 'artifact_content_unavailable' });
  });
  it('finds legacy exact kinds beyond 500 using headers only and opens only the selected page', async () => {
    const rows = Array.from({ length: 1001 }, (_, index) => ({ artifactId: `legacy-${index}`,
      header: { kind: index === 700 || index === 1000 ? 'account_notice.v1' : 'document.v1' },
      createdAt: 1, updatedAt: 2000 - index }));
    const indexed = { ...rows[700]!, artifactId: 'indexed', updatedAt: 1400 };
    const kindCoverage = { status: 'partial' as const, unclassifiedCount: rows.length,
      reason: 'unclassified_legacy_rows' as const };
    const requests: unknown[] = [];
    const bodies: string[] = [];
    const returned: string[] = [];
    let cursor: string | undefined;
    do {
      const result = await listArtifactHeadersV1({ options: { kinds: ['account_notice.v1'], includeBody: true, ownerAccountId: 'owner',
        limit: 2, ...(cursor ? { cursor } : {}) }, encodeCursor,
        readPage: async options => {
          requests.push(options);
          const source = options?.unclassified ? [...rows, indexed].sort((left, right) => right.updatedAt - left.updatedAt) : [indexed];
          const after = options?.cursor === indexed.artifactId ? indexed : rows.find(row => row.artifactId === options?.cursor);
          const remaining = source.filter(row => !after || row.updatedAt < after.updatedAt);
          const items = remaining.slice(0, options?.limit ?? 500);
          return { items, hasUnclassified: true, kindCoverage,
            ...(remaining.length > items.length ? { nextCursor: items.at(-1)!.artifactId } : {}) };
        },
        readBodies: async items => { bodies.push(...items.map(row => row.artifactId)); return items; },
      });
      expect(result).toMatchObject({ coverage: 'complete', kindCoverage });
      returned.push(...result.items.map(row => row.artifactId));
      cursor = result.nextCursor;
    } while (cursor);
    expect(returned).toEqual(['indexed', 'legacy-700', 'legacy-1000']);
    expect(bodies).toEqual(returned);
    expect(requests.filter(value => typeof value === 'object' && value && Reflect.get(value, 'unclassified'))).toHaveLength(4);
    expect(requests.every(value => typeof value === 'object' && value && Reflect.get(value, 'includeBody') !== true)).toBe(true);
    expect(requests.every(value => typeof value === 'object' && value && Reflect.get(value, 'ownerAccountId') === 'owner')).toBe(true);
  });

  it.each(['readable', 'unreadable'] as const)('keeps a legacy Role catalog %s through the real shared Role reader', async availability => {
    const row = { artifactId: 'legacy-role', header: { kind: 'role.v1' }, headerVersion: 1,
      bodyVersion: 1, createdAt: 1, updatedAt: 1, ownerAccountId: 'account', access: 'owner' as const };
    const kindCoverage = { status: 'partial' as const, unclassifiedCount: 1,
      reason: 'unclassified_legacy_rows' as const };
    const bodyIds: string[] = [];
    const read = createRoleSourceReaderV1({ artifactStore: {
      read: async () => { throw new Error('Catalog must use the selected list body'); },
      list: options => listArtifactHeadersV1({ options, encodeCursor,
        readPage: async selection => ({ items: selection?.unclassified && availability === 'readable' ? [row] : [],
          coverage: selection?.unclassified && availability === 'unreadable' ? 'partial' : 'complete',
          hasUnclassified: true, kindCoverage }),
        readBodies: async items => { bodyIds.push(...items.map(item => item.artifactId));
          return items.map(item => ({ ...item, body: JSON.stringify(BUILT_IN_ROLES_V1.builder) })); },
      }),
    } });
    const result = await read();
    expect(result.status).toBe(availability === 'readable' ? 'ready' : 'partial');
    expect(result.entries.some(entry => entry.roleId === row.artifactId)).toBe(availability === 'readable');
    expect(bodyIds).toEqual(availability === 'readable' ? [row.artifactId] : []);
  });

  it('keeps complete exact coverage indexed-only and carries its derived count', async () => {
    let queries = 0;
    const kindCoverage = { status: 'complete' as const, unclassifiedCount: 0 as const };
    const result = await listArtifactHeadersV1({ options: { kinds: ['account_notice.v1'] }, encodeCursor,
      readPage: async options => {
        queries++;
        expect(options).toEqual({ limit: 500, kinds: ['account_notice.v1'] });
        return { items: [], hasUnclassified: false, kindCoverage };
      } });
    expect(result).toEqual({ items: [], coverage: 'complete', kindCoverage });
    expect(queries).toBe(1);
  });

  it('does not confuse complete kind classification with readable content coverage', async () => {
    const kindCoverage = { status: 'complete' as const, unclassifiedCount: 0 as const };
    const result = await listArtifactHeadersV1({ options: { kinds: ['account_notice.v1'] }, encodeCursor,
      readPage: async () => ({ items: [], coverage: 'partial', kindCoverage }) });
    expect(result).toEqual({ items: [], coverage: 'partial', kindCoverage });
  });

  it('never opens 35k unrelated headers to refine known coarse classifications', async () => {
    const rows = Array.from({ length: 35000 }, (_, index) => ({ ...prompt, artifactId: String(index) }));
    let opened = 0;
    let queries = 0;
    const result = await listArtifactHeadersV1({ options: { coarseKind: 'skill' }, encodeCursor,
      readPage: async options => {
        queries++;
        if (!options?.unclassified) return { items: [], hasUnclassified: false };
        const start = Number(options.cursor ?? 0);
        const items = rows.slice(start, start + 500);
        opened += items.length;
        return { items, ...(start + 500 < rows.length ? { nextCursor: String(start + 500) } : {}) };
      } });
    expect(opened).toBe(0);
    expect(queries).toBe(1);
    expect(result).toEqual({ items: [], coverage: 'complete' });
  });

  it('pages a Role catalog once with complete typed membership', async () => {
    const roles = Array.from({ length: 1201 }, (_, index) => ({ artifactId: `role-${index}`,
      header: { kind: 'role.v1', title: `Role ${index}` }, createdAt: 1, updatedAt: 2402 - index * 2 }));
    const rows = roles.flatMap(role => [role, { ...role, artifactId: `document-${role.artifactId}`,
      header: { kind: 'document.v1', title: 'Not a Role' }, updatedAt: role.updatedAt - 1 }]);
    const physicalCursors: Array<string | undefined> = [];
    const opened: string[] = [];
    const returned: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await listArtifactHeadersV1({ options: { kind: 'role.v1', coarseKind: 'other',
        includeBody: true, limit: 500, ...(cursor ? { cursor } : {}) }, encodeCursor,
        readPage: async options => {
          physicalCursors.push(options?.cursor);
          const candidates = options?.kinds ? roles : rows;
          const start = options?.cursor ? candidates.findIndex(row => row.artifactId === options.cursor) + 1 : 0;
          const items = candidates.slice(start, start + (options?.limit ?? 500));
          return { items, ...(start + items.length < candidates.length ? { nextCursor: items.at(-1)!.artifactId } : {}),
            hasUnclassified: false, kindCoverage: completeKindCoverage };
        },
        readBodies: async items => {
          opened.push(...items.map(item => item.artifactId));
          return items.map(item => ({ ...item, body: `content:${item.artifactId}` }));
        },
      });
      expect(page.coverage).toBe('complete');
      returned.push(...page.items.map(item => item.artifactId));
      cursor = page.nextCursor;
    } while (cursor);
    expect(returned).toEqual(roles.map(role => role.artifactId));
    expect(opened).toHaveLength(roles.length);
    expect(opened).toEqual(returned);
    expect(physicalCursors).toHaveLength(3);
    expect(physicalCursors.filter(value => value === undefined)).toHaveLength(1);
  });

  it.each(['title_asc', 'created_desc'] as const)('opens only each returned body for %s', async sort => {
    const rows = [
      { artifactId: 'c', header: { kind: 'role.v1', title: 'Role C' }, createdAt: 1, updatedAt: 3 },
      { artifactId: 'a', header: { kind: 'role.v1', title: 'Role A' }, createdAt: 3, updatedAt: 2 },
      { artifactId: 'b', header: { kind: 'role.v1', title: 'Role B' }, createdAt: 2, updatedAt: 1 },
    ];
    const opened: string[] = [];
    const returned: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await listArtifactHeadersV1({ options: { kind: 'role.v1', includeBody: true,
        limit: 1, sort, search: 'ROLE', ...(cursor ? { cursor } : {}) }, encodeCursor,
        readPage: async () => ({ items: rows, kindCoverage: completeKindCoverage }),
        readBodies: async items => {
          opened.push(...items.map(item => item.artifactId));
          return items;
        } });
      returned.push(...page.items.map(item => item.artifactId));
      cursor = page.nextCursor;
    } while (cursor);
    expect(returned).toEqual(['a', 'b', 'c']);
    expect(opened).toEqual(returned);
  });

  it('keeps the updated-order cursor aligned with the transport id-desc tie break', async () => {
    const rows = ['c', 'b', 'a'].map(artifactId => ({ artifactId,
      header: { kind: 'role.v1' }, createdAt: 1, updatedAt: 1 }));
    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await listArtifactHeadersV1({ options: { kind: 'role.v1', limit: 1,
        ...(cursor ? { cursor } : {}) }, encodeCursor,
        readPage: async options => ({ items: rows.slice(options?.cursor
          ? rows.findIndex(row => row.artifactId === options.cursor) + 1 : 0), kindCoverage: completeKindCoverage }) });
      ids.push(...page.items.map(row => row.artifactId));
      cursor = page.nextCursor;
    } while (cursor);
    expect(ids).toEqual(['c', 'b', 'a']);
  });

  it('returns fresh selected revisions and keeps a changed-kind page from disclosing content', async () => {
    const rows = ['a', 'b', 'c'].map((artifactId, index) => ({ artifactId,
      header: { kind: 'role.v1', title: artifactId }, headerVersion: 1, bodyVersion: 1,
      createdAt: 1, updatedAt: 3 - index }));
    const page = await listArtifactHeadersV1({ options: { kind: 'role.v1', includeBody: true, limit: 2 }, encodeCursor,
      readPage: async () => ({ items: rows, kindCoverage: completeKindCoverage }),
      readBodies: async items => items.map(item => ({ ...item, headerVersion: 2, bodyVersion: 2,
        header: { kind: item.artifactId === 'a' ? 'role.v1' : 'document.v1', title: item.artifactId },
        body: `fresh:${item.artifactId}` })),
    });
    expect(page.items).toEqual([{ ...rows[0], headerVersion: 2, bodyVersion: 2, body: 'fresh:a' }]);
    // The structural continuation still advances over the page we admitted,
    // including a body whose fresh header no longer belongs to this selection.
    expect(page.nextCursor).toBe('b');
  });

  it('does not return a selected body if cancellation arrives while opening it', async () => {
    const controller = new AbortController();
    const reason = new Error('Caller cancelled body opening');
    await expect(listArtifactHeadersV1({ options: { kind: 'role.v1', includeBody: true, signal: controller.signal },
      encodeCursor, readPage: async () => ({ items: [{ ...prompt, header: { kind: 'role.v1' } }], kindCoverage: completeKindCoverage }),
      readBodies: async items => { controller.abort(reason); return items; },
    })).rejects.toBe(reason);
  });

  it.each(['single-page', 'inventory'] as const)('selects %s rows with a native method-absent AbortSignal', async mode => {
    const controller = new AbortController();
    // React Native's installed abort-controller exposes events/aborted, not this method.
    Object.defineProperty(controller.signal, 'throwIfAborted', { value: undefined });
    const result = await listArtifactHeadersV1({ options: { signal: controller.signal,
      ...(mode === 'single-page' ? { limit: 1 } : {}) }, encodeCursor,
      readPage: async () => ({ items: [prompt] }) });
    expect(result.items).toEqual([prompt]);
    expect(result.coverage).toBe('complete');
  });

  it.each(['before-read', 'after-read', 'after-read-without-reason'] as const)('keeps native cancellation authoritative %s', async when => {
    const controller = new AbortController();
    Object.defineProperty(controller.signal, 'throwIfAborted', { value: undefined });
    const reason = new Error('Caller cancelled');
    if (when === 'before-read') controller.abort(reason);
    let reads = 0;
    const result = listArtifactHeadersV1({ options: { signal: controller.signal }, encodeCursor,
      readPage: async () => {
        reads++; controller.abort(reason);
        // The native abort-controller also has no AbortSignal.reason property.
        if (when === 'after-read-without-reason') Object.defineProperty(controller.signal, 'reason', { value: undefined });
        return { items: [prompt] };
      },
    });
    if (when === 'after-read-without-reason') await expect(result).rejects.toMatchObject({ name: 'AbortError' });
    else await expect(result).rejects.toBe(reason);
    expect(reads).toBe(when === 'before-read' ? 0 : 1);
  });

  it.each([
    ['widget_area_layout', 'widget-area-layout.v1'], ['widget_definition', 'widget-definition.v1'],
    ['widget_layout_fragment', 'widget-layout-fragment.v1'],
  ] as const)('resolves %s legacy membership without opening unrelated bodies', async (coarseKind, kind) => {
    const requests: PageOptions[] = [];
    const layout = { ...skill, artifactId: 'widget', header: { kind } };
    const kindCoverage = { status: 'partial', unclassifiedCount: 2, reason: 'unclassified_legacy_rows' } as const;
    const page = await listArtifactHeadersV1({ options: { coarseKind }, encodeCursor,
      readPage: async options => {
        requests.push(options ?? {});
        return options?.unclassified ? { items: [layout, prompt], kindCoverage } : { items: [], hasUnclassified: true };
      } });
    expect(page.items.map(row => row.artifactId)).toEqual(['widget']);
    expect(page.coverage).toBe('complete');
    expect(requests).toEqual([{ limit: 500, coarseKind }, { limit: 500, unclassified: 'coarse' }]);
  });
  it('reads only filtered pages when classification is complete', async () => {
    const requests: PageOptions[] = [];
    const page = await listArtifactHeadersV1({ options: { coarseKind: 'skill' }, encodeCursor,
      readPage: async options => {
        requests.push(options ?? {});
        return options?.coarseKind === 'skill' ? { items: [skill], hasUnclassified: false } : { items: [skill, prompt] };
      } });
    expect(page.items.map(row => row.artifactId)).toEqual(['skill']);
    expect(requests).toEqual([{ limit: 500, coarseKind: 'skill' }]);
    expect(page.coverage).toBe('complete');
  });

  it.each(['readable', 'unreadable'] as const)('keeps legacy Skill inventory %s through the complete library reader', async availability => {
    const requests: unknown[] = [];
    const bodies: string[] = [];
    const kindCoverage = { status: 'partial', unclassifiedCount: 501, reason: 'unclassified_legacy_rows' } as const;
    const unrelated = Array.from({ length: 500 }, (_, index) => ({ ...prompt, artifactId: `prompt-${index}`, updatedAt: 1000 - index }));
    const inventory = readCompleteSkillLibraryInventoryV1({
      list: options => listArtifactHeadersV1({ options, encodeCursor,
        readPage: async selection => {
          requests.push(selection);
          if (!selection?.unclassified) return { items: [skill], hasUnclassified: true };
          if (!selection.cursor) return { items: unrelated, nextCursor: unrelated.at(-1)!.artifactId, kindCoverage };
          return { items: availability === 'readable' ? [legacy, skill] : [skill], kindCoverage,
            coverage: availability === 'readable' ? 'complete' : 'partial' };
        },
        readBodies: async items => { bodies.push(...items.map(row => row.artifactId)); return items; },
      }),
    }, { includeBody: true });
    if (availability === 'readable') await expect(inventory).resolves.toEqual([skill, legacy]);
    else await expect(inventory).rejects.toMatchObject({ code: 'catalog_unavailable' });
    expect(requests).toEqual([{ limit: 500, coarseKind: 'skill' }, { limit: 500, unclassified: 'coarse' },
      { limit: 500, unclassified: 'coarse', cursor: 'prompt-499' }]);
    expect(bodies).toEqual(availability === 'readable' ? ['skill', 'legacy'] : ['skill']);
  });

  it('requires typed legacy coverage before certifying a coarse inventory', async () => {
    await expect(listArtifactHeadersV1({ options: { coarseKind: 'skill' }, encodeCursor,
      readPage: async selection => selection?.unclassified ? { items: [legacy] } : { items: [], hasUnclassified: true },
    })).rejects.toMatchObject({ code: 'artifact_content_unavailable', retryable: false });
  });

  it('merges coarse legacy membership before paging and carries the owner scope', async () => {
    const kindCoverage = { status: 'partial', unclassifiedCount: 1, reason: 'unclassified_legacy_rows' } as const;
    const returned: string[] = [];
    const requests: unknown[] = [];
    let cursor: string | undefined;
    do {
      const page = await listArtifactHeadersV1({ options: { coarseKind: 'skill', ownerAccountId: 'owner', limit: 1,
        ...(cursor ? { cursor } : {}) }, encodeCursor,
        readPage: async selection => {
          requests.push(selection);
          const rows = selection?.unclassified ? [legacy] : [skill];
          const after = [skill, legacy].find(row => row.artifactId === selection?.cursor);
          return { items: rows.filter(row => !after || row.updatedAt < after.updatedAt), hasUnclassified: true, kindCoverage };
        },
      });
      expect(page.coverage).toBe('complete');
      returned.push(...page.items.map(row => row.artifactId));
      cursor = page.nextCursor;
    } while (cursor);
    expect(returned).toEqual(['skill', 'legacy']);
    expect(requests).toEqual([
      { limit: 500, coarseKind: 'skill', ownerAccountId: 'owner' },
      { limit: 500, unclassified: 'coarse', ownerAccountId: 'owner' },
      { limit: 500, coarseKind: 'skill', ownerAccountId: 'owner', cursor: 'skill' },
      { limit: 500, unclassified: 'coarse', ownerAccountId: 'owner', cursor: 'skill' },
    ]);
  });

});
