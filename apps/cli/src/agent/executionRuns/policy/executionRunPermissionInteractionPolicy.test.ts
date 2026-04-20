import { describe, expect, it } from 'vitest';

import {
  buildExecutionRunParentSessionPermissionRequestEnvelope,
  resolveExecutionRunPermissionInteractionMode,
} from './executionRunPermissionInteractionPolicy';

describe('resolveExecutionRunPermissionInteractionMode', () => {
  it('keeps review, plan, and memory_hints runs deterministic', () => {
    expect(resolveExecutionRunPermissionInteractionMode({
      intent: 'review',
      runClass: 'bounded',
      ioMode: 'request_response',
      retentionPolicy: 'ephemeral',
      permissionMode: 'safe-yolo',
    })).toBe('deterministic');

    expect(resolveExecutionRunPermissionInteractionMode({
      intent: 'plan',
      runClass: 'bounded',
      ioMode: 'request_response',
      retentionPolicy: 'ephemeral',
      permissionMode: 'safe-yolo',
    })).toBe('deterministic');

    expect(resolveExecutionRunPermissionInteractionMode({
      intent: 'memory_hints',
      runClass: 'bounded',
      ioMode: 'request_response',
      retentionPolicy: 'ephemeral',
      permissionMode: 'safe-yolo',
    })).toBe('deterministic');
  });

  it('routes delegate runs with a compatible parent session through the parent-session prompt mode', () => {
    expect(resolveExecutionRunPermissionInteractionMode({
      intent: 'delegate',
      runClass: 'long_lived',
      ioMode: 'streaming',
      retentionPolicy: 'resumable',
      permissionMode: 'safe-yolo',
      parentSessionId: 'parent-session-1',
      backendCapabilities: {
        canRespondToPermission: true,
        canSurfaceParentSessionPrompt: true,
      },
    })).toBe('prompt_in_parent_session');
  });

  it('falls back to deterministic behavior when there is no parent session', () => {
    expect(resolveExecutionRunPermissionInteractionMode({
      intent: 'delegate',
      runClass: 'long_lived',
      ioMode: 'streaming',
      retentionPolicy: 'resumable',
      permissionMode: 'safe-yolo',
    })).toBe('deterministic');
  });

  it('fails closed when a parent session exists but the backend cannot route permission responses', () => {
    expect(resolveExecutionRunPermissionInteractionMode({
      intent: 'voice_agent',
      runClass: 'long_lived',
      ioMode: 'streaming',
      retentionPolicy: 'resumable',
      permissionMode: 'safe-yolo',
      parentSessionId: 'parent-session-1',
      backendCapabilities: {
        canRespondToPermission: false,
        canSurfaceParentSessionPrompt: true,
      },
    })).toBe('fail_closed');
  });
});

describe('buildExecutionRunParentSessionPermissionRequestEnvelope', () => {
  it('canonicalizes the permission mode and carries the parent-session routing fields', () => {
    expect(buildExecutionRunParentSessionPermissionRequestEnvelope({
      sessionId: 'session-1',
      runId: 'run-1',
      callId: 'call-1',
      sidechainId: 'sidechain-1',
      backendId: 'opencode',
      runtimeKind: 'server',
      permissionMode: 'workspace_write',
      providerRequestId: 'provider-request-1',
      providerMetadata: { provider: 'opencode' },
      providerPayload: { toolName: 'bash', input: { command: 'echo hi' } },
      toolName: 'bash',
      reason: 'needs parent approval',
      createdAtMs: 123,
    })).toEqual(expect.objectContaining({
      sessionId: 'session-1',
      runId: 'run-1',
      callId: 'call-1',
      sidechainId: 'sidechain-1',
      backendId: 'opencode',
      runtimeKind: 'server',
      permissionMode: 'safe-yolo',
      providerRequestId: 'provider-request-1',
      providerMetadata: { provider: 'opencode' },
      providerPayload: { toolName: 'bash', input: { command: 'echo hi' } },
      toolName: 'bash',
      reason: 'needs parent approval',
      createdAtMs: 123,
    }));
  });
});
