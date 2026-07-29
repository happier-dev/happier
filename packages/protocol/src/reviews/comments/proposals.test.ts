import { describe, expect, it } from 'vitest';

import { ReviewCommentProposalV1Schema, ReviewCommentProposalsV1Schema } from './proposals.js';

describe('ReviewCommentProposalV1Schema', () => {
  it('accepts bounded comment material without persistence authority', () => {
    expect(ReviewCommentProposalV1Schema.parse({
      findingId: 'finding-1',
      body: 'Validate the redirect before use.',
      anchor: { kind: 'line', filePath: 'src/auth.ts', line: 12 },
      severity: 'error',
      taxonomyIds: ['security.redirect'],
      tags: ['coderabbit'],
    })).toEqual(expect.objectContaining({ findingId: 'finding-1' }));
  });

  it.each(['projectId', 'snapshot', 'principal', 'clientMutationId'])(
    'rejects plugin-supplied %s authority',
    (field) => {
      expect(ReviewCommentProposalV1Schema.safeParse({
        body: 'Finding',
        anchor: { kind: 'file', filePath: 'src/auth.ts' },
        [field]: field === 'snapshot' ? { kind: 'text' } : 'plugin-owned',
      }).success).toBe(false);
    },
  );

  it.each(['/etc/passwd', '../secret.ts', 'src/../../secret.ts', 'C:\\secret.ts'])(
    'rejects non-workspace-relative anchor path %s',
    (filePath) => {
      expect(ReviewCommentProposalV1Schema.safeParse({
        body: 'Finding',
        anchor: { kind: 'file', filePath },
      }).success).toBe(false);
    },
  );

  it('rejects proposal sets whose aggregate comment material exceeds the bounded envelope', () => {
    expect(ReviewCommentProposalsV1Schema.safeParse(Array.from({ length: 20 }, (_, index) => ({
      body: `${index}:${'x'.repeat(65_000)}`,
      anchor: { kind: 'file', filePath: `src/${index}.ts` },
    }))).success).toBe(false);
  });
});
