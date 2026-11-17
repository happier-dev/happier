import { describe, expect, it } from 'vitest';

import {
  buildExecutionRunParentSessionPermissionRequestEnvelope,
  readExecutionRunPermissionResponseTarget,
  resolveExecutionRunPermissionInteractionMode,
} from './executionRunPermissionInteractionPolicy';

describe('resolveExecutionRunPermissionInteractionMode', () => {
  it.each(['attached', 'detached'] as const)('allows review questions with an %s response target while tools remain deterministic', (scope) => {
    const context = {
      intent: 'review', runClass: 'bounded', ioMode: 'request_response', retentionPolicy: 'ephemeral',
      permissionMode: 'read-only', parentSessionId: scope === 'attached' ? 'session-1' : null,
      interactionTargetAvailable: true,
      backendCapabilities: { canRespondToPermission: true, canSurfaceParentSessionPrompt: true },
    } as const;
    expect(resolveExecutionRunPermissionInteractionMode({ ...context, requestKind: 'question' })).toBe('prompt_in_execution_scope');
    expect(resolveExecutionRunPermissionInteractionMode(context)).toBe('deterministic');
    expect(resolveExecutionRunPermissionInteractionMode({ ...context, requestKind: 'question', parentSessionId: null, interactionTargetAvailable: false })).toBe('interaction_unavailable');
    expect(resolveExecutionRunPermissionInteractionMode({ ...context, requestKind: 'question', interactionTargetAvailable: false })).toBe('interaction_unavailable');
    expect(resolveExecutionRunPermissionInteractionMode({ ...context, requestKind: 'question', backendCapabilities: { canRespondToPermission: false, canSurfaceParentSessionPrompt: true } })).toBe('fail_closed');
  });

  it('keeps review, plan, and memory_hints runs deterministic', () => {
    expect(resolveExecutionRunPermissionInteractionMode({
      intent: 'review',
      runClass: 'bounded',
      ioMode: 'request_response',
      retentionPolicy: 'ephemeral',
      permissionMode: 'default',
    })).toBe('deterministic');

    expect(resolveExecutionRunPermissionInteractionMode({
      intent: 'plan',
      runClass: 'bounded',
      ioMode: 'request_response',
      retentionPolicy: 'ephemeral',
      permissionMode: 'default',
    })).toBe('deterministic');

    expect(resolveExecutionRunPermissionInteractionMode({
      intent: 'memory_hints',
      runClass: 'bounded',
      ioMode: 'request_response',
      retentionPolicy: 'ephemeral',
      permissionMode: 'default',
    })).toBe('deterministic');
  });

  it('routes delegate runs with a compatible parent session through the parent-session prompt mode', () => {
    expect(resolveExecutionRunPermissionInteractionMode({
      intent: 'delegate',
      runClass: 'long_lived',
      ioMode: 'streaming',
      retentionPolicy: 'resumable',
      permissionMode: 'default',
      parentSessionId: 'parent-session-1',
      backendCapabilities: {
        canRespondToPermission: true,
        canSurfaceParentSessionPrompt: true,
      },
    })).toBe('prompt_in_execution_scope');
  });

  it('reports unavailable when an interactive run has no durable interaction target', () => {
    expect(resolveExecutionRunPermissionInteractionMode({
      intent: 'delegate',
      runClass: 'long_lived',
      ioMode: 'streaming',
      retentionPolicy: 'resumable',
      permissionMode: 'default',
    })).toBe('interaction_unavailable');
  });

  it.each(['auto', 'safe-yolo', 'acceptEdits'])(
    'keeps the %s Auto alias deterministic without an interaction target',
    (permissionMode) => {
      expect(resolveExecutionRunPermissionInteractionMode({
        intent: 'agent',
        runClass: 'bounded',
        ioMode: 'request_response',
        retentionPolicy: 'ephemeral',
        permissionMode,
        parentSessionId: null,
      })).toBe('deterministic');
    },
  );

  it('routes a detached general Agent through its run-scoped interaction target', () => {
    expect(resolveExecutionRunPermissionInteractionMode({
      intent: 'agent',
      runClass: 'long_lived',
      ioMode: 'request_response',
      retentionPolicy: 'resumable',
      permissionMode: 'default',
      parentSessionId: null,
      interactionTargetAvailable: true,
      backendCapabilities: {
        canRespondToPermission: true,
        canSurfaceParentSessionPrompt: true,
      },
    })).toBe('prompt_in_execution_scope');
  });

  it('routes a bounded ephemeral detached Agent through its run-scoped interaction target', () => {
    expect(resolveExecutionRunPermissionInteractionMode({
      intent: 'agent',
      runClass: 'bounded',
      ioMode: 'request_response',
      retentionPolicy: 'ephemeral',
      permissionMode: 'default',
      parentSessionId: null,
      interactionTargetAvailable: true,
      backendCapabilities: {
        canRespondToPermission: true,
        canSurfaceParentSessionPrompt: true,
      },
    })).toBe('prompt_in_execution_scope');
  });

  it('fails closed when a parent session exists but the backend cannot route permission responses', () => {
    expect(resolveExecutionRunPermissionInteractionMode({
      intent: 'voice_agent',
      runClass: 'long_lived',
      ioMode: 'streaming',
      retentionPolicy: 'resumable',
      permissionMode: 'default',
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
    const envelope = buildExecutionRunParentSessionPermissionRequestEnvelope({
      sessionId: 'session-1',
      runId: 'run-1',
      callId: 'call-1',
      sidechainId: 'sidechain-1',
      backendId: 'opencode',
      runtimeKind: 'server',
      permissionMode: 'workspace_write',
      providerRequestId: 'provider-request-1',
      controllerOccurrenceId: 'occurrence-1',
      providerMetadata: { provider: 'opencode' },
      providerPayload: { toolName: 'bash', input: { command: 'echo hi' } },
      toolName: 'bash',
      reason: 'needs parent approval',
      createdAtMs: 123,
    });
    expect(envelope).toEqual(expect.objectContaining({
      sessionId: 'session-1',
      runId: 'run-1',
      callId: 'call-1',
      sidechainId: 'sidechain-1',
      backendId: 'opencode',
      runtimeKind: 'server',
      permissionMode: 'safe-yolo',
      providerRequestId: 'provider-request-1',
      controllerOccurrenceId: 'occurrence-1',
      providerMetadata: { provider: 'opencode' },
      providerPayload: { toolName: 'bash', input: { command: 'echo hi' } },
      toolName: 'bash',
      reason: 'needs parent approval',
      createdAtMs: 123,
    }));
    expect(envelope.responseTarget).toMatchObject({ controllerOccurrenceId: 'occurrence-1' });
  });

  it('parses predecessor targets without inventing controller occurrence authority', () => {
    expect(readExecutionRunPermissionResponseTarget({
      kind: 'execution_run_host_bridge',
      sessionId: 'session-1',
      runId: 'run-1',
      callId: 'call-1',
      sidechainId: 'sidechain-1',
      backendId: 'opencode',
      runtimeKind: 'server',
      providerRequestId: 'provider-request-1',
    })).toEqual({
      kind: 'execution_run_host_bridge',
      sessionId: 'session-1',
      runId: 'run-1',
      callId: 'call-1',
      sidechainId: 'sidechain-1',
      backendId: 'opencode',
      runtimeKind: 'server',
      providerRequestId: 'provider-request-1',
    });
  });
});
