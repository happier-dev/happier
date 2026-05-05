import { spawnSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, readdir } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_WIDGET_TARGET_NAME = 'ExpoWidgetsTarget';
export const DEFAULT_XCODEBUILD_MAX_BUFFER_BYTES = 128 * 1024 * 1024;
export const DEFAULT_DERIVED_DATA_ROOT_PREFIX = 'ios-widgets-simulator-build-smoke-';
export const DEFAULT_SIMCTL_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
export const DEFAULT_XCODEBUILD_TIMEOUT_MS = 10 * 60 * 1000;

async function assertReadablePath(filePath) {
    await access(filePath, fsConstants.R_OK);
    return filePath;
}

async function resolveWorkspacePath({ iosDir, appScheme }) {
    const topLevelWorkspacePath = join(iosDir, `${appScheme}.xcworkspace`);
    const topLevelWorkspaceContentsPath = join(topLevelWorkspacePath, 'contents.xcworkspacedata');

    try {
        const workspaceContents = await readFile(topLevelWorkspaceContentsPath, 'utf8');
        if (!/Pods\/Pods\.xcodeproj/.test(workspaceContents)) {
            throw new Error(
                `Generated iOS workspace '${topLevelWorkspacePath}' is missing the CocoaPods workspace reference 'Pods/Pods.xcodeproj'.`,
            );
        }

        return topLevelWorkspacePath;
    } catch (error) {
        if (
            error instanceof Error &&
            'code' in error &&
            error.code === 'ENOENT'
        ) {
            return join(iosDir, `${appScheme}.xcodeproj`, 'project.xcworkspace');
        }

        throw error;
    }
}

function buildXcodebuildError(args, result, messagePrefix) {
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
    return new Error(`${messagePrefix}\ncommand: xcodebuild ${args.join(' ')}\n${output}`.trim());
}

