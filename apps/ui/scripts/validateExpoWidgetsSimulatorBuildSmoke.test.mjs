import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    assertExpoWidgetsSimulatorBuildSmoke,
    DEFAULT_WIDGET_TARGET_NAME,
    DEFAULT_XCODEBUILD_MAX_BUFFER_BYTES,
    DEFAULT_XCODEBUILD_TIMEOUT_MS,
} from './validateExpoWidgetsSimulatorBuildSmoke.mjs';

async function createGeneratedIosFixture({
    appScheme = 'Happierinternaldev',
    includeTopLevelWorkspace = false,
    topLevelWorkspaceIncludesPods = true,
} = {}) {
    const rootDir = await mkdtemp(join(tmpdir(), 'expo-widgets-build-smoke-'));
    const iosDir = join(rootDir, 'ios');
    const xcodeprojDir = join(iosDir, `${appScheme}.xcodeproj`);
    const nestedWorkspaceDir = join(xcodeprojDir, 'project.xcworkspace');
    const topLevelWorkspaceDir = join(iosDir, `${appScheme}.xcworkspace`);
    const localPodspecsDir = join(iosDir, 'Pods', 'Local Podspecs');

    await mkdir(nestedWorkspaceDir, { recursive: true });
    await mkdir(localPodspecsDir, { recursive: true });
    await writeFile(
        join(nestedWorkspaceDir, 'contents.xcworkspacedata'),
        [
            '<?xml version="1.0" encoding="UTF-8"?>',
            '<Workspace version="1.0">',
            '   <FileRef location="self:">',
            '   </FileRef>',
            '</Workspace>',
        ].join('\n'),
        'utf8',
    );

    if (includeTopLevelWorkspace) {
        await mkdir(topLevelWorkspaceDir, { recursive: true });
        await writeFile(
            join(topLevelWorkspaceDir, 'contents.xcworkspacedata'),
            [
                '<?xml version="1.0" encoding="UTF-8"?>',
                '<Workspace version="1.0">',
                `   <FileRef location="group:${appScheme}.xcodeproj">`,
                '   </FileRef>',
                topLevelWorkspaceIncludesPods
                    ? '   <FileRef location="group:Pods/Pods.xcodeproj">'
                    : '   <FileRef location="group:Pods/Missing.xcodeproj">',
                '   </FileRef>',
                '</Workspace>',
            ].join('\n'),
            'utf8',
        );
    }

    await writeFile(
        join(localPodspecsDir, 'ExpoWidgets.podspec.json'),
        JSON.stringify({ name: 'ExpoWidgets' }),
        'utf8',
    );

    return {
        iosDir,
        appScheme,
        nestedWorkspaceDir,
        topLevelWorkspaceDir,
    };
}

test('assertExpoWidgetsSimulatorBuildSmoke prefers the top-level CocoaPods workspace when available', async () => {
    const { iosDir, appScheme, topLevelWorkspaceDir } = await createGeneratedIosFixture({
        includeTopLevelWorkspace: true,
    });
    const recordedInvocations = [];

    const summary = await assertExpoWidgetsSimulatorBuildSmoke({
        iosDir,
        derivedDataRoot: join(iosDir, '.tmp-derived-data'),
        spawnSyncImpl(command, args, options) {
            recordedInvocations.push({ command, args, options });

            if (command === 'xcrun') {
                return {
                    status: 0,
                    stdout: JSON.stringify({
                        devices: {
                            'com.apple.CoreSimulator.SimRuntime.iOS-26-4': [
                                {
                                    isAvailable: true,
                                    state: 'Shutdown',
                                    name: 'iPhone 17 Pro',
                                    udid: 'SIM-DEVICE-UDID',
                                    deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro',
                                },
                            ],
                        },
                    }),
                    stderr: '',
                    error: undefined,
                };
            }

            if (args[0] === '-list') {
                return {
                    status: 0,
                    stdout: `Information about workspace "${appScheme}":\n    Schemes:\n        ${DEFAULT_WIDGET_TARGET_NAME}\n        ${appScheme}\n`,
                    stderr: '',
                    error: undefined,
                };
            }

            return {
                status: 0,
                stdout: '',
                stderr: '',
                error: undefined,
            };
        },
    });

    assert.equal(summary.appScheme, appScheme);
    assert.equal(summary.widgetScheme, DEFAULT_WIDGET_TARGET_NAME);
    assert.equal(summary.workspacePath, topLevelWorkspaceDir);
    assert.equal(recordedInvocations.length, 4);
    assert.deepEqual(recordedInvocations.map(({ command, args }) => [command, ...args.slice(0, 4)]), [
        ['xcrun', 'simctl', 'list', 'devices', 'available'],
        ['xcodebuild', '-list', '-workspace', topLevelWorkspaceDir],
        ['xcodebuild', '-workspace', topLevelWorkspaceDir, '-scheme', DEFAULT_WIDGET_TARGET_NAME],
        ['xcodebuild', '-workspace', topLevelWorkspaceDir, '-scheme', appScheme],
    ]);
    assert.equal(recordedInvocations[0].options.maxBuffer < DEFAULT_XCODEBUILD_MAX_BUFFER_BYTES, true);
    assert.ok(
        recordedInvocations
            .slice(1)
            .every(({ options }) => options.maxBuffer === DEFAULT_XCODEBUILD_MAX_BUFFER_BYTES),
    );
    assert.ok(recordedInvocations.slice(1).every(({ options }) => options.timeout === DEFAULT_XCODEBUILD_TIMEOUT_MS));
    const widgetBuildArgs = recordedInvocations[2].args;
    assert.ok(widgetBuildArgs.includes('id=SIM-DEVICE-UDID'));
    assert.ok(widgetBuildArgs.includes('ONLY_ACTIVE_ARCH=YES'));
    assert.ok(widgetBuildArgs.includes('COMPILER_INDEX_STORE_ENABLE=NO'));
});

