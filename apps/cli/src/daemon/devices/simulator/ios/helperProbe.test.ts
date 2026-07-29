import { describe, expect, it } from 'vitest';

describe('probeIosSimulatorHelperHealth', () => {
    it('parses strict helper health JSON', async () => {
        const mod = await import('./helperProbe').catch(() => null);

        expect(mod?.probeIosSimulatorHelperHealth).toBeTypeOf('function');
        if (!mod?.probeIosSimulatorHelperHealth) return;

        await expect(mod.probeIosSimulatorHelperHealth({
            helperPath: '/tmp/helper',
            runHelper: async () => ({
                exitCode: 0,
                stdout: JSON.stringify({
                    v: 1,
                    platform: 'ios',
                    status: 'available',
                    usesPrivateFrameworks: true,
                    helperDistribution: 'prebuilt-signed',
                    requiredPrivateFrameworks: ['CoreSimulator', 'SimulatorKit'],
                    supportedCodecs: ['image.mjpeg'],
                    supportedInputKinds: ['tap'],
                    helperVersion: '1.2.3',
                }),
                stderr: '',
            }),
        })).resolves.toMatchObject({
            status: 'available',
            helperVersion: '1.2.3',
        });
    });

    it('fails closed for malformed helper output', async () => {
        const mod = await import('./helperProbe').catch(() => null);

        expect(mod?.probeIosSimulatorHelperHealth).toBeTypeOf('function');
        if (!mod?.probeIosSimulatorHelperHealth) return;

        await expect(mod.probeIosSimulatorHelperHealth({
            helperPath: '/tmp/helper',
            runHelper: async () => ({ exitCode: 0, stdout: '{not-json', stderr: '' }),
        })).resolves.toMatchObject({
            status: 'unavailable',
            reasonCode: 'ios_private_helper_unavailable',
            diagnostics: [expect.objectContaining({ code: 'helper_health_malformed_output' })],
        });
    });

    it('maps helper-reported private symbol drift to a typed unavailable health result', async () => {
        const mod = await import('./helperProbe').catch(() => null);

        expect(mod?.probeIosSimulatorHelperHealth).toBeTypeOf('function');
        if (!mod?.probeIosSimulatorHelperHealth) return;

        await expect(mod.probeIosSimulatorHelperHealth({
            helperPath: '/tmp/helper',
            runHelper: async () => ({
                exitCode: 0,
                stdout: JSON.stringify({
                    v: 1,
                    platform: 'ios',
                    status: 'unavailable',
                    reasonCode: 'private_framework_symbol_mismatch',
                    diagnostics: [{
                        missingSymbol: 'IndigoHIDMessageForMouseNSEvent',
                    }],
                }),
                stderr: '',
            }),
        })).resolves.toMatchObject({
            status: 'unavailable',
            reasonCode: 'private_framework_symbol_mismatch',
            diagnostics: [expect.objectContaining({
                missingSymbol: 'IndigoHIDMessageForMouseNSEvent',
            })],
        });
    });
});
