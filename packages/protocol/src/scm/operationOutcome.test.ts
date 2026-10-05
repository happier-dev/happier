import { describe, expect, it } from 'vitest';
import * as scm from './index.js';
import { ScmBranchCreateResponseSchema } from './branches.js';
import { REMOVE_INDEX_LOCK_CONFIRMATION_TOKEN } from './repositoryProvisioning.js';
import { ScmCommitPublicationSchema } from './commitPublication.js';

describe('SCM operation outcomes', () => {
  it('accepts verified index tree evidence only after successful publication and index reconciliation', () => {
    const publication = { state: 'published', expectedHeadOid: 'a'.repeat(40), expectedRef: 'refs/heads/main', candidateOid: 'b'.repeat(40), indexReconciliation: 'reconciled', indexTreeOid: 'c'.repeat(40) };
    expect(ScmCommitPublicationSchema.parse(publication)).toEqual(publication);
    for (const indexReconciliation of ['not_required', 'pending', 'failed']) expect(ScmCommitPublicationSchema.safeParse({ ...publication, indexReconciliation }).success).toBe(false);
    for (const state of ['not_published', 'unknown']) expect(ScmCommitPublicationSchema.safeParse({ ...publication, state }).success).toBe(false);
    expect(ScmCommitPublicationSchema.safeParse({ ...publication, indexTreeOid: 'not-an-oid' }).success).toBe(false);
    const { indexTreeOid: _legacyAbsent, ...legacyPublication } = publication;
    expect(ScmCommitPublicationSchema.safeParse(legacyPublication).success).toBe(true);
  });
  it('consumes publication truth without interpreting an unpublished candidate as a landed commit', () => {
    const publication = { state: 'published' as const, expectedHeadOid: 'a'.repeat(40), expectedRef: 'refs/heads/main', candidateOid: 'b'.repeat(40), indexReconciliation: 'failed' as const };
    expect(scm.normalizeScmOperationOutcome({ success: false, errorCode: 'INDEX_RECONCILIATION_FAILED', publication })).toMatchObject({ kind: 'effect_applied_with_warning', effect: { kind: 'commit', commitSha: publication.candidateOid } });
    expect(scm.normalizeScmOperationOutcome({ success: false, errorCode: 'INDEX_LOCKED', outcome: { v: 1, kind: 'failed', errorCode: 'INDEX_LOCKED', nextActions: [{ kind: 'retry' }] }, publication })).toMatchObject({ kind: 'effect_applied_with_warning', effect: { kind: 'commit', commitSha: publication.candidateOid }, nextActions: [{ kind: 'reconcile_index' }] });
    expect(scm.normalizeScmOperationOutcome({ success: false, outcome: scm.createScmOperationUnknownOutcome({ kind: 'repository_status' }), publication })).toMatchObject({ kind: 'effect_applied_with_warning', effect: { kind: 'commit', commitSha: publication.candidateOid } });
    expect(scm.normalizeScmOperationOutcome({ success: false, publication: { ...publication, state: 'unknown' } })).toMatchObject({ kind: 'outcome_unknown', reconciliation: { kind: 'commit', commitSha: publication.candidateOid } });
    expect(scm.normalizeScmOperationOutcome({ success: false, errorCode: 'COMMIT_HOOK_CONTENT_CHANGED', publication: { ...publication, state: 'not_published' } })).toMatchObject({ kind: 'needs_input' });
  });
  it('exposes existing mutation schemas and confirmation authority through the SCM facade', () => {
    expect(scm.ScmBranchCreateResponseSchema).toBe(ScmBranchCreateResponseSchema);
    expect(scm.REMOVE_INDEX_LOCK_CONFIRMATION_TOKEN).toBe(REMOVE_INDEX_LOCK_CONFIRMATION_TOKEN);
  });
  it('requires read-only reconciliation before repeating an uncertain mutation', () => {
    const reconciliation = { kind: 'remote_ref' as const, remote: 'upstream', branch: 'feature', expectedOid: 'abc' };
    expect(scm.createScmOperationUnknownOutcome(reconciliation)).toEqual({
      v: 1,
      kind: 'outcome_unknown',
      errorCode: 'COMMAND_OUTCOME_UNKNOWN',
      reconciliation,
      nextActions: [{ kind: 'refresh' }],
    });
  });

  it('requires proven effect identity for partial success and reconciliation for uncertain effects', () => {
    expect(scm.ScmOperationOutcomeSchema.safeParse({ kind: 'effect_applied_with_warning', errorCode: 'INDEX_RECONCILIATION_FAILED' }).success).toBe(false);
    expect(scm.ScmOperationOutcomeSchema.parse({ kind: 'effect_applied_with_warning', errorCode: 'INDEX_RECONCILIATION_FAILED', effect: { kind: 'commit', commitSha: 'abc123' } })).toMatchObject({ kind: 'effect_applied_with_warning' });
    expect(scm.ScmOperationOutcomeSchema.safeParse({ kind: 'outcome_unknown', errorCode: 'COMMAND_FAILED' }).success).toBe(false);
    expect(scm.ScmOperationOutcomeSchema.parse({ kind: 'outcome_unknown', errorCode: 'COMMAND_FAILED', reconciliation: { kind: 'repository_status', cwd: '/repo' } })).toMatchObject({ kind: 'outcome_unknown' });
  });

  it('rejects unknown mutation authority and impossible conflict continuation', () => {
    expect(scm.ScmOperationOutcomeSchema.safeParse({ kind: 'succeeded', hiddenAuthority: true }).success).toBe(false);
    expect(scm.ScmOperationOutcomeSchema.safeParse({ kind: 'succeeded', effect: { kind: 'commit', commitSha: 'abc', hiddenAuthority: true } }).success).toBe(false);
    expect(scm.ScmOperationStateSchema.safeParse({ kind: 'revert', unresolvedCount: 1, canContinue: true, canAbort: true }).success).toBe(false);
    expect(scm.ScmOperationOutcomeSchema.parse({ v: 1, kind: 'conflicted', errorCode: 'CONFLICTING_WORKTREE', repositoryState: { hasConflicts: true, operation: null } })).toMatchObject({ kind: 'conflicted', repositoryState: { operation: null } });
  });

  it('normalizes predecessor responses at the protocol seam without parsing prose', () => {
    expect(scm.normalizeScmOperationOutcome({ success: false, commitSha: 'abc123', errorCode: 'COMMAND_FAILED' })).toMatchObject({ kind: 'effect_applied_with_warning', effect: { kind: 'commit', commitSha: 'abc123' } });
    expect(scm.normalizeScmOperationOutcome({ success: false, errorCode: 'COMMAND_FAILED', error: 'automatic merge failed; could not resolve host' })).toMatchObject({ kind: 'failed', errorCode: 'COMMAND_FAILED' });
    expect(scm.normalizeScmOperationOutcome({ success: false, errorCode: 'REMOTE_AUTH_REQUIRED' })).toMatchObject({ kind: 'needs_input', errorCode: 'REMOTE_AUTH_REQUIRED' });
  });

  it('preserves explicit remote policy and rejects a lease without exact target authority', () => {
    const request = { remote: ' origin ', branch: ' main ', dirtyPolicy: 'autostash', reconcile: 'rebase', pushMode: 'force_with_lease', expectedRemoteOid: 'a'.repeat(40) } as const;
    expect(scm.normalizeScmRemoteRequest(request)).toMatchObject({ ok: true, request: { ...request, remote: 'origin', branch: 'main' } });
    expect(scm.ScmRemoteRequestSchema.safeParse({ pushMode: 'force_with_lease', expectedRemoteOid: 'a'.repeat(40) }).success).toBe(false);
  });

  it('classifies process diagnostics once at the canonical protocol mapper', () => {
    expect(scm.mapGitScmErrorCode('error: gpg failed to sign the data')).toBe('COMMIT_SIGNING_FAILED');
    expect(scm.mapGitScmErrorCode('Author identity unknown')).toBe('COMMIT_IDENTITY_REQUIRED');
    expect(scm.mapGitScmErrorCode("fatal: Unable to create '/repo/.git/index.lock': File exists")).toBe('INDEX_LOCKED');
    expect(scm.mapGitScmErrorCode('fatal: Could not resolve host: github.com')).toBe('REMOTE_NETWORK_FAILED');
  });

  it('classifies a lost remote response as a network failure for effect reconciliation', () => {
    for (const diagnostic of [
      'fatal: the remote end hung up unexpectedly',
      'send-pack: unexpected disconnect while reading sideband packet',
      'fatal: unable to access remote: Connection reset by peer',
    ]) {
      expect(scm.mapGitScmErrorCode(diagnostic)).toBe('REMOTE_NETWORK_FAILED');
    }
  });
});
