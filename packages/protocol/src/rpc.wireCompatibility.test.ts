import { describe, expect, it } from 'vitest';

import {
  RPC_ERROR_CODES,
  RPC_ERROR_MESSAGES,
  RPC_METHODS,
  SESSION_RPC_METHODS,
  isRpcMethodNotFoundResult,
} from './rpc.js';

describe('rpc wire compatibility', () => {
  it('pins negotiation literals used by mixed-version daemon and ui clients', () => {
    expect(RPC_ERROR_CODES).toEqual({
      METHOD_NOT_AVAILABLE: 'RPC_METHOD_NOT_AVAILABLE',
      METHOD_NOT_FOUND: 'RPC_METHOD_NOT_FOUND',
    });
    expect(RPC_ERROR_MESSAGES).toEqual({
      METHOD_NOT_AVAILABLE: 'RPC method not available',
      METHOD_NOT_FOUND: 'Method not found',
    });
  });

  it('treats both legacy message-only and current coded method-not-found results as unsupported', () => {
    expect(isRpcMethodNotFoundResult({
      errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND,
      error: 'future daemon payload',
    })).toBe(true);
    expect(isRpcMethodNotFoundResult({
      error: RPC_ERROR_MESSAGES.METHOD_NOT_FOUND,
    })).toBe(true);
    expect(isRpcMethodNotFoundResult({
      error: `${RPC_ERROR_MESSAGES.METHOD_NOT_FOUND}: daemon.executionRuns.list`,
    })).toBe(false);
  });

  it('pins execution-run and replay method literals consumed across rpc boundaries', () => {
    expect(RPC_METHODS.DAEMON_EXECUTION_RUNS_LIST).toBe('daemon.executionRuns.list');
    expect(RPC_METHODS.SESSION_CONTINUE_WITH_REPLAY).toBe('session.continueWithReplay');
    expect(RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE).toBe(
      'daemon.extensions.contributionRegistryProjection.describe',
    );
    expect(SESSION_RPC_METHODS.EXECUTION_RUN_START).toBe('execution.run.start');
    expect(SESSION_RPC_METHODS.EXECUTION_RUN_LIST).toBe('execution.run.list');
  });
});
