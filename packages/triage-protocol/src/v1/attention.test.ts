import { describe, expect, it } from 'vitest';
import { TriageReadAttentionResultV1Schema } from './attention.js';

describe('the public attention result contract', () => {
  it('loads with canonical boolean schemas and refuses non-boolean attention or paging facts', () => {
    const item = {
      localRef: { kindId: 'issue', collisionScope: 'project-a', entryId: '17' },
      reason: 'assignment', type: 'mention', title: 'Assigned issue', resolved: false,
    };
    expect(TriageReadAttentionResultV1Schema.parse({ kind: 'page', items: [item], nextPage: true }))
      .toMatchObject({ items: [{ resolved: false }], nextPage: true });
    expect(TriageReadAttentionResultV1Schema.parse({ kind: 'page', items: [{ ...item, resolved: true }], nextPage: false }))
      .toMatchObject({ items: [{ resolved: true }], nextPage: false });
    expect(TriageReadAttentionResultV1Schema.safeParse({ kind: 'page', items: [item], nextPage: 'false' }).success).toBe(false);
    expect(TriageReadAttentionResultV1Schema.safeParse({ kind: 'page', items: [{ ...item, resolved: 0 }], nextPage: false }).success).toBe(false);
  });
});
