import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { getConfig } from '@expo/config';
import { resolveEasBuildProfileEnv } from '../../../scripts/pipeline/expo/resolve-eas-build-profile-env.mjs';

const execFile = promisify(execFileCallback);

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const appRoot = dirname(scriptsDir);
const repoRoot = dirname(dirname(appRoot));
const nodeRequire = createRequire(import.meta.url);
const monorepoExpoAutolinkingSearchPaths = ['../../node_modules', './node_modules'];

async function readJson(path) {
    return JSON.parse(await readFile(path, 'utf-8'));
}

async function readText(path) {
    return readFile(path, 'utf-8');
}

async function pathExists(path) {
    try {
        await access(path);
        return true;
    } catch {
        return false;
    }
}

function extractQuotedEventNames(source) {
    const eventsMatch = source.match(/Events\(([^)]*)\)/s);
    assert.ok(eventsMatch);
    return [...eventsMatch[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]).sort();
}

function extractTerminalNativeTsEventNames(source) {
    const tsEventsMatch = source.match(/TERMINAL_NATIVE_EVENT_NAMES[^=]*=\s*\[([\s\S]*?)\]/);
    assert.ok(tsEventsMatch);
    return [...tsEventsMatch[1].matchAll(/'([^']+)'/g)].map((match) => match[1]).sort();
}

function normalizeHappierWorkspaceToken(packageName) {
    const raw = String(packageName ?? '').trim();
    return raw.startsWith('@happier-dev/') ? raw.slice('@happier-dev/'.length) : raw;
}

function parseScopeTokens(rawScope) {
    return new Set(
        String(rawScope ?? '')
            .split(/[,\s]+/g)
            .map((token) => token.trim())
            .filter(Boolean),
    );
}

function expectedAutolinkingConfig(excludedPackages) {
    const exclude = [...excludedPackages];
    return {
        searchPaths: monorepoExpoAutolinkingSearchPaths,
        ...(exclude.length > 0
            ? {
                exclude,
                ios: { exclude },
                android: { exclude },
            }
            : {}),
    };
}

async function findUiFirstPartyNativeExpoModules() {
    const rootPackageJson = await readJson(join(repoRoot, 'package.json'));
    const appPackageJson = await readJson(join(appRoot, 'package.json'));
    const workspacePackagePaths = Array.isArray(rootPackageJson?.workspaces?.packages)
        ? rootPackageJson.workspaces.packages
        : [];
    const appDependencies = {
        ...(appPackageJson.dependencies ?? {}),
        ...(appPackageJson.optionalDependencies ?? {}),
    };
    const modules = [];

    for (const workspacePath of workspacePackagePaths) {
        const packageJsonPath = join(repoRoot, workspacePath, 'package.json');
        const expoModuleConfigPath = join(repoRoot, workspacePath, 'expo-module.config.json');
        if (!(await pathExists(packageJsonPath)) || !(await pathExists(expoModuleConfigPath))) continue;

        const packageJson = await readJson(packageJsonPath);
        if (typeof packageJson?.name !== 'string' || !packageJson.name.startsWith('@happier-dev/')) continue;
        if (!Object.prototype.hasOwnProperty.call(appDependencies, packageJson.name)) continue;

        modules.push({
            packageName: packageJson.name,
            workspacePath,
        });
    }

    return modules.sort((a, b) => a.packageName.localeCompare(b.packageName));
}

async function searchAutolinkedModules(platform) {
    const binaryPath = join(appRoot, 'node_modules', '.bin', 'expo-modules-autolinking');
    const { stdout } = await execFile(binaryPath, ['search', '--platform', platform, '--json'], {
        cwd: appRoot,
    });

    return JSON.parse(stdout);
}

async function loadAppConfigWithNativeFlags(options) {
    const previousNativeSsh = process.env.HAPPIER_ENABLE_NATIVE_SSH;
    const previousTerminalNative = process.env.HAPPIER_ENABLE_TERMINAL_NATIVE;
    if (options.nativeSsh !== undefined) {
        process.env.HAPPIER_ENABLE_NATIVE_SSH = options.nativeSsh;
    }
    if (options.terminalNative !== undefined) {
        process.env.HAPPIER_ENABLE_TERMINAL_NATIVE = options.terminalNative;
    }
    try {
        const resolved = nodeRequire.resolve(join(appRoot, 'app.config.js'));
        delete nodeRequire.cache[resolved];
        return getConfig(appRoot, { skipSDKVersionRequirement: true, isPublicConfig: true }).exp;
    } finally {
        if (previousNativeSsh === undefined) {
            delete process.env.HAPPIER_ENABLE_NATIVE_SSH;
        } else {
            process.env.HAPPIER_ENABLE_NATIVE_SSH = previousNativeSsh;
        }
        if (previousTerminalNative === undefined) {
            delete process.env.HAPPIER_ENABLE_TERMINAL_NATIVE;
        } else {
            process.env.HAPPIER_ENABLE_TERMINAL_NATIVE = previousTerminalNative;
        }
    }
}

async function loadAppConfigWithNativeSshFlag(value) {
    return loadAppConfigWithNativeFlags({ nativeSsh: value, terminalNative: '1' });
}

test('apps/ui fast test lane includes the native modules package contract check', async () => {
    const packageJson = await readJson(join(appRoot, 'package.json'));
    // `scripts.test` is only the Stack executor indirection
    // (`hstack-exec --script=test:local`); the executed lane body — and therefore
    // the file list this contract is about — lives in `scripts['test:local']`.
    // Reading `scripts.test` made this assertion unsatisfiable.
    const testScript = packageJson?.scripts?.['test:local'];

    assert.equal(typeof testScript, 'string');
    assert.match(testScript, /nativeModulesPackageContract\.test\.mjs/);
});

test('React Native carries the upstream Xcode 26 fmt fix and a version-matched Happier patch', async () => {
    const appPackageJson = await readJson(join(appRoot, 'package.json'));
    const installedReactNativePackageJsonPath = nodeRequire.resolve('react-native/package.json');
    const installedReactNativeRoot = dirname(installedReactNativePackageJsonPath);
    const installedReactNativePackageJson = await readJson(installedReactNativePackageJsonPath);
    const reactNativeVersion = appPackageJson.dependencies?.['react-native'];

    assert.equal(
        reactNativeVersion,
        '0.83.5',
        'React Native 0.83.5 is the first 0.83 patch carrying fmt 12.1.0 for Xcode 26.4+',
    );
    assert.equal(installedReactNativePackageJson.version, reactNativeVersion);

    const fmtPodspec = await readText(
        join(installedReactNativeRoot, 'third-party-podspecs', 'fmt.podspec'),
    );
    const follyPodspec = await readText(
        join(installedReactNativeRoot, 'third-party-podspecs', 'RCT-Folly.podspec'),
    );

    assert.match(fmtPodspec, /spec\.version = "12\.1\.0"/);
    assert.match(fmtPodspec, /:tag => "12\.1\.0"/);
    assert.match(follyPodspec, /spec\.dependency "fmt", "12\.1\.0"/);
    assert.equal(
        await pathExists(join(appRoot, 'patches', `react-native+${reactNativeVersion}.patch`)),
        true,
        'the Happier React Native patch must track the installed package version',
    );
});

