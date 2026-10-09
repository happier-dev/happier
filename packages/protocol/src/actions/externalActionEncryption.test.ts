import { describe, expect, it } from 'vitest';
import { sealAccountScopedBlobCiphertext } from '../crypto/accountScopedCipher.js';
import { computeCanonicalDomainSeparatedDigest } from '../crypto/canonicalDigest.js';
import {
  EXTERNAL_ACTION_HTTP_BODY_LIMIT_BYTES,
  EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES,
  EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES_V2,
  isExternalActionRequestWithinLimit,
  measureExternalActionResponseEnvelopeUtf8BytesV1,
} from './externalActionApi.js';
import {
  openExternalActionRequestV2,
  openExternalActionResponseV2,
  sealExternalActionRequestV2,
  prepareExternalActionResponseV2,
} from './externalActionEncryption.js';

const material = { type: 'dataKey' as const, machineKey: new Uint8Array(32).fill(9) };
const binding = {
  serverIdentityId: 'srv_test', accountId: 'account-1',
  credentialId: '00000000-0000-4000-8000-000000000001',
  actionId: 'session.message.send', requestId: 'reused-request',
  target: { kind: 'machine' as const, machineId: 'machine-1' },
};
const randomBytes = (length: number) => new Uint8Array(length).fill(2);

