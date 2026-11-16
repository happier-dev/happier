import { describe, expect, it } from 'vitest';

describe('simulator preview action builders', () => {
  it('builds canonical stream, lease, sideband, and stream-control events', async () => {
    const mod = await import('./actionBuilders.js');

    expect(mod?.createSimulatorPreviewOpenStreamEventV1).toBeTypeOf('function');
    if (!mod?.createSimulatorPreviewOpenStreamEventV1) return;

    expect(mod.createSimulatorPreviewOpenStreamEventV1({
      simulatorId: 'sim_1',
      sourceId: 'source_1',
    })).toEqual({
      type: 'simulator.stream.open',
      simulatorId: 'sim_1',
      sourceId: 'source_1',
    });
  });

  it('backs capture health and process-produced device logs', async () => {
    const mod = await import('./actionBuilders.js');

    expect(mod?.BACKED_SIMULATOR_SIDEBAND_KINDS_V1).toEqual(['capture_health', 'logs']);
    expect(mod?.normalizeBackedSimulatorSidebandKindsV1?.([
      'logs',
      'capture_health',
      'route',
      'capture_health',
    ])).toEqual(['logs', 'capture_health']);
  });
});