test('assertExpoWidgetsSimulatorBuildSmoke rejects a top-level workspace that omits Pods integration', async () => {
    const { iosDir } = await createGeneratedIosFixture({
        includeTopLevelWorkspace: true,
        topLevelWorkspaceIncludesPods: false,
    });

    await assert.rejects(
        () =>
            assertExpoWidgetsSimulatorBuildSmoke({
                iosDir,
                spawnSyncImpl: () => ({
                    status: 0,
                    stdout: '',
                    stderr: '',
                    error: undefined,
                }),
            }),
        /Pods\/Pods\.xcodeproj/i,
    );
});

test('assertExpoWidgetsSimulatorBuildSmoke rejects missing ExpoWidgets pod installation state', async () => {
    const { iosDir } = await createGeneratedIosFixture();
    await rm(join(iosDir, 'Pods', 'Local Podspecs', 'ExpoWidgets.podspec.json'));

    await assert.rejects(
        () =>
            assertExpoWidgetsSimulatorBuildSmoke({
                iosDir,
                spawnSyncImpl: () => ({
                    status: 0,
                    stdout: '',
                    stderr: '',
                    error: undefined,
                }),
            }),
        /ExpoWidgets\.podspec\.json/i,
    );
});

test('apps/ui package.json exposes a dedicated Expo widgets simulator build-smoke validation script', async () => {
    const scriptsDir = dirname(fileURLToPath(import.meta.url));
    const packageRoot = dirname(scriptsDir);
    const raw = await readFile(join(packageRoot, 'package.json'), 'utf8');
    const pkg = JSON.parse(raw);

    assert.equal(
        pkg?.scripts?.['validate:ios:widgets:simulator-build-smoke'],
        'cross-env EXPO_UNSTABLE_WEB_MODAL=1 node ./scripts/validateExpoWidgetsSimulatorBuildSmoke.mjs',
    );
});

test('assertExpoWidgetsSimulatorBuildSmoke uses a unique derived-data root by default', async () => {
    const { iosDir } = await createGeneratedIosFixture({
        includeTopLevelWorkspace: true,
    });
    const recordedInvocations = [];

    const spawnSyncImpl = (command, args, options) => {
        recordedInvocations.push({ command, args, options });

        if (command === 'xcrun') {
            return {
                status: 0,
                stdout: JSON.stringify({
                    devices: {
                        'com.apple.CoreSimulator.SimRuntime.iOS-26-4': [
                            {
                                isAvailable: true,
                                state: 'Shutdown',
                                name: 'iPhone 17 Pro',
                                udid: 'SIM-DEVICE-UDID',
                                deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro',
                            },
                        ],
                    },
                }),
                stderr: '',
                error: undefined,
            };
        }

        if (args[0] === '-list') {
            return {
                status: 0,
                stdout: `Information about workspace "Happierinternaldev":\n    Schemes:\n        ${DEFAULT_WIDGET_TARGET_NAME}\n        Happierinternaldev\n`,
                stderr: '',
                error: undefined,
            };
        }

        return {
            status: 0,
            stdout: '',
            stderr: '',
            error: undefined,
        };
    };

    const first = await assertExpoWidgetsSimulatorBuildSmoke({
        iosDir,
        spawnSyncImpl,
    });
    const second = await assertExpoWidgetsSimulatorBuildSmoke({
        iosDir,
        spawnSyncImpl,
    });

    assert.notEqual(first.derivedDataRoot, second.derivedDataRoot);
    assert.match(first.derivedDataRoot, /ios-widgets-simulator-build-smoke-/);
    assert.match(second.derivedDataRoot, /ios-widgets-simulator-build-smoke-/);
});

