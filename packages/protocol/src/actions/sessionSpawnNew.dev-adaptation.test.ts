import { describe, expect, it } from 'vitest';

import { getActionSpec } from './actionSpecs.js';
import {
  isActionDirectToolExposedOn,
  isActionDiscoverableOnToolSurface,
  resolveActionToolExposureMode,
} from './actionToolExposure.js';

describe('session.spawn_new dev adaptation', () => {
  const canonicalInput = {
    creationKey: 'manual:attempt-7',
    executionTarget: {
      serverId: 'server-1',
      machineId: 'machine-1',
    },
    directory: '/workspace/project',
    organizationPlacement: {
      folderId: 'folder-1',
      tagIds: ['tag-1'],
    },
    agentTarget: {
      kind: 'agent',
      identity: {
        pluginId: 'happier.agent.codex',
        localId: 'codex',
      },
    },
  } as const;

  it('is discoverable but not direct by default on the agent surface', () => {
    const spec = getActionSpec('session.spawn_new');

    expect(spec.surfaces.agent).toBe(true);
    expect(resolveActionToolExposureMode(spec, 'agent')).toBe('discoverable_only');
    expect(isActionDiscoverableOnToolSurface(spec, 'agent')).toBe(true);
    expect(isActionDirectToolExposedOn(spec, 'agent')).toBe(false);
  });

  it('accepts the strict canonical create-or-rejoin request', () => {
    const spec = getActionSpec('session.spawn_new');

    const parsed = spec.inputSchema.safeParse(canonicalInput);

    expect(parsed.success).toBe(true);
  });

  it('publishes the public Action through its strict ActionSpec RPC binding', () => {
    const spec = getActionSpec('session.spawn_new');

    expect(spec.surfaces.rpc).toBe(true);
    expect(spec.bindings?.rpcMethod).toBe('session.spawnNew');
    expect(spec.surfaceBindings?.rpc?.inputSchema.safeParse(canonicalInput).success).toBe(true);
    const { creationKey: _creationKey, ...missingCreationKey } = canonicalInput;
    expect(spec.surfaceBindings?.rpc?.inputSchema.safeParse(missingCreationKey).success).toBe(false);
  });

  it('rejects predecessor flat ingress at every live public Action boundary', () => {
    const spec = getActionSpec('session.spawn_new');
    const predecessorFlatInput = {
      tag: 'remote-dev-metadata-label',
      agentId: 'codex',
      modelId: 'gpt-5',
      providerConnectionId: 'provider-connection-1',
      backendTargetKey: 'agent:codex',
      machineId: 'machine-1',
      serverId: 'server-1',
      path: '/workspace/project',
      host: 'target-host',
      initialMessage: 'Inspect this repository.',
    } as const;

    expect(spec.inputSchema.safeParse(predecessorFlatInput).success).toBe(false);
    expect(spec.surfaceBindings?.rpc?.inputSchema.safeParse(predecessorFlatInput).success).toBe(false);
  });

  it.each([
    ['legacy metadata tag', { ...canonicalInput, tag: 'not-a-creation-key' }],
    ['flat machine target', { ...canonicalInput, machineId: 'machine-2' }],
    ['flat server target', { ...canonicalInput, serverId: 'server-2' }],
    ['legacy backend target', {
      ...canonicalInput,
      backendTarget: { kind: 'backend', backendId: 'codex' },
    }],
    ['secret-bearing environment input', {
      ...canonicalInput,
      environmentVariables: { API_TOKEN: 'secret' },
    }],
  ])('rejects %s at the canonical boundary', (_label, input) => {
    const spec = getActionSpec('session.spawn_new');

    expect(spec.inputSchema.safeParse(input).success).toBe(false);
  });

  it('requires exact target, directory, and Agent identity', () => {
    const spec = getActionSpec('session.spawn_new');

    expect(spec.inputSchema.safeParse({
      creationKey: canonicalInput.creationKey,
    }).success).toBe(false);
  });

  it('publishes only the strict canonical creation outcome', () => {
    const spec = getActionSpec('session.spawn_new');
    const result = {
      type: 'success',
      disposition: 'created',
      sessionId: 'session-1',
      executionTarget: {
        serverId: 'server-1',
        machineId: 'machine-1',
      },
      organizationPlacement: {
        folderId: null,
        tagIds: [],
      },
      initialInput: {
        status: 'notRequested',
      },
    };

    expect(spec.outputSchema.safeParse(result).success).toBe(true);
    expect(spec.outputSchema.safeParse({
      ...result,
      created: true,
    }).success).toBe(false);
    expect(spec.outputSchema.safeParse({
      ...result,
      initialInput: { status: 'accepted' },
    }).success).toBe(false);
    expect(spec.surfaceBindings?.rpc?.outputSchema.safeParse(result).success).toBe(true);
    expect(spec.surfaceBindings?.rpc?.outputSchema.safeParse({
      ...result,
      created: true,
    }).success).toBe(false);
  });
});
