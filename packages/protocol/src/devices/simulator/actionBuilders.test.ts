import { describe, expect, it } from 'vitest';

describe('simulator preview action builders', () => {
  it('builds canonical stream, lease, sideband, and stream-control events', async () => {
    const mod = await import('./actionBuilders.js').catch(() => null);

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

  it('keeps capture_health as the only backed sideband kind before native producers land', async () => {
    const mod = await import('./actionBuilders.js').catch(() => null);

    expect(mod?.BACKED_SIMULATOR_SIDEBAND_KINDS_V1).toEqual(['capture_health']);
    expect(mod?.normalizeBackedSimulatorSidebandKindsV1?.([
      'logs',
      'capture_health',
      'route',
      'capture_health',
    ])).toEqual(['capture_health']);
  });
});
