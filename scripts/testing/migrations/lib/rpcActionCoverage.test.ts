import assert from 'node:assert/strict';
import test from 'node:test';

import { validateRpcActionCoverage } from './rpcActionCoverage.ts';

function serverRequiredPolicy(method) {
  return {
    method,
    routeClass: 'server_required',
    serverRequiredReason: 'unclassified',
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
  assert.deepEqual(
    result.errors.map((error) => error.code),
    ['rpc-method-conflicting-classification'],
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
  assert.deepEqual(
    result.errors.map((error) => error.code),
    ['route-policy-governance-mismatch'],
  );
});