test('assertExpoWidgetsSimulatorBuildSmoke creates the default derived-data parent when absent', async () => {
    const { iosDir } = await createGeneratedIosFixture({
        includeTopLevelWorkspace: true,
    });
    const packageRoot = await mkdtemp(join(tmpdir(), 'expo-widgets-package-root-'));
    const recordedInvocations = [];

    let summary;
    await assert.doesNotReject(async () => {
        summary = await assertExpoWidgetsSimulatorBuildSmoke({
            cwd: packageRoot,
            iosDir,
            spawnSyncImpl(command, args, options) {
                recordedInvocations.push({ command, args, options });

                if (command === 'xcrun') {
                    return {
                        status: 0,
                        stdout: JSON.stringify({
                            devices: {
                                'com.apple.CoreSimulator.SimRuntime.iOS-26-4': [
                                    {
                                        isAvailable: true,
                                        state: 'Shutdown',
                                        name: 'iPhone 17 Pro',
                                        udid: 'SIM-DEVICE-UDID',
                                        deviceTypeIdentifier:
                                            'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro',
                                    },
                                ],
                            },
                        }),
                        stderr: '',
                        error: undefined,
                    };
                }

                if (args[0] === '-list') {
                    return {
                        status: 0,
                        stdout: `Information about workspace "Happierinternaldev":\n    Schemes:\n        ${DEFAULT_WIDGET_TARGET_NAME}\n        Happierinternaldev\n`,
                        stderr: '',
                        error: undefined,
                    };
                }

                return {
                    status: 0,
                    stdout: '',
                    stderr: '',
                    error: undefined,
                };
            },
        });
    });

    assert.match(summary.derivedDataRoot, new RegExp(`${packageRoot}/\\.project/tmp/ios-widgets-simulator-build-smoke-`));
    assert.equal(recordedInvocations.length, 4);
});

test('assertExpoWidgetsSimulatorBuildSmoke falls back to the generic simulator destination when simctl is unavailable', async () => {
    const { iosDir } = await createGeneratedIosFixture({
        includeTopLevelWorkspace: true,
    });
    const recordedInvocations = [];

    await assertExpoWidgetsSimulatorBuildSmoke({
        iosDir,
        derivedDataRoot: join(iosDir, '.tmp-derived-data'),
        spawnSyncImpl(command, args, options) {
            recordedInvocations.push({ command, args, options });

            if (command === 'xcrun') {
                return {
                    status: null,
                    stdout: '',
                    stderr: '',
                    error: Object.assign(new Error('spawn xcrun ENOENT'), { code: 'ENOENT' }),
                };
            }

            if (args[0] === '-list') {
                return {
                    status: 0,
                    stdout: `Information about workspace "Happierinternaldev":\n    Schemes:\n        ${DEFAULT_WIDGET_TARGET_NAME}\n        Happierinternaldev\n`,
                    stderr: '',
                    error: undefined,
                };
            }

            return {
                status: 0,
                stdout: '',
                stderr: '',
                error: undefined,
            };
        },
    });

    const widgetBuildArgs = recordedInvocations[2].args;
    assert.ok(widgetBuildArgs.includes('generic/platform=iOS Simulator'));
});

test('assertExpoWidgetsSimulatorBuildSmoke classifies timeouts after the integrated Pods build has started', async () => {
    const { iosDir } = await createGeneratedIosFixture({
        includeTopLevelWorkspace: true,
    });

    await assert.rejects(
        () =>
            assertExpoWidgetsSimulatorBuildSmoke({
                iosDir,
                derivedDataRoot: join(iosDir, '.tmp-derived-data'),
                xcodebuildTimeoutMs: 1234,
                spawnSyncImpl(command, args) {
                    if (command === 'xcrun') {
                        return {
                            status: 0,
                            stdout: JSON.stringify({
                                devices: {
                                    'com.apple.CoreSimulator.SimRuntime.iOS-26-4': [
                                        {
                                            isAvailable: true,
                                            state: 'Shutdown',
                                            name: 'iPhone 17 Pro',
                                            udid: 'SIM-DEVICE-UDID',
                                            deviceTypeIdentifier:
                                                'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro',
                                        },
                                    ],
                                },
                            }),
                            stderr: '',
                            error: undefined,
                        };
                    }

                    if (args[0] === '-list') {
                        return {
                            status: 0,
                            stdout: `Information about workspace "Happierinternaldev":\n    Schemes:\n        ${DEFAULT_WIDGET_TARGET_NAME}\n        Happierinternaldev\n`,
                            stderr: '',
                            error: undefined,
                        };
                    }

                    return {
                        status: null,
                        stdout: "note: Target dependency graph (193 targets)\nTarget 'Pods-ExpoWidgetsTarget' in project 'Pods'",
                        stderr: '',
                        error: Object.assign(new Error('spawnSync xcodebuild ETIMEDOUT'), {
                            code: 'ETIMEDOUT',
                        }),
                    };
                },
            }),
        /classification=timed_out_after_integrated_build_started/i,
    );
});
