import { describe, expect, it, vi } from 'vitest';

import type { SimulatorToolRunResult } from '../process';

function okRun(stdout = ''): SimulatorToolRunResult {
    return { exitCode: 0, stdout, stderr: '' };
}

function failRun(stderr: string, exitCode = 1): SimulatorToolRunResult {
    return { exitCode, stdout: '', stderr };
}

describe('verifyIosSimulatorHelperSignature', () => {
    it('accepts a Gatekeeper-accepted, notarized, stapled artifact', async () => {
        const mod = await import('./signature').catch(() => null);

        expect(mod?.verifyIosSimulatorHelperSignature).toBeTypeOf('function');
        if (!mod?.verifyIosSimulatorHelperSignature) return;

        const runTool = vi.fn(async (input: { command: string; args: readonly string[] }) => {
            if (input.command === 'codesign') return okRun('valid on disk');
            if (input.command === 'spctl') return okRun('source=Notarized Developer ID');
            if (input.command === 'stapler') return okRun('The validate action worked!');
            throw new Error(`unexpected command ${input.command}`);
        });

        await expect(mod.verifyIosSimulatorHelperSignature({
            path: '/tmp/happier-ios-simulator-helper',
            runTool,
        })).resolves.toEqual({ ok: true });

        const commands = runTool.mock.calls.map((call) => call[0].command);
        expect(commands).toContain('codesign');
        expect(commands).toContain('spctl');
    });

    it('fails closed with helper_artifact_unsigned when codesign --verify fails', async () => {
        const mod = await import('./signature').catch(() => null);

        expect(mod?.verifyIosSimulatorHelperSignature).toBeTypeOf('function');
        if (!mod?.verifyIosSimulatorHelperSignature) return;

        const runTool = vi.fn(async (input: { command: string }) => {
            if (input.command === 'codesign') return failRun('code object is not signed at all');
            return okRun();
        });

        await expect(mod.verifyIosSimulatorHelperSignature({
            path: '/tmp/happier-ios-simulator-helper',
            runTool,
        })).resolves.toMatchObject({
            ok: false,
            reasonCode: 'codesign_verify_failed',
        });
    });

    it('fails closed with helper_artifact_unsigned when Gatekeeper rejects the artifact', async () => {
        const mod = await import('./signature').catch(() => null);

        expect(mod?.verifyIosSimulatorHelperSignature).toBeTypeOf('function');
        if (!mod?.verifyIosSimulatorHelperSignature) return;

        const runTool = vi.fn(async (input: { command: string }) => {
            if (input.command === 'codesign') return okRun('valid on disk');
            if (input.command === 'spctl') return failRun('rejected\nsource=no usable signature');
            return okRun();
        });

        await expect(mod.verifyIosSimulatorHelperSignature({
            path: '/tmp/happier-ios-simulator-helper',
            runTool,
        })).resolves.toMatchObject({
            ok: false,
            reasonCode: 'spctl_assess_rejected',
        });
    });

    it('fails closed when the staple validation fails', async () => {
        const mod = await import('./signature').catch(() => null);

        expect(mod?.verifyIosSimulatorHelperSignature).toBeTypeOf('function');
        if (!mod?.verifyIosSimulatorHelperSignature) return;

        const runTool = vi.fn(async (input: { command: string }) => {
            if (input.command === 'codesign') return okRun('valid on disk');
            if (input.command === 'spctl') return okRun('source=Notarized Developer ID');
            if (input.command === 'stapler') return failRun('does not have a ticket stapled');
            return okRun();
        });

        await expect(mod.verifyIosSimulatorHelperSignature({
            path: '/tmp/happier-ios-simulator-helper',
            runTool,
            requireStaple: true,
        })).resolves.toMatchObject({
            ok: false,
            reasonCode: 'stapler_validate_failed',
        });
    });

    it('fails closed on non-macOS hosts without invoking Gatekeeper tools', async () => {
        const mod = await import('./signature').catch(() => null);

        expect(mod?.verifyIosSimulatorHelperSignature).toBeTypeOf('function');
        if (!mod?.verifyIosSimulatorHelperSignature) return;

        const runTool = vi.fn(async () => okRun());

        await expect(mod.verifyIosSimulatorHelperSignature({
            path: '/tmp/happier-ios-simulator-helper',
            platform: 'linux',
            runTool,
        })).resolves.toMatchObject({
            ok: false,
            reasonCode: 'signature_verifier_unsupported_host',
        });
        expect(runTool).not.toHaveBeenCalled();
    });

    it('fails closed when the verifier tool runner throws', async () => {
        const mod = await import('./signature').catch(() => null);

        expect(mod?.verifyIosSimulatorHelperSignature).toBeTypeOf('function');
        if (!mod?.verifyIosSimulatorHelperSignature) return;

        const runTool = vi.fn(async () => {
            throw new Error('spawn ENOENT');
        });

        await expect(mod.verifyIosSimulatorHelperSignature({
            path: '/tmp/happier-ios-simulator-helper',
            runTool,
        })).resolves.toMatchObject({
            ok: false,
            reasonCode: 'signature_verifier_failed',
        });
    });
});
