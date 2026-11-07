import { describe, expect, it } from 'vitest';
import { readForgeOperationStateV1 } from './operationState.js';

describe('shared provider repair and write uncertainty', () => {
  it('offers repair only for expired authentication and retains the exact account', () => {
    const account = { service: { pluginId: 'happier.scm-github', localId: 'github' }, accountId: 'selected' };
    const state = readForgeOperationStateV1({ failure: { class: 'authentication', code: 'expired' }, account, hasRetainedValue: true });
    expect(state).toMatchObject({ kind: 'credentials-expired', account, stale: true, recovery: 'repairAccount' });
    expect(readForgeOperationStateV1({ failure: { class: 'permission', code: 'denied' }, account, hasRetainedValue: true })).toMatchObject({ kind: 'failure', recovery: 'none' });
    expect(readForgeOperationStateV1({ failure: { class: 'transient', code: 'offline' }, account, hasRetainedValue: false })).toMatchObject({ kind: 'failure', recovery: 'none' });
  });

  it('keeps a possibly-applied effect uncertain and only admits safe readback, never replay', () => {
    const state = readForgeOperationStateV1({
      mutation: { kind: 'outcome_unknown', affected: { repository: { kind: 'github', deployment: 'https://github.com', repository: 'owner/repository' }, workflowId: 'ci' }, webUrl: 'https://github.com/owner/repository/actions/workflows/ci.yml' },
      hasRetainedValue: true,
    });
    expect(state).toMatchObject({ kind: 'uncertain-write-outcome', recovery: 'readStatus', stale: true, targetUrl: 'https://github.com/owner/repository/actions/workflows/ci.yml' });
    expect(state).not.toHaveProperty('retry');
    // A successful unrelated read cannot establish the original write's outcome.
    expect(readForgeOperationStateV1({ mutation: { kind: 'outcome_unknown', affected: { repository: { kind: 'github', deployment: 'https://github.com', repository: 'owner/repository' } } }, hasRetainedValue: true }).kind).toBe('uncertain-write-outcome');
  });

  it('preserves canonical unknown downloads and exact dispatch operands without claiming saved bytes', () => {
    expect(readForgeOperationStateV1({ download: { success: false, status: 'unknown', error: 'Transfer response lost' }, hasRetainedValue: false })).toMatchObject({ kind: 'uncertain-write-outcome', recovery: 'readStatus', targetUrl: null });
    expect(readForgeOperationStateV1({ mutation: { kind: 'outcome_unknown', affected: { repository: { kind: 'github', deployment: 'https://github.com', repository: 'owner/repository' }, workflowId: 'ci', ref: 'main' } }, hasRetainedValue: true })).toMatchObject({ outcome: { affected: { workflowId: 'ci', ref: 'main' } } });
  });

  it('retains a failed download and its detail without classifying a chosen cancellation as failure', () => {
    const download = { success: false, status: 'failed', error: 'The destination is read-only', errorCode: 'EACCES' } as const;
    const state = readForgeOperationStateV1({ download, hasRetainedValue: true });
    expect(state).toMatchObject({ kind: 'failure', download, stale: true, recovery: 'none' });
    expect(readForgeOperationStateV1({ download: { success: false, status: 'cancelled', error: 'Picker dismissed' }, hasRetainedValue: true }).kind).toBe('ready');
  });

  it('retains an uncertain release identity at the same shared state owner', () => {
    const mutation = { kind: 'outcome_unknown', releaseId: '7', webUrl: 'https://github.com/acme/widgets/releases/7' } as const;
    const state = readForgeOperationStateV1({ mutation, hasRetainedValue: true });
    expect(state).toMatchObject({ kind: 'uncertain-write-outcome', recovery: 'readStatus', targetUrl: mutation.webUrl, stale: true });
    if (state.kind === 'uncertain-write-outcome') expect(state.outcome).toBe(mutation);
    expect(state).not.toHaveProperty('retry');
  });
});