function classifyXcodebuildFailure(output) {
    if (/no such module ['"]?ExpoWidgets['"]?/i.test(output)) {
        return 'missing_expo_widgets_module';
    }

    if (/database is locked/i.test(output)) {
        return 'concurrent_build_database_locked';
    }

    if (/Target dependency graph \(\d+ targets\)/.test(output) && /project 'Pods'/.test(output)) {
        return 'timed_out_after_integrated_build_started';
    }

    return 'timed_out_before_integrated_build_started';
}

function buildXcodebuildTimeoutError(args, result, timeoutMs) {
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
    const classification = classifyXcodebuildFailure(output);

    return new Error(
        [
            'xcodebuild simulator build validation timed out.',
            `classification=${classification}`,
            `timeoutMs=${timeoutMs}`,
            `command: xcodebuild ${args.join(' ')}`,
            output,
        ]
            .filter((part) => part.length > 0)
            .join('\n')
            .trim(),
    );
}

function runCommand({ command, cwd, args, spawnSyncImpl, maxBuffer, timeout }) {
    const result = spawnSyncImpl(command, args, {
        cwd,
        encoding: 'utf8',
        maxBuffer,
        timeout,
    });

    if (result.error) {
        if (command === 'xcodebuild' && result.error?.code === 'ETIMEDOUT') {
            return result;
        }
        throw result.error;
    }

    return result;
}

function parseRuntimeVersion(runtimeIdentifier) {
    const match = runtimeIdentifier.match(/iOS-(\d+)-(\d+)/);
    if (!match) {
        return { major: -1, minor: -1 };
    }

    return {
        major: Number(match[1]),
        minor: Number(match[2]),
    };
}

function compareSimulatorCandidates(left, right) {
    if (left.isIPhone !== right.isIPhone) {
        return left.isIPhone ? -1 : 1;
    }

    if (left.runtime.major !== right.runtime.major) {
        return right.runtime.major - left.runtime.major;
    }

    if (left.runtime.minor !== right.runtime.minor) {
        return right.runtime.minor - left.runtime.minor;
    }

    return left.name.localeCompare(right.name);
}

function resolveSimulatorDestinationId({ cwd, spawnSyncImpl }) {
    try {
        const result = runCommand({
            command: 'xcrun',
            cwd,
            args: ['simctl', 'list', 'devices', 'available', '--json'],
            spawnSyncImpl,
            maxBuffer: DEFAULT_SIMCTL_MAX_BUFFER_BYTES,
        });

        if (result.status !== 0) {
            return null;
        }

        const raw = JSON.parse(`${result.stdout ?? ''}`);
        const candidates = Object.entries(raw?.devices ?? {})
            .flatMap(([runtimeIdentifier, devices]) =>
                (Array.isArray(devices) ? devices : []).map((device) => ({
                    runtimeIdentifier,
                    runtime: parseRuntimeVersion(runtimeIdentifier),
                    name: typeof device?.name === 'string' ? device.name : '',
                    udid: typeof device?.udid === 'string' ? device.udid : '',
                    isAvailable: device?.isAvailable === true,
                    isIPhone:
                        typeof device?.deviceTypeIdentifier === 'string' &&
                        device.deviceTypeIdentifier.includes('iPhone'),
                })),
            )
            .filter((candidate) => candidate.isAvailable && candidate.udid.length > 0)
            .sort(compareSimulatorCandidates);

        return candidates[0]?.udid ?? null;
    } catch (error) {
        if (
            error instanceof Error &&
            'code' in error &&
            error.code === 'ENOENT'
        ) {
            return null;
        }

        throw error;
    }
}

async function resolveGeneratedWorkspace({ iosDir, widgetTargetName }) {
    const entries = await readdir(iosDir, { withFileTypes: true });
    const projectEntry = entries.find(
        (entry) => entry.isDirectory() && entry.name.endsWith('.xcodeproj') && entry.name !== 'Pods.xcodeproj',
    );

    if (!projectEntry) {
        throw new Error(`Unable to find generated iOS Xcode project in '${iosDir}'.`);
    }

    const appScheme = basename(projectEntry.name, '.xcodeproj');
    const workspacePath = await resolveWorkspacePath({
        iosDir,
        appScheme,
    });
    const expoWidgetsPodspecPath = join(iosDir, 'Pods', 'Local Podspecs', 'ExpoWidgets.podspec.json');

    await Promise.all([
        assertReadablePath(workspacePath),
        assertReadablePath(expoWidgetsPodspecPath),
    ]);

    const podspec = JSON.parse(await readFile(expoWidgetsPodspecPath, 'utf8'));
    if (podspec?.name !== 'ExpoWidgets') {
        throw new Error(
            `Installed widget podspec at '${expoWidgetsPodspecPath}' did not resolve to ExpoWidgets.`,
        );
    }

    return {
        appScheme,
        workspacePath,
        expoWidgetsPodspecPath,
        widgetTargetName,
    };
}

function runXcodebuild({ cwd, args, spawnSyncImpl, xcodebuildTimeoutMs }) {
    const result = runCommand({
        command: 'xcodebuild',
        cwd,
        args,
        spawnSyncImpl,
        maxBuffer: DEFAULT_XCODEBUILD_MAX_BUFFER_BYTES,
        timeout: xcodebuildTimeoutMs,
    });

    if (result.error?.code === 'ETIMEDOUT') {
        throw buildXcodebuildTimeoutError(args, result, xcodebuildTimeoutMs);
    }

    if (result.status !== 0) {
        throw buildXcodebuildError(args, result, 'xcodebuild simulator build validation failed.');
    }

    return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}

export async function assertExpoWidgetsSimulatorBuildSmoke({
    cwd,
    iosDir,
    widgetTargetName = DEFAULT_WIDGET_TARGET_NAME,
    derivedDataRoot,
    xcodebuildTimeoutMs = process.env.HAPPIER_EXPO_WIDGETS_XCODEBUILD_TIMEOUT_MS
        ? Number(process.env.HAPPIER_EXPO_WIDGETS_XCODEBUILD_TIMEOUT_MS)
        : DEFAULT_XCODEBUILD_TIMEOUT_MS,
    spawnSyncImpl = spawnSync,
} = {}) {
    const scriptsDir = dirname(fileURLToPath(import.meta.url));
    const packageRoot = cwd ?? dirname(scriptsDir);
    const resolvedIosDir = iosDir ?? join(packageRoot, 'ios');
    const defaultDerivedDataParent = join(packageRoot, '.project', 'tmp');
    const resolvedDerivedDataRoot =
        derivedDataRoot ??
        (await mkdir(defaultDerivedDataParent, { recursive: true }).then(() =>
            mkdtemp(join(defaultDerivedDataParent, DEFAULT_DERIVED_DATA_ROOT_PREFIX)),
        ));

    const resolvedWorkspace = await resolveGeneratedWorkspace({
        iosDir: resolvedIosDir,
        widgetTargetName,
    });
    const simulatorDestinationId = resolveSimulatorDestinationId({
        cwd: packageRoot,
        spawnSyncImpl,
    });

    const listOutput = runXcodebuild({
        cwd: packageRoot,
        args: ['-list', '-workspace', resolvedWorkspace.workspacePath],
        spawnSyncImpl,
        xcodebuildTimeoutMs,
    });

    for (const requiredScheme of [resolvedWorkspace.appScheme, widgetTargetName]) {
        if (!new RegExp(`\\b${requiredScheme}\\b`).test(listOutput)) {
            throw new Error(
                `xcodebuild -list did not report expected scheme '${requiredScheme}' in workspace '${resolvedWorkspace.workspacePath}'.`,
            );
        }
    }

    const commonBuildArgs = [
        '-workspace',
        resolvedWorkspace.workspacePath,
        '-sdk',
        'iphonesimulator',
        '-configuration',
        'Debug',
        '-destination',
        simulatorDestinationId ? `id=${simulatorDestinationId}` : 'generic/platform=iOS Simulator',
        'build',
        'CODE_SIGNING_ALLOWED=NO',
        'ONLY_ACTIVE_ARCH=YES',
        'COMPILER_INDEX_STORE_ENABLE=NO',
    ];

    runXcodebuild({
        cwd: packageRoot,
        args: [
            '-workspace',
            resolvedWorkspace.workspacePath,
            '-scheme',
            widgetTargetName,
            '-derivedDataPath',
            join(resolvedDerivedDataRoot, 'widget-target'),
            ...commonBuildArgs.slice(2),
        ],
        spawnSyncImpl,
        xcodebuildTimeoutMs,
    });

    runXcodebuild({
        cwd: packageRoot,
        args: [
            '-workspace',
            resolvedWorkspace.workspacePath,
            '-scheme',
            resolvedWorkspace.appScheme,
            '-derivedDataPath',
            join(resolvedDerivedDataRoot, 'app-target'),
            ...commonBuildArgs.slice(2),
        ],
        spawnSyncImpl,
        xcodebuildTimeoutMs,
    });

    return {
        appScheme: resolvedWorkspace.appScheme,
        widgetScheme: widgetTargetName,
        workspacePath: resolvedWorkspace.workspacePath,
        expoWidgetsPodspecPath: resolvedWorkspace.expoWidgetsPodspecPath,
        derivedDataRoot: resolvedDerivedDataRoot,
        classification: 'success',
    };
}

async function runCli() {
    try {
        const summary = await assertExpoWidgetsSimulatorBuildSmoke();
        console.log(
            [
                'Expo widgets simulator build smoke validated.',
                `classification=${summary.classification}`,
                `workspace=${summary.workspacePath}`,
                `appScheme=${summary.appScheme}`,
                `widgetScheme=${summary.widgetScheme}`,
                `podspec=${summary.expoWidgetsPodspecPath}`,
            ].join(' '),
        );
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(message);
        process.exitCode = 1;
    }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    await runCli();
}
