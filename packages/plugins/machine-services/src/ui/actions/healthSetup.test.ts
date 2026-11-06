import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { ingestPluginManifestV2 } from '@happier-dev/protocol/plugins/manifest';
import { openMachineServiceHealthSetupV1 } from './healthSetup.js';
import { PLUGIN_MANIFEST } from '../../manifest.js';

it('opens authoring for the exact watched service without enrolling or choosing its observer', async () => {
    const subject = { kind: 'machineService', machineId: 'watched-machine', serviceId: 'systemd:api' } as const;
    const opened: unknown[] = [];
    // The UI host is the process boundary; source setup and persistence stay outside this authoring intent.
    expect(await openMachineServiceHealthSetupV1({ subject }, {
        signal: new AbortController().signal,
        ui: { openAutomationEvent: async request => { opened.push(request); } },
    })).toEqual({ status: 'opened' });
    const admission = ingestPluginManifestV2(PLUGIN_MANIFEST);
    expect(admission.ok, admission.ok ? undefined : JSON.stringify(admission.diagnostics)).toBe(true);
    const declaration = PLUGIN_MANIFEST.contributes.events?.find(row => row.id === 'health-check-failed');
    expect(declaration?.kind).toBe('event');
    if (declaration?.kind !== 'event') throw new Error('Health event is missing');
    const setupSurface = declaration.automation?.source.setupSurface;
    expect(setupSurface, 'Health Configure source must reach the native check form').toBeDefined();
    const renderer = PLUGIN_MANIFEST.contributes.ui?.renderers?.find(row => row.id === setupSurface?.renderer);
    expect(renderer).toMatchObject({ kind: 'reactNative', requiredHostMethods: expect.arrayContaining(['settleEphemeralInput']) });
    if (renderer?.kind !== 'reactNative') throw new Error('Native health setup renderer is missing');
    // The package export is the public artifact boundary consumed by the UI compiler.
    expect(createRequire(import.meta.url).resolve(`@happier-dev/plugins-machine-services/happier-plugin-ui/${renderer.artifact}`))
        .toBe(fileURLToPath(new URL('../healthSetup.ts', import.meta.url)));
    expect(opened).toEqual([{ eventRef: { pluginId: PLUGIN_MANIFEST.id, localId: declaration?.id },
        sourceInstanceId: expect.stringMatching(/^health:.+$/),
        setupInput: { v: 1, subject } }]);
});

it('preserves an explicit observer selection and refuses malformed or withdrawn authoring intent', async () => {
    const opened: unknown[] = [];
    const ui = { openAutomationEvent: async (request: unknown) => { opened.push(request); } };
    const subject = { kind: 'machineService', machineId: 'watched-machine', serviceId: 'compose:api' } as const;
    expect(await openMachineServiceHealthSetupV1({ subject, monitoringMachineId: 'observer-machine' }, {
        signal: new AbortController().signal, ui,
    })).toEqual({ status: 'opened' });
    expect(opened[0]).toMatchObject({ monitoringMachineId: 'observer-machine', setupInput: { subject } });
    await expect(openMachineServiceHealthSetupV1({ subject: { ...subject, machineId: '' } }, {
        signal: new AbortController().signal, ui,
    })).rejects.toMatchObject({ code: 'health_setup_input_invalid' });
    expect(await openMachineServiceHealthSetupV1({ subject }, { signal: AbortSignal.abort(), ui }))
        .toEqual({ status: 'unavailable' });
    expect(opened).toHaveLength(1);
});
