import { describe, expect, it } from 'vitest';

describe('Simulator preview runtime protocol V1', () => {
  it('defines strict daemon snapshot rpc envelopes for simulator resources', async () => {
    const mod = await import('./runtimeV1').catch(() => null);

    expect(mod?.SimulatorPreviewSnapshotV1Schema).toBeTruthy();
    expect(mod?.DaemonSimulatorPreviewSnapshotRequestV1Schema).toBeTruthy();
    expect(mod?.DaemonSimulatorPreviewSnapshotResponseV1Schema).toBeTruthy();
    if (
      !mod?.SimulatorPreviewSnapshotV1Schema
      || !mod.DaemonSimulatorPreviewSnapshotRequestV1Schema
      || !mod.DaemonSimulatorPreviewSnapshotResponseV1Schema
    ) {
      return;
    }

    const snapshot = mod.SimulatorPreviewSnapshotV1Schema.parse({
      v: 1,
      machineId: 'machine_1',
      generatedAt: 2_000,
      refreshState: 'idle',
      resources: [{
        v: 1,
        simulatorId: 'sim_1',
        platform: 'ios',
        deviceId: 'device_1',
        displayName: 'iPhone 16 Pro',
        capture: {
          sourceId: 'source_1',
          supportedCodecs: ['image.mjpeg'],
          inputMode: 'exclusive',
        },
      }],
      diagnostics: [],
    });

    expect(snapshot.resources[0]?.simulatorId).toBe('sim_1');
    expect(mod.DaemonSimulatorPreviewSnapshotRequestV1Schema.parse({
      machineId: 'machine_1',
    })).toEqual({ machineId: 'machine_1' });
    expect(mod.DaemonSimulatorPreviewSnapshotResponseV1Schema.parse({
      protocolVersion: 1,
      snapshot,
    }).snapshot.machineId).toBe('machine_1');
    expect(mod.DaemonSimulatorPreviewSnapshotResponseV1Schema.safeParse({
      protocolVersion: 1,
      snapshot,
      controlServerToken: 'must-not-leak',
    }).success).toBe(false);
  });

  it('defines typed simulator action rpc envelopes and rejects ad hoc payload fields', async () => {
    const mod = await import('./runtimeV1').catch(() => null);

    expect(mod?.DaemonSimulatorPreviewActionRequestV1Schema).toBeTruthy();
    expect(mod?.DaemonSimulatorPreviewActionResponseV1Schema).toBeTruthy();
    if (!mod?.DaemonSimulatorPreviewActionRequestV1Schema || !mod.DaemonSimulatorPreviewActionResponseV1Schema) {
      return;
    }

    const request = mod.DaemonSimulatorPreviewActionRequestV1Schema.parse({
      protocolVersion: 1,
      machineId: 'machine_1',
      event: {
        type: 'simulator.lease.acquire',
        simulatorId: 'sim_1',
        streamId: 'stream_1',
        sourceId: 'source_1',
        viewerId: 'viewer_1',
      },
    });
    expect(request.event.type).toBe('simulator.lease.acquire');

    const response = mod.DaemonSimulatorPreviewActionResponseV1Schema.parse({
      protocolVersion: 1,
      result: {
        v: 1,
        eventType: 'simulator.lease.acquire',
        status: 'accepted',
        lease: {
          v: 1,
          leaseId: 'lease_1',
          streamId: 'stream_1',
          sourceId: 'source_1',
          holderId: 'viewer_1',
          mode: 'exclusive',
          acquiredAtMs: 2_000,
          expiresAtMs: 3_000,
        },
        diagnostics: [],
      },
    });
    expect(response.result.status).toBe('accepted');

    expect(mod.DaemonSimulatorPreviewActionRequestV1Schema.safeParse({
      protocolVersion: 1,
      machineId: 'machine_1',
      event: {
        type: 'simulator.sideband.request',
        simulatorId: 'sim_1',
        kind: 'logs',
        rawCommand: 'unsafe',
      },
    }).success).toBe(false);

    expect(mod.DaemonSimulatorPreviewActionRequestV1Schema.safeParse({
      protocolVersion: 1,
      machineId: 'machine_1',
      event: {
        type: 'simulator.quality.set',
        simulatorId: 'sim_1',
        streamId: 'stream_1',
        sourceId: 'source_1',
        control: {
          v: 1,
          kind: 'set_quality',
          streamId: 'stream_1',
          sourceId: 'source_2',
          eventId: 'quality_1',
          maxFramesPerSecond: 15,
        },
      },
    }).success).toBe(false);
  });

  it('allows accepted sideband request results to carry the typed sideband message', async () => {
    const mod = await import('./runtimeV1').catch(() => null);

    expect(mod?.SimulatorPreviewActionResultV1Schema).toBeTruthy();
    if (!mod?.SimulatorPreviewActionResultV1Schema) return;

    const parsed = mod.SimulatorPreviewActionResultV1Schema.parse({
      v: 1,
      eventType: 'simulator.sideband.request',
      status: 'accepted',
      diagnostics: [],
      sideband: {
        v: 1,
        simulatorId: 'sim_1',
        emittedAtMs: 1_000,
        kind: 'capture_health',
        status: 'available',
      },
    });

    expect(parsed.sideband).toMatchObject({
      kind: 'capture_health',
      simulatorId: 'sim_1',
      status: 'available',
    });
  });

  it('allows accepted stream-open results to carry the live stream binding', async () => {
    const mod = await import('./runtimeV1').catch(() => null);

    expect(mod?.SimulatorPreviewActionResultV1Schema).toBeTruthy();
    if (!mod?.SimulatorPreviewActionResultV1Schema) return;

    const parsed = mod.SimulatorPreviewActionResultV1Schema.parse({
      v: 1,
      eventType: 'simulator.stream.open',
      status: 'accepted',
      diagnostics: [],
      stream: {
        v: 1,
        streamId: 'stream_1',
        sourceId: 'simulator:android:emulator-5554:screen',
        streamFamily: 'simulator:android:emulator-5554:screen',
        routeKind: 'loopback_direct',
        sourceMachineId: 'machine_1',
        targetMachineId: 'machine_1',
        expiresAtMs: 62_000,
      },
    });

    expect(parsed.stream).toMatchObject({
      streamId: 'stream_1',
      sourceId: 'simulator:android:emulator-5554:screen',
      routeKind: 'loopback_direct',
      sourceMachineId: 'machine_1',
      targetMachineId: 'machine_1',
    });
  });
});
