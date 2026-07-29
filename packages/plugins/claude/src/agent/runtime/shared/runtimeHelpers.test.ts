import { describe, expect, it, vi } from 'vitest';

import {
  composeClaudeRuntimeEnvironment,
  observeClaudeProviderTaskActivity,
  readClaudeRuntimeConfigEffortUpdate,
  readClaudeRuntimeConfigUltracodeUpdate,
  readClaudeRuntimeDirectory,
  readClaudeRuntimeString,
} from './runtimeHelpers.js';
import { createClaudeProviderActivityLedger } from '../remote/sdk/providerActivity.js';

describe('Claude shared runtime helpers', () => {
  it('composes launch env with case-insensitive unsets and Windows replacement semantics', () => {
    expect(composeClaudeRuntimeEnvironment({
      inheritedEnvironment: {
        ANTHROPIC_API_KEY: 'ambient',
        Anthropic_Base_Url: 'ambient-url',
        POSIX_KEY: 'upper',
        posix_key: 'lower',
      },
      isolationEnvironment: { ANTHROPIC_BASE_URL: 'provider-url' },
      environment: { EMPTY: '' },
      unsetEnvKeys: ['anthropic_api_key'],
      platform: 'win32',
    })).toEqual({
      ANTHROPIC_BASE_URL: 'provider-url',
      POSIX_KEY: 'upper',
      posix_key: 'lower',
      EMPTY: '',
    });

    expect(composeClaudeRuntimeEnvironment({
      inheritedEnvironment: { Path: 'ambient', PATH: 'second' },
      environment: { PATH: 'explicit' },
      platform: 'posix',
    })).toEqual({ Path: 'ambient', PATH: 'explicit' });
  });

  it('distinguishes absent runtime config options from explicit effort clears', () => {
    expect(readClaudeRuntimeConfigEffortUpdate({})).toBeUndefined();
    expect(readClaudeRuntimeConfigEffortUpdate({ configOption: { id: 'reasoning_effort', value: '' } })).toBeNull();
    expect(readClaudeRuntimeConfigEffortUpdate({ configOption: { id: 'effort', value: 'xhigh' } })).toBe('xhigh');
    expect(readClaudeRuntimeConfigUltracodeUpdate({})).toBeUndefined();
    expect(readClaudeRuntimeConfigUltracodeUpdate({ configOption: { id: 'ultracode', value: 'false' } })).toBe(false);
  });

  it('normalizes string and directory inputs for both Claude runtime families', () => {
    expect(readClaudeRuntimeString('  value  ')).toBe('value');
    expect(readClaudeRuntimeString('   ')).toBeNull();
    expect(readClaudeRuntimeDirectory({ cwd: ' /repo ', directory: '/fallback' })).toBe('/repo');
  });

  it('keeps an untracked terminal inert instead of publishing synthetic unknown', () => {
    const publish = vi.fn(async () => {});

    expect(observeClaudeProviderTaskActivity({
      row: {
        type: 'system',
        subtype: 'task_notification',
        session_id: 'wrong-session',
        task_id: 'missing',
        status: 'completed',
      },
      ledger: createClaudeProviderActivityLedger(),
      runtimeActivityPublisher: {
        publish,
        subscribe: vi.fn(() => () => {}),
      },
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      logPrefix: '[test]',
    })).toBe(true);
    expect(publish).not.toHaveBeenCalled();
  });

  it('publishes a proven Workflow start as active and the last exact terminal as idle', () => {
    const publish = vi.fn(async () => {});
    const ledger = createClaudeProviderActivityLedger();
    const common = {
      ledger,
      runtimeActivityPublisher: {
        publish,
        subscribe: vi.fn(() => () => {}),
      },
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      logPrefix: '[test]',
    };

    expect(observeClaudeProviderTaskActivity({
      ...common,
      row: {
        type: 'system', subtype: 'task_started', session_id: 's1', task_id: 't1', task_type: 'local_workflow',
      },
    })).toBe(true);
    expect(publish).toHaveBeenLastCalledWith({ state: 'active', activeCount: 1 });

    expect(observeClaudeProviderTaskActivity({
      ...common,
      row: {
        type: 'system', subtype: 'task_notification', session_id: 's1', task_id: 't1', status: 'completed',
      },
    })).toBe(true);
    expect(publish).toHaveBeenLastCalledWith({ state: 'idle', activeCount: 0 });
  });

  it('publishes an exact sidechain StopFailure as the admitted task terminal', () => {
    const publish = vi.fn(async () => {});
    const ledger = createClaudeProviderActivityLedger();
    const common = {
      ledger,
      runtimeActivityPublisher: {
        publish,
        subscribe: vi.fn(() => () => {}),
      },
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      logPrefix: '[test]',
    };

    expect(observeClaudeProviderTaskActivity({
      ...common,
      row: {
        hook_event_name: 'PostToolUse',
        session_id: 's1',
        tool_name: 'Agent',
        tool_response: { status: 'async_launched', agentId: 'agent-1' },
      },
    })).toBe(true);
    expect(publish).toHaveBeenLastCalledWith({ state: 'active', activeCount: 1 });

    expect(observeClaudeProviderTaskActivity({
      ...common,
      row: {
        hook_event_name: 'StopFailure',
        session_id: 's1',
        agent_id: 'agent-1',
        error: 'authentication_failed',
      },
    })).toBe(true);
    expect(publish).toHaveBeenLastCalledWith({ state: 'idle', activeCount: 0 });
  });
});
