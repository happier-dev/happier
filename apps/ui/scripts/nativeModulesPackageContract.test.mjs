import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { getConfig } from '@expo/config';

const execFile = promisify(execFileCallback);

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const appRoot = dirname(scriptsDir);
const repoRoot = dirname(dirname(appRoot));
const nodeRequire = createRequire(import.meta.url);

async function readJson(path) {
    return JSON.parse(await readFile(path, 'utf-8'));
}

async function readText(path) {
    return readFile(path, 'utf-8');
}

async function searchAutolinkedModules(platform) {
    const binaryPath = join(appRoot, 'node_modules', '.bin', 'expo-modules-autolinking');
    const { stdout } = await execFile(binaryPath, ['search', '--platform', platform, '--json'], {
        cwd: appRoot,
    });

    return JSON.parse(stdout);
}

async function loadAppConfigWithNativeSshFlag(value) {
    const previous = process.env.HAPPIER_ENABLE_NATIVE_SSH;
    process.env.HAPPIER_ENABLE_NATIVE_SSH = value;
    try {
        const resolved = nodeRequire.resolve(join(appRoot, 'app.config.js'));
        delete nodeRequire.cache[resolved];
        return getConfig(appRoot, { skipSDKVersionRequirement: true, isPublicConfig: true }).exp;
    } finally {
        if (previous === undefined) {
            delete process.env.HAPPIER_ENABLE_NATIVE_SSH;
        } else {
            process.env.HAPPIER_ENABLE_NATIVE_SSH = previous;
        }
    }
}

test('apps/ui fast test lane includes the native modules package contract check', async () => {
    const packageJson = await readJson(join(appRoot, 'package.json'));
    const testScript = packageJson?.scripts?.test;

    assert.equal(typeof testScript, 'string');
    assert.match(testScript, /nativeModulesPackageContract\.test\.mjs/);
});

test('sherpa-native declares Expo module metadata consistent with sibling native modules', async () => {
    const audioStreamPackageRoot = join(repoRoot, 'packages', 'audio-stream-native');
    const sherpaPackageRoot = join(repoRoot, 'packages', 'sherpa-native');

    const audioStreamPackageJson = await readJson(join(audioStreamPackageRoot, 'package.json'));
    const sherpaPackageJson = await readJson(join(sherpaPackageRoot, 'package.json'));
    const sherpaModuleConfig = await readJson(join(sherpaPackageRoot, 'expo-module.config.json'));

    assert.deepEqual(
        sherpaPackageJson.files,
        audioStreamPackageJson.files,
        'sherpa-native should ship the same Expo-native packaging entries as audio-stream-native',
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
    assert.deepEqual(disabledConfig?.autolinking, {
        exclude: ['@happier-dev/ssh-native'],
        ios: {
            exclude: ['@happier-dev/ssh-native'],
        },
        android: {
            exclude: ['@happier-dev/ssh-native'],
        },
    });

    const enabledConfig = await loadAppConfigWithNativeSshFlag('1');
    assert.equal(enabledConfig?.autolinking, undefined);
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
    assert.match(podspec, /source_files\s*=\s*'\*\.{h,m,mm,swift}'/);
    assert.doesNotMatch(podspec, /source_files\s*=\s*'\*\*\/\*\.{h,m,mm,swift}'/);
});

test('sherpa-native iOS Silero VAD wrapper matches the generated Objective-C initializer ABI', async () => {
    const detectorSource = await readText(join(repoRoot, 'packages', 'sherpa-native', 'ios', 'SileroVadDetector.swift'));

    assert.match(detectorSource, /HappierSherpaSileroVadDetector\(\s*modelPath:\s*modelPath,\s*sampleRate:\s*sampleRate,\s*minSpeechSec:\s*minSpeechSec,\s*minSilenceSec:\s*minSilenceSec\s*\)/s);
    assert.doesNotMatch(detectorSource, /HappierSherpaSileroVadDetector\([^)]*error:\s*&err/s);
});

test('sherpa-native iOS TTS and ASR wrappers match generated Swift ABIs', async () => {
    const moduleSource = await readText(join(repoRoot, 'packages', 'sherpa-native', 'ios', 'HappierSherpaNativeModule.swift'));

    assert.match(moduleSource, /let engine = HappierSherpaOfflineTtsEngine\(assetsDir:\s*assetsDir,\s*error:\s*&err\)/);
    assert.match(moduleSource, /let engine = HappierSherpaOnlineAsrEngine\(assetsDir:\s*assetsDir,\s*sampleRate:\s*16000,\s*language:\s*langKey\.isEmpty \? nil : langKey,\s*error:\s*&err\s*\)/s);
    assert.match(moduleSource, /try engine\.synthesizeToWavFile\(atPath:\s*outWavPath,\s*text:\s*text,\s*sid:\s*Int32\(sid\),\s*speed:\s*Float\(speed\),\s*jobId:\s*jobId\s*\)/s);
    assert.match(moduleSource, /let stream = try engine\.createStream\(\)/);
    assert.match(moduleSource, /let result = stream\.pushPcm16Data\(data,\s*sampleRate:\s*Int32\(sampleRate\),\s*channels:\s*Int32\(channels\),\s*error:\s*&err\)/s);
    assert.match(moduleSource, /let text = stream\.finishWithError\(&err\)/);
    assert.doesNotMatch(moduleSource, /if let engine = HappierSherpaOfflineTtsEngine/);
    assert.doesNotMatch(moduleSource, /if let engine = HappierSherpaOnlineAsrEngine/);
    assert.doesNotMatch(moduleSource, /synthesizeToWavFile\([^)]*error:\s*&err/s);
    assert.doesNotMatch(moduleSource, /createStreamWithError/);
});

test('sherpa-native iOS module tears down any active VAD session on module destroy without creating a runner', async () => {
    const moduleSource = await readText(join(repoRoot, 'packages', 'sherpa-native', 'ios', 'HappierSherpaNativeModule.swift'));

    assert.match(moduleSource, /private var vadRunner: IosVadSessionRunner\?/);
    assert.match(moduleSource, /private func getOrCreateVadRunner\(\) throws -> IosVadSessionRunner/);
    assert.match(moduleSource, /private func handleModuleDestroy\(\)/);
    assert.match(moduleSource, /guard let runner = vadRunner else \{ return \}/);
    assert.match(moduleSource, /vadRunner = nil/);
    assert.match(moduleSource, /runner\.stopAny\(\)/);
    assert.match(moduleSource, /OnDestroy\s*\{\s*self\.handleModuleDestroy\(\)\s*\}/m);
});
