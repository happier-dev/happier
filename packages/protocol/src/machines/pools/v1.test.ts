import { describe, expect, it } from 'vitest';

import {
  MachinePoolCreateInputV1Schema,
  MachinePoolErrorV1Schema,
  MachinePoolPriorityTierV1Schema,
  MachinePoolRoutingViewV1Schema,
  MachinePoolResolveResultV1Schema,
  MachinePoolSelectionOriginV1Schema,
} from './v1.js';

describe('Machine Pool V1 schemas', () => {
  it('keeps selection origin to a strict informational Pool identity', () => {
    const origin = {
      kind: 'machine_pool',
      poolId: '11111111-1111-4111-8111-111111111111',
    } as const;
    expect(MachinePoolSelectionOriginV1Schema.parse(origin)).toEqual(origin);
    expect(MachinePoolSelectionOriginV1Schema.safeParse({
      ...origin,
      name: 'Private Pool',
    }).success).toBe(false);
  });

  it('bounds priority tiers to the database Int range', () => {
    expect(MachinePoolPriorityTierV1Schema.safeParse(2_147_483_647).success).toBe(true);
    expect(MachinePoolPriorityTierV1Schema.safeParse(2_147_483_648).success).toBe(false);
  });

  it('permits a nondisclosing create collision without a current pool projection', () => {
    expect(MachinePoolErrorV1Schema.parse({ code: 'pool_changed' })).toEqual({ code: 'pool_changed' });
  });

  it('accepts only opaque private labels on a server-facing create', () => {
    const input = {
      poolId: '11111111-1111-4111-8111-111111111111',
      name: { content: { t: 'plain' as const, v: 'Private Pool' }, recipients: [] },
      description: { content: { t: 'plain' as const, v: 'Only the recipient sees this' }, recipients: [] },
      members: [],
    };
    expect(MachinePoolCreateInputV1Schema.parse(input)).toEqual(input);
    expect(MachinePoolCreateInputV1Schema.safeParse({ ...input, name: 'Private Pool' }).success).toBe(false);
  });

  it('derives routing facts from an opaque private view without retaining labels', () => {
    const view = {
      pool: {
        id: '11111111-1111-4111-8111-111111111111',
        name: { kind: 'available' as const, label: {
          content: { t: 'encrypted' as const, c: 'opaque-name' }, recipientEnvelope: null,
        } },
        description: { kind: 'unavailable' as const },
        revision: 1,
        createdAt: 1,
        updatedAt: 1,
        members: [{ machineId: 'machine-a', priorityTier: 0, enabled: true, state: 'connected' as const }],
      },
      availability: { state: 'known' as const, connectedCount: 1, enabledCount: 1 },
      access: { canManage: true, canResolve: true, canViewMembers: true },
    };
    expect(MachinePoolRoutingViewV1Schema.parse(view)).toEqual({
      pool: { id: view.pool.id, members: view.pool.members },
      availability: view.availability,
    });
  });

  it('carries only a structural Managed Preset projection from Pool resolution', () => {
    const resolved = {
      kind: 'resolved' as const,
      poolId: '11111111-1111-4111-8111-111111111111',
      machineId: 'controller-machine',
      priorityTier: 0,
      managedPreset: {
        preset: { id: 'preset-id', revision: 3, contentEncryptionMode: 'e2ee' as const },
        controller: { machineId: 'controller-machine', installationId: 'controller-installation' },
        controllerAccess: {
          installationPublicKey: '11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo',
          custodian: { accountId: 'owner-account' },
        },
        retention: { kind: 'until-delete' as const },
        wakeOnAcceptedMessage: true,
      },
    };
    expect(MachinePoolResolveResultV1Schema.parse(resolved)).toEqual(resolved);
    const { controller: _controller, ...withoutController } = resolved.managedPreset;
    const { controllerAccess: _controllerAccess, ...withoutControllerAccess } = resolved.managedPreset;
    expect(MachinePoolResolveResultV1Schema.safeParse({ ...resolved, managedPreset: withoutController }).success).toBe(false);
    expect(MachinePoolResolveResultV1Schema.safeParse({ ...resolved, managedPreset: withoutControllerAccess }).success).toBe(false);
    expect(MachinePoolResolveResultV1Schema.safeParse({ ...resolved, managedPreset: {
      ...resolved.managedPreset,
      provisioner: { id: 'private' },
      reviewedFacts: { launch: 'private' },
    } }).success).toBe(false);
  });
});
