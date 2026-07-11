import { describe, expect, it } from 'vitest';

import {
  createLocalServiceActionConfirmationNonceV1,
  isLocalServiceActionConfirmationNonceV1,
  LocalServiceActionDecisionV1Schema,
  type LocalServiceActionRequestV1,
  LocalServiceActionRequestV1Schema,
  LocalServiceActionResultV1Schema,
  LocalServiceActionTargetV1Schema,
} from './v1.js';

describe('LocalServiceActionTargetV1Schema', () => {
  it('requires action authority to reference a canonical inventory or managed service target', () => {
    expect(LocalServiceActionTargetV1Schema.parse({
      kind: 'inventory_entry',
      inventoryEntryId: 'inventory-a',
      machineId: 'machine-a',
      sessionId: 'session-a',
    }).inventoryEntryId).toBe('inventory-a');

    expect(() => LocalServiceActionTargetV1Schema.parse({
      kind: 'inventory_entry',
      port: 5173,
      pid: 400,
      machineId: 'machine-a',
    })).toThrow();
  });
});

describe('LocalServiceActionRequestV1Schema', () => {
  it('requires managed and destructive actions to carry a confirmation nonce', () => {
    expect(() => LocalServiceActionRequestV1Schema.parse({
      requestId: 'request-a',
      target: { kind: 'managed_service', managedServiceId: 'managed-a', machineId: 'machine-a' },
      action: 'stop_managed',
    })).toThrow();

    expect(LocalServiceActionRequestV1Schema.parse({
      requestId: 'request-a',
      target: { kind: 'inventory_entry', inventoryEntryId: 'inventory-a', machineId: 'machine-a' },
      action: 'forget',
    }).confirmationNonce).toBeUndefined();

    expect(LocalServiceActionRequestV1Schema.parse({
      requestId: 'request-a',
      target: { kind: 'managed_service', managedServiceId: 'managed-a', machineId: 'machine-a' },
      action: 'stop_managed',
      confirmationNonce: 'nonce-a',
    }).confirmationNonce).toBe('nonce-a');
  });

  it('requires force actions to carry a second-confirmation nonce', () => {
    expect(() => LocalServiceActionRequestV1Schema.parse({
      requestId: 'request-a',
      target: { kind: 'inventory_entry', inventoryEntryId: 'inventory-a', machineId: 'machine-a' },
      action: 'terminate_detected',
      force: true,
    })).toThrow();

    expect(LocalServiceActionRequestV1Schema.parse({
      requestId: 'request-a',
      target: { kind: 'inventory_entry', inventoryEntryId: 'inventory-a', machineId: 'machine-a' },
      action: 'terminate_detected',
      force: true,
      confirmationNonce: 'nonce-a',
    }).force).toBe(true);
  });
});

describe('Local Service action confirmation nonce helpers', () => {
  const request: LocalServiceActionRequestV1 = {
    requestId: 'request-a',
    target: {
      kind: 'managed_service',
      managedServiceId: 'managed-a',
      machineId: 'machine-a',
      sessionId: 'session-a',
      workspaceId: 'workspace-a',
    },
    action: 'stop_managed',
    confirmationNonce: 'placeholder',
    force: false,
  };

  it('creates a bounded confirmation nonce bound to request/action/target scope', () => {
    const nonce = createLocalServiceActionConfirmationNonceV1(request);

    expect(nonce).toMatch(/^lsact1_[a-z0-9]+$/);
    expect(nonce.length).toBeLessThanOrEqual(256);
    expect(createLocalServiceActionConfirmationNonceV1(request)).toBe(nonce);
    expect(isLocalServiceActionConfirmationNonceV1({ ...request, confirmationNonce: nonce })).toBe(true);
    expect(isLocalServiceActionConfirmationNonceV1({
      ...request,
      requestId: 'request-b',
      confirmationNonce: nonce,
    })).toBe(false);
    expect(isLocalServiceActionConfirmationNonceV1({
      ...request,
      action: 'restart_managed',
      confirmationNonce: nonce,
    })).toBe(false);
    expect(isLocalServiceActionConfirmationNonceV1({
      ...request,
      target: { ...request.target, managedServiceId: 'managed-b' },
      confirmationNonce: nonce,
    })).toBe(false);
    expect(isLocalServiceActionConfirmationNonceV1({
      ...request,
      target: { ...request.target, machineId: 'machine-b' },
      confirmationNonce: nonce,
    })).toBe(false);
    expect(isLocalServiceActionConfirmationNonceV1({
      ...request,
      target: { ...request.target, sessionId: 'session-b' },
      confirmationNonce: nonce,
    })).toBe(false);
    expect(isLocalServiceActionConfirmationNonceV1({
      ...request,
      target: { ...request.target, workspaceId: 'workspace-b' },
      confirmationNonce: nonce,
    })).toBe(false);
    expect(isLocalServiceActionConfirmationNonceV1({
      ...request,
      force: true,
      confirmationNonce: nonce,
    })).toBe(false);
  });
});

describe('LocalServiceActionDecisionV1Schema', () => {
  it('requires denied dangerous actions to include an audit-safe reason code', () => {
    expect(() => LocalServiceActionDecisionV1Schema.parse({
      kind: 'terminate_detected',
      enabled: false,
      requiresConfirmation: true,
      auditRequired: true,
    })).toThrow();

    expect(LocalServiceActionDecisionV1Schema.parse({
      kind: 'terminate_detected',
      enabled: false,
      requiresConfirmation: true,
      auditRequired: true,
      reasonCode: 'low_signal_process',
    }).reasonCode).toBe('low_signal_process');
  });
});

describe('LocalServiceActionResultV1Schema', () => {
  it('requires unsuccessful action executions to include an audit-safe reason code', () => {
    expect(() => LocalServiceActionResultV1Schema.parse({
      v: 1,
      requestId: 'request-a',
      action: 'stop_managed',
      status: 'denied',
      auditEvents: [],
    })).toThrow();

    expect(LocalServiceActionResultV1Schema.parse({
      v: 1,
      requestId: 'request-a',
      action: 'stop_managed',
      status: 'denied',
      reasonCode: 'managed_stop_unavailable',
      auditEvents: [],
    })).toMatchObject({
      status: 'denied',
      reasonCode: 'managed_stop_unavailable',
    });
  });
});
