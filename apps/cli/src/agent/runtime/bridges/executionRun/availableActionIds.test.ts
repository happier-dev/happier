import { describe, expect, it } from 'vitest';

import { buildExecutionRunProfileCatalog } from '@/agent/executionRuns/profiles/intentRegistry';

import { getExecutionRunAvailableActionIds } from './availableActionIds';
import type { ExecutionRunState } from './executionRunTypes';

describe('getExecutionRunAvailableActionIds', () => {
  it('uses contributed execution-run profiles through the profile-id catalog lookup', () => {
    const catalog = buildExecutionRunProfileCatalog([
      {
        id: 'acme.review.profile',
        kind: 'executionRun.profile',
        version: '1.0.0',
        intent: 'review',
        displayKey: 'plugins.acme.executionRuns.review.label',
        capabilityGates: [],
        permissionGates: [],
        redaction: 'none',
        hidden: false,
        actionIds: ['acme.review.promote'],
      },
    ]);
    const run: ExecutionRunState & Readonly<{ profileId: string }> = {
      runId: 'run_1',
      callId: 'call_1',
      sidechainId: 'sidechain_1',
      sessionId: 'session_1',
      depth: 0,
      intent: 'review',
      profileId: 'acme.review.profile',
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

    expect(getExecutionRunAvailableActionIds(run, null, catalog)).toContain('acme.review.promote');
  });
});