describe('whole external Action encryption', () => {
  it('retains terminal authentication kind across encrypted finite requests and responses without an Account upgrade', () => {
    const { credentialId: _credentialId, ...routing } = binding;
    const terminal = { ...routing, actionId: 'projects.script.run', authentication: { kind: 'terminal' as const, tokenEpoch: 7 } };
    const account = { ...terminal, authentication: { kind: 'account' as const, tokenEpoch: 7 } };
    const input = { privateCommand: 'caller-owned finite work' };
    const request = sealExternalActionRequestV2({ binding: terminal, input, material, randomBytes });
    expect(openExternalActionRequestV2({ envelope: request, binding: terminal, material })).toEqual({ input });
    expect(openExternalActionRequestV2({ envelope: request, binding: account, material })).toBeNull();
    const response = prepareExternalActionResponseV2({ binding: terminal, request,
      executedMachineId: binding.target.machineId, execution: { ok: true, result: { finite: true } }, material, randomBytes });
    expect(openExternalActionResponseV2({ envelope: response.response, binding: terminal, request, material }))
      .toEqual({ ok: true, result: { finite: true } });
    expect(openExternalActionResponseV2({ envelope: response.response, binding: account, request, material })).toBeNull();
  });
  it('binds ordinary Account ciphertext to the exact authentication epoch without a PAT alias', () => {
    const { credentialId: _credentialId, ...routing } = binding;
    const accountBinding = { ...routing, authentication: { kind: 'account' as const, tokenEpoch: 7 } };
    const input = { privateStartupInstructions: 'Do not expose this to the Home' };
    const request = sealExternalActionRequestV2({ binding: accountBinding, input, material, randomBytes });
    expect(openExternalActionRequestV2({ envelope: request, binding: accountBinding, material })).toEqual({ input });
    expect(openExternalActionRequestV2({ envelope: request, binding: { ...accountBinding,
      authentication: { kind: 'account', tokenEpoch: 8 } }, material })).toBeNull();
    expect(openExternalActionRequestV2({ envelope: request, binding, material })).toBeNull();
    const response = prepareExternalActionResponseV2({ binding: accountBinding, request,
      executedMachineId: binding.target.machineId, execution: { ok: true, result: { managedId: 'waiting' } }, material, randomBytes });
    expect(openExternalActionResponseV2({ envelope: response.response, binding: accountBinding, request, material }))
      .toEqual({ ok: true, result: { managedId: 'waiting' } });
  });
  it('preserves the complete decoded V1 request budget for domain input', () => {
      const target = binding.target;
      const input = { blob: '' };
      const baseEnvelope = { v: 1 as const, requestId: binding.requestId, target, input };
      const baseBytes = new TextEncoder().encode(JSON.stringify(baseEnvelope)).byteLength;
      const padding = 'x'.repeat(EXTERNAL_ACTION_HTTP_BODY_LIMIT_BYTES - baseBytes);
      const completeInput = { blob: padding };
      const completeTarget = target;
      const completeEnvelope = {
        v: 1 as const,
        requestId: binding.requestId,
        target: completeTarget,
        input: completeInput,
      };

      expect(new TextEncoder().encode(JSON.stringify(completeEnvelope)).byteLength)
        .toBe(EXTERNAL_ACTION_HTTP_BODY_LIMIT_BYTES);
      expect(isExternalActionRequestWithinLimit(completeEnvelope)).toBe(true);

      const completeBinding = { ...binding, target: completeTarget };
      const sealed = sealExternalActionRequestV2({
        binding: completeBinding,
        input: completeInput,
        material,
        randomBytes,
      });
      const opened = openExternalActionRequestV2({
        envelope: sealed,
        binding: completeBinding,
        material,
      });

      expect(opened).not.toBeNull();
      expect((opened?.input as { blob: string }).blob).toHaveLength(padding.length);
  }, 120_000);

  it('rejects before transmission when duplicated visible routing metadata exceeds the V2 body ceiling', () => {
    const target = {
      kind: 'machine' as const,
      machineId: 'machine-1',
      project: { machineId: 'machine-1', directory: '', workspaceRefId: 'workspace-1' },
    };
    const baseEnvelope = { v: 1 as const, requestId: binding.requestId, target, input: {} };
    const baseBytes = new TextEncoder().encode(JSON.stringify(baseEnvelope)).byteLength;
    const completeTarget = {
      ...target,
      project: {
        ...target.project,
        directory: 'x'.repeat(EXTERNAL_ACTION_HTTP_BODY_LIMIT_BYTES - baseBytes),
      },
    };

    expect(isExternalActionRequestWithinLimit({
      ...baseEnvelope,
      target: completeTarget,
    })).toBe(true);
    expect(() => sealExternalActionRequestV2({
      binding: { ...binding, target: completeTarget },
      input: {},
      material,
      randomBytes,
    })).toThrowError('External Action request exceeds its protected wire limit');
  }, 120_000);

  it('preserves the complete decoded V1 response budget', () => {
    const request = sealExternalActionRequestV2({ binding, input: {}, material, randomBytes });
    const fixedResponseBytes = measureExternalActionResponseEnvelopeUtf8BytesV1({
      v: 1,
      actionId: binding.actionId,
      requestId: binding.requestId,
      execution: { ok: true, result: '' },
    });
    const result = 'y'.repeat(
      EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES - fixedResponseBytes,
    );
    const response = prepareExternalActionResponseV2({
      binding,
      request,
      executedMachineId: binding.target.machineId,
      execution: { ok: true, result },
      material,
      randomBytes,
    });
    const openedResponse = openExternalActionResponseV2({
      envelope: response.response,
      binding,
      request,
      material,
    });

    expect(response.byteLength).toBeLessThanOrEqual(
      EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES_V2,
    );
    expect(openedResponse?.ok).toBe(true);
    if (openedResponse?.ok) {
      expect(openedResponse.result).toHaveLength(result.length);
    }
  }, 30_000);

  it('rejects an authenticated response that exceeds the existing decoded response budget', () => {
    const request = sealExternalActionRequestV2({ binding, input: {}, material, randomBytes });
    const fixed = measureExternalActionResponseEnvelopeUtf8BytesV1({ v: 1, actionId: binding.actionId,
      requestId: binding.requestId, execution: { ok: true, result: '' } });
    const c = sealAccountScopedBlobCiphertext({ kind: 'external_action_transport', material, randomBytes,
      payload: { ...binding, v: 2, direction: 'response', executedMachineId: 'machine-1',
        requestPayloadDigest: computeCanonicalDomainSeparatedDigest('happier:external_action_request:v2', [request.payload.c]),
        execution: { ok: true, result: 'x'.repeat(EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES - fixed + 1) } } });
    expect(openExternalActionResponseV2({ envelope: { v: 2, actionId: binding.actionId, requestId: binding.requestId,
      payload: { t: 'encrypted', c } }, binding, request, material })).toBeNull();
  }, 30_000);

  it('protects complete input and result and binds a response to exact ciphertext', () => {
    const input = { sessionId: 'session-1', message: 'private request sentinel' };
    const request = sealExternalActionRequestV2({ binding, input, material, randomBytes });
    expect(JSON.stringify(request)).not.toContain(input.message);
    expect(openExternalActionRequestV2({ envelope: request, binding, material })).toEqual({ input });
    const execution = { ok: false as const, errorCode: 'conflict', error: 'private error sentinel',
      details: { document: 'private conflict sentinel' } };
    const response = prepareExternalActionResponseV2({ binding, request, executedMachineId: 'machine-1',
      execution, material, randomBytes });
    expect(response.body).not.toContain('sentinel');
    expect(openExternalActionResponseV2({ envelope: response.response, binding, request, material })).toEqual(execution);
    const changed = sealExternalActionRequestV2({ binding, input: { ...input, message: 'other' }, material, randomBytes });
    expect(openExternalActionResponseV2({ envelope: response.response, binding, request: changed, material })).toBeNull();
    const resealed = sealExternalActionRequestV2({ binding, input, material,
      randomBytes: (length) => new Uint8Array(length).fill(3) });
    expect(openExternalActionResponseV2({ envelope: response.response, binding, request: resealed, material })).toBeNull();
  });

  it.each(['serverIdentityId', 'accountId', 'credentialId', 'actionId', 'requestId'] as const)(
    'rejects a different authenticated %s', (field) => {
      const request = sealExternalActionRequestV2({ binding, input: {}, material, randomBytes });
      expect(openExternalActionRequestV2({ envelope: request, binding: { ...binding, [field]: 'different' }, material })).toBeNull();
    },
  );

  it('rejects target swapping, wrong key, unknown fields and response direction as input', () => {
    const request = sealExternalActionRequestV2({ binding, input: {}, material, randomBytes });
    expect(openExternalActionRequestV2({ envelope: { ...request, target: { kind: 'session', sessionId: 'other' } }, binding, material })).toBeNull();
    expect(openExternalActionRequestV2({ envelope: request, binding, material: { type: 'dataKey', machineKey: new Uint8Array(32).fill(1) } })).toBeNull();
    for (const extra of [{ direction: 'response' }, { authority: 'present_user' }]) {
      const c = sealAccountScopedBlobCiphertext({ kind: 'external_action_transport', material, randomBytes,
        payload: { v: 2, direction: 'request', ...binding, input: {}, ...extra } });
      expect(openExternalActionRequestV2({ envelope: { ...request, payload: { t: 'encrypted', c } }, binding, material })).toBeNull();
    }
  });

  it('binds every Machine target field inside the encrypted request', () => {
    const projectBinding = { ...binding, target: { ...binding.target, project: { machineId: 'machine-1', directory: '/repo/a', workspaceRefId: 'workspace-1' } } };
    const request = sealExternalActionRequestV2({ binding: projectBinding, input: {}, material, randomBytes });
    expect(openExternalActionRequestV2({ envelope: request, binding: projectBinding, material })).toEqual({ input: {} });
    for (const target of [
      { kind: 'machine' as const, machineId: 'machine-2', project: { ...projectBinding.target.project, machineId: 'machine-2' } },
      { ...projectBinding.target, project: { ...projectBinding.target.project, directory: '/repo/b' } },
      { ...projectBinding.target, project: { ...projectBinding.target.project, workspaceRefId: 'workspace-2' } },
      { kind: 'machine' as const, machineId: 'machine-1' },
      { kind: 'session' as const, sessionId: 'session-1' },
    ]) {
      expect(openExternalActionRequestV2({ envelope: request, binding: { ...projectBinding, target }, material })).toBeNull();
    }
  });

  it('retains nested stored ciphertext and protects approval results', () => {
    const request = sealExternalActionRequestV2({ binding, input: {}, material, randomBytes });
    for (const result of [
      { content: { t: 'encrypted', c: 'stored ciphertext stays byte exact' } },
      { kind: 'approval_request_created', artifactId: 'private-artifact', actionId: binding.actionId },
    ]) {
      const prepared = prepareExternalActionResponseV2({ binding, request, executedMachineId: 'machine-1',
        execution: { ok: true, result }, material, randomBytes });
      expect(openExternalActionResponseV2({ envelope: prepared.response, binding, request, material }))
        .toEqual({ ok: true, result });
    }
    expect(computeCanonicalDomainSeparatedDigest('happier:external_action_request:v2', [request.payload.c])).toHaveLength(43);
  });
});
