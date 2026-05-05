import assert from 'node:assert/strict';
import test from 'node:test';

import { validateRpcActionCoverage } from './rpcActionCoverage.ts';

test('validateRpcActionCoverage reports unclassified deployed RPC methods as advisory warnings', () => {
  const result = validateRpcActionCoverage({
    rpcMethods: { DEMO_STATUS_GET: 'demo.status.get' },
    sessionRpcMethods: {},
    actionSpecs: [],
    internalOnlyEntries: [],
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(
    result.warnings.map((warning) => warning.code),
    ['unclassified-rpc-method'],
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
  });

  assert.equal(result.ok, false);
  assert.deepEqual(
    result.errors.map((error) => error.code),
    ['action-rpc-method-not-registered'],
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
  });

  assert.equal(result.ok, false);
  assert.deepEqual(
    result.errors.map((error) => error.code),
    ['rpc-method-conflicting-classification'],
  );
});
