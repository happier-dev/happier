import { access, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SimulatorAccessibilitySnapshotV1 } from '@happier-dev/protocol/devices/simulator/accessibilityV1';

import { resolveCliRuntimeAssetPath } from '@/packagedRuntime/assets/resolveCliRuntimeAssetPath';
import { defaultSimulatorOperationRunner, type SimulatorOperationProcessResult, type SimulatorOperationRunner } from '../process';

export type SimulatorAccessibilityResult = Readonly<
    | { ok: true; snapshot?: SimulatorAccessibilitySnapshotV1; pressedIdentifier?: string }
    | { ok: false; errorCode: string; step: string; exitCode?: number; cause?: string }
>;

type JsonObject = Record<string, unknown>;
function object(value: unknown): value is JsonObject { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function finite(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value); }

function decodeSnapshot(value: unknown): SimulatorAccessibilitySnapshotV1 | null {
    if (!object(value) || value.protocolVersion !== 1 || typeof value.truncated !== 'boolean' || !object(value.tree)
        || typeof value.appBundleId !== 'string' || !value.appBundleId || !object(value.viewport)
        || !finite(value.viewport.width) || !finite(value.viewport.height) || value.viewport.width <= 0 || value.viewport.height <= 0) return null;
    const nodes: SimulatorAccessibilitySnapshotV1['nodes'] = [];
    const visit = (raw: unknown, parentIndex?: number): boolean => {
        if (!object(raw) || !Array.isArray(raw.XC_kAXXCAttributeChildren)) return false;
        const index = nodes.length;
        const rawFrame = raw.XC_kAXXCAttributeFrame;
        let frame: SimulatorAccessibilitySnapshotV1['nodes'][number]['frame'];
        if (rawFrame !== undefined) {
            if (!object(rawFrame) || !finite(rawFrame.X) || !finite(rawFrame.Y) || !finite(rawFrame.Width) || !finite(rawFrame.Height)) return false;
            frame = { x: rawFrame.X, y: rawFrame.Y, width: rawFrame.Width, height: rawFrame.Height };
        }
        const traits = raw.XC_kAXXCAttributeTraits;
        if (traits !== undefined && (typeof traits !== 'string' || !/^\d+$/.test(traits))) return false;
        const type = raw.XC_kAXXCAttributeElementType;
        const identifier = raw.XC_kAXXCAttributeIdentifier;
        const label = raw.XC_kAXXCAttributeLabel;
        const nodeValue = raw.XC_kAXXCAttributeValue;
        nodes.push({ index, ...(parentIndex === undefined ? {} : { parentIndex }),
            type: typeof type === 'string' ? type : 'Other',
            ...(typeof identifier === 'string' && identifier ? { identifier } : {}),
            ...(typeof label === 'string' ? { label } : {}),
            ...(typeof nodeValue === 'string' || finite(nodeValue) ? { value: nodeValue } : {}),
            ...(frame ? { frame } : {}),
            // UIAccessibilityTraitNotEnabled is bit 8 in the characterized native AX vocabulary.
            ...(typeof traits === 'string' ? { enabled: (BigInt(traits) & (1n << 8n)) === 0n } : {}),
        });
        return raw.XC_kAXXCAttributeChildren.every((child) => visit(child, index));
    };
    return visit(value.tree) ? { nodes, truncated: value.truncated, appBundleId: value.appBundleId,
        viewport: { width: value.viewport.width, height: value.viewport.height } } : null;
}

function parseJson(buffer: Buffer): unknown {
    try { return JSON.parse(buffer.toString('utf8')); } catch { return undefined; }
}

function nativeFailure(step: string, result: SimulatorOperationProcessResult): Extract<SimulatorAccessibilityResult, { ok: false }> {
    const unavailable = result.errorCode === 'ENOENT' || result.exitCode === 69
        || /requires Xcode|unable to find (?:utility|SDK)|SDK .* cannot be located|no such file or directory|file not found|build input file cannot be found|does not contain a scheme named/i.test(`${result.stderr}\n${result.stdout.toString('utf8')}`);
    return { ok: false, step, errorCode: result.aborted ? 'operation_cancelled' : unavailable ? 'simulator_accessibility_unavailable' : result.errorCode ?? 'simulator_accessibility_native_failed',
        ...(result.exitCode === null ? {} : { exitCode: result.exitCode }),
        ...(result.stderr || result.cause ? { cause: result.stderr || result.cause } : {}),
    };
}

