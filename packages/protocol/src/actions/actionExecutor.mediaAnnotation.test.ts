import { describe, expect, it } from 'vitest';
import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';
import { isAgentInitiatedApprovalRequiredByDefault } from './actionApprovalPolicy.js';
import { MediaAnnotationTargetV1Schema } from './mediaAnnotationAction.js';
import type { ActionId } from './actionIds.js';

const scope = { serverId: 'home-a', accountId: 'account-a' };
const target = { kind: 'composerAttachment', ref: { kind: 'newSession', instanceId: 'composer-a' }, attachmentId: 'picture-a' };

describe('media annotation Action boundary', () => {
  it('addresses an open still capture by its required reference', async () => {
    const executor = createActionExecutor({ mediaAnnotation: async () => ({ status: 'replaced' }) } as ActionExecutorDeps);
    const context = { surface: 'agent' as const, serverId: scope.serverId, runtimeAccountId: scope.accountId };
    expect(await executor.execute('media.annotation.apply', { scope,
      target: { kind: 'capture', captureRef: 'still-a' }, operations: [{ kind: 'reset' }] }, context))
      .toEqual({ ok: true, result: { status: 'replaced' } });
    expect(await executor.execute('media.annotation.read', { scope, target: { kind: 'capture' } }, context))
      .toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
    expect(await executor.execute('media.annotation.apply', { scope,
      target: { kind: 'capture', captureRef: 'still-a' }, reset: true, into: { sessionId: 'copy' } }, context))
      .toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
  });
  it('admits recording-frame marks at a source timestamp without a copy destination', async () => {
    expect(MediaAnnotationTargetV1Schema.safeParse({ kind: 'recordingFrame', captureRef: 'movie', sourceTimeMs: 1234.5 }).success).toBe(false);
    const executor = createActionExecutor({ mediaAnnotation: async () => ({ status: 'replaced' }) } as ActionExecutorDeps);
    expect(await executor.execute('media.annotation.apply', { scope,
      target: { kind: 'recordingFrame', captureRef: 'movie', sourceTimeMs: 1500 }, operations: [{ kind: 'reset' }] },
      { surface: 'agent', serverId: scope.serverId, runtimeAccountId: scope.accountId }))
      .toEqual({ ok: true, result: { status: 'replaced' } });
  });
  it('dispatches admitted marks without requiring agent approval', async () => {
    const executor = createActionExecutor({
      mediaAnnotation: async () => ({ status: 'replaced' }),
    } as ActionExecutorDeps);
    expect(await executor.execute('media.annotation.apply' as ActionId, { scope, target, operations: [
      { kind: 'mark.add', mark: { id: 'arrow-a', kind: 'arrow', from: { x: 1, y: 2 }, to: { x: 20, y: 30 }, color: 'red', size: 'm' } },
    ] }, { surface: 'agent', serverId: scope.serverId, runtimeAccountId: scope.accountId })).toEqual({ ok: true, result: { status: 'replaced' } });
    expect(isAgentInitiatedApprovalRequiredByDefault('media.annotation.apply' as ActionId)).toBe(false);
    expect(isAgentInitiatedApprovalRequiredByDefault('media.annotation.read' as ActionId)).toBe(false);
  });

  it('rejects malformed operations before invoking the host', async () => {
    let calls = 0;
    const executor = createActionExecutor({ mediaAnnotation: async () => { calls++; return { status: 'replaced' }; } } as ActionExecutorDeps);
    expect(await executor.execute('media.annotation.apply' as ActionId,
      { scope, target, operations: [{ kind: 'mark.add', mark: { id: 'bad', kind: 'blur', rect: { x: 0, y: 0, width: -1, height: 10 }, size: 'm' } }] },
      { surface: 'agent', serverId: scope.serverId, runtimeAccountId: scope.accountId })).toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
    expect(calls).toBe(0);
  });
});
