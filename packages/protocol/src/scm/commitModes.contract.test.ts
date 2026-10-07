import { describe, expect, it } from 'vitest';
import {
  SCM_COMMIT_MESSAGE_MAX_LENGTH,
  ScmCommitCreateRequestSchema,
  ScmCommitCreateResponseSchema,
  ScmOperationErrorCodeSchema,
  classifyScmOperationErrorCode,
  createScmCapabilities,
  admitScmCommitPolicy,
} from './index.js';
import { ScmBackendCommitCapabilitiesSchema } from './backendCapabilities.js';

describe('explicit commit modes', () => {
  it('admits uncapped nonblank prepared-plan messages while retaining ordinary message admission', () => {
    const message = 'm'.repeat(SCM_COMMIT_MESSAGE_MAX_LENGTH + 1);
    const prepared = {
      message,
      expectedHeadOid: 'a'.repeat(40),
      expectedRef: 'refs/heads/main',
      expectedCandidateTreeOid: 'b'.repeat(40),
      preparedTreeOid: 'b'.repeat(40),
    };
    expect(ScmCommitCreateRequestSchema.parse(prepared)).toEqual(prepared);
    expect(ScmCommitCreateRequestSchema.safeParse({ ...prepared, message: ' \n\t ' }).success).toBe(false);
    expect(ScmCommitCreateRequestSchema.safeParse({ message }).success).toBe(false);
    expect(ScmCommitCreateRequestSchema.parse({ message: message.slice(1) })).toEqual({ message: message.slice(1) });
    expect(ScmCommitCreateRequestSchema.parse({ message: '' })).toEqual({ message: '' });
  });
  it('requires exact-tree plan authority and advertised safe-plan support while preserving ordinary callers', () => {
    const request = { message: 'planned', expectedHeadOid: 'a'.repeat(40), expectedRef: 'refs/heads/main', expectedCandidateTreeOid: 'b'.repeat(40), acceptedHookTreeOid: 'c'.repeat(40) };
    expect(ScmCommitCreateRequestSchema.safeParse(request).success).toBe(true);
    expect(ScmCommitCreateRequestSchema.safeParse({ ...request, expectedRef: undefined }).success).toBe(false);
    expect(ScmCommitCreateRequestSchema.safeParse({ ...request, expectedCandidateTreeOid: undefined }).success).toBe(false);
    expect(ScmCommitCreateRequestSchema.safeParse({ ...request, mode: 'amend' }).success).toBe(false);
    expect(admitScmCommitPolicy(request, createScmCapabilities({ writeCommitExpectedBase: true }))).toMatchObject({ success: false, errorCode: 'FEATURE_UNSUPPORTED' });
    expect(admitScmCommitPolicy(request, createScmCapabilities({ writeCommitExpectedBase: true, ...{ writeCommitSafePlan: true } }))).toEqual({ success: true });
    const prepared = { message: request.message, expectedHeadOid: request.expectedHeadOid, expectedRef: request.expectedRef,
      expectedCandidateTreeOid: request.expectedCandidateTreeOid, preparedTreeOid: request.expectedCandidateTreeOid };
    expect(ScmCommitCreateRequestSchema.safeParse(prepared).success).toBe(true);
    expect(ScmCommitCreateRequestSchema.safeParse({ ...prepared, expectedIndexTreeOid: 'e'.repeat(40) }).success).toBe(true);
    expect(ScmCommitCreateRequestSchema.safeParse({ ...request, expectedIndexTreeOid: 'e'.repeat(40) }).success).toBe(false);
    expect(ScmCommitCreateRequestSchema.safeParse({ ...prepared, expectedIndexTreeOid: 'invalid' }).success).toBe(false);
    expect(ScmCommitCreateRequestSchema.safeParse({ ...prepared, expectedCandidateTreeOid: undefined }).success).toBe(false);
    expect(ScmCommitCreateRequestSchema.safeParse({ ...prepared, preparedTreeOid: 'd'.repeat(40) }).success).toBe(false);
    expect(ScmCommitCreateRequestSchema.safeParse({ ...prepared, scope: { kind: 'all-pending' } }).success).toBe(false);
    expect(admitScmCommitPolicy(prepared, createScmCapabilities({ writeCommitExpectedBase: true }))).toMatchObject({ success: false, errorCode: 'FEATURE_UNSUPPORTED' });
  });
  it('retains an explicit captured base and typed publication while accepting predecessor requests', () => {
    const request = { message: 'commit', expectedHeadOid: 'a'.repeat(40), expectedRef: 'refs/heads/main' };
    expect(ScmCommitCreateRequestSchema.parse(request)).toEqual(request);
    expect(ScmCommitCreateRequestSchema.parse({ message: 'predecessor commit' })).toEqual({ message: 'predecessor commit' });
    expect(ScmCommitCreateRequestSchema.parse({ message: 'root', expectedHeadOid: null, expectedRef: null })).toMatchObject({ expectedHeadOid: null, expectedRef: null });
    const publication = { state: 'published', expectedHeadOid: request.expectedHeadOid, expectedRef: request.expectedRef, candidateOid: 'b'.repeat(40), actualMessage: 'rewritten', indexReconciliation: 'failed' };
    expect(ScmCommitCreateResponseSchema.parse({ success: false, publication })).toMatchObject({ publication });
    expect(ScmCommitCreateResponseSchema.safeParse({ success: false, publication: { ...publication, hiddenAuthority: true } }).success).toBe(false);
  });
  it('preserves amend, independent sign-off and published-head acknowledgment', () => {
    const request = { message: 'Revise the commit', mode: 'amend', signOff: true, allowPublishedAmend: true };
    expect(ScmCommitCreateRequestSchema.parse(request)).toEqual(request);
    expect(ScmOperationErrorCodeSchema.safeParse('COMMIT_AMEND_PUBLISHED').success).toBe(true);
    expect(classifyScmOperationErrorCode('COMMIT_AMEND_PUBLISHED')).toBe('commit');
    expect(classifyScmOperationErrorCode('COMMIT_UNDO_PUBLISHED')).toBe('commit');
    expect(ScmCommitCreateRequestSchema.safeParse({ message: 'New commit', allowPublishedAmend: true }).success).toBe(false);
    expect(ScmCommitCreateRequestSchema.safeParse({ message: 'New commit', mode: 'automatic' }).success).toBe(false);
  });

  it('requires advertised commit-option support instead of inheriting ordinary commit support', () => {
    expect(createScmCapabilities()).toMatchObject({ writeCommitAmend: false, writeCommitSignOff: false });
    expect(ScmBackendCommitCapabilitiesSchema.parse({
      create: { support: 'supported' },
      amend: { support: 'supported' },
      signOff: { support: 'supported' },
    })).toMatchObject({ amend: { support: 'supported' }, signOff: { support: 'supported' } });
  });
  it('requires explicit-base capability instead of silently ignoring mutation authority', () => {
    const request = { expectedHeadOid: 'a'.repeat(40), expectedRef: 'refs/heads/main' };
    expect(admitScmCommitPolicy(request, createScmCapabilities({ writeCommit: true }))).toMatchObject({ success: false, errorCode: 'FEATURE_UNSUPPORTED' });
    expect(admitScmCommitPolicy({ expectedHeadOid: null, expectedRef: null })).toMatchObject({ success: false });
    expect(admitScmCommitPolicy(request, createScmCapabilities({ writeCommitExpectedBase: true }))).toEqual({ success: true });
    expect(ScmCommitCreateRequestSchema.safeParse({ message: 'commit', hiddenAuthority: true }).success).toBe(false);
    expect(ScmCommitCreateRequestSchema.safeParse({ message: 'commit', scope: { kind: 'all-pending', hiddenAuthority: true } }).success).toBe(false);
  });
});