export function createIosSimulatorAccessibility(options: Readonly<{
    platform?: NodeJS.Platform; arch?: string; sourcePath?: string; upstreamPath?: string; run?: SimulatorOperationRunner;
}> = {}) {
    const run = options.run ?? defaultSimulatorOperationRunner;
    const platform = options.platform ?? process.platform;
    const sourcePath = options.sourcePath ?? resolveCliRuntimeAssetPath('native', 'simulator', 'accessibility');
    const architecture = options.arch ?? process.arch;
    const upstreamPath = options.upstreamPath ?? resolveCliRuntimeAssetPath('assets', 'ios', 'accessibility', 'upstream');
    const isAvailable = async (): Promise<boolean> => {
        if (platform !== 'darwin') return false;
        try {
            await Promise.all([
                ...['SnapshotMain.m', 'Host.m', 'PressTests.m', 'Press.xcodeproj/project.pbxproj',
                    'Press.xcodeproj/xcshareddata/xcschemes/Press.xcscheme'].map((file) => access(join(sourcePath, file))),
                ...['SnapshotBridgeRuntime.m', 'SnapshotBridgeRuntime.h', 'SnapshotBridgeCapture.m',
                    'SnapshotBridgeCapture.h', 'ForegroundApplicationGeometry.h'].map((file) => access(join(upstreamPath, file))),
            ]);
            const tools = await Promise.all(['clang', 'xcodebuild'].map((tool) => run({ command: 'xcrun', args: ['--find', tool] })));
            return tools.every((result) => result.exitCode === 0);
        } catch { return false; }
    };
    const execute = async (input: Readonly<{
        deviceId: string; operation: 'accessibility_snapshot' | 'accessibility_press'; identifier?: string;
    }>, signal?: AbortSignal): Promise<SimulatorAccessibilityResult> => {
        if (signal?.aborted) return { ok: false, errorCode: 'operation_cancelled', step: 'accessibility.prepare' };
        if (platform !== 'darwin') return { ok: false, errorCode: 'simulator_accessibility_unavailable', step: 'accessibility.prepare' };
        const scratch = await mkdtemp(join(tmpdir(), 'happier-simulator-accessibility-'));
        const invoke = (command: string, args: readonly string[], stdin?: string) => run({ command, args,
            ...(stdin === undefined ? {} : { stdin }), ...(signal ? { signal } : {}) });
        try {
            const binary = join(scratch, 'snapshot');
            // Runtime sources are packaged alongside their licenses. xcrun uses the selected full Xcode SDK.
            const built = await invoke('xcrun', ['--sdk', 'iphonesimulator', 'clang', '-arch', architecture === 'x64' ? 'x86_64' : architecture,
                '-mios-simulator-version-min=15.0', '-fobjc-arc', '-fblocks', '-framework', 'Foundation', '-framework', 'CoreGraphics',
                '-I', join(upstreamPath, '..'), join(sourcePath, 'SnapshotMain.m'),
                join(upstreamPath, 'SnapshotBridgeRuntime.m'), join(upstreamPath, 'SnapshotBridgeCapture.m'), '-o', binary]);
            if (built.exitCode !== 0) return nativeFailure('accessibility.build_snapshot', built);
            const captured = await invoke('xcrun', ['simctl', 'spawn', input.deviceId, binary, input.operation === 'accessibility_press' ? 'target' : 'snapshot']);
            if (captured.exitCode !== 0) return nativeFailure('accessibility.snapshot', captured);
            const raw = parseJson(captured.stdout);
            if (object(raw) && raw.ok === false && typeof raw.error_code === 'string') return {
                ok: false, errorCode: raw.error_code, step: 'accessibility.snapshot', ...(typeof raw.error === 'string' ? { cause: raw.error } : {}),
            };
            if (input.operation === 'accessibility_snapshot') {
                const snapshot = decodeSnapshot(raw);
                return snapshot ? { ok: true, snapshot } : { ok: false, errorCode: 'simulator_accessibility_snapshot_invalid', step: 'accessibility.snapshot' };
            }
            // XCTest owns identifier resolution and the effect. The guest only locates the foreground app.
            if (!object(raw) || raw.ok !== true || typeof raw.appBundleId !== 'string' || !raw.appBundleId) return {
                ok: false, errorCode: 'simulator_accessibility_target_invalid', step: 'accessibility.target',
            };
            const buildPath = join(scratch, 'build');
            const runnerBuild = await invoke('xcodebuild', ['build-for-testing', '-project', join(sourcePath, 'Press.xcodeproj'), '-scheme', 'Press',
                '-destination', `id=${input.deviceId}`, '-derivedDataPath', buildPath, '-parallel-testing-enabled', 'NO', 'CODE_SIGNING_ALLOWED=NO']);
            if (runnerBuild.exitCode !== 0) return nativeFailure('accessibility.build_press', runnerBuild);
            const products = join(buildPath, 'Build', 'Products');
            const manifest = (await readdir(products)).find((file) => file.endsWith('.xctestrun'));
            if (!manifest) return { ok: false, errorCode: 'simulator_accessibility_runner_manifest_missing', step: 'accessibility.build_press' };
            const decoded = await invoke('plutil', ['-convert', 'json', '-o', '-', join(products, manifest)]);
            if (decoded.exitCode !== 0) return nativeFailure('accessibility.configure_press', decoded);
            const configuration = parseJson(decoded.stdout);
            if (!object(configuration)) return { ok: false, errorCode: 'simulator_accessibility_runner_manifest_invalid', step: 'accessibility.configure_press' };
            const requestPath = join(scratch, 'request.json');
            const resultPath = join(scratch, 'result.json');
            await writeFile(requestPath, JSON.stringify({ appBundleId: raw.appBundleId, identifier: input.identifier, resultPath }));
            // Our shared XCTest scheme produces xctestrun format 1 (target dictionaries at the root).
            const target = configuration.HappierSimulatorPressTests;
            if (!object(target)) return { ok: false, errorCode: 'simulator_accessibility_runner_manifest_invalid', step: 'accessibility.configure_press' };
            target.EnvironmentVariables = { ...(object(target.EnvironmentVariables) ? target.EnvironmentVariables : {}), HAPPIER_SIMULATOR_PRESS_REQUEST: requestPath };
            const configuredPath = join(products, 'HappierPress.xctestrun');
            const encoded = await invoke('plutil', ['-convert', 'binary1', '-o', configuredPath, '-'], JSON.stringify(configuration));
            if (encoded.exitCode !== 0) return nativeFailure('accessibility.configure_press', encoded);
            const pressed = await invoke('xcodebuild', ['test-without-building', '-xctestrun', configuredPath,
                '-destination', `id=${input.deviceId}`, '-parallel-testing-enabled', 'NO']);
            if (pressed.exitCode !== 0) return nativeFailure('accessibility.press', pressed);
            const response: unknown = JSON.parse(await readFile(resultPath, 'utf8'));
            if (object(response) && response.ok === true && input.identifier) return { ok: true, pressedIdentifier: input.identifier };
            return { ok: false, step: 'accessibility.press', errorCode: object(response) && typeof response.errorCode === 'string' ? response.errorCode : 'simulator_accessibility_press_invalid',
                ...(object(response) && typeof response.cause === 'string' ? { cause: response.cause } : {}),
            };
        } catch (error) {
            return { ok: false, errorCode: signal?.aborted ? 'operation_cancelled' : 'simulator_accessibility_native_failed', step: 'accessibility.native',
                ...(error instanceof Error ? { cause: error.message } : {}),
            };
        } finally { await rm(scratch, { recursive: true, force: true }); }
    };
    return { execute, isAvailable };
}
