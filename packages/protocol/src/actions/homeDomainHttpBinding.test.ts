import { describe, expect, it } from 'vitest';
import { z } from 'zod/mini';

import { bindHomeDomainHttpRequestV1, readHomeDomainConfirmedRollbackV1 } from './homeDomainHttpBinding.js';
import { bindHomeDomainActionHttpRequestV1 } from './homeDomainActionFamily.js';
import { DeleteSessionOrganizationTagRequestSchema } from '../sessions/organization/mutations.js';

describe('Home-domain HTTP binding', () => {
  it('binds only the reviewed reclaim identity and notice through the closed Home Action', () => {
    const input = { accountId: 'person/one', username: 'held_name', reason: 'Impersonation', notice: 'Contact this Home operator.' };
    expect(bindHomeDomainActionHttpRequestV1('home.public_profiles.handle_reclaim', input)).toEqual({
      method: 'POST', path: '/v1/home/public-profiles/person%2Fone/handle-reclaim',
      body: { username: 'held_name', reason: 'Impersonation', notice: 'Contact this Home operator.' },
    });
    expect(() => bindHomeDomainActionHttpRequestV1('home.public_profiles.handle_reclaim', { ...input, isAdmin: true })).toThrow();
    expect(() => bindHomeDomainActionHttpRequestV1('home.public_profiles.handle_reclaim', { ...input, reason: ' ' })).toThrow();
    expect(() => bindHomeDomainActionHttpRequestV1('home.public_profiles.handle_reclaim', { ...input, notice: '' })).toThrow();
  });
  it('recognizes only the exact confirmed transaction rollback response', () => {
    const body = { error: 'database_transaction_conflict_exhausted', statusCode: 503 };
    expect(readHomeDomainConfirmedRollbackV1(503, body)).toEqual({
      code: 'database_transaction_conflict_exhausted',
      details: body,
    });
    expect(readHomeDomainConfirmedRollbackV1(500, body)).toBeNull();
    expect(readHomeDomainConfirmedRollbackV1(503, { ...body, statusCode: 500 })).toBeNull();
    expect(readHomeDomainConfirmedRollbackV1(503, { ...body, extra: true })).toBeNull();
  });

  it('keeps organization deletion identities in the body required by the existing HTTP routes', () => {
    const tag = bindHomeDomainActionHttpRequestV1('session.tags.delete', { tagId: 'tag/a' });
    expect(tag.path).toBe('/v2/session-organization/tags/tag%2Fa');
    expect(DeleteSessionOrganizationTagRequestSchema.parse(tag.body)).toEqual({
      tagId: 'tag/a', assignmentBehavior: 'removeAssignments',
    });
  });

  const schema = z.strictObject({
    v: z.literal(1),
    teamId: z.string(),
    sourceId: z.string(),
    limit: z.optional(z.number().check(z.int())),
    query: z.optional(z.string()),
  });

  it('binds exact path parameters and remaining GET input as a query', () => {
    expect(bindHomeDomainHttpRequestV1({
      transport: { method: 'GET', path: '/v1/teams/:teamId/directory-sources/:sourceId/groups' },
      inputSchema: schema,
      input: { v: 1, teamId: 'team/a', sourceId: 'source b', limit: 25, query: 'R&D' },
    })).toEqual({
      method: 'GET',
      path: '/v1/teams/team%2Fa/directory-sources/source%20b/groups?limit=25&query=R%26D',
      body: undefined,
    });
  });

  it('keeps existing unbound POST input intact and rejects missing path values', () => {
    const input = { v: 1, teamId: 'team_1', sourceId: 'source_1' };
    expect(bindHomeDomainHttpRequestV1({
      transport: { method: 'POST', path: '/v1/teams/action' },
      inputSchema: schema,
      input,
    })).toEqual({ method: 'POST', path: '/v1/teams/action', body: input });
    expect(() => bindHomeDomainHttpRequestV1({
      transport: { method: 'GET', path: '/v1/teams/:missing' },
      inputSchema: schema,
      input,
    })).toThrow('missing');
  });
});
