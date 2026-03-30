import { describe, expect, it } from 'vitest';

import {
  createRelayRuntimeInstallOrUpdateTaskKind,
  createRelayRuntimeStartTaskKind,
  createRelayRuntimeStatusTaskKind,
  createRelayRuntimeStopTaskKind,
} from './relayRuntimeKinds.js';

describe('relay runtime shared system task kinds', () => {
  it('returns the canonical relay runtime status payload', async () => {
    const kind = createRelayRuntimeStatusTaskKind({
      readStatus: async () => ({
        installed: true,
        version: '1.2.3',
        service: {
          active: true,
          enabled: true,
        },
        baseUrl: 'http://127.0.0.1:3005',
      }),
      checkHealth: async () => true,
    });

    const events: unknown[] = [];
    const result = await kind.run({
      params: {
        target: { kind: 'local' },
        mode: 'user',
        channel: 'stable',
      },
      emit: (event) => {
        events.push(event);
      },
      prompt: async () => {
        throw new Error('relay runtime status should not prompt');
      },
    });

    expect(events).toEqual([
      {
        type: 'progress',
        stepId: 'relay.status.inspect',
        message: 'Inspecting relay runtime',
      },
      {
        type: 'progress',
        stepId: 'relay.status.health',
        message: 'Checking relay runtime health',
      },
    ]);
    expect(result).toEqual({
      installed: true,
      version: '1.2.3',
      service: {
        active: true,
        enabled: true,
      },
      relayUrl: 'http://127.0.0.1:3005',
      healthy: true,
    });
  });

  it('installs or updates the relay runtime and returns the canonical task payload', async () => {
    const events: unknown[] = [];
    const kind = createRelayRuntimeInstallOrUpdateTaskKind({
      installOrUpdate: async () => ({
        relayUrl: 'http://127.0.0.1:3005',
        mode: 'user',
      }),
    });

    const result = await kind.run({
      params: {
        target: { kind: 'local' },
        mode: 'user',
        channel: 'stable',
      },
      emit: (event) => {
        events.push(event);
      },
      prompt: async () => {
        throw new Error('installOrUpdate should not prompt');
      },
    });

    expect(events).toEqual([
      {
        type: 'progress',
        stepId: 'relay.install',
        message: 'Installing relay runtime',
      },
    ]);
    expect(result).toEqual({
      relayUrl: 'http://127.0.0.1:3005',
      mode: 'user',
    });
  });

  it('starts the relay runtime service and returns a fresh canonical status snapshot', async () => {
    const events: unknown[] = [];
    const kind = createRelayRuntimeStartTaskKind({
      control: async () => undefined,
      readStatus: async () => ({
        installed: true,
        version: '2.3.4',
        service: {
          active: true,
          enabled: true,
        },
        baseUrl: 'http://127.0.0.1:3005',
      }),
      checkHealth: async () => true,
    });

    const result = await kind.run({
      params: {
        target: { kind: 'local' },
        mode: 'user',
        channel: 'preview',
      },
      emit: (event) => {
        events.push(event);
      },
      prompt: async () => {
        throw new Error('start should not prompt');
      },
    });

    expect(events).toEqual([
      {
        type: 'progress',
        stepId: 'relay.start',
        message: 'Starting relay runtime',
      },
      {
        type: 'progress',
        stepId: 'relay.status.inspect',
        message: 'Inspecting relay runtime',
      },
      {
        type: 'progress',
        stepId: 'relay.status.health',
        message: 'Checking relay runtime health',
      },
    ]);
    expect(result).toEqual({
      installed: true,
      version: '2.3.4',
      relayUrl: 'http://127.0.0.1:3005',
      healthy: true,
      service: {
        active: true,
        enabled: true,
      },
    });
  });

  it('stops the relay runtime service and returns the canonical stop payload', async () => {
    const events: unknown[] = [];
    const kind = createRelayRuntimeStopTaskKind({
      control: async () => undefined,
    });

    const result = await kind.run({
      params: {
        target: { kind: 'local' },
        mode: 'user',
        channel: 'stable',
      },
      emit: (event) => {
        events.push(event);
      },
      prompt: async () => {
        throw new Error('stop should not prompt');
      },
    });

    expect(events).toEqual([
      {
        type: 'progress',
        stepId: 'relay.stop',
        message: 'Stopping relay runtime',
      },
    ]);
    expect(result).toEqual({
      stopped: true,
    });
  });
});
