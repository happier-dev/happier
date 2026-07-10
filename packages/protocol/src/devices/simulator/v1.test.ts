import { describe, expect, it } from 'vitest';

describe('Simulator device protocol V1', () => {
  it('validates simulator resources with platform, device id, app id, and capture capabilities', async () => {
    const mod = await import('./v1').catch((error: unknown) => ({ importError: error }));

    expect(mod).toHaveProperty('SimulatorDeviceResourceV1Schema');
    if (!('SimulatorDeviceResourceV1Schema' in mod)) return;

    const parsed = mod.SimulatorDeviceResourceV1Schema.parse({
      v: 1,
      simulatorId: 'sim_1',
      platform: 'ios',
      deviceId: 'E4B5B8D6-0000-0000-0000-000000000001',
      displayName: 'iPhone 16 Pro',
      appId: 'dev.happier.app',
      capture: {
        sourceId: 'sim_1:screen',
        supportedCodecs: ['image.mjpeg'],
        inputMode: 'exclusive',
      },
    });

    expect(parsed.platform).toBe('ios');
    expect(parsed.capture.supportedCodecs).toEqual(['image.mjpeg']);
  });

  it('preserves per-resource supported input kinds in capture capabilities', async () => {
    const mod = await import('./v1').catch((error: unknown) => ({ importError: error }));

    expect(mod).toHaveProperty('SimulatorDeviceResourceV1Schema');
    if (!('SimulatorDeviceResourceV1Schema' in mod)) return;

    const parsed = mod.SimulatorDeviceResourceV1Schema.parse({
      v: 1,
      simulatorId: 'sim_1',
      platform: 'ios',
      deviceId: 'E4B5B8D6-0000-0000-0000-000000000001',
      displayName: 'iPhone 16 Pro',
      capture: {
        sourceId: 'sim_1:screen',
        supportedCodecs: ['image.mjpeg'],
        inputMode: 'exclusive',
        supportedInputKinds: ['tap', 'swipe', 'keyboard_text'],
      },
    });

    expect(parsed.capture.supportedInputKinds).toEqual(['tap', 'swipe', 'keyboard_text']);
  });

  it('keeps a backed stream control advertised while still stripping the unbacked absolute-orientation input kind', async () => {
    const mod = await import('./v1').catch((error: unknown) => ({ importError: error }));

    expect(mod).toHaveProperty('normalizeSimulatorDeviceResourceVisibleCapabilitiesV1');
    if (!('normalizeSimulatorDeviceResourceVisibleCapabilitiesV1' in mod)) return;

    const resource = mod.SimulatorDeviceResourceV1Schema.parse({
      v: 1,
      simulatorId: 'sim_1',
      platform: 'android',
      deviceId: 'emulator-5554',
      displayName: 'Pixel 9',
      capture: {
        sourceId: 'sim_1:screen',
        supportedCodecs: ['h264.avcc'],
        inputMode: 'exclusive',
        supportedInputKinds: ['tap', 'orientation', 'pinch', 'rotate'],
        streamControls: {
          requestKeyframe: true,
          snapshot: true,
          setQuality: true,
          setFps: true,
          setScale: true,
        },
      },
    });
    const normalized = mod.normalizeSimulatorDeviceResourceVisibleCapabilitiesV1(resource);

    // The server-restart producer backs every stream control, so an advertised bit survives. The
    // absolute-orientation input kind has no producer path and is still stripped.
    expect(normalized.capture).toMatchObject({
      status: 'available',
      supportedInputKinds: ['tap', 'pinch', 'rotate'],
      streamControls: {
        requestKeyframe: true,
        snapshot: true,
        setQuality: true,
        setFps: true,
        setScale: true,
      },
    });
  });

  it('forces an unadvertised stream control false even though the control is backable (platform without the producer)', async () => {
    const mod = await import('./v1').catch((error: unknown) => ({ importError: error }));

    expect(mod).toHaveProperty('normalizeSimulatorDeviceResourceVisibleCapabilitiesV1');
    if (!('normalizeSimulatorDeviceResourceVisibleCapabilitiesV1' in mod)) return;

    const resource = mod.SimulatorDeviceResourceV1Schema.parse({
      v: 1,
      simulatorId: 'sim_ios',
      platform: 'ios',
      deviceId: 'ios-sim',
      displayName: 'iPhone',
      capture: {
        sourceId: 'sim_ios:screen',
        supportedCodecs: ['image.mjpeg'],
        inputMode: 'exclusive',
        streamControls: {
          requestKeyframe: false,
          snapshot: false,
          setQuality: false,
          setFps: false,
          setScale: false,
        },
      },
    });
    const normalized = mod.normalizeSimulatorDeviceResourceVisibleCapabilitiesV1(resource);

    expect(normalized.capture).toMatchObject({
      status: 'available',
      streamControls: {
        requestKeyframe: false,
        snapshot: false,
        setQuality: false,
        setFps: false,
        setScale: false,
      },
    });
  });

  it('projects each visible stream-control bit from the backable-control set (capability-truth)', async () => {
    const mod = await import('./v1').catch((error: unknown) => ({ importError: error }));
    const backing = await import('./runtimeActionBacking').catch((error: unknown) => ({ importError: error }));

    expect(mod).toHaveProperty('normalizeSimulatorDeviceResourceVisibleCapabilitiesV1');
    expect(backing).toHaveProperty('BACKABLE_SIMULATOR_STREAM_CONTROLS_V1');
    if (!('normalizeSimulatorDeviceResourceVisibleCapabilitiesV1' in mod)) return;
    if (!('BACKABLE_SIMULATOR_STREAM_CONTROLS_V1' in backing)) return;

    const backable = backing.BACKABLE_SIMULATOR_STREAM_CONTROLS_V1;

    const resource = mod.SimulatorDeviceResourceV1Schema.parse({
      v: 1,
      simulatorId: 'sim_1',
      platform: 'android',
      deviceId: 'emulator-5554',
      displayName: 'Pixel 9',
      capture: {
        sourceId: 'sim_1:screen',
        supportedCodecs: ['h264.avcc'],
        inputMode: 'exclusive',
        streamControls: {
          requestKeyframe: true,
          snapshot: true,
          setQuality: true,
          setFps: true,
          setScale: true,
        },
      },
    });
    const normalized = mod.normalizeSimulatorDeviceResourceVisibleCapabilitiesV1(resource);
    if (normalized.capture.status !== 'available') throw new Error('expected available capture');

    // A control's advertised bit survives normalization iff it is in the backable set; every other
    // control is forced false even though the resource advertised it true.
    const controls = normalized.capture.streamControls ?? {};
    expect(controls).toEqual({
      requestKeyframe: backable.has('requestKeyframe'),
      snapshot: backable.has('snapshot'),
      setQuality: backable.has('setQuality'),
      setFps: backable.has('setFps'),
      setScale: backable.has('setScale'),
    });
  });

  it('rejects ad hoc simulator sideband fields outside typed schemas', async () => {
    const mod = await import('./v1').catch((error: unknown) => ({ importError: error }));

    expect(mod).toHaveProperty('SimulatorDeviceResourceV1Schema');
    if (!('SimulatorDeviceResourceV1Schema' in mod)) return;

    const result = mod.SimulatorDeviceResourceV1Schema.safeParse({
      v: 1,
      simulatorId: 'sim_1',
      platform: 'ios',
      deviceId: 'E4B5B8D6-0000-0000-0000-000000000001',
      displayName: 'iPhone 16 Pro',
      capture: {
        sourceId: 'sim_1:screen',
        supportedCodecs: ['image.mjpeg'],
        inputMode: 'exclusive',
        rawSideband: { logs: true },
      },
      rawSideband: { logs: true },
    });

    expect(result.success).toBe(false);
  });

  it('represents capture-unavailable simulator resources without fake codec capabilities', async () => {
    const mod = await import('./v1').catch((error: unknown) => ({ importError: error }));

    expect(mod).toHaveProperty('SimulatorDeviceResourceV1Schema');
    if (!('SimulatorDeviceResourceV1Schema' in mod)) return;

    const parsed = mod.SimulatorDeviceResourceV1Schema.parse({
      v: 1,
      simulatorId: 'sim_1',
      platform: 'ios',
      deviceId: 'E4B5B8D6-0000-0000-0000-000000000001',
      displayName: 'iPhone 16 Pro',
      capture: {
        status: 'unavailable',
        sourceId: 'sim_1:screen',
        reasonCode: 'ios_private_helper_unavailable',
      },
    });

    expect(parsed.capture).toEqual({
      status: 'unavailable',
      sourceId: 'sim_1:screen',
      reasonCode: 'ios_private_helper_unavailable',
    });
  });

  it('derives the canonical PMS stream family from a simulator capture source id', async () => {
    const mod = await import('./v1').catch((error: unknown) => ({ importError: error }));

    expect(mod).toHaveProperty('simulatorCaptureStreamFamilyV1');
    if (!('simulatorCaptureStreamFamilyV1' in mod)) return;

    expect(mod.simulatorCaptureStreamFamilyV1('ios-simulator:A1B2-C3D4:screen')).toBe(
      'ios-simulator:A1B2-C3D4:screen',
    );
    expect(mod.simulatorCaptureStreamFamilyV1('  ')).toBeNull();
  });
});
