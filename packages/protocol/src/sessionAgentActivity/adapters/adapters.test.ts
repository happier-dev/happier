import { describe, expect, it } from 'vitest';

import { ExecutionRunStatusSchema, type ExecutionRunStatus } from '../../executionRunListRequest.js';
import {
  SessionWorkflowAgentStatusV1Schema,
  SessionWorkflowRunStatusV1Schema,
  type SessionWorkflowAgentStatusV1,
  type SessionWorkflowRunStatusV1,
} from '../../sessionWorkflowActivity/sessionWorkflowRunSnapshotV1.js';
import {
  AGENT_ACTIVITY_STATUSES_V1,
  type AgentActivityStatusV1,
} from '../agentActivityStatusV1.js';
import {
  SessionSubagentStatusSourceV1Schema,
  fromExecutionRunStatus,
  fromSubagentStatus,
  fromWorkflowAgentStatus,
  fromWorkflowRunStatus,
  type SessionSubagentStatusSourceV1,
} from './index.js';

/**
 * One case per source enum. `options` comes from each source's own schema, so a value added
 * upstream widens the iterated set automatically and fails `covers every source value` before it
 * can slip through as `unknown`. The `expected` tables are written by hand on purpose: they are the
 * mapping contract, and a silently re-pointed status fails its own row.
 */
const SOURCE_CASES = [
  {
    name: 'SessionWorkflowRunStatusV1',
    options: SessionWorkflowRunStatusV1Schema.options as readonly string[],
    adapt: (value: string) => fromWorkflowRunStatus(value as SessionWorkflowRunStatusV1),
    expected: {
      active: 'running',
      complete: 'succeeded',
      failed: 'failed',
      // A run reconciled after a CLI crash lands as `stopped`; it is a stop, never a failure.
      stopped: 'cancelled',
      blocked: 'blocked',
      cancelled: 'cancelled',
      unknown: 'unknown',
    } as Readonly<Record<string, AgentActivityStatusV1>>,
  },
  {
    name: 'SessionWorkflowAgentStatusV1',
    options: SessionWorkflowAgentStatusV1Schema.options as readonly string[],
    adapt: (value: string) => fromWorkflowAgentStatus(value as SessionWorkflowAgentStatusV1),
    expected: {
      pending: 'queued',
      active: 'running',
      complete: 'succeeded',
      failed: 'failed',
      blocked: 'blocked',
      cancelled: 'cancelled',
      unknown: 'unknown',
    } as Readonly<Record<string, AgentActivityStatusV1>>,
  },
  {
    name: 'SessionSubagentStatus',
    options: SessionSubagentStatusSourceV1Schema.options as readonly string[],
    adapt: (value: string) => fromSubagentStatus(value as SessionSubagentStatusSourceV1),
    expected: {
      running: 'running',
      succeeded: 'succeeded',
      failed: 'failed',
      // Distinct from `failed`: raise the budget vs read the error.
      timedOut: 'timedOut',
      cancelled: 'cancelled',
      // PLAN §4.2: `terminated` folds into `cancelled` rather than growing the vocabulary.
      terminated: 'cancelled',
      unknown: 'unknown',
    } as Readonly<Record<string, AgentActivityStatusV1>>,
  },
  {
    name: 'ExecutionRunStatus',
    options: ExecutionRunStatusSchema.options as readonly string[],
    adapt: (value: string) => fromExecutionRunStatus(value as ExecutionRunStatus),
    expected: {
      running: 'running',
      succeeded: 'succeeded',
      failed: 'failed',
      cancelled: 'cancelled',
      // R-2 / defect D-1: a timed-out run must never render as succeeded.
      timeout: 'timedOut',
    } as Readonly<Record<string, AgentActivityStatusV1>>,
  },
] as const;

describe('agent-activity status adapters', () => {
  it.each(SOURCE_CASES.map((testCase) => [testCase.name, testCase] as const))(
    '%s: the expected table covers every source value',
    (_name, testCase) => {
      expect(Object.keys(testCase.expected).sort()).toEqual([...testCase.options].sort());
    },
  );

  for (const testCase of SOURCE_CASES) {
    describe(testCase.name, () => {
      it.each([...testCase.options])('maps %s to its declared status', (value) => {
        const mapped = testCase.adapt(value);
        expect(AGENT_ACTIVITY_STATUSES_V1).toContain(mapped);
        expect(mapped).toBe(testCase.expected[value]);
      });

      it('never degrades a known source value to unknown', () => {
        // A `default: return 'unknown'` arm would pass "maps to a defined status" while silently
        // erasing a new provider state. Only a source value that IS `unknown` may map to it.
        for (const value of testCase.options) {
          if (value === 'unknown') {
            continue;
          }
          expect(testCase.adapt(value)).not.toBe('unknown');
        }
      });
    });
  }

  it('maps an execution-run timeout to timedOut, never succeeded (R-2 / D-1)', () => {
    expect(fromExecutionRunStatus('timeout')).toBe('timedOut');
    expect(fromExecutionRunStatus('timeout')).not.toBe('succeeded');
  });

  it('keeps the subagent source vocabulary in step with its UI owner', () => {
    // Mirror of `SessionSubagentStatus` at
    // apps/ui/sources/sync/domains/session/subagents/types.ts:4 — protocol cannot import from
    // apps/ui, so this list is the boundary contract that UI call sites are checked against.
    expect(SessionSubagentStatusSourceV1Schema.options).toEqual([
      'running',
      'succeeded',
      'failed',
      'timedOut',
      'cancelled',
      'terminated',
      'unknown',
    ]);
  });
});
