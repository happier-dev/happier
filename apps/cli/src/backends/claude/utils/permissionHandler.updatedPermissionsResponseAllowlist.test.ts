import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { SDKAssistantMessage } from '../sdk';
import type { EnhancedMode } from '../loop';
import { createPermissionHandlerSessionStub } from './permissionHandler.testkit';

vi.mock('@/lib', () => ({
  logger: {
    debug: vi.fn(),
    debugLargeJson: vi.fn(),
  },
}));

function bashToolUseMessage(id: string, command: string): SDKAssistantMessage {
  return {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }],
    },
  };
}

function shellToolUseMessage(id: string, toolName: string, command: string): SDKAssistantMessage {
  return {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id, name: toolName, input: { command } }],
    },
  };
}

function bashToolUseMessageArgv(id: string, argv: string[]): SDKAssistantMessage {
  return {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id, name: 'Bash', input: { command: argv } }],
    },
  };
}

const defaultMode = { permissionMode: 'default' } as EnhancedMode;

describe('PermissionHandler (updatedPermissions response allowlist)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('applies addRules updatedPermissions from permission responses to suppress future prompts', async () => {
    const { session, client } = createPermissionHandlerSessionStub('s1');
    const { PermissionHandler } = await import('./permissionHandler');
    const handler = new PermissionHandler(session);

    handler.onMessage(bashToolUseMessage('toolu_1', 'pwd'));

    const controller1 = new AbortController();
    const p1 = handler.handleToolCall('Bash', { command: 'pwd' }, defaultMode, { signal: controller1.signal });

    const permissionRpc = client.rpcHandlerManager.getHandler('permission');
    expect(permissionRpc).toBeDefined();

    await permissionRpc?.({
      id: 'toolu_1',
      approved: true,
      updatedPermissions: [
        {
          type: 'addRules',
          behavior: 'allow',
          destination: 'session',
          rules: [{ toolName: 'Bash', ruleContent: 'pwd' }],
        },
      ],
    } as any);

    await expect(p1).resolves.toEqual({
      behavior: 'allow',
      updatedInput: { command: 'pwd' },
      updatedPermissions: [
        {
          type: 'addRules',
          behavior: 'allow',
          destination: 'session',
          rules: [{ toolName: 'Bash', ruleContent: 'pwd' }],
        },
      ],
    });

    handler.onMessage(bashToolUseMessage('toolu_2', 'pwd'));

    const controller2 = new AbortController();
    const p2 = handler.handleToolCall('Bash', { command: 'pwd' }, defaultMode, { signal: controller2.signal });

    expect((client.agentState as any).requests?.toolu_2).toBeUndefined();
    await expect(p2).resolves.toEqual({ behavior: 'allow', updatedInput: { command: 'pwd' } });
  });

  it('suppresses prompts for shell-tool synonyms (Execute) after addRules prefix updates', async () => {
    const { session, client } = createPermissionHandlerSessionStub('s1');
    const { PermissionHandler } = await import('./permissionHandler');
    const handler = new PermissionHandler(session);

    handler.onMessage(shellToolUseMessage('toolu_1', 'Execute', 'unset FOO; pwd'));

    const controller1 = new AbortController();
    const p1 = handler.handleToolCall('Execute', { command: 'unset FOO; pwd' }, defaultMode, { signal: controller1.signal });

    const permissionRpc = client.rpcHandlerManager.getHandler('permission');
    expect(permissionRpc).toBeDefined();

    await permissionRpc?.({
      id: 'toolu_1',
      approved: true,
      updatedPermissions: [
        {
          type: 'addRules',
          behavior: 'allow',
          destination: 'session',
          rules: [{ toolName: 'Execute', ruleContent: 'pwd:*' }],
        },
      ],
    } as any);

    await expect(p1).resolves.toEqual({
      behavior: 'allow',
      updatedInput: { command: 'unset FOO; pwd' },
      updatedPermissions: [
        {
          type: 'addRules',
          behavior: 'allow',
          destination: 'session',
          rules: [{ toolName: 'Execute', ruleContent: 'pwd:*' }],
        },
      ],
    });

    handler.onMessage(shellToolUseMessage('toolu_2', 'Execute', 'unset BAR; pwd'));

    const controller2 = new AbortController();
    const p2 = handler.handleToolCall('Execute', { command: 'unset BAR; pwd' }, defaultMode, { signal: controller2.signal });

    expect((client.agentState as any).requests?.toolu_2).toBeUndefined();
    await expect(p2).resolves.toEqual({ behavior: 'allow', updatedInput: { command: 'unset BAR; pwd' } });
  });

  it('treats updatedPermissions toolName case-insensitively for shell tools', async () => {
    const { session, client } = createPermissionHandlerSessionStub('s1');
    const { PermissionHandler } = await import('./permissionHandler');
    const handler = new PermissionHandler(session);

    handler.onMessage(bashToolUseMessage('toolu_1', 'unset FOO; pwd'));

    const controller1 = new AbortController();
    const p1 = handler.handleToolCall('Bash', { command: 'unset FOO; pwd' }, defaultMode, { signal: controller1.signal });

    const permissionRpc = client.rpcHandlerManager.getHandler('permission');
    expect(permissionRpc).toBeDefined();

    await permissionRpc?.({
      id: 'toolu_1',
      approved: true,
      updatedPermissions: [
        {
          type: 'addRules',
          behavior: 'allow',
          destination: 'session',
          rules: [{ toolName: 'bash', ruleContent: 'pwd:*' }],
        },
      ],
    } as any);

    await expect(p1).resolves.toEqual({
      behavior: 'allow',
      updatedInput: { command: 'unset FOO; pwd' },
      updatedPermissions: [
        {
          type: 'addRules',
          behavior: 'allow',
          destination: 'session',
          rules: [{ toolName: 'bash', ruleContent: 'pwd:*' }],
        },
      ],
    });

    handler.onMessage(bashToolUseMessage('toolu_2', 'unset BAR; pwd'));

    const controller2 = new AbortController();
    const p2 = handler.handleToolCall('Bash', { command: 'unset BAR; pwd' }, defaultMode, { signal: controller2.signal });

    expect((client.agentState as any).requests?.toolu_2).toBeUndefined();
    await expect(p2).resolves.toEqual({ behavior: 'allow', updatedInput: { command: 'unset BAR; pwd' } });
  });

  it('suppresses prompts when Bash commands are represented as argv arrays', async () => {
    const { session, client } = createPermissionHandlerSessionStub('s1');
    const { PermissionHandler } = await import('./permissionHandler');
    const handler = new PermissionHandler(session);

    handler.onMessage(bashToolUseMessageArgv('toolu_1', ['bash', '-lc', 'unset FOO; find .']));

    const controller1 = new AbortController();
    const p1 = handler.handleToolCall('Bash', { command: ['bash', '-lc', 'unset FOO; find .'] }, defaultMode, { signal: controller1.signal });

    const permissionRpc = client.rpcHandlerManager.getHandler('permission');
    expect(permissionRpc).toBeDefined();

    await permissionRpc?.({
      id: 'toolu_1',
      approved: true,
      updatedPermissions: [
        {
          type: 'addRules',
          behavior: 'allow',
          destination: 'session',
          rules: [{ toolName: 'Bash', ruleContent: 'find:*' }],
        },
      ],
    } as any);

    await expect(p1).resolves.toEqual({
      behavior: 'allow',
      updatedInput: { command: ['bash', '-lc', 'unset FOO; find .'] },
      updatedPermissions: [
        {
          type: 'addRules',
          behavior: 'allow',
          destination: 'session',
          rules: [{ toolName: 'Bash', ruleContent: 'find:*' }],
        },
      ],
    });

    handler.onMessage(bashToolUseMessageArgv('toolu_2', ['bash', '-lc', 'unset BAR; find src']));

    const controller2 = new AbortController();
    const p2 = handler.handleToolCall('Bash', { command: ['bash', '-lc', 'unset BAR; find src'] }, defaultMode, { signal: controller2.signal });

    expect((client.agentState as any).requests?.toolu_2).toBeUndefined();
    await expect(p2).resolves.toEqual({ behavior: 'allow', updatedInput: { command: ['bash', '-lc', 'unset BAR; find src'] } });
  });

  it('does not apply allowlist side-effects from denied permission responses', async () => {
    const { session, client } = createPermissionHandlerSessionStub('s1');
    const { PermissionHandler } = await import('./permissionHandler');
    const handler = new PermissionHandler(session);

    handler.onMessage(bashToolUseMessage('toolu_denied_1', 'ls'));

    const controller1 = new AbortController();
    const denied = handler.handleToolCall('Bash', { command: 'ls' }, defaultMode, { signal: controller1.signal });

    const permissionRpc = client.rpcHandlerManager.getHandler('permission');
    expect(permissionRpc).toBeDefined();

    await permissionRpc?.({
      id: 'toolu_denied_1',
      approved: false,
      allowedTools: ['Bash(ls:*)'],
      updatedPermissions: [
        {
          type: 'addRules',
          behavior: 'allow',
          destination: 'session',
          rules: [{ toolName: 'Bash', ruleContent: 'ls:*' }],
        },
      ],
    } as any);

    await expect(denied).resolves.toMatchObject({ behavior: 'deny' });

    handler.onMessage(bashToolUseMessage('toolu_denied_2', 'ls src'));

    const controller2 = new AbortController();
    const pending = handler.handleToolCall('Bash', { command: 'ls src' }, defaultMode, { signal: controller2.signal });

    expect((client.agentState as any).requests?.toolu_denied_2).toBeDefined();
    controller2.abort();
    await expect(pending).rejects.toBeTruthy();
  });
});
