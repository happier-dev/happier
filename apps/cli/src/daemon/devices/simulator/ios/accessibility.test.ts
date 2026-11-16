import { Buffer } from 'node:buffer';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveCliRuntimeAssetPath } from '@/packagedRuntime/assets/resolveCliRuntimeAssetPath';
import { describe, expect, it, vi } from 'vitest';

import type { SimulatorOperationRunner } from '../process';
import { createIosSimulatorAccessibility } from './accessibility';

const completed = (value: unknown) => ({ exitCode: 0, stdout: Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)), stderr: '' });
// Captured guest AX attribute vocabulary from the native reader.
const nativeNode = (identifier: string, x = 20) => ({
    XC_kAXXCAttributeElementType: 'UIButton', XC_kAXXCAttributeIdentifier: identifier,
    XC_kAXXCAttributeLabel: 'Increment fixture', XC_kAXXCAttributeTraits: '1',
    XC_kAXXCAttributeFrame: { X: x, Y: 300, Width: 350, Height: 100 }, XC_kAXXCAttributeChildren: [],
});
const snapshot = (children = [nativeNode('fixture-increment')]) => ({
    ok: true, protocolVersion: 1, pid: 42,
    appBundleId: 'dev.happier.axfixture', viewport: { width: 393, height: 852 }, truncated: false,
    tree: { XC_kAXXCAttributeElementType: 'UIApplication', XC_kAXXCAttributeChildren: children },
});

function nativeBoundary(read: () => unknown) {
    return vi.fn<SimulatorOperationRunner>(async ({ args }) => {
        if (args[0] === 'simctl') return completed(read());
        return completed('');
    });
}

