import { projectExternalActionMachineRuntimeDemandV1, readExternalActionMachineRuntimeDemandV1 } from './actionSpecs.js';
import { RPC_METHODS } from '../rpc/methods.js';
import { DaemonPluginUiResourceReadRequestSchema, DaemonPluginUiResourceReadResponseSchema, DaemonPluginUiResourceWatchOpenResponseSchema,
  DaemonPluginUiResourceWatchNextRequestSchema, DaemonPluginUiResourceWatchCloseRequestSchema } from '../daemon/contributionRegistryProjection.js';
import { describe, expect, it } from 'vitest';
import { sealAccountScopedBlobCiphertext } from '../crypto/accountScopedCipher.js';
import { computeCanonicalDomainSeparatedDigest } from '../crypto/canonicalDigest.js';
import {
  EXTERNAL_ACTION_HTTP_BODY_LIMIT_BYTES,
  EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES,
  EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES_V2,
  isExternalActionRequestWithinLimit,
  measureExternalActionResponseEnvelopeUtf8BytesV1,
  projectExternalActionPendingResetStartAdmissionV1,
  ExternalActionRequestEnvelopeV1Schema,
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
  it.each([
    { actionId: 'daemon.filesystem.listDirectory', expected: undefined },
    { actionId: 'session.message.send', expected: undefined },
    { actionId: 'daemon.filesystem.readFile', expected: 'required' },
  ] as const)('admits sealed runtime demand only for a declared finite root: $actionId', ({ actionId, expected }) => {
    const envelope = sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1,
      binding: { ...binding, actionId }, input: { rootPath: '/work', path: '.', message: 'private' }, material, randomBytes });
    expect(readExternalActionMachineRuntimeDemandV1(actionId, { ...envelope, machineRuntimeDemand: 'required' })).toBe(expected);
  });
  it.each([
    { actionId: 'session.open', target: { kind: 'session' as const, sessionId: 'chosen' }, input: { sessionId: 'chosen', intent: 'resume' }, demanded: true },
    { actionId: 'session.open', target: { kind: 'session' as const, sessionId: 'chosen' }, input: { sessionId: 'chosen' }, demanded: false },
    { actionId: 'session.message.send', target: { kind: 'session' as const, sessionId: 'chosen' }, input: { sessionId: 'chosen', message: 'private input' }, demanded: false },
    { actionId: 'daemon.filesystem.readFile', target: binding.target, input: { rootPath: '/work', path: 'private-file' }, demanded: true },
    { actionId: 'daemon.filesystem.listDirectory', target: binding.target, input: { rootPath: '/work', path: '.' }, demanded: false },
  ])('projects only explicit pre-effect runtime demand for $actionId ($demanded)', ({ actionId, target, input, demanded }) => {
    const root = { ...binding, actionId, target };
    const envelope = sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding: root, input, material, randomBytes });
    expect(envelope).toMatchObject(demanded ? { machineRuntimeDemand: 'required' } : {});
    if (!demanded) expect(envelope).not.toHaveProperty('machineRuntimeDemand');
    expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding: root, envelope, material })?.input).toEqual(input);
    const forged = { ...envelope, machineRuntimeDemand: demanded ? undefined : 'required' };
    expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding: root, envelope: forged, material })).toBeNull();
  });

  it('requires the full native identity for OPEN, joined reads and disposal', () => {
    const input = { serverId: 'home', machineId: 'machine-1', serviceId: 'worker' };
    const resource = { hostRead: 'machines.services.logs', input, expectedGeneration: 'generation',
      sourceRevision: 'actual-native-source' };
    const { sourceRevision: _sourceRevision, ...withoutRevision } = resource;
    const candidate = { method: RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_OPEN,
      params: { machineId: input.machineId, subscriptionId: 'watch', resource } };
    const plain = { v: 1, requestId: binding.requestId, target: binding.target, input, resourceContinuation: candidate };
    expect(ExternalActionRequestEnvelopeV1Schema.safeParse(plain).success).toBe(true);
    const { resourceContinuation } = ExternalActionRequestEnvelopeV1Schema.parse(plain);
    const args = { binding: { ...binding, actionId: 'machines.services.logs.read' }, input,
      resourceContinuation, material, randomBytes };
    const request = sealExternalActionRequestV2({ ...args, projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1 });
    expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope: request, binding: args.binding, material }))
      .toEqual({ input, resourceContinuation });
    expect(ExternalActionRequestEnvelopeV1Schema.safeParse({ ...plain, resourceContinuation: {
      ...candidate, params: { ...candidate.params, resource: withoutRevision },
    } }).success).toBe(false);
    const readSelector = { machineId: input.machineId, resource };
    expect(DaemonPluginUiResourceReadRequestSchema.safeParse(readSelector).success).toBe(true);
    expect(DaemonPluginUiResourceReadRequestSchema.safeParse({ ...readSelector,
      subscriptionId: 'watch' }).success).toBe(false);
    for (const [schema, selector] of [
      [DaemonPluginUiResourceReadRequestSchema, readSelector],
      [DaemonPluginUiResourceWatchNextRequestSchema, { ...readSelector, subscriptionId: 'watch' }],
      [DaemonPluginUiResourceWatchCloseRequestSchema, { ...readSelector, subscriptionId: 'watch' }],
    ] as const) {
      expect(schema.safeParse({ ...selector, resource: withoutRevision }).success).toBe(false);
      expect(schema.safeParse({ ...selector, actorAccountId: 'forged' }).success).toBe(false);
    }
    const snapshot = { ok: true, resource, contentType: 'application/json',
      bytesBase64: 'e30=', digest: `sha256:${'0'.repeat(64)}` };
    expect(DaemonPluginUiResourceReadResponseSchema.safeParse(snapshot).success).toBe(true);
    expect(DaemonPluginUiResourceWatchOpenResponseSchema.safeParse({ ok: true,
      subscriptionId: 'watch', digest: snapshot.digest }).success).toBe(true);
    expect(DaemonPluginUiResourceWatchOpenResponseSchema.safeParse({ ...snapshot,
      subscriptionId: 'watch' }).success).toBe(false);
  });

  it.each([
    RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_READ,
    RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_OPEN,
    RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_NEXT,
    RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_CLOSE,
  ])('protects the exact native logs Resource continuation for %s', method => {
    const input = { serverId: 'home', machineId: 'machine-1', serviceId: 'worker',
      cursor: { sourceRevision: 'source', token: 'position' } };
    const resource = { hostRead: 'machines.services.logs' as const, input,
      expectedGeneration: 'generation', sourceRevision: 'source' };
    const candidate = { method, params: { machineId: input.machineId, resource,
      ...(method === RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_READ ? {} : { subscriptionId: 'watch' }) } };
    const plain = { v: 1, requestId: binding.requestId, target: binding.target, input, resourceContinuation: candidate };
    expect(ExternalActionRequestEnvelopeV1Schema.safeParse(plain).success).toBe(true);
    const { resourceContinuation } = ExternalActionRequestEnvelopeV1Schema.parse(plain);
    const args = { binding: { ...binding, actionId: 'machines.services.logs.read' }, input,
      resourceContinuation, material, randomBytes };
    const request = sealExternalActionRequestV2({ ...args, projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1 });
    expect(request).not.toHaveProperty('resourceContinuation');
    expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope: request, binding: args.binding, material }))
      .toEqual({ input, resourceContinuation });
    expect(ExternalActionRequestEnvelopeV1Schema.safeParse({ ...plain, resourceContinuation: {
      ...resourceContinuation, params: { ...resourceContinuation.params, authority: 'present_user' },
    } }).success).toBe(false);
  });

  it('reports only the failed opening phase while preserving opaque public refusal', () => {
    const request = sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding, material, randomBytes, input: { privateInput: 'private-content' } });
    const failures: unknown[] = [];
    expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope: request, binding,
      material: { type: 'dataKey', machineKey: new Uint8Array(32).fill(3) },
      onFailure: failure => { failures.push(failure); },
    })).toBeNull();
    expect(failures).toEqual([{ phase: 'ciphertext_open' }]);
    failures.length = 0;
    expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope: request, binding: { ...binding, accountId: 'different' }, material,
      onFailure: failure => { failures.push(failure); },
    })).toBeNull();
    expect(failures).toEqual([{ phase: 'plaintext_binding' }]);
    expect(JSON.stringify(failures)).not.toContain('private-content');
    expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope: request, binding, material })).toEqual({ input: { privateInput: 'private-content' } });
  });
  it('retains narrowing mounted provenance beside E2EE content through the root codec', () => {
    const pluginInvocation = { kind: 'mountedPluginSurface' as const, mountedBinding: {
      pluginId: 'happier.inspector', contributionLocalId: 'inspector-app', occurrenceId: 'occurrence',
      sourceCustody: { kind: 'development' as const, registeredRootId: 'inspector-root' },
      materializationRef: { machineId: binding.target.machineId, pluginId: 'happier.inspector', materializationId: 'installed' },
    } };
    const input = { privateInput: 'account content' };
    const request = sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding, material, randomBytes, input, pluginInvocation });
    expect(request.pluginInvocation).toEqual(pluginInvocation);
    expect(JSON.stringify(request)).not.toContain(input.privateInput);
    expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope: request, binding, material })).toEqual({ input });
  });
  it('binds fresh reset preparatory facts to the encrypted input without exposing initial content', () => {
    const reset = { source: { bindingKind: 'account' as const, ref: { service: { pluginId: 'example.usage', localId: 'quota' }, accountId: 'connected' } },
      recordId: 'paug_v1_abcdefgh', meterId: 'weekly', witness: { id: 'accepted', observedAtMs: 100 } };
    const resetBinding = { ...binding, actionId: 'session.pending.resetStart.set', target: { kind: 'session' as const, sessionId: 'session' } };
    const input = { sessionId: 'session', localId: 'prepared', reset,
      initialInput: { content: { t: 'encrypted' as const, c: 'private-session-ciphertext' } } };
    const request = sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding: resetBinding, input, material, randomBytes });
    expect(request).toMatchObject({ pendingResetStartAdmission: projectExternalActionPendingResetStartAdmissionV1(input) });
    expect(JSON.stringify(request)).not.toContain('weekly');
    expect(JSON.stringify(request)).not.toContain('private-session-ciphertext');
    expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope: request, binding: resetBinding, material })).toEqual({ input });
    // Strict JSON preserves lone UTF-16 surrogates; digest encoding must not
    // collapse distinct accepted identities into TextEncoder's replacement character.
    const surrogateInput = { ...input, reset: { ...reset, meterId: '\ud800' } };
    const surrogateRequest = sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding: resetBinding, input: surrogateInput, material, randomBytes });
    expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope: { ...surrogateRequest,
      pendingResetStartAdmission: projectExternalActionPendingResetStartAdmissionV1({ ...surrogateInput,
        reset: { ...reset, meterId: '\ufffd' } }) }, binding: resetBinding, material })).toBeNull();
    for (const substituted of [
      { sessionId: 'another', localId: input.localId, reset },
      { sessionId: input.sessionId, localId: 'another', reset },
      { sessionId: input.sessionId, localId: input.localId, reset: { ...reset, meterId: 'another' } },
      { sessionId: input.sessionId, localId: input.localId, reset: { ...reset, witness: { ...reset.witness, id: 'another' } } },
      { ...input, reset: { ...reset, source: { ...reset.source, ref: { ...reset.source.ref, accountId: 'another' } } } },
      { ...input, reset: { ...reset, recordId: 'paug_v1_anotherrecord' } },
      { ...input, reset: { ...reset, witness: { ...reset.witness, observedAtMs: 101 } } },
    ]) expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope: { ...request,
      pendingResetStartAdmission: projectExternalActionPendingResetStartAdmissionV1(substituted) }, binding: resetBinding, material })).toBeNull();
    const { pendingResetStartAdmission: _admission, ...missing } = request;
    expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope: missing, binding: resetBinding, material })).toBeNull();
  });
  it('retains terminal authentication kind across encrypted finite requests and responses without an Account upgrade', () => {
    const { credentialId: _credentialId, ...routing } = binding;
    const terminal = { ...routing, actionId: 'projects.script.run', authentication: { kind: 'terminal' as const, tokenEpoch: 7 } };
    const account = { ...terminal, authentication: { kind: 'account' as const, tokenEpoch: 7 } };
    const input = { privateCommand: 'caller-owned finite work' };
    const request = sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding: terminal, input, material, randomBytes });
    expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope: request, binding: terminal, material })).toEqual({ input });
    expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope: request, binding: account, material })).toBeNull();
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
    const request = sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding: accountBinding, input, material, randomBytes });
    expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope: request, binding: accountBinding, material })).toEqual({ input });
    expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope: request, binding: { ...accountBinding,
      authentication: { kind: 'account', tokenEpoch: 8 } }, material })).toBeNull();
    expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope: request, binding, material })).toBeNull();
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
      const sealed = sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1,
        binding: completeBinding,
        input: completeInput,
        material,
        randomBytes,
      });
      const opened = openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1,
        envelope: sealed,
        binding: completeBinding,
        material,
      });

      expect(opened).not.toBeNull();
      expect((opened?.input as { blob: string }).blob).toHaveLength(padding.length);
  }, 120_000);

  it('preserves the decoded reset input budget with compact exact facts for Home admission', () => {
    const target = { kind: 'session' as const, sessionId: 'session' };
    const reset = { source: { bindingKind: 'account' as const, ref: { service: { pluginId: 'example.usage', localId: 'quota' }, accountId: 'connected' } },
      recordId: 'paug_v1_abcdefgh', meterId: '', witness: { id: 'accepted', observedAtMs: 100 } };
    const input = { sessionId: 'session', localId: 'prepared', reset };
    const bytes = new TextEncoder().encode(JSON.stringify({ v: 1, requestId: binding.requestId, target, input })).byteLength;
    input.reset.meterId = 'x'.repeat(EXTERNAL_ACTION_HTTP_BODY_LIMIT_BYTES - bytes);
    const resetBinding = { ...binding, actionId: 'session.pending.resetStart.set', target };
    const sealed = sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding: resetBinding, input, material, randomBytes });
    expect(isExternalActionRequestWithinLimit(sealed)).toBe(true);
    expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope: sealed, binding: resetBinding, material })).toEqual({ input });
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
    expect(() => sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1,
      binding: { ...binding, target: completeTarget },
      input: {},
      material,
      randomBytes,
    })).toThrowError('External Action request exceeds its protected wire limit');
  }, 120_000);

  it('preserves the complete decoded V1 response budget', () => {
    const request = sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding, input: {}, material, randomBytes });
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
    const request = sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding, input: {}, material, randomBytes });
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
    const request = sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding, input, material, randomBytes });
    expect(JSON.stringify(request)).not.toContain(input.message);
    expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope: request, binding, material })).toEqual({ input });
    const execution = { ok: false as const, errorCode: 'conflict', error: 'private error sentinel',
      details: { document: 'private conflict sentinel' } };
    const response = prepareExternalActionResponseV2({ binding, request, executedMachineId: 'machine-1',
      execution, material, randomBytes });
    expect(response.body).not.toContain('sentinel');
    expect(openExternalActionResponseV2({ envelope: response.response, binding, request, material })).toEqual(execution);
    const changed = sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding, input: { ...input, message: 'other' }, material, randomBytes });
    expect(openExternalActionResponseV2({ envelope: response.response, binding, request: changed, material })).toBeNull();
    const resealed = sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding, input, material,
      randomBytes: (length) => new Uint8Array(length).fill(3) });
    expect(openExternalActionResponseV2({ envelope: response.response, binding, request: resealed, material })).toBeNull();
  });

  it.each(['serverIdentityId', 'accountId', 'credentialId', 'actionId', 'requestId'] as const)(
    'rejects a different authenticated %s', (field) => {
      const request = sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding, input: {}, material, randomBytes });
      expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope: request, binding: { ...binding, [field]: 'different' }, material })).toBeNull();
    },
  );

  it('rejects target swapping, wrong key, unknown fields and response direction as input', () => {
    const request = sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding, input: {}, material, randomBytes });
    expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope: { ...request, target: { kind: 'session', sessionId: 'other' } }, binding, material })).toBeNull();
    expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope: request, binding, material: { type: 'dataKey', machineKey: new Uint8Array(32).fill(1) } })).toBeNull();
    for (const extra of [{ direction: 'response' }, { authority: 'present_user' }]) {
      const c = sealAccountScopedBlobCiphertext({ kind: 'external_action_transport', material, randomBytes,
        payload: { v: 2, direction: 'request', ...binding, input: {}, ...extra } });
      expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope: { ...request, payload: { t: 'encrypted', c } }, binding, material })).toBeNull();
    }
  });

  it('binds every Machine target field inside the encrypted request', () => {
    const projectBinding = { ...binding, target: { ...binding.target, project: { machineId: 'machine-1', directory: '/repo/a', workspaceRefId: 'workspace-1' } } };
    const request = sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding: projectBinding, input: {}, material, randomBytes });
    expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope: request, binding: projectBinding, material })).toEqual({ input: {} });
    for (const target of [
      { kind: 'machine' as const, machineId: 'machine-2', project: { ...projectBinding.target.project, machineId: 'machine-2' } },
      { ...projectBinding.target, project: { ...projectBinding.target.project, directory: '/repo/b' } },
      { ...projectBinding.target, project: { ...projectBinding.target.project, workspaceRefId: 'workspace-2' } },
      { kind: 'machine' as const, machineId: 'machine-1' },
      { kind: 'session' as const, sessionId: 'session-1' },
    ]) {
      expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope: request, binding: { ...projectBinding, target }, material })).toBeNull();
    }
  });

  it('retains nested stored ciphertext and protects approval results', () => {
    const request = sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding, input: {}, material, randomBytes });
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
