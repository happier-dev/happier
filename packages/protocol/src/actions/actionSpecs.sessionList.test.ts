import { describe, expect, it } from 'vitest';

import { getActionContextualDefaults, getActionSpec } from './actionSpecs.js';
import { bindSessionListCliInput, SessionListCliInputSchema } from './specs/session/listCli.js';

const query = {
  v: 1,
  storage: 'active',
  includeInactive: false,
  scope: 'all_accessible',
  attention: 'any',
  audiences: { include: [{ kind: 'team', teamId: 'team-a' }], exclude: [] },
  tagIds: { include: ['urgent'], exclude: [] },
} as const;

describe('session.list Action input', () => {
  const schema = getActionSpec('session.list').inputSchema;

  it('normalizes its query through the canonical listing schema', () => {
    expect(schema.parse({ query: { ...query, tagIds: { include: [' z ', 'a'], exclude: [] } }, view: 'summary' }))
      .toEqual({ query: { ...query, tagIds: { include: ['a', 'z'], exclude: [] } }, view: 'summary' });
  });

  it('preserves a server-proved subtree selector in canonical and CLI queries', () => {
    expect(schema.parse({ underSessionId: ' lead ' })).toEqual({ underSessionId: 'lead' });
    expect(schema.parse({ query: { ...query, underSessionId: 'lead' } })).toEqual({ query: { ...query, underSessionId: 'lead' } });
    expect(schema.safeParse({ query, underSessionId: 'other' }).success).toBe(false);
    const cli = SessionListCliInputSchema.parse({ underSessionId: 'lead' });
    expect(bindSessionListCliInput(cli)).toMatchObject({ query: { underSessionId: 'lead', scope: 'all_accessible', includeInactive: true } });
  });

  it.each(['limit', 'cursor', 'activeOnly', 'archivedOnly', 'resumableOnly'])(
    'rejects a duplicated or incompatible legacy %s field in the query arm', (field) => {
      const value = field === 'limit' ? 20 : field === 'cursor' ? null : false;
      expect(schema.safeParse({ query, [field]: value }).success).toBe(false);
    },
  );

  it('rejects unknown selectors and plaintext title search without dropping them', () => {
    expect(schema.safeParse({ query: { ...query, titleQuery: 'private' } }).success).toBe(false);
    expect(schema.safeParse({ titleQuery: 'private' }).success).toBe(false);
    expect(schema.safeParse({ query, typo: true }).success).toBe(false);
    expect(schema.safeParse({ query: { ...query, scope: 'owned' } }).success).toBe(false);
  });

  it('exposes the representation selector in the canonical input hints', () => {
    // Every generated UI/CLI/SDK/MCP form projection reads these hints. A host that had to add
    // its own `view` control would be re-deciding the Action contract locally (E09A.4).
    const field = getActionSpec('session.list').inputHints?.fields.find((entry) => entry.path === 'view');
    expect(field).toMatchObject({ widget: 'select' });
    expect(field?.options?.map((option) => option.value)).toEqual(['summary', 'awareness']);
  });

  it('keeps current-Session list scoping in executor context instead of polluting strict input', () => {
    expect(getActionContextualDefaults('session.list')).toBeNull();
    expect(schema.safeParse({ limit: 1, sessionId: 'session-from-context' }).success).toBe(false);
  });

  it('preserves the legacy flat arm and rejects awareness previews', () => {
    const legacy = { limit: 20, cursor: null, archivedOnly: true, includeRows: true };
    expect(schema.parse(legacy)).toEqual(legacy);
    expect(schema.parse({ ...legacy, view: 'awareness' })).toEqual({ ...legacy, view: 'awareness' });
    expect(schema.safeParse({ view: 'awareness', includeLastMessagePreview: false }).success).toBe(false);
    expect(schema.safeParse({ query, view: 'invalid' }).success).toBe(false);
  });

  it('rejects an oversized friendly-query limit while preserving the released legacy clamp', () => {
    expect(SessionListCliInputSchema.safeParse({ scope: 'my_work', limit: 999 }).success).toBe(false);

    const legacy = SessionListCliInputSchema.parse({ limit: 999 });
    expect(bindSessionListCliInput(legacy)).toEqual({ limit: 200 });
  });
});
