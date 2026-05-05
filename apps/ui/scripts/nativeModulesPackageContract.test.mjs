import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const appRoot = dirname(scriptsDir);
const repoRoot = dirname(dirname(appRoot));

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
