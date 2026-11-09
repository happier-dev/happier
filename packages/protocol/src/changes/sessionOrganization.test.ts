import { describe, expect, it } from 'vitest';

import { SessionOrganizationChangeHintSchema } from './index.js';

describe('SessionOrganizationChangeHintSchema', () => {
  it('parses the session appearance invalidation published by the organization owner', () => {
    const hint = { sessionOrganization: true, scope: 'sessionAppearances', sessionIds: ['session-1'] };
    expect(SessionOrganizationChangeHintSchema.parse(hint)).toEqual(hint);
  });

  it('parses an optional exact tag-deletion signal without requiring it for upserts', () => {
    expect(SessionOrganizationChangeHintSchema.parse({
      sessionOrganization: true,
      scope: 'tags',
      tagIds: ['tag-1'],
      deletedTagIds: ['tag-1'],
    })).toMatchObject({ deletedTagIds: ['tag-1'] });
    expect(SessionOrganizationChangeHintSchema.parse({
      sessionOrganization: true,
      scope: 'tags',
      tagIds: ['tag-1'],
    }).deletedTagIds).toBeUndefined();
  });
});
