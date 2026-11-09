import { describe, expect, it } from 'vitest';
import { readHappierActionToolFailure, readHappierActionToolPayload } from './happierActionToolResult.js';

/** The MCP text envelope an Agent's transcript stores for a first-party Action call. */
function mcpTextResult(payload: unknown) {
  const text = JSON.stringify(payload);
  return {
    content: [{ type: 'text', text }],
    structuredContent: null,
    text,
    _mcp: { serverId: 'happier', toolId: 'action_execute' },
    _happier: { v: 2, protocol: 'acp', provider: 'codex', rawToolName: 'mcp__happier__action_execute' },
  };
}
const input = { actionId: 'session.stop', input: { sessionId: 's1' } };

describe('readHappierActionToolFailure', () => {
  it('reads the Action operand from current qualified tool provenance', () => {
    const operand = { actionId: 'session.stop', input: { sessionId: 's1' } };
    expect(readHappierActionToolPayload({
      ...operand,
      _happier: {
        v: 3,
        protocol: 'native',
        agent: { pluginId: 'example.agent', localId: 'fixture' },
        rawToolName: 'mcp__happier__action_execute',
        canonicalToolName: 'MCP',
      },
      _raw: { truncatedPreview: true },
    })).toEqual(operand);
  });

  it('reads the host SubAgentRun terminal failure without treating a successful result or another tool as a failure', () => {
    const result = { status: 'failed', runId: 'run_1', callId: 'call_1', sidechainId: 'call_1',
      error: { code: 'codex_tool_restriction_unsupported_auth', message: 'Codex cannot enforce this policy.' } };
    expect(readHappierActionToolFailure('SubAgentRun', { runId: 'run_1' }, result)).toEqual({
      code: 'codex_tool_restriction_unsupported_auth', cause: null, message: 'Codex cannot enforce this policy.',
    });
    expect(readHappierActionToolFailure('SubAgentRun', { runId: 'run_1' }, { ...result, status: 'succeeded' })).toBeNull();
    expect(readHappierActionToolFailure('mcp__other__run', {}, result)).toBeNull();
  });
  it('reads a typed Action failure and its cause from the MCP text envelope', () => {
    const result = mcpTextResult({
      errorCode: 'unsupported_action', error: 'unsupported_action:session.stop', details: { cause: 'target_outside_led_subtree' },
    });
    expect(readHappierActionToolFailure('mcp__happier__action_execute', input, result)).toEqual({
      code: 'unsupported_action', cause: 'target_outside_led_subtree', message: null,
    });
  });

  it('reads the reason of a failure that names one instead of a cause', () => {
    const result = mcpTextResult({ errorCode: 'target_unavailable', error: 'target_unavailable', details: { reason: 'external_authorization_refused' } });
    expect(readHappierActionToolFailure('mcp__happier__action_execute', input, result)).toEqual({
      code: 'target_unavailable', cause: 'external_authorization_refused', message: null,
    });
  });

  it('reads a typed spawn error by its launch code', () => {
    const result = mcpTextResult({ type: 'error', code: 'spawn_failed', retryable: true,
      launchError: { kind: 'launch_error', code: 'database_transaction_conflict_exhausted', message: 'Failed to get or create session' } });
    expect(readHappierActionToolFailure('mcp__happier__action_execute', input, result)).toEqual({
      code: 'database_transaction_conflict_exhausted', cause: null, message: null,
    });
  });

  it('does not read a pending acceptance or a successful result as a failure', () => {
    expect(readHappierActionToolFailure('mcp__happier__action_execute', input,
      mcpTextResult({ type: 'pending', retryWithSameCreationKey: true, outcome: 'accepted' }))).toBeNull();
    expect(readHappierActionToolFailure('mcp__happier__action_execute', input,
      mcpTextResult({ workState: { v: 1, items: [] } }))).toBeNull();
  });

  it('only reads first-party Happier tools, never another MCP server that returns the same keys', () => {
    const result = mcpTextResult({ errorCode: 'target_unavailable', error: 'target_unavailable' });
    expect(readHappierActionToolFailure('mcp__linear__create_issue', {}, result)).toBeNull();
  });
});
