import { describe, expect, it } from 'vitest';
import { createExecutionRunPermissionHandler, resolveExecutionRunInputAuthority } from './executionRunPermissionDecision';
import { createRunScopedExecutionPermissionHandler } from './runScopedExecutionPermissionHandler';

describe('execution-run hands-off permission ceiling', () => {
  it('admits public inputs from Run policy and refuses missing private authority', () => {
    const publicInput = resolveExecutionRunInputAuthority({ permissionMode: 'read_only' });
    if (!publicInput.ok) throw new Error(publicInput.error);
    const handler = createExecutionRunPermissionHandler({ permissionMode: 'read_only', backendId: 'claude' });
    const context = { causalPermissionAuthority: publicInput.causalPermissionAuthority,
      callerPermissionMode: publicInput.effectiveCallerPermissionMode };
    expect(handler.getImmediateDecision('public-read', 'Read', { file_path: '/repo/a' }, context)).toEqual({ decision: 'approved' });
    expect(handler.getImmediateDecision('public-write', 'Write', { path: '/repo/a' }, context)).toEqual({ decision: 'denied' });
    expect(handler.getImmediateDecision('idle-read', 'Read', { file_path: '/repo/a' }, { causalPermissionAuthority: null })).toEqual({ decision: 'denied' });
    expect(resolveExecutionRunInputAuthority({ permissionMode: 'yolo', effectiveCallerPermissionMode: 'read-only' }))
      .toMatchObject({ ok: false, errorCode: 'execution_run_not_allowed', error: 'causal_permission_authority_invalid' });
    expect(resolveExecutionRunInputAuthority({ permissionMode: 'yolo', causalPermissionAuthority: null }))
      .toMatchObject({ ok: false, errorCode: 'execution_run_not_allowed', error: 'causal_permission_authority_invalid' });
  });

  it('keeps the original authority immutable while bounding later caller and Run modes', () => {
    const causalPermissionAuthority = Object.freeze({ kind: 'admittedSessionInputV1' as const, admittedPermissionCeiling: 'yolo' as const });
    expect(resolveExecutionRunInputAuthority({ permissionMode: 'read_only', causalPermissionAuthority, effectiveCallerPermissionMode: 'yolo' }))
      .toMatchObject({ ok: true, causalPermissionAuthority, effectiveCallerPermissionMode: 'read-only' });
    expect(resolveExecutionRunInputAuthority({ permissionMode: 'yolo', causalPermissionAuthority, effectiveCallerPermissionMode: 'read-only' }))
      .toMatchObject({ ok: true, causalPermissionAuthority, effectiveCallerPermissionMode: 'read-only' });
    expect(causalPermissionAuthority.admittedPermissionCeiling).toBe('yolo');
  });

  it('keeps retained native tools below the current caller mode without rewriting its original ceiling', () => {
    const handler = createExecutionRunPermissionHandler({ permissionMode: 'yolo', backendId: 'claude' });
    const causalPermissionAuthority = { kind: 'admittedSessionInputV1' as const, admittedPermissionCeiling: 'yolo' as const };
    const context = { causalPermissionAuthority, callerPermissionMode: 'read-only' };
    expect(handler.getImmediateDecision('write', 'Write', { path: '/repo/a' }, context)).toEqual({ decision: 'denied' });
    expect(handler.getImmediateDecision('read', 'Read', { file_path: '/repo/a' }, context)).toEqual({ decision: 'approved' });
    expect(causalPermissionAuthority.admittedPermissionCeiling).toBe('yolo');
  });

  it.each(['read-only', 'yolo'])('keeps listed builtin writes below the admitted read-only ceiling (%s)', (permissionMode) => {
    const handler = createExecutionRunPermissionHandler({ permissionMode, backendId: 'claude',
      allowedTools: ['Write', 'mcp__wilson-brief__*'], unlistedTools: 'deny' });
    const context = { causalPermissionAuthority: { kind: 'admittedSessionInputV1' as const, admittedPermissionCeiling: 'read-only' as const } };
    expect(handler.getImmediateDecision('write', 'Write', { path: '/repo/a' }, context)).toEqual({ decision: 'denied' });
    expect(handler.getImmediateDecision('mcp', 'mcp__wilson-brief__save_brief', {}, context)).toEqual({ decision: 'approved_for_session' });
  });

  it.each(['default', 'no_tools'])('checks semantic Happier Action effects before shared-safe tool approval (%s)', (permissionMode) => {
    const handler = createExecutionRunPermissionHandler({ permissionMode, backendId: 'codex' });
    const context = { causalPermissionAuthority: {
      kind: 'admittedSessionInputV1' as const, admittedPermissionCeiling: 'read-only' as const,
    } };
    for (const [tool, input] of [
      ['mcp__happier__session_stop', { sessionId: 'other-session' }],
      ['mcp__happier__settings_invoke', { anchor: 'voicePrivacy.forgetVoiceAgentMemory' }],
      ['mcp__happier__action_execute', { actionId: 'settings.set', input: { anchor: 'voiceConversations.minSpeechMs', value: 1100 } }],
    ] as const) {
      expect.soft(handler.getImmediateDecision(tool, tool, input, context)).toEqual({ decision: 'denied' });
      // Normal approval remains owned by the Action executor, with no second native Ask.
      expect(handler.getImmediateDecision(tool, tool, input)).toEqual({ decision: 'approved' });
    }
    expect(handler.getImmediateDecision('read', 'mcp__happier__settings_get',
      { anchor: 'voiceConversations.minSpeechMs' }, context)).toEqual({ decision: 'approved' });
  });

  it('retains the explicit legacy no_tools policy independently of its normalized mode', () => {
    const handler = createExecutionRunPermissionHandler({ permissionMode: 'no_tools', backendId: 'codex' });
    expect(handler.getImmediateDecision('safe', 'mcp__happier__session_stop', { sessionId: 'other-session' }))
      .toEqual({ decision: 'approved' });
    expect(handler.getImmediateDecision('dispatch', 'mcp__happier__action_execute',
      { actionId: 'settings.get', input: { anchor: 'voiceConversations.minSpeechMs' } })).toEqual({ decision: 'approved' });
    expect(handler.getImmediateDecision('write', 'Write', { path: '/repo/a' })).toEqual({ decision: 'denied' });
    expect(handler.getImmediateDecision('invalid', 'mcp__happier__session_stop', { sessionId: 'other-session' },
      { causalPermissionAuthority: null })).toEqual({ decision: 'denied' });
  });

  it('uses the attached Run policy ahead of parent grants and preserves parent denial', async () => {
    const parent = createExecutionRunPermissionHandler({ permissionMode: 'default', backendId: 'claude',
      workspaceWrites: 'deny', allowedTools: ['Glob', 'Read'] });
    const run = createRunScopedExecutionPermissionHandler({ runId: 'run', controllerOccurrenceId: 'occurrence',
      handler: { handleToolCall: parent.handleToolCall, abortPendingRequestAndFlush: parent.abortPendingRequestAndFlush },
      toolPolicy: { permissionMode: 'default', backendId: 'claude', workspaceWrites: 'deny',
        allowedTools: ['Read', 'Write'], unlistedTools: 'deny' } });
    expect(run.handler.getImmediateDecision?.('unlisted', 'Glob', { pattern: '*' })).toEqual({ decision: 'denied' });
    await expect(run.handler.handleToolCall('unlisted', 'Glob', { pattern: '*' })).resolves.toEqual({ decision: 'denied' });
    await expect(run.handler.handleToolCall('listed', 'Read', { file_path: '/repo/a' })).resolves.toEqual({ decision: 'approved_for_session' });
    await expect(run.handler.handleToolCall('parent-deny', 'Write', { path: '/repo/a' })).resolves.toEqual({ decision: 'denied' });
    await expect(run.handler.handleToolCall('causal-deny', 'Read', { file_path: '/repo/a' },
      { causalPermissionAuthority: null })).resolves.toEqual({ decision: 'denied' });
    await run.dispose('test completed');
  });

  it('denies every unlisted tool before permissive modes without publishing an approval', async () => {
    const handler = createExecutionRunPermissionHandler({ permissionMode: 'yolo', backendId: 'claude',
      allowedTools: ['mcp__wilson-brief__*'], unlistedTools: 'deny' });
    await expect(handler.handleToolCall('read', 'Read', { file_path: '/repo/secret' })).resolves.toEqual({ decision: 'denied' });
    await expect(handler.handleToolCall('coordination', 'mcp__happier__session_spawn_new', {})).resolves.toEqual({ decision: 'denied' });
    expect(handler.getImmediateDecision('listed', 'mcp__wilson-brief__save_brief', {})).toEqual({ decision: 'approved_for_session' });
  });

  it('pre-approves listed Run tools in the interactive mode and leaves others interactive by default', () => {
    const handler = createExecutionRunPermissionHandler({ permissionMode: 'default', backendId: 'claude',
      allowedTools: ['mcp__wilson-brief__*'] });
    expect(handler.getImmediateDecision('listed', 'mcp__wilson-brief__save_brief', {})).toEqual({ decision: 'approved_for_session' });
    expect(handler.getImmediateDecision('other', 'mcp__other__save_brief', {})).toBeNull();
  });

  it.each(['codex', 'opencode'])('denies %s writes and unsafe shell before YOLO while preserving coordination', async backendId => {
    const handler = createExecutionRunPermissionHandler({ permissionMode: 'yolo', backendId, workspaceWrites: 'deny' });
    await expect(handler.handleToolCall('write', 'Write', { path: '/repo/a' })).resolves.toEqual({ decision: 'denied' });
    await expect(handler.handleToolCall('native-write', 'write', { filePath: '/repo/a', content: 'changed' }))
      .resolves.toEqual({ decision: 'denied' });
    expect(handler.getImmediateDecision('shell', 'Bash', { command: 'git status > changed.txt' })).toEqual({ decision: 'denied' });
    expect(handler.getImmediateDecision('read', 'Bash', { command: 'git status' })).not.toEqual({ decision: 'denied' });
    expect(handler.getImmediateDecision('spawn', 'mcp__happier__session_spawn_new', {})).not.toEqual({ decision: 'denied' });
  });
});