describe('iOS simulator accessibility', () => {
    it('withdraws accessibility capability when a consumed native source is missing', async () => {
        const scratch = await mkdtemp(join(tmpdir(), 'happier-ax-availability-test-'));
        const sourcePath = join(scratch, 'native');
        const upstreamPath = join(scratch, 'upstream');
        try {
            await cp(resolveCliRuntimeAssetPath('native', 'simulator', 'accessibility'), sourcePath, { recursive: true });
            await cp(resolveCliRuntimeAssetPath('assets', 'ios', 'accessibility', 'upstream'), upstreamPath, { recursive: true });
            const backend = createIosSimulatorAccessibility({ platform: 'darwin', sourcePath, upstreamPath, run: async () => completed('') });
            expect(await backend.isAvailable()).toBe(true);
            await rm(join(sourcePath, 'PressTests.m'));
            expect(await backend.isAvailable()).toBe(false);
        } finally { await rm(scratch, { recursive: true, force: true }); }
    });

    it('uses the native compiler spelling for an Intel host architecture', async () => {
        const run = nativeBoundary(() => snapshot());
        const backend = createIosSimulatorAccessibility({ platform: 'darwin', arch: 'x64', run });
        expect(await backend.execute({ deviceId: 'owned-device', operation: 'accessibility_snapshot' })).toMatchObject({ ok: true });
        const compile = run.mock.calls[0]![0].args;
        expect(compile[compile.indexOf('-arch') + 1]).toBe('x86_64');
    });

    it('classifies a missing consumed native header as unavailable', async () => {
        const backend = createIosSimulatorAccessibility({ platform: 'darwin', run: async () => ({ exitCode: 1, stdout: Buffer.alloc(0), stderr: "fatal error: 'upstream/ForegroundApplicationGeometry.h' file not found" }) });
        expect(await backend.execute({ deviceId: 'owned-device', operation: 'accessibility_snapshot' })).toMatchObject({ ok: false, errorCode: 'simulator_accessibility_unavailable' });
    });

    it('publishes the guest tree with hierarchy, identifier and point-space frames', async () => {
        const run = nativeBoundary(() => snapshot());
        const backend = createIosSimulatorAccessibility({ platform: 'darwin', sourcePath: '/bundled/accessibility', upstreamPath: '/bundled/upstream', run });
        expect(await backend.execute({ deviceId: 'owned-device', operation: 'accessibility_snapshot' })).toMatchObject({
            ok: true, snapshot: { appBundleId: 'dev.happier.axfixture', viewport: { width: 393, height: 852 }, truncated: false,
                nodes: [{ index: 0, type: 'UIApplication' }, { index: 1, parentIndex: 0, type: 'UIButton', identifier: 'fixture-increment', frame: { x: 20, y: 300, width: 350, height: 100 }, enabled: true }],
            },
        });
    });

    it('discloses native truncation and refuses malformed trees rather than dropping nodes', async () => {
        let response: unknown = { ...snapshot(), truncated: true };
        const run = nativeBoundary(() => response);
        const backend = createIosSimulatorAccessibility({ platform: 'darwin', sourcePath: '/bundled/accessibility', upstreamPath: '/bundled/upstream', run });
        const request = { deviceId: 'owned-device', operation: 'accessibility_snapshot' as const };
        expect(await backend.execute(request)).toMatchObject({ ok: true, snapshot: { truncated: true } });
        response = { ...snapshot(), tree: { XC_kAXXCAttributeChildren: [null] } };
        expect(await backend.execute(request)).toMatchObject({ ok: false, errorCode: 'simulator_accessibility_snapshot_invalid' });
    });

    it('lets XCTest own identifier resolution without first acquiring the AX tree and retains typed refusals', async () => {
        const targetReads: string[][] = [];
        const requests: unknown[] = [];
        let outcome: unknown = { ok: true };
        const run: SimulatorOperationRunner = async ({ args, stdin }) => {
            if (args[0] === 'simctl') {
                targetReads.push([...args]);
                return completed({ ok: true, appBundleId: 'dev.happier.axfixture' });
            }
            if (args[0] === 'build-for-testing') {
                const directory = args[args.indexOf('-derivedDataPath') + 1]!;
                // Captured xctestrun format 1 from our shared native scheme on Xcode 26.5.
                await mkdir(`${directory}/Build/Products`, { recursive: true });
                await writeFile(`${directory}/Build/Products/Press_iphonesimulator.xctestrun`, 'plist');
            }
            if (args[0] === '-convert' && args[1] === 'json') return completed({ HappierSimulatorPressTests: { EnvironmentVariables: {} } });
            if (args[0] === '-convert' && stdin) {
                const configuration = JSON.parse(stdin.toString());
                const requestPath = configuration.HappierSimulatorPressTests.EnvironmentVariables.HAPPIER_SIMULATOR_PRESS_REQUEST;
                requests.push(JSON.parse(await readFile(requestPath, 'utf8')));
            }
            if (args[0] === 'test-without-building') {
                const request = requests.at(-1) as { resultPath: string };
                await writeFile(request.resultPath, JSON.stringify(outcome));
            }
            return completed('');
        };
        const backend = createIosSimulatorAccessibility({ platform: 'darwin', sourcePath: '/bundled/accessibility', upstreamPath: '/bundled/upstream', run });
        const press = { deviceId: 'owned-device', operation: 'accessibility_press' as const, identifier: 'fixture-increment' };
        expect(await backend.execute(press)).toEqual({ ok: true, pressedIdentifier: 'fixture-increment' });
        for (const errorCode of ['simulator_accessibility_element_not_found', 'simulator_accessibility_element_ambiguous', 'simulator_accessibility_element_not_hittable']) {
            outcome = { ok: false, errorCode };
            expect(await backend.execute(press)).toMatchObject({ ok: false, errorCode });
        }
        expect(targetReads).toHaveLength(4);
        expect(targetReads.every((args) => args.at(-1) === 'target')).toBe(true);
        expect(requests).toEqual(expect.arrayContaining([expect.objectContaining({ identifier: 'fixture-increment', appBundleId: 'dev.happier.axfixture' })]));
    });

    it('carries native refusal and cancellation without disclosing a partial tree', async () => {
        const run = nativeBoundary(() => ({ ok: false, error_code: 'foreground-owner-changed', error: 'Foreground changed' }));
        const backend = createIosSimulatorAccessibility({ platform: 'darwin', sourcePath: '/bundled/accessibility', upstreamPath: '/bundled/upstream', run });
        const controller = new AbortController();
        expect(await backend.execute({ deviceId: 'owned-device', operation: 'accessibility_snapshot' }, controller.signal)).toMatchObject({ ok: false, errorCode: 'foreground-owner-changed', cause: 'Foreground changed' });
        expect(run.mock.calls.every(([call]) => call.signal === controller.signal)).toBe(true);
        const signal = AbortSignal.abort();
        expect(await backend.execute({ deviceId: 'owned-device', operation: 'accessibility_snapshot' }, signal)).toMatchObject({ ok: false, errorCode: 'operation_cancelled' });
        expect(run.mock.calls.every(([call]) => !call.signal?.aborted)).toBe(true);
    });

    it('reports missing bundled native assets and an unavailable Xcode toolchain as unavailable', async () => {
        const backend = createIosSimulatorAccessibility({ platform: 'darwin', run: async () => ({ exitCode: null, stdout: Buffer.alloc(0), stderr: '', errorCode: 'ENOENT', cause: 'spawn xcrun ENOENT' }) });
        expect(await backend.execute({ deviceId: 'owned-device', operation: 'accessibility_snapshot' })).toMatchObject({ ok: false, errorCode: 'simulator_accessibility_unavailable', step: 'accessibility.build_snapshot', cause: 'spawn xcrun ENOENT' });
    });
});