test('sherpa-native declares Expo module metadata consistent with sibling native modules', async () => {
    const audioStreamPackageRoot = join(repoRoot, 'packages', 'audio-stream-native');
    const sherpaPackageRoot = join(repoRoot, 'packages', 'sherpa-native');

    const audioStreamPackageJson = await readJson(join(audioStreamPackageRoot, 'package.json'));
    const sherpaPackageJson = await readJson(join(sherpaPackageRoot, 'package.json'));
    const sherpaModuleConfig = await readJson(join(sherpaPackageRoot, 'expo-module.config.json'));
    const sharedExpoNativeFiles = audioStreamPackageJson.files;
    const sherpaSharedFiles = sherpaPackageJson.files.filter((entry) => sharedExpoNativeFiles.includes(entry));
    const sherpaIntentionalExtras = sherpaPackageJson.files.filter((entry) => !sharedExpoNativeFiles.includes(entry));

    assert.deepEqual(
        sherpaSharedFiles,
        sharedExpoNativeFiles,
        'sherpa-native should retain the shared Expo-native package surface used by sibling modules',
    );
    assert.deepEqual(
        sherpaIntentionalExtras,
        ['common', 'scripts'],
        'sherpa-native should only extend the shared Expo-native package surface with its common C++ headers and build scripts',
    );
    assert.deepEqual(sherpaModuleConfig, {
        name: 'HappierSherpaNative',
        platforms: ['ios', 'android'],
        ios: {
            modules: ['HappierSherpaNativeModule'],
        },
        android: {
            modules: ['dev.happier.sherpa.HappierSherpaNativeModule'],
        },
    });
});

test('sherpa-native online ASR bridge matches the vendored Sherpa C API shape', async () => {
    const source = await readText(join(
        repoRoot,
        'packages',
        'sherpa-native',
        'ios',
        'HappierSherpaOnlineAsrEngine.mm',
    ));

    assert.doesNotMatch(source, /config\.decoder_config\./);
    assert.doesNotMatch(source, /config\.endpoint_config\./);
    assert.doesNotMatch(source, /wrapper->_/);
    assert.match(source, /const SherpaOnnxOnlineStream \*_stream/);
});

test('ssh-native declares Expo module metadata and package surface', async () => {
    const sshPackageRoot = join(repoRoot, 'packages', 'ssh-native');
    const sshPackageJson = await readJson(join(sshPackageRoot, 'package.json'));
    const sshModuleConfig = await readJson(join(sshPackageRoot, 'expo-module.config.json'));

    assert.equal(sshPackageJson.name, '@happier-dev/ssh-native');
    assert.equal(sshPackageJson.private, true);
    assert.deepEqual(sshPackageJson.files, [
        'src',
        'ios/HappierSshNativeModule.swift',
        'ios/HappierSshNativeBridge.swift',
        'ios/HappierSshNative.podspec',
        'android/build.gradle',
        'android/src',
        'rust/happier-ssh-native/Cargo.toml',
        'rust/happier-ssh-native/Cargo.lock',
        'rust/happier-ssh-native/src',
        'scripts',
        'expo-module.config.json',
        'package.json',
        'README.md',
    ]);
    assert.deepEqual(sshModuleConfig, {
        name: 'HappierSshNative',
        platforms: ['ios', 'android'],
        ios: {
            modules: ['HappierSshNativeModule'],
        },
        android: {
            modules: ['dev.happier.ssh.HappierSshNativeModule'],
        },
    });
});

test('ssh-native ships the selected russh core instead of platform-split SSH engines', async () => {
    const sshPackageRoot = join(repoRoot, 'packages', 'ssh-native');
    const androidBuildGradle = await readText(join(sshPackageRoot, 'android', 'build.gradle'));
    const iosPodspec = await readText(join(sshPackageRoot, 'ios', 'HappierSshNative.podspec'));
    const rustCargoToml = await readText(join(
        sshPackageRoot,
        'rust',
        'happier-ssh-native',
        'Cargo.toml',
    ));

    assert.doesNotMatch(androidBuildGradle, /jsch/i);
    assert.doesNotMatch(iosPodspec, /NMSSH/);
    assert.match(rustCargoToml, /russh/);
    assert.match(rustCargoToml, /aws-lc-rs/);
});

test('ssh-native bridges cancellation into the selected Rust core', async () => {
    const sshPackageRoot = join(repoRoot, 'packages', 'ssh-native');
    const androidBridge = await readText(join(
        sshPackageRoot,
        'android',
        'src',
        'main',
        'java',
        'dev',
        'happier',
        'ssh',
        'HappierSshNativeBridge.kt',
    ));
    const iosBridge = await readText(join(sshPackageRoot, 'ios', 'HappierSshNativeBridge.swift'));
    const rustLib = await readText(join(
        sshPackageRoot,
        'rust',
        'happier-ssh-native',
        'src',
        'lib.rs',
    ));

    assert.doesNotMatch(androidBridge, /fun cancelRequest\(requestId: String\) \{\s*\}/);
    assert.doesNotMatch(iosBridge, /func cancelRequest\(requestId: String\) \{\s*\}/);
    assert.doesNotMatch(androidBridge, /contains\(requestId\)/);
    assert.doesNotMatch(iosBridge, /contains\(requestId\)/);
    assert.match(rustLib, /happier_ssh_native_cancel_request_json/);
});

test('ssh-native Android Rust build script resolves the NDK host tag per build host', async () => {
    const script = await readText(join(
        repoRoot,
        'packages',
        'ssh-native',
        'scripts',
        'build-rust-android.sh',
    ));

    assert.doesNotMatch(script, /^HOST_TAG="darwin-x86_64"/m);
    assert.match(script, /uname -s/);
    assert.match(script, /linux-x86_64/);
    assert.match(script, /darwin-x86_64/);
});

