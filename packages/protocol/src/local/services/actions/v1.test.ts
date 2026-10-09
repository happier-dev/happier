import { describe, expect, it } from 'vitest';
import { ProjectManifestV1Schema } from '../../../workspaces/projectSetup/projectManifestV1.js';
import { WorkspaceRefV1WriteSchema } from '../../../workspaces/workspaceRefV1.js';
import { DaemonLocalServiceLauncherStartRequestV1Schema } from '../launcher/v1.js';

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
  it('binds confirmation to the exact accepted workspace identity without a narrower consumer limit', () => {
    const workspace = WorkspaceRefV1WriteSchema.parse({
      id: ` ${'accepted-workspace'.repeat(20)} `, serverId: 'home-a', machineId: 'machine-a',
      rootPath: `/repo/${'nested/'.repeat(320)}service `, createdAtMs: 1,
    });
    const request = {
      requestId: 'reviewed-operation', action: 'stop_managed', confirmationNonce: 'placeholder',
      target: { kind: 'managed_service', managedServiceId: 'service-a', machineId: workspace.machineId,
        workspaceId: workspace.id, cwd: workspace.rootPath,
        declaration: { workspaceRefId: workspace.id, selection: { kind: 'manifest', name: 'web' } } },
    };
    const parsed = LocalServiceActionRequestV1Schema.parse(request);
    expect(parsed.target).toEqual(request.target);
    expect(DaemonLocalServiceLauncherStartRequestV1Schema.parse({ machineId: workspace.machineId,
      targetId: 'project-service:web', workspaceId: workspace.id,
      workspace: { serverId: workspace.serverId, machineId: workspace.machineId, workspaceId: workspace.id, rootPath: workspace.rootPath },
      declaration: request.target.declaration,
    }).workspaceId).toBe(workspace.id);
    const other = LocalServiceActionRequestV1Schema.parse({ ...request, target: { ...request.target,
      declaration: { ...request.target.declaration, workspaceRefId: workspace.id.trim() },
    } });
    expect(createLocalServiceActionConfirmationNonceV1(parsed)).not.toBe(createLocalServiceActionConfirmationNonceV1(other));
  });
  it('preserves exact manifest service identities through the actual target and confirmation boundary', () => {
    const services = {
      web: { source: { kind: 'command', command: 'run-web' } },
      ' web ': { source: { kind: 'command', command: 'run-other-web' } },
      ['service'.repeat(50)]: { source: { kind: 'command', command: 'run-long-name' } },
    };
    const manifest = ProjectManifestV1Schema.parse({ version: 1, services });
    const nonces = new Set<string>();
    for (const name of Object.keys(manifest.services ?? {})) {
      const target = {
        kind: 'managed_service', managedServiceId: 'service-a', machineId: 'machine-a',
        declaration: { workspaceRefId: 'workspace-a', selection: { kind: 'manifest', name } },
      };
      expect(LocalServiceActionTargetV1Schema.parse(target)).toEqual(target);
      const request = LocalServiceActionRequestV1Schema.parse({
        requestId: 'same-reviewed-operation', action: 'stop_managed', target, confirmationNonce: 'placeholder',
      });
      nonces.add(createLocalServiceActionConfirmationNonceV1(request));
    }
    expect(nonces.size).toBe(Object.keys(services).length);
    expect(LocalServiceActionTargetV1Schema.safeParse({
      kind: 'managed_service', managedServiceId: 'service-a', machineId: 'machine-a',
      declaration: { workspaceRefId: 'workspace-a', selection: { kind: 'manifest', name: '' } },
    }).success).toBe(false);
  });

  it('retains exact Project declaration provenance and actual cwd without granting target authority', () => {
    const target = {
      kind: 'managed_service', managedServiceId: 'service-a', machineId: 'machine-a', cwd: '/repo/app',
      declaration: {
        workspaceRefId: 'workspace-a',
        selection: { kind: 'native', source: { kind: 'native', tool: 'compose', file: 'compose.yaml', target: 'web' } },
      },
    };
    expect(LocalServiceActionTargetV1Schema.parse(target)).toEqual(target);
    expect(LocalServiceActionTargetV1Schema.safeParse({
      ...target,
      declaration: { ...target.declaration, selection: { ...target.declaration.selection,
        source: { ...target.declaration.selection.source, file: '../another/compose.yaml' },
      } },
    }).success).toBe(false);
    expect(LocalServiceActionTargetV1Schema.safeParse({
      ...target, declaration: { ...target.declaration, starterAccountId: 'forged-owner' },
    }).success).toBe(false);
  });

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
  it('admits Undo only through Forget and rejects an undo key on other actions', () => {
    const request = {
      requestId: 'undo',
      target: { kind: 'inventory_entry', inventoryEntryId: 'machine-a:tcp:loopback:127.0.0.1:5173', machineId: 'machine-a' },
      action: 'forget',
      undoKey: 'machine-a:tcp:loopback:127.0.0.1:5173',
    };
    expect(LocalServiceActionRequestV1Schema.parse(request)).toMatchObject({ undoKey: request.undoKey });
    expect(LocalServiceActionRequestV1Schema.safeParse({ ...request, action: 'copy_url' }).success).toBe(false);
    expect(LocalServiceActionRequestV1Schema.safeParse({ ...request, target: { ...request.target, inventoryEntryId: 'another-entry' } }).success).toBe(false);
  });

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
  it('binds confirmation to reviewed declaration identity and actual cwd', () => {
    const request = {
      requestId: 'request-project-service', action: 'stop_managed', confirmationNonce: 'placeholder',
      target: {
        kind: 'managed_service', managedServiceId: 'service-a', machineId: 'machine-a', cwd: '/repo/app',
        declaration: { workspaceRefId: 'workspace-a', selection: { kind: 'manifest', name: 'web' } },
      },
    };
    const parsed = LocalServiceActionRequestV1Schema.parse(request);
    const nonce = createLocalServiceActionConfirmationNonceV1(parsed);
    for (const target of [
      { ...request.target, cwd: '/repo/another' },
      { ...request.target, declaration: { ...request.target.declaration, workspaceRefId: 'workspace-b' } },
      { ...request.target, declaration: { ...request.target.declaration, selection: { kind: 'manifest', name: 'worker' } } },
    ]) {
      expect(isLocalServiceActionConfirmationNonceV1(LocalServiceActionRequestV1Schema.parse({
        ...request, target, confirmationNonce: nonce,
      }))).toBe(false);
    }
  });

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
