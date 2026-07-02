import assert from 'node:assert/strict';
import test from 'node:test';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { ACTION_SPEC_RPC_EXCEPTIONS } from '../../../../apps/cli/src/rpc/handlers/actionSpecRpcExceptions.ts';
import { validateRpcActionCoverage } from './rpcActionCoverage.ts';

function serverRequiredPolicy(method) {
  return {
    method,
    routeClass: 'server_required',
    serverRequiredReason: 'unclassified',
  };
}

function actionSpecBoundPolicy(method, actionSpecId) {
  return {
    method,
    routeClass: 'server_required',
    serverRequiredReason: 'action_spec_bound',
    rpcClassification: 'action_spec_bound',
    actionSpecId,
  };
}

test('validateRpcActionCoverage allows unclassified methods only through deny-default server route policy', () => {
  const result = validateRpcActionCoverage({
    rpcMethods: { DEMO_STATUS_GET: 'demo.status.get' },
    sessionRpcMethods: {},
    actionSpecs: [],
    internalOnlyEntries: [],
    machineRpcRoutePolicies: [serverRequiredPolicy('demo.status.get')],
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(
    result.warnings.map((warning) => warning.code),
    ['unclassified-rpc-method'],
  );
});

test('validateRpcActionCoverage rejects direct-eligible policies with advisory governance', () => {
  const result = validateRpcActionCoverage({
    rpcMethods: { DEMO_STATUS_GET: 'demo.status.get' },
    sessionRpcMethods: {},
    actionSpecs: [],
    internalOnlyEntries: [],
    machineRpcRoutePolicies: [
      {
        method: 'demo.status.get',
        routeClass: 'direct_ephemeral',
        rpcClassification: 'advisory_unclassified',
      },
    ],
  });

  assert.equal(result.ok, false);
  assert.deepEqual(
    result.errors.map((error) => error.code),
    ['route-policy-direct-unclassified'],
  );
});

test('validateRpcActionCoverage rejects direct internal-only self-labels missing from the canonical allowlist', () => {
  const result = validateRpcActionCoverage({
    rpcMethods: { DEMO_STATUS_GET: 'demo.status.get' },
    sessionRpcMethods: {},
    actionSpecs: [],
    internalOnlyEntries: [],
    machineRpcRoutePolicies: [
      {
        method: 'demo.status.get',
        routeClass: 'direct_ephemeral',
        rpcClassification: 'internal_only',
      },
    ],
  });

  assert.equal(result.ok, false);
  assert.deepEqual(
    result.errors.map((error) => error.code),
    ['route-policy-governance-mismatch'],
  );
});

test('validateRpcActionCoverage rejects deployed RPC methods missing direct route policy rows', () => {
  const result = validateRpcActionCoverage({
    rpcMethods: { DEMO_STATUS_GET: 'demo.status.get' },
    sessionRpcMethods: {},
    actionSpecs: [],
    internalOnlyEntries: [],
    machineRpcRoutePolicies: [],
  });

  assert.equal(result.ok, false);
  assert.deepEqual(
    result.errors.map((error) => error.code),
    ['rpc-method-missing-route-policy'],
  );
});

test('validateRpcActionCoverage rejects direct route policies for unknown methods', () => {
  const result = validateRpcActionCoverage({
    rpcMethods: {},
    sessionRpcMethods: {},
    actionSpecs: [],
    internalOnlyEntries: [],
    machineRpcRoutePolicies: [
      {
        method: 'demo.status.get',
        routeClass: 'direct_ephemeral',
        rationale: 'fixture direct route',
        ownerPacket: 'PMS-5',
        rpcClassification: 'internal_only',
        commandReceiptRequired: false,
        scope: {
          accountRequired: true,
          machineRequired: true,
          sessionRequired: false,
          serverRequired: false,
        },
      },
    ],
  });

  assert.equal(result.ok, false);
  assert.deepEqual(
    result.errors.map((error) => error.code),
    ['route-policy-method-not-registered'],
  );
});

test('validateRpcActionCoverage rejects rpc-surfaced ActionSpecs without registered RPC methods', () => {
  const result = validateRpcActionCoverage({
    rpcMethods: {},
    sessionRpcMethods: {},
    actionSpecs: [
      {
        id: 'demo.action',
        surfaces: { rpc: true },
        bindings: { rpcMethod: 'demo.action' },
      },
    ],
    internalOnlyEntries: [],
    machineRpcRoutePolicies: [serverRequiredPolicy('demo.action')],
  });

  assert.equal(result.ok, false);
  assert.equal(
    result.errors.some((error) => error.code === 'action-rpc-method-not-registered'),
    true,
  );
});

test('validateRpcActionCoverage rejects methods classified as both action-bound and internal-only', () => {
  const result = validateRpcActionCoverage({
    rpcMethods: { DEMO_ACTION: 'demo.action' },
    sessionRpcMethods: {},
    actionSpecs: [
      {
        id: 'demo.action',
        surfaces: { rpc: true },
        bindings: { rpcMethod: 'demo.action' },
      },
    ],
    internalOnlyEntries: [
      {
        method: 'demo.action',
        rationale: 'fixture conflict',
        ownerPacket: 'A.12.0',
      },
    ],
    machineRpcRoutePolicies: [serverRequiredPolicy('demo.action')],
  });

  assert.equal(result.ok, false);
  assert.equal(
    result.errors.some((error) => error.code === 'rpc-method-conflicting-classification'),
    true,
  );
});

test('validateRpcActionCoverage rejects route policy governance that omits ActionSpec binding metadata', () => {
  const result = validateRpcActionCoverage({
    rpcMethods: { DEMO_ACTION: 'demo.action' },
    sessionRpcMethods: {},
    actionSpecs: [
      {
        id: 'demo.action',
        surfaces: { rpc: true },
        bindings: { rpcMethod: 'demo.action' },
      },
    ],
    internalOnlyEntries: [],
    machineRpcRoutePolicies: [
      {
        method: 'demo.action',
        routeClass: 'server_required',
        serverRequiredReason: 'server_persistence',
        rpcClassification: 'advisory_unclassified',
      },
    ],
  });

  assert.equal(result.ok, false);
  assert.equal(
    result.errors.some((error) => error.code === 'route-policy-governance-mismatch'),
    true,
  );
});

test('validateRpcActionCoverage rejects rpc ActionSpecs omitted from generic registration and exceptions', () => {
  const result = validateRpcActionCoverage({
    rpcMethods: { DEMO_ACTION: 'demo.action' },
    sessionRpcMethods: {},
    genericActionSpecRpcMethods: ['sessions.subagents.list'],
    actionSpecRpcExceptions: [],
    actionSpecs: [
      {
        id: 'demo.action',
        surfaces: { rpc: true },
        bindings: { rpcMethod: 'demo.action' },
      },
    ],
    internalOnlyEntries: [],
    machineRpcRoutePolicies: [actionSpecBoundPolicy('demo.action', 'demo.action')],
  });

  assert.equal(result.ok, false);
  assert.deepEqual(
    result.errors.map((error) => error.code),
    ['action-rpc-method-not-generically-registered'],
  );
});

test('validateRpcActionCoverage treats scoped ActionSpec aliases as generic registrations', () => {
  const result = validateRpcActionCoverage({
    rpcMethods: {
      DEMO_ACTION: 'daemon.externalSessions.demo',
      DEMO_ACTION_LEGACY: 'daemon.directSessions.demo',
    },
    sessionRpcMethods: {},
    actionSpecRpcExceptions: [],
    actionSpecs: [
      {
        id: 'sessions.external.demo',
        surfaces: { rpc: true },
        bindings: {
          rpcMethod: 'daemon.externalSessions.demo',
          rpcMethodAliases: ['daemon.directSessions.demo'],
        },
      },
    ],
    internalOnlyEntries: [],
    machineRpcRoutePolicies: [
      actionSpecBoundPolicy('daemon.externalSessions.demo', 'sessions.external.demo'),
      actionSpecBoundPolicy('daemon.directSessions.demo', 'sessions.external.demo'),
    ],
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.actionBoundRpcMethods, [
    'daemon.directSessions.demo',
    'daemon.externalSessions.demo',
  ]);
});

test('validateRpcActionCoverage does not infer generic coverage from arbitrary ActionSpec rows', () => {
  const result = validateRpcActionCoverage({
    rpcMethods: { DEMO_ACTION: 'demo.action' },
    sessionRpcMethods: {},
    actionSpecs: [
      {
        id: 'demo.action',
        surfaces: { rpc: true },
        bindings: { rpcMethod: 'demo.action' },
      },
    ],
    internalOnlyEntries: [],
    machineRpcRoutePolicies: [actionSpecBoundPolicy('demo.action', 'demo.action')],
  });

  assert.equal(result.ok, false);
  assert.deepEqual(
    result.errors.map((error) => error.code),
    ['action-rpc-method-not-generically-registered'],
  );
});

test('validateRpcActionCoverage classifies prompt transfer control RPCs as internal transport', () => {
  const result = validateRpcActionCoverage();
  const promptTransferMethods = [
    'daemon.promptAssets.upload.init',
    'daemon.promptAssets.upload.chunk',
    'daemon.promptAssets.upload.finalize',
    'daemon.promptAssets.upload.abort',
    'daemon.promptAssets.download.init',
    'daemon.promptAssets.download.chunk',
    'daemon.promptAssets.download.finalize',
    'daemon.promptAssets.download.abort',
    'daemon.promptRegistry.download.init',
    'daemon.promptRegistry.download.chunk',
    'daemon.promptRegistry.download.finalize',
    'daemon.promptRegistry.download.abort',
  ];

  for (const method of promptTransferMethods) {
    assert.equal(result.unclassifiedRpcMethods.includes(method), false, method);
    assert.equal(result.internalOnlyRpcMethods.includes(method), true, method);
  }
});

test('validateRpcActionCoverage classifies A.12 voice cleanup RPCs as bounded internal transport or targeted status', () => {
  const result = validateRpcActionCoverage();
  const voiceCleanupMethods = [
    RPC_METHODS.DAEMON_MEMORY_STATUS,
    RPC_METHODS.DAEMON_VOICE_INFERENCE_STATUS,
    RPC_METHODS.DAEMON_VOICE_INFERENCE_MODELS_LIST,
    RPC_METHODS.DAEMON_VOICE_INFERENCE_MODELS_INSTALL,
    RPC_METHODS.DAEMON_VOICE_INFERENCE_MODELS_REMOVE,
    RPC_METHODS.DAEMON_VOICE_INFERENCE_MODELS_STATUS,
    RPC_METHODS.DAEMON_VOICE_INFERENCE_MODELS_WARM,
    RPC_METHODS.DAEMON_VOICE_INFERENCE_TTS_SYNTHESIZE,
    RPC_METHODS.DAEMON_VOICE_INFERENCE_TTS_CHUNK,
    RPC_METHODS.DAEMON_VOICE_INFERENCE_TTS_FINALIZE,
    RPC_METHODS.DAEMON_VOICE_INFERENCE_TTS_ABORT,
    RPC_METHODS.DAEMON_VOICE_INFERENCE_TTS_CANCEL,
    RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_UPLOAD_INIT,
    RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_UPLOAD_CHUNK,
    RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_UPLOAD_FINALIZE,
    RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_UPLOAD_ABORT,
    RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_TRANSCRIBE,
    RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_CANCEL,
  ];

  for (const method of voiceCleanupMethods) {
    assert.equal(result.unclassifiedRpcMethods.includes(method), false, method);
    assert.equal(result.internalOnlyRpcMethods.includes(method), true, method);
  }
});

test('A.12 voice cleanup RPCs outside ActionSpec registration have typed exception ledger entries', () => {
  const exceptionMethods = new Set(ACTION_SPEC_RPC_EXCEPTIONS.map((entry) => entry.method));
  const expected = [
    RPC_METHODS.DAEMON_MEMORY_STATUS,
    RPC_METHODS.DAEMON_VOICE_INFERENCE_STATUS,
    RPC_METHODS.DAEMON_VOICE_INFERENCE_MODELS_LIST,
    RPC_METHODS.DAEMON_VOICE_INFERENCE_MODELS_INSTALL,
    RPC_METHODS.DAEMON_VOICE_INFERENCE_MODELS_REMOVE,
    RPC_METHODS.DAEMON_VOICE_INFERENCE_MODELS_STATUS,
    RPC_METHODS.DAEMON_VOICE_INFERENCE_MODELS_WARM,
    RPC_METHODS.DAEMON_VOICE_INFERENCE_TTS_SYNTHESIZE,
    RPC_METHODS.DAEMON_VOICE_INFERENCE_TTS_CHUNK,
    RPC_METHODS.DAEMON_VOICE_INFERENCE_TTS_FINALIZE,
    RPC_METHODS.DAEMON_VOICE_INFERENCE_TTS_ABORT,
    RPC_METHODS.DAEMON_VOICE_INFERENCE_TTS_CANCEL,
    RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_UPLOAD_INIT,
    RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_UPLOAD_CHUNK,
    RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_UPLOAD_FINALIZE,
    RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_UPLOAD_ABORT,
    RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_TRANSCRIBE,
    RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_CANCEL,
  ];

  for (const method of expected) {
    assert.equal(exceptionMethods.has(method), true, method);
  }
});

test('validateRpcActionCoverage accepts required methods from canonical generic registrar scopes', () => {
  const result = validateRpcActionCoverage({
    rpcMethods: { SESSIONS_SUBAGENTS_INSPECT: 'sessions.subagents.inspect' },
    sessionRpcMethods: {},
    actionSpecs: [
      {
        id: 'sessions.subagents.inspect',
        surfaces: { rpc: true },
        bindings: { rpcMethod: 'sessions.subagents.inspect' },
      },
    ],
    internalOnlyEntries: [],
    machineRpcRoutePolicies: [actionSpecBoundPolicy('sessions.subagents.inspect', 'sessions.subagents.inspect')],
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test('validateRpcActionCoverage rejects invalid action rpc exception metadata', () => {
  const result = validateRpcActionCoverage({
    rpcMethods: { DEMO_ACTION: 'demo.action' },
    sessionRpcMethods: {},
    genericActionSpecRpcMethods: ['sessions.subagents.list'],
    actionSpecRpcExceptions: [
      {
        method: 'demo.action',
        actionId: 'demo.action',
        reason: 'not_a_real_reason',
        ownerPacket: '',
        rationale: '',
        retirement: 'Retire when the fixture is generic.',
      },
    ],
    actionSpecs: [
      {
        id: 'demo.action',
        surfaces: { rpc: true },
        bindings: { rpcMethod: 'demo.action' },
      },
    ],
    internalOnlyEntries: [],
    machineRpcRoutePolicies: [actionSpecBoundPolicy('demo.action', 'demo.action')],
  });

  assert.equal(result.ok, false);
  assert.deepEqual(
    result.errors.map((error) => error.code),
    [
      'invalid-action-spec-rpc-exception',
      'invalid-action-spec-rpc-exception',
      'invalid-action-spec-rpc-exception',
    ],
  );
});

test('validateRpcActionCoverage rejects packet-owned coordination exceptions without retirement', () => {
  const result = validateRpcActionCoverage({
    rpcMethods: { DEMO_ACTION: 'demo.action' },
    sessionRpcMethods: {},
    genericActionSpecRpcMethods: [],
    actionSpecRpcExceptions: [
      {
        method: 'demo.action',
        actionId: 'demo.action',
        reason: 'packet_owned_coordination',
        ownerPacket: 'A.fixture',
        rationale: 'Fixture packet-owned coordination.',
      },
    ],
    actionSpecs: [
      {
        id: 'demo.action',
        surfaces: { rpc: true },
        bindings: { rpcMethod: 'demo.action' },
      },
    ],
    internalOnlyEntries: [],
    machineRpcRoutePolicies: [actionSpecBoundPolicy('demo.action', 'demo.action')],
  });

  assert.equal(result.ok, false);
  assert.deepEqual(
    result.errors.map((error) => error.code),
    ['invalid-action-spec-rpc-exception'],
  );
});

test('validateRpcActionCoverage rejects exceptions for required generic ActionSpec rpc methods', () => {
  const result = validateRpcActionCoverage({
    rpcMethods: { SESSIONS_SUBAGENTS_LIST: 'sessions.subagents.list' },
    sessionRpcMethods: {},
    genericActionSpecRpcMethods: ['sessions.subagents.list'],
    actionSpecRpcExceptions: [
      {
        method: 'sessions.subagents.list',
        actionId: 'sessions.subagents.list',
        reason: 'custom_context_extraction',
        ownerPacket: 'A.fixture',
        rationale: 'Fixture should be generic.',
        retirement: 'Retire by registering through the generic registrar.',
      },
    ],
    actionSpecs: [
      {
        id: 'sessions.subagents.list',
        surfaces: { rpc: true },
        bindings: { rpcMethod: 'sessions.subagents.list' },
      },
    ],
    internalOnlyEntries: [],
    machineRpcRoutePolicies: [actionSpecBoundPolicy('sessions.subagents.list', 'sessions.subagents.list')],
  });

  assert.equal(result.ok, false);
  assert.deepEqual(
    result.errors.map((error) => error.code),
    ['action-rpc-exception-generically-servable', 'duplicate-action-rpc-method-coverage'],
  );
});

test('validateRpcActionCoverage rejects duplicate generic and exception ownership', () => {
  const result = validateRpcActionCoverage({
    rpcMethods: { DEMO_ACTION: 'demo.action' },
    sessionRpcMethods: {},
    genericActionSpecRpcMethods: ['demo.action'],
    actionSpecRpcExceptions: [
      {
        method: 'demo.action',
        actionId: 'demo.action',
        reason: 'custom_result_envelope',
        ownerPacket: 'A.fixture',
        rationale: 'Fixture custom envelope.',
        retirement: 'Retire when the fixture is generic.',
      },
    ],
    actionSpecs: [
      {
        id: 'demo.action',
        surfaces: { rpc: true },
        bindings: { rpcMethod: 'demo.action' },
      },
    ],
    internalOnlyEntries: [],
    machineRpcRoutePolicies: [actionSpecBoundPolicy('demo.action', 'demo.action')],
  });

  assert.equal(result.ok, false);
  assert.equal(
    result.errors.some((error) => error.code === 'duplicate-action-rpc-method-coverage'),
    true,
  );
});