test('ssh-native iOS Rust build script exports every Swift bridge FFI symbol', async () => {
    const script = await readText(join(
        repoRoot,
        'packages',
        'ssh-native',
        'scripts',
        'build-rust-ios.sh',
    ));

    assert.match(script, /happier_ssh_native_exec_json/);
    assert.match(script, /happier_ssh_native_start_loopback_tunnel_json/);
    assert.match(script, /happier_ssh_native_stop_loopback_tunnel_json/);
    assert.match(script, /happier_ssh_native_cancel_request_json/);
    assert.match(script, /happier_ssh_native_free_string/);
});

test('ssh-native iOS Rust build script gives simulator and device libraries the same binary name', async () => {
    const script = await readText(join(
        repoRoot,
        'packages',
        'ssh-native',
        'scripts',
        'build-rust-ios.sh',
    ));

    assert.doesNotMatch(script, /libhappier_ssh_native_sim\.a/);
    assert.match(script, /SIM_UNIVERSAL=.*libhappier_ssh_native\.a/);
});

test('ssh-native native bridges emit progress events, host-key prompts, and auth prompts', async () => {
    const sshPackageRoot = join(repoRoot, 'packages', 'ssh-native');
    const androidBridge = await readText(join(
        sshPackageRoot,
        'android',
        'src',
        'main',
        'java',
        'dev',
        'happier',
        'ssh',
        'HappierSshNativeBridge.kt',
    ));
    const iosBridge = await readText(join(sshPackageRoot, 'ios', 'HappierSshNativeBridge.swift'));

    assert.match(androidBridge, /sendEvent\("progress"/);
    assert.match(androidBridge, /"hostKeyPrompt"/);
    assert.match(androidBridge, /"authPrompt"/);
    assert.match(androidBridge, /module\.sendEvent\(eventName/);
    assert.match(androidBridge, /respondToAuthPrompt/);
    assert.match(iosBridge, /sendEvent\("progress"/);
    assert.match(iosBridge, /"hostKeyPrompt"/);
    assert.match(iosBridge, /"authPrompt"/);
    assert.match(iosBridge, /module\.sendEvent\(eventName/);
    assert.match(iosBridge, /respondToAuthPrompt/);
});

test('ssh-native iOS runs blocking Rust SSH work off the Expo async function queue', async () => {
    const sshPackageRoot = join(repoRoot, 'packages', 'ssh-native');
    const iosModule = await readText(join(sshPackageRoot, 'ios', 'HappierSshNativeModule.swift'));
    const iosBridge = await readText(join(sshPackageRoot, 'ios', 'HappierSshNativeBridge.swift'));

    assert.match(iosModule, /AsyncFunction\("exec"\)\s*\{[^}]*async throws/s);
    assert.match(iosModule, /AsyncFunction\("startLoopbackTunnel"\)\s*\{[^}]*async throws/s);
    assert.match(iosModule, /HappierSshNativeBridge\.execAsync/);
    assert.match(iosModule, /HappierSshNativeBridge\.startLoopbackTunnelAsync/);
    assert.match(iosBridge, /DispatchQueue\(\s*label:\s*"dev\.happier\.ssh-native\.rust-work"/s);
    assert.match(iosBridge, /withCheckedThrowingContinuation/);
});

test('ssh-native Android runs blocking Rust SSH work off the Expo async function queue', async () => {
    const sshPackageRoot = join(repoRoot, 'packages', 'ssh-native');
    const androidModule = await readText(join(
        sshPackageRoot,
        'android',
        'src',
        'main',
        'java',
        'dev',
        'happier',
        'ssh',
        'HappierSshNativeModule.kt',
    ));
    const androidBridge = await readText(join(
        sshPackageRoot,
        'android',
        'src',
        'main',
        'java',
        'dev',
        'happier',
        'ssh',
        'HappierSshNativeBridge.kt',
    ));

    assert.match(androidModule, /SuspendBody/);
    assert.match(androidModule, /Dispatchers\.IO/);
    assert.match(androidModule, /withContext\(Dispatchers\.IO\)/);
    assert.match(androidBridge, /CompletableFuture/);
});

test('ssh-native package excludes generated build artifacts from pack surfaces', async () => {
    const sshPackageRoot = join(repoRoot, 'packages', 'ssh-native');
    const npmIgnore = await readText(join(sshPackageRoot, '.npmignore'));

    assert.match(npmIgnore, /^rust\/happier-ssh-native\/target$/m);
    assert.match(npmIgnore, /^ios\/vendor$/m);
    assert.match(npmIgnore, /^android\/build$/m);
});

test('ssh-native Rust tunnel keeps accepting clients when one direct-tcpip channel fails', async () => {
    const tunnelSource = await readText(join(
        repoRoot,
        'packages',
        'ssh-native',
        'rust',
        'happier-ssh-native',
        'src',
        'tunnel.rs',
    ));

    assert.doesNotMatch(tunnelSource, /channel_open_direct_tcpip\([\s\S]*?\)\.await\?/);
    assert.match(tunnelSource, /continue/);
});

test('ssh-native native bridges use a stable host-key-untrusted code when host trust prompts time out', async () => {
    const sshPackageRoot = join(repoRoot, 'packages', 'ssh-native');
    const androidBridge = await readText(join(
        sshPackageRoot,
        'android',
        'src',
        'main',
        'java',
        'dev',
        'happier',
        'ssh',
        'HappierSshNativeBridge.kt',
    ));
    const iosBridge = await readText(join(sshPackageRoot, 'ios', 'HappierSshNativeBridge.swift'));

    assert.match(androidBridge, /"host-key-untrusted"/);
    assert.match(androidBridge, /"SSH host key trust prompt timed out\."/);
    assert.match(iosBridge, /"host-key-untrusted"/);
    assert.match(iosBridge, /"SSH host key trust prompt timed out\."/);
});

test('native SSH bootstrap UI import surface does not pull Node-only SCP installer code', async () => {
    const nativeBootstrapBarrel = await readText(join(
        repoRoot,
        'packages',
        'cli-common',
        'src',
        'systemTasks',
        'nativeRemoteSshBootstrap.ts',
    ));
    const nativeTask = await readText(join(
        repoRoot,
        'apps',
        'ui',
        'sources',
        'components',
        'systemTasks',
        'remoteSshBootstrap',
        'nativeTask.ts',
    ));

    assert.doesNotMatch(nativeBootstrapBarrel, /remoteFirstPartyPayloadInstaller/);
    assert.doesNotMatch(nativeBootstrapBarrel, /createScpReadyPayloadArchive/);
    assert.doesNotMatch(nativeTask, /installRemoteFirstPartyComponent/);
});

test('ssh-native native bridges distinguish rejected host-key prompts from untrusted timeouts', async () => {
    const sshPackageRoot = join(repoRoot, 'packages', 'ssh-native');
    const androidBridge = await readText(join(
        sshPackageRoot,
        'android',
        'src',
        'main',
        'java',
        'dev',
        'happier',
        'ssh',
        'HappierSshNativeBridge.kt',
    ));
    const iosBridge = await readText(join(sshPackageRoot, 'ios', 'HappierSshNativeBridge.swift'));

    assert.match(androidBridge, /NativeSshException\("host-key-rejected",\s*"SSH host key trust was declined\."/);
    assert.match(iosBridge, /nativeSshError\(code:\s*"host-key-rejected",\s*message:\s*"SSH host key trust was declined\."/);
});

test('HAPPIER_ENABLE_NATIVE_SSH controls Expo autolinking exclusion for ssh-native', async () => {
    const disabledConfig = await loadAppConfigWithNativeSshFlag('0');
    assert.deepEqual(
        disabledConfig?.autolinking,
        expectedAutolinkingConfig(['@happier-dev/ssh-native']),
    );

    const enabledConfig = await loadAppConfigWithNativeSshFlag('1');
    assert.deepEqual(enabledConfig?.autolinking, expectedAutolinkingConfig([]));
});

test('terminal-native declares Expo module metadata and gated package surface', async () => {
    const terminalPackageRoot = join(repoRoot, 'packages', 'terminal-native');

    assert.equal(
        await pathExists(join(terminalPackageRoot, 'package.json')),
        true,
        'terminal-native package must exist before it is added to app package manifests',
    );

    const terminalPackageJson = await readJson(join(terminalPackageRoot, 'package.json'));
    const terminalModuleConfig = await readJson(join(terminalPackageRoot, 'expo-module.config.json'));

    assert.equal(terminalPackageJson.name, '@happier-dev/terminal-native');
    assert.equal(terminalPackageJson.private, true);
    assert.equal(
        terminalPackageJson.scripts['build:ghosttykit:ios'],
        'node scripts/buildGhosttyKitIos.mjs',
    );
    assert.deepEqual(terminalPackageJson.files, [
        'native-renderers.json',
        'src',
        'ios/HappierTerminalNativeModule.swift',
        'ios/GhosttyRuntime.swift',
        'ios/GhosttySurfaceBridge.swift',
        'ios/GhosttySurfaceView.swift',
        'ios/GhosttyInput.swift',
        'ios/GhosttySelection.swift',
        'ios/GhosttyLinks.swift',
        'ios/GhosttyAccessibility.swift',
        'ios/HappierTerminalNative.podspec',
        'ios/Vendor/README.md',
        'android/build.gradle',
        'android/src',
        'android/termux',
        'scripts',
        'expo-module.config.json',
        'package.json',
        'README.md',
    ]);
    assert.deepEqual(terminalModuleConfig, {
        name: 'HappierTerminalNative',
        platforms: ['ios', 'android'],
        ios: {
            modules: ['HappierTerminalNativeModule'],
        },
        android: {
            modules: ['dev.happier.terminal.HappierTerminalNativeModule'],
        },
    });
    assert.equal(await pathExists(join(terminalPackageRoot, 'scripts', 'buildGhosttyKitIos.mjs')), true);
    const androidModule = await readText(join(
        terminalPackageRoot,
        'android',
        'src',
        'main',
        'java',
        'dev',
        'happier',
        'terminal',
        'HappierTerminalNativeModule.kt',
    ));
    const androidView = await readText(join(
        terminalPackageRoot,
        'android',
        'src',
        'main',
        'java',
        'dev',
        'happier',
        'terminal',
        'TermuxView.kt',
    ));
    assert.match(androidModule, /View\(TermuxView::class\)/);
    assert.match(androidModule, /Name\("HappierTerminalNativeView"\)/);
    assert.match(androidModule, /Prop\("surfaceId"\)/);
    assert.match(androidView, /class TermuxView\([^)]*appContext: AppContext[^)]*\)\s*:\s*ExpoView\(context,\s*appContext\)/);
    for (const relativePath of [
        'ios/GhosttyRuntime.swift',
        'ios/GhosttySurfaceBridge.swift',
        'ios/GhosttySurfaceView.swift',
        'ios/GhosttyInput.swift',
        'ios/GhosttySelection.swift',
        'ios/GhosttyLinks.swift',
        'ios/GhosttyAccessibility.swift',
        'android/src/main/java/dev/happier/terminal/TermuxView.kt',
        'android/src/main/java/dev/happier/terminal/TermuxBridge.kt',
        'android/src/main/java/dev/happier/terminal/TermuxInput.kt',
        'android/src/main/java/dev/happier/terminal/TermuxSelection.kt',
        'android/src/main/java/dev/happier/terminal/TermuxAccessibility.kt',
    ]) {
        assert.equal(await pathExists(join(terminalPackageRoot, relativePath)), true, relativePath);
    }
});

test('terminal-native records native renderer supply-chain gates', async () => {
    const terminalPackageRoot = join(repoRoot, 'packages', 'terminal-native');
    const rendererPolicy = await readJson(join(terminalPackageRoot, 'native-renderers.json'));

    assert.equal(rendererPolicy.iosGhostty.renderer, 'ios-ghosttykit');
    assert.equal(rendererPolicy.iosGhostty.integration, 'expo-module-libghostty-spm-vendored-xcframework');
    assert.equal(rendererPolicy.iosGhostty.artifact.path, 'ios/Vendor/GhosttyKit.xcframework');
    assert.equal(rendererPolicy.iosGhostty.artifact.source, 'libghostty-spm');
    assert.deepEqual(rendererPolicy.iosGhostty.artifact.requiredSlices, [
        'ios-arm64',
        'ios-arm64_x86_64-simulator',
    ]);
    assert.equal(rendererPolicy.iosGhostty.artifact.upstreamRelease, 'storage.1.2.4');
    assert.equal(
        rendererPolicy.iosGhostty.artifact.upstreamZipSha256,
        'f1484a5411559bf4a5b665b82a5bb91cb8a3ca2065467dc15202fb191d7a5c9d',
    );
    assert.equal(rendererPolicy.iosGhostty.upstream.observedCommit, 'c069f05e0a4ef50143e943e954ed75e52e947009');
    assert.equal(rendererPolicy.iosGhostty.upstream.observedPackageVersion, '1.2.4');
    assert.equal(rendererPolicy.iosGhostty.referenceImplementations.libghosttySpm.referenceOnly, false);
    assert.equal(rendererPolicy.iosGhostty.referenceImplementations.remodex.referenceOnly, true);
    assert.match(
        rendererPolicy.iosGhostty.referenceImplementations.remodex.observedCommit,
        /^[a-f0-9]{40}$/,
    );
    assert.match(
        rendererPolicy.iosGhostty.referenceImplementations.remodex.url,
        /^https:\/\/github\.com\/Emanuele-web04\/remodex/,
    );
    assert.ok(rendererPolicy.iosGhostty.gates.includes('pinned-libghostty-spm-version'));
    assert.ok(rendererPolicy.iosGhostty.gates.includes('checksum-pinned-artifact'));
	assert.ok(rendererPolicy.iosGhostty.gates.includes('custom-accessibility-model-or-webview-accessible-fallback'));

	assert.equal(rendererPolicy.androidTermux.renderer, 'android-termux');
	assert.equal(rendererPolicy.androidTermux.integration, 'expo-module-termux-emulator-renderer-remote-session');
	assert.match(rendererPolicy.androidTermux.upstream.observedCommit, /^[a-f0-9]{40}$/);
	assert.equal(rendererPolicy.androidTermux.license.kind, 'Apache-2.0');
	assert.equal(rendererPolicy.androidTermux.license.scope, 'terminal-view-and-terminal-emulator-exception-only');
	assert.equal(rendererPolicy.androidTermux.license.fullTermuxAppLicense, 'GPL-3.0-only');
	assert.equal(rendererPolicy.androidTermux.license.bundleFullTermuxApp, false);
    assert.equal(rendererPolicy.androidTermux.interactionModel.kind, 'happier-owned-remote-session-adapter');
    assert.deepEqual(rendererPolicy.androidTermux.interactionModel.uses, [
        'TerminalEmulator',
        'TerminalRenderer',
    ]);
    assert.equal(rendererPolicy.androidTermux.interactionModel.doesNotEmbed, 'process-backed Termux TerminalView widget');
    assert.ok(rendererPolicy.androidTermux.interactionModel.implementedInAdapter.includes('ime-commit-text'));
    assert.ok(rendererPolicy.androidTermux.interactionModel.implementedInAdapter.includes('hardware-key-escape-mapping'));
    assert.ok(rendererPolicy.androidTermux.interactionModel.implementedInAdapter.includes('mouse-tracking-and-scrollback'));
    assert.ok(rendererPolicy.androidTermux.interactionModel.remainingGaps.includes('selection-handles'));
    assert.ok(rendererPolicy.androidTermux.interactionModel.remainingGaps.includes('custom-accessibility'));
    assert.ok(rendererPolicy.androidTermux.interactionModel.requiresDeviceQa.includes('ime-keyboard-and-mouse-smoke'));
    assert.ok(rendererPolicy.androidTermux.gates.includes('legal-product-approval'));
    assert.ok(rendererPolicy.androidTermux.gates.includes('custom-accessibility-model-or-webview-accessible-fallback'));
});

test('terminal-native iOS runtime reports precise fail-closed availability reasons', async () => {
    const ghosttyRuntime = await readText(join(
        repoRoot,
        'packages',
        'terminal-native',
        'ios',
        'GhosttyRuntime.swift',
    ));

    assert.match(ghosttyRuntime, /"reason":\s*reason/);
    assert.match(ghosttyRuntime, /reason:\s*"artifact-missing"/);
    assert.match(ghosttyRuntime, /reason:\s*"package-proof-unaccepted"/);
    assert.match(ghosttyRuntime, /HAPPIER_TERMINAL_NATIVE_IOS_PACKAGE_PROOF_ACCEPTED/);
    assert.match(ghosttyRuntime, /HAPPIER_TERMINAL_NATIVE_IOS_CRASH_FALLBACK_PROVEN/);
    assert.match(ghosttyRuntime, /HAPPIER_TERMINAL_NATIVE_IOS_ACCESSIBILITY_NATIVE/);
    assert.match(ghosttyRuntime, /state:\s*\.available/);
    assert.match(ghosttyRuntime, /return "fallback-required"/);
    assert.doesNotMatch(ghosttyRuntime, /GhosttyKit is linked, but the host-managed Happier surface bridge is still proof-gated/);
});

test('terminal-native iOS Ghostty bridge is compiled only behind linked-artifact guards', async () => {
    const bridgeSource = await readText(join(
        repoRoot,
        'packages',
        'terminal-native',
        'ios',
        'GhosttySurfaceBridge.swift',
    ));

    assert.match(bridgeSource, /#if HAPPIER_TERMINAL_NATIVE_HAS_GHOSTTY/);
    assert.match(bridgeSource, /import libghostty/);
    assert.match(bridgeSource, /ghostty_surface_new/);
    assert.match(bridgeSource, /ghostty_surface_write_buffer/);
    assert.match(bridgeSource, /ghostty_surface_receive_buffer_cb/);
    assert.match(bridgeSource, /ghostty_surface_receive_resize_cb/);
    assert.match(bridgeSource, /let nextByteOffset = byteOffset \+ Int64\(bytes\.count\)/);
    assert.match(bridgeSource, /emitWriteAck\(nextByteOffset\)/);
});

test('terminal-native iOS Ghostty view owns text, delete, and pointer routing into Ghostty', async () => {
    const viewSource = await readText(join(
        repoRoot,
        'packages',
        'terminal-native',
        'ios',
        'GhosttySurfaceView.swift',
    ));
    const bridgeSource = await readText(join(
        repoRoot,
        'packages',
        'terminal-native',
        'ios',
        'GhosttySurfaceBridge.swift',
    ));

    assert.match(viewSource, /final class GhosttySurfaceView: UIView, UIKeyInput/);
    assert.match(viewSource, /func insertText\(_ text: String\)/);
    assert.match(viewSource, /func deleteBackward\(\)/);
    assert.match(viewSource, /override func touchesBegan\(_ touches: Set<UITouch>, with event: UIEvent\?\)/);
    assert.match(viewSource, /override func touchesMoved\(_ touches: Set<UITouch>, with event: UIEvent\?\)/);
    assert.match(viewSource, /override func touchesEnded\(_ touches: Set<UITouch>, with event: UIEvent\?\)/);
    assert.match(viewSource, /submitText\(text\)/);
    assert.match(viewSource, /deleteBackward\(\)/);
    assert.match(viewSource, /handleTouch\(touch, phase:/);

    assert.match(bridgeSource, /func submitText\(_ text: String\) -> Bool/);
    assert.match(bridgeSource, /ghostty_surface_text/);
    assert.match(bridgeSource, /func deleteBackward\(\) -> Bool/);
    assert.match(bridgeSource, /func handleTouch\(_ touch: UITouch, phase: UITouch\.Phase\)/);
    assert.match(bridgeSource, /ghostty_surface_mouse_pos/);
    assert.match(bridgeSource, /ghostty_surface_mouse_button/);
});

test('terminal-native Android event payloads match the TypeScript native event contract', async () => {
    const callbacks = await readText(join(
        repoRoot,
        'packages',
        'terminal-native',
        'android',
        'src',
        'main',
        'java',
        'dev',
        'happier',
        'terminal',
        'TermuxRemoteSession.kt',
    ));

    assert.doesNotMatch(callbacks, /"base64Bytes"\s+to/);
    assert.match(callbacks, /"data"\s+to/);
    assert.doesNotMatch(callbacks, /"message"\s+to/);
    assert.match(callbacks, /"reason"\s+to/);
    assert.match(callbacks, /"cols"\s+to\s+cols/);
    assert.match(callbacks, /"rows"\s+to\s+rows/);
    assert.match(callbacks, /"state"\s+to\s+"changed"/);
    assert.match(callbacks, /"state"\s+to\s+"cleared"/);
});

test('terminal-native Android surface creation attaches the Expo module event sink', async () => {
    const bridge = await readText(join(
        repoRoot,
        'packages',
        'terminal-native',
        'android',
        'src',
        'main',
        'java',
        'dev',
        'happier',
        'terminal',
        'TermuxBridge.kt',
    ));
    const session = await readText(join(
        repoRoot,
        'packages',
        'terminal-native',
        'android',
        'src',
        'main',
        'java',
        'dev',
        'happier',
        'terminal',
        'TermuxRemoteSession.kt',
    ));
    const surface = await readText(join(
        repoRoot,
        'apps',
        'ui',
        'sources',
        'components',
        'terminal',
        'native',
        'surface.native.tsx',
    ));

    assert.match(session, /fun attachEventSink\(eventSink: TermuxEventSink\)/);
    assert.match(session, /fun attachEventSink\(eventSink: TermuxEventSink\)\s*\{/);
    assert.match(bridge, /attachEventSink\(eventSink\)/);
    assert.match(bridge, /putIfAbsent\(surfaceId, created\)/);
    assert.match(surface, /nativeModule\.createSurface\?\.\(props\.surfaceId\)/);
});

test('terminal-native Android layout-driven renderer resize propagates back to the remote PTY', async () => {
    const backedSession = await readText(join(
        repoRoot,
        'packages',
        'terminal-native',
        'android',
        'termux',
        'adapter-src',
        'main',
        'java',
        'dev',
        'happier',
        'terminal',
        'termux',
        'TermuxBackedRemoteSession.kt',
    ));

    assert.match(backedSession, /if \(nextCols != cols \|\| nextRows != rows\) \{/);
    assert.match(backedSession, /resizeEmulator\(nextCols, nextRows,/);
    assert.match(backedSession, /callbacks\.emitResize\(nextCols, nextRows\)/);
});

test('terminal-native Android view owns IME, hardware key, and pointer routing into the remote PTY input contract', async () => {
    const view = await readText(join(
        repoRoot,
        'packages',
        'terminal-native',
        'android',
        'src',
        'main',
        'java',
        'dev',
        'happier',
        'terminal',
        'TermuxView.kt',
    ));
    const bridge = await readText(join(
        repoRoot,
        'packages',
        'terminal-native',
        'android',
        'src',
        'main',
        'java',
        'dev',
        'happier',
        'terminal',
        'TermuxBridge.kt',
    ));
    const remoteSession = await readText(join(
        repoRoot,
        'packages',
        'terminal-native',
        'android',
        'src',
        'main',
        'java',
        'dev',
        'happier',
        'terminal',
        'TermuxRemoteSession.kt',
    ));

    assert.match(view, /override fun onCheckIsTextEditor\(\): Boolean = true/);
    assert.match(view, /override fun onCreateInputConnection\(outAttrs: EditorInfo\): InputConnection/);
    assert.match(view, /commitText\(text: CharSequence\?, newCursorPosition: Int\)/);
    assert.match(view, /deleteSurroundingText\(leftLength: Int, rightLength: Int\)/);
    assert.match(view, /override fun onKeyDown\(keyCode: Int, event: KeyEvent\): Boolean/);
    assert.match(view, /override fun onGenericMotionEvent\(event: MotionEvent\): Boolean/);
    assert.match(view, /override fun onTouchEvent\(event: MotionEvent\): Boolean/);
    assert.match(view, /InputMethodManager/);
    assert.match(view, /TermuxBridge\.sendTextInput\(surfaceId,/);
    assert.match(view, /TermuxBridge\.sendKeyEvent\(surfaceId, keyCode, event\)/);
    assert.match(view, /TermuxBridge\.handleMotionEvent\(surfaceId, event\)/);

    assert.match(bridge, /fun sendTextInput\(surfaceId: String, text: CharSequence\): Map<String, Any\?>/);
    assert.match(bridge, /fun sendKeyEvent\(surfaceId: String, keyCode: Int, event: KeyEvent\): Boolean/);
    assert.match(bridge, /fun handleMotionEvent\(surfaceId: String, event: MotionEvent\): Boolean/);

    assert.match(remoteSession, /fun sendTextInput\(text: CharSequence\): TermuxWriteResult/);
    assert.match(remoteSession, /fun sendKeyEvent\(keyCode: Int, event: KeyEvent\): Boolean/);
    assert.match(remoteSession, /fun handleMotionEvent\(event: MotionEvent\): Boolean/);
});

test('terminal-native Android Termux-backed adapter uses Termux key, mouse, and scrollback primitives', async () => {
    const backedSession = await readText(join(
        repoRoot,
        'packages',
        'terminal-native',
        'android',
        'termux',
        'adapter-src',
        'main',
        'java',
        'dev',
        'happier',
        'terminal',
        'termux',
        'TermuxBackedRemoteSession.kt',
    ));

    assert.match(backedSession, /import com\.termux\.terminal\.KeyHandler/);
    assert.match(backedSession, /KeyHandler\.getCode\(/);
    assert.match(backedSession, /event\.getUnicodeChar\(/);
    assert.match(backedSession, /emulator\.sendMouseEvent\(/);
    assert.match(backedSession, /emulator\.isMouseTrackingActive/);
    assert.match(backedSession, /emulator\.isAlternateBufferActive/);
    assert.match(backedSession, /getActiveTranscriptRows\(\)/);
    assert.match(backedSession, /activeRenderer\.render\(emulator, canvas, topRow,/);
    assert.doesNotMatch(backedSession, /android\.util\.Log|println\(|System\.out/);
});

test('terminal-native Android availability gates are actionable and keep accessibility as a renderer-selection policy', async () => {
    const gradle = await readText(join(
        repoRoot,
        'packages',
        'terminal-native',
        'android',
        'build.gradle',
    ));
    const bridge = await readText(join(
        repoRoot,
        'packages',
        'terminal-native',
        'android',
        'src',
        'main',
        'java',
        'dev',
        'happier',
        'terminal',
        'TermuxBridge.kt',
    ));

    for (const gate of [
        'HAPPIER_TERMINAL_NATIVE_ANDROID_DEPENDENCY_CLOSURE_APPROVED',
        'HAPPIER_TERMINAL_NATIVE_ANDROID_LEGAL_ACCEPTED',
        'HAPPIER_TERMINAL_NATIVE_ANDROID_GRADLE_BUILD_PROVEN',
        'HAPPIER_TERMINAL_NATIVE_ANDROID_ABI_SMOKE_PASSED',
        'HAPPIER_TERMINAL_NATIVE_ANDROID_CRASH_FALLBACK_PROVEN',
        'HAPPIER_TERMINAL_NATIVE_ANDROID_ACCESSIBILITY_NATIVE',
    ]) {
        assert.match(gradle, new RegExp(gate));
        assert.match(bridge, new RegExp(gate));
    }

    assert.match(bridge, /accessibility\s*=\s*if\s*\(BuildConfig\.HAPPIER_TERMINAL_NATIVE_ANDROID_ACCESSIBILITY_NATIVE\)/);
    assert.doesNotMatch(bridge, /reason\s*=\s*"accessibility-unproven"/);
});

test('terminal-native Android declared events match the TypeScript event names', async () => {
    const moduleSource = await readText(join(
        repoRoot,
        'packages',
        'terminal-native',
        'android',
        'src',
        'main',
        'java',
        'dev',
        'happier',
        'terminal',
        'HappierTerminalNativeModule.kt',
    ));
    const eventsSource = await readText(join(
        repoRoot,
        'packages',
        'terminal-native',
        'src',
        'events.ts',
    ));

    const androidEvents = extractQuotedEventNames(moduleSource);
    const tsEvents = extractTerminalNativeTsEventNames(eventsSource);

    assert.deepEqual(androidEvents, tsEvents);
});

test('terminal-native iOS declared events match the TypeScript event names', async () => {
    const moduleSource = await readText(join(
        repoRoot,
        'packages',
        'terminal-native',
        'ios',
        'HappierTerminalNativeModule.swift',
    ));
    const eventsSource = await readText(join(
        repoRoot,
        'packages',
        'terminal-native',
        'src',
        'events.ts',
    ));

    const iosEvents = extractQuotedEventNames(moduleSource);
    const tsEvents = extractTerminalNativeTsEventNames(eventsSource);

    assert.deepEqual(iosEvents, tsEvents);
});

test('terminal-native podspec links GhosttyKit only when the XCFramework artifact exists', async () => {
    const podspec = await readText(join(
        repoRoot,
        'packages',
        'terminal-native',
        'ios',
        'HappierTerminalNative.podspec',
    ));

    assert.match(podspec, /Vendor\/GhosttyKit\.xcframework/);
    assert.match(podspec, /s\.source_files\s*=\s*'\*\.{h,m,mm,swift}'/);
    assert.doesNotMatch(podspec, /s\.source_files\s*=\s*'\*\*\/\*\.{h,m,mm,swift}'/);
    assert.match(podspec, /File\.exist\?\(ghostty_framework_path\)/);
    assert.match(podspec, /s\.vendored_frameworks\s*=\s*'Vendor\/GhosttyKit\.xcframework'/);
    assert.match(podspec, /s\.libraries\s*=\s*'c\+\+'/);
    assert.match(podspec, /HAPPIER_TERMINAL_NATIVE_HAS_GHOSTTY/);
});

test('terminal-native is registered as a workspace and UI dependency', async () => {
    const rootPackageJson = await readJson(join(repoRoot, 'package.json'));
    const appPackageJson = await readJson(join(appRoot, 'package.json'));

    assert.ok(rootPackageJson.workspaces.packages.includes('packages/terminal-native'));
    assert.equal(appPackageJson.dependencies['@happier-dev/terminal-native'], '0.0.0');
});

test('HAPPIER_ENABLE_TERMINAL_NATIVE controls Expo autolinking exclusion for terminal-native', async () => {
    const disabledConfig = await loadAppConfigWithNativeFlags({ nativeSsh: '1', terminalNative: '0' });
    assert.deepEqual(
        disabledConfig?.autolinking,
        expectedAutolinkingConfig(['@happier-dev/terminal-native']),
    );

    const enabledConfig = await loadAppConfigWithNativeFlags({ nativeSsh: '1', terminalNative: '1' });
    assert.deepEqual(enabledConfig?.autolinking, expectedAutolinkingConfig([]));
});

test('EAS build install scopes include active first-party native Expo modules', async () => {
    const easJson = await readJson(join(appRoot, 'eas.json'));
    const nativeModules = await findUiFirstPartyNativeExpoModules();
    assert.ok(nativeModules.length > 0, 'Expected apps/ui to depend on first-party native Expo modules');

    for (const profileId of Object.keys(easJson?.build ?? {})) {
        const env = resolveEasBuildProfileEnv({ easJsonPath: join(appRoot, 'eas.json'), profileId });
        const config = await loadAppConfigWithNativeFlags({
            nativeSsh: env.HAPPIER_ENABLE_NATIVE_SSH,
            terminalNative: env.HAPPIER_ENABLE_TERMINAL_NATIVE,
        });
        const excluded = new Set(config?.autolinking?.exclude ?? []);
        const requiredNativeModules = nativeModules.filter((nativeModule) => !excluded.has(nativeModule.packageName));
        const scopeTokens = parseScopeTokens(env.HAPPIER_INSTALL_SCOPE);

        for (const nativeModule of requiredNativeModules) {
            const scopeToken = normalizeHappierWorkspaceToken(nativeModule.packageName);
            assert.ok(
                scopeTokens.has(scopeToken),
                `Expected EAS profile ${profileId} HAPPIER_INSTALL_SCOPE to include ${scopeToken}`,
            );
        }
    }
});

test('Expo autolinking discovers sherpa-native alongside audio-stream-native for Android', async () => {
    const autolinkedModules = await searchAutolinkedModules('android');
    const audioStreamEntry = autolinkedModules['@happier-dev/audio-stream-native'];
    const sherpaEntry = autolinkedModules['@happier-dev/sherpa-native'];

    assert.equal(typeof audioStreamEntry, 'object');
    assert.equal(typeof sherpaEntry, 'object');
    assert.equal(audioStreamEntry?.path, join(repoRoot, 'packages', 'audio-stream-native'));
    assert.equal(sherpaEntry?.path, join(repoRoot, 'packages', 'sherpa-native'));
    assert.deepEqual(sherpaEntry?.config, {
        name: 'HappierSherpaNative',
        platforms: ['ios', 'android'],
        ios: {
            modules: ['HappierSherpaNativeModule'],
        },
        android: {
            modules: ['dev.happier.sherpa.HappierSherpaNativeModule'],
        },
    });
});

test('Expo autolinking discovers sherpa-native alongside audio-stream-native for iOS', async () => {
    const autolinkedModules = await searchAutolinkedModules('ios');
    const audioStreamEntry = autolinkedModules['@happier-dev/audio-stream-native'];
    const sherpaEntry = autolinkedModules['@happier-dev/sherpa-native'];

    assert.equal(typeof audioStreamEntry, 'object');
    assert.equal(typeof sherpaEntry, 'object');
    assert.equal(audioStreamEntry?.path, join(repoRoot, 'packages', 'audio-stream-native'));
    assert.equal(sherpaEntry?.path, join(repoRoot, 'packages', 'sherpa-native'));
    assert.deepEqual(sherpaEntry?.config, {
        name: 'HappierSherpaNative',
        platforms: ['ios', 'android'],
        ios: {
            modules: ['HappierSherpaNativeModule'],
        },
        android: {
            modules: ['dev.happier.sherpa.HappierSherpaNativeModule'],
        },
    });
});

test('sherpa-native iOS podspec ships the bundled VAD model resource and excludes tests', async () => {
    const podspec = await readText(join(repoRoot, 'packages', 'sherpa-native', 'ios', 'HappierSherpaNative.podspec'));

    assert.match(
        podspec,
        /resource_bundles\s*=\s*\{\s*'HappierSherpaNativeResources'\s*=>\s*\['\.\.\/android\/src\/main\/assets\/silero_vad_v5\.onnx'\]\s*\}/m,
    );
    assert.match(podspec, /exclude_files\s*=\s*'Tests\/\*\*\/\*'/);
    assert.match(
        podspec,
        /source_files\s*=\s*\[\s*'\*\.{h,m,mm,swift}',\s*'\.\.\/common\/cpp\/HappierSherpaTtsJobRegistry\.h'\s*\]/m,
    );
    assert.match(podspec, /private_header_files\s*=\s*'\.\.\/common\/cpp\/HappierSherpaTtsJobRegistry\.h'/);
    assert.doesNotMatch(podspec, /source_files\s*=\s*'\*\*\/\*\.{h,m,mm,swift}'/);
});

test('sherpa-native iOS Silero VAD wrapper matches the generated Objective-C initializer ABI', async () => {
    const detectorSource = await readText(join(repoRoot, 'packages', 'sherpa-native', 'ios', 'SileroVadDetector.swift'));

    assert.match(detectorSource, /HappierSherpaSileroVadDetector\(\s*modelPath:\s*modelPath,\s*sampleRate:\s*sampleRate,\s*minSpeechSec:\s*minSpeechSec,\s*minSilenceSec:\s*minSilenceSec\s*\)/s);
    assert.doesNotMatch(detectorSource, /HappierSherpaSileroVadDetector\([^)]*error:\s*&err/s);
});

test('sherpa-native iOS TTS and ASR wrappers use the imported throwing Swift ABIs', async () => {
    const moduleSource = await readText(join(repoRoot, 'packages', 'sherpa-native', 'ios', 'HappierSherpaNativeModule.swift'));
    const offlineHeader = await readText(join(repoRoot, 'packages', 'sherpa-native', 'ios', 'HappierSherpaOfflineTtsEngine.h'));
    const onlineHeader = await readText(join(repoRoot, 'packages', 'sherpa-native', 'ios', 'HappierSherpaOnlineAsrEngine.h'));

    assert.match(offlineHeader, /-\s*\(nullable instancetype\)initWithAssetsDir:/);
    assert.match(onlineHeader, /-\s*\(nullable instancetype\)initWithAssetsDir:/);
    assert.match(moduleSource, /let engine = try HappierSherpaOfflineTtsEngine\(assetsDir:\s*assetsDir\)/);
    assert.match(moduleSource, /let engine = try HappierSherpaOnlineAsrEngine\(assetsDir:\s*assetsDir,\s*sampleRate:\s*16000,\s*language:\s*langKey\.isEmpty \? nil : langKey\)/s);
    assert.match(moduleSource, /try engine\.synthesizeToWavFile\(atPath:\s*outWavPath,\s*text:\s*text,\s*sid:\s*Int32\(sid\),\s*speed:\s*Float\(speed\),\s*jobId:\s*jobId\s*\)/s);
    assert.match(moduleSource, /let stream = try engine\.createStream\(\)/);
    assert.match(moduleSource, /let result = stream\.pushPcm16Data\(data,\s*sampleRate:\s*Int32\(sampleRate\),\s*channels:\s*Int32\(channels\),\s*error:\s*&err\)/s);
    assert.match(moduleSource, /let text = stream\.finishWithError\(&err\)/);
    assert.doesNotMatch(moduleSource, /synthesizeToWavFile\([^)]*error:\s*&err/s);
    assert.doesNotMatch(moduleSource, /createStreamWithError/);
});

test('sherpa-native iOS module tears down frame-fed VAD detectors without owning capture', async () => {
    const moduleSource = await readText(join(repoRoot, 'packages', 'sherpa-native', 'ios', 'HappierSherpaNativeModule.swift'));

    assert.match(moduleSource, /private lazy var vadDetectors = FrameFedVadDetectorRegistry/);
    assert.match(moduleSource, /private func handleModuleDestroy\(\)/);
    assert.match(moduleSource, /vadDetectors\.cancelAll\(\)/);
    assert.match(moduleSource, /OnDestroy\s*\{\s*self\.handleModuleDestroy\(\)\s*\}/m);
    assert.match(moduleSource, /AsyncFunction\("createVadDetector"\)/);
    assert.match(moduleSource, /AsyncFunction\("pushVadAudioFrame"\)/);
    assert.match(moduleSource, /AsyncFunction\("cancelVadDetector"\)/);
    assert.doesNotMatch(moduleSource, /IosVadSessionRunner|startVadSession|stopVadSession|vadSpeechEnd/);
});
