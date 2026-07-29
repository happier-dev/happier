import { describe, expect, it } from 'vitest';

import { buildExecutionRunProfileCatalog } from '@/agent/executionRuns/profiles/intentRegistry';

import { getExecutionRunAvailableActionIds } from './availableActionIds';
import type { ExecutionRunState } from './executionRunTypes';

describe('getExecutionRunAvailableActionIds', () => {
  it('exposes retained review proposals only for the matching succeeded run', () => {
    const catalog = buildExecutionRunProfileCatalog([{
      pluginId: 'happier.review.coderabbit',
      definition: {
        id: 'review', intent: 'review', title: 'Review', promptAsset: 'review-prompt', compatibleAgents: ['coderabbit'],
        defaults: { retention: 'ephemeral', runClass: 'bounded', io: 'streaming' },
        actions: [{ kind: 'hostAction', actionId: 'reviews.comments.create' }],
      },
    }]);
    const run = {
      runId: 'run_1', callId: 'call_1', sidechainId: 'call_1', sessionId: 'session_1', depth: 0,
      intent: 'review', profileId: 'happier.review.coderabbit/review',
      backendTarget: { kind: 'builtInAgent', agentId: 'coderabbit' }, backendId: 'coderabbit',
      instructions: 'Review', permissionMode: 'read_only', retentionPolicy: 'ephemeral',
      runClass: 'bounded', ioMode: 'request_response', startedAtMs: 1,
      structuredMeta: { kind: 'review_findings.v2', payload: {
        runRef: { runId: 'other_run', callId: 'call_1', backendId: 'coderabbit' },
        proposedComments: [{ body: 'x', anchor: { kind: 'file', filePath: 'src/a.ts' } }],
      } }, status: 'succeeded',
    } as ExecutionRunState;
    expect(getExecutionRunAvailableActionIds(run, null, catalog)).not.toContain('reviews.comments.create');
    expect(getExecutionRunAvailableActionIds({
      ...run, status: 'running', structuredMeta: { ...run.structuredMeta!, payload: {
        ...(run.structuredMeta!.payload as object), runRef: { runId: 'run_1', callId: 'call_1', backendId: 'coderabbit' },
      } },
    }, null, catalog)).not.toContain('reviews.comments.create');
  });
  it('uses contributed execution-run profiles through the profile-id catalog lookup', () => {
    const catalog = buildExecutionRunProfileCatalog([
      {
        id: 'acme-review-profile',
        title: 'Acme review',
        promptAsset: 'review-prompt',
        intent: 'review',
        compatibleAgents: ['claude'],
        defaults: { retention: 'ephemeral', runClass: 'bounded', io: 'streaming' },
        actions: [{ kind: 'contributionAction', action: 'acme-review-promote' }],
      },
    ]);
    const run: ExecutionRunState & Readonly<{ profileId: string }> = {
      runId: 'run_1',
      callId: 'call_1',
      sidechainId: 'sidechain_1',
      sessionId: 'session_1',
      depth: 0,
      intent: 'review',
      profileId: 'acme-review-profile',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      backendId: 'claude',
      instructions: 'Review this change',
      permissionMode: 'default',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
      structuredMeta: { kind: 'review_findings.v2', payload: {} },
      status: 'running',
      startedAtMs: 1,
    };

    expect(getExecutionRunAvailableActionIds(run, null, catalog)).toContain('acme-review-promote');
  });
});
