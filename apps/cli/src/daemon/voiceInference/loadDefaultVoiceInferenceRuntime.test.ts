import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as tar from 'tar';

import { createEnvKeyScope } from '@/testkit/env/envScope';

import type { VoiceInferenceRuntimeTranscribeInput } from './voiceInferenceRuntimeTypes';

function createMonoPcm16WavBuffer(sampleCount = 4, sampleRate = 16_000): Buffer {
    const dataSize = sampleCount * 2;
    const buffer = Buffer.alloc(44 + dataSize);
    buffer.write('RIFF', 0, 'ascii');
    buffer.writeUInt32LE(36 + dataSize, 4);
    buffer.write('WAVE', 8, 'ascii');
    buffer.write('fmt ', 12, 'ascii');
    buffer.writeUInt32LE(16, 16);
    buffer.writeUInt16LE(1, 20);
    buffer.writeUInt16LE(1, 22);
    buffer.writeUInt32LE(sampleRate, 24);
    buffer.writeUInt32LE(sampleRate * 2, 28);
    buffer.writeUInt16LE(2, 32);
    buffer.writeUInt16LE(16, 34);
    buffer.write('data', 36, 'ascii');
    buffer.writeUInt32LE(dataSize, 40);
    for (let index = 0; index < sampleCount; index += 1) {
        buffer.writeInt16LE(index * 128, 44 + (index * 2));
    }
    return buffer;
}

function normalizeNodePlatform(platform: string): string {
    return platform === 'win32' ? 'windows' : platform;
}

describe('loadDefaultVoiceInferenceRuntime', () => {
    const envKeys = ['HAPPIER_VOICE_INFERENCE_RUNTIME_MODULE'] as const;
    let envScope = createEnvKeyScope(envKeys);
    const tempDirs: string[] = [];
    const voiceRuntimeLoaderSourcePath = fileURLToPath(new URL('../../../scripts/runtime/loadVoiceInferenceRuntime.mjs', import.meta.url));
    const deferredVoiceRuntimePackagesModulePath = fileURLToPath(
        new URL(
            '../../../../../packages/cli-common/dist/componentArtifacts/deferredVoiceRuntimePackages.js',
            import.meta.url,
        ),
    );
    const releaseRuntimeArchiveExtractionModulePath = fileURLToPath(
        new URL('../../../../../packages/release-runtime/dist/archiveExtraction.js', import.meta.url),
    );

    async function createTempDir(): Promise<string> {
        const dir = await mkdtemp(join(tmpdir(), 'happier-load-default-voice-runtime-'));
        tempDirs.push(dir);
        return dir;
    }

    async function createRuntimeModule(params: Readonly<{
        filePath: string;
        transcribeText: string;
    }>): Promise<void> {
        await mkdir(dirname(params.filePath), { recursive: true });
        await writeFile(
            params.filePath,
            [
                `const transcribeText = ${JSON.stringify(params.transcribeText)};`,
                'export const voiceInferenceRuntimeEngine = {',
                '    warmModel: async () => {},',
                "    synthesizeTts: async () => ({ bytes: Buffer.from('unused'), output: { codec: 'wav', mimeType: 'audio/wav' }, name: 'unused.wav' }),",
                '    transcribeAudio: async () => ({ text: transcribeText, language: "en" }),',
                '};',
                '',
            ].join('\n'),
            'utf8',
        );
    }

    async function createPackagedVoiceRuntimeLoader(filePath: string): Promise<void> {
        await mkdir(dirname(filePath), { recursive: true });
        await writeFile(
            filePath,
            (await readFile(voiceRuntimeLoaderSourcePath, 'utf8'))
                .replace(
                    "from '@happier-dev/cli-common/componentArtifacts/deferredVoiceRuntimePackages';",
                    `from ${JSON.stringify(pathToFileURL(deferredVoiceRuntimePackagesModulePath).href)};`,
                )
                .replace(
                    "from '@happier-dev/release-runtime/archiveExtraction';",
                    `from ${JSON.stringify(pathToFileURL(releaseRuntimeArchiveExtractionModulePath).href)};`,
                ),
            'utf8',
        );
    }

    async function importLoaderModule() {
        vi.resetModules();
        return await import('./loadDefaultVoiceInferenceRuntime');
    }

    async function createInputFixture(rootDir: string): Promise<VoiceInferenceRuntimeTranscribeInput> {
        const filePath = join(rootDir, 'input.wav');
        await writeFile(filePath, createMonoPcm16WavBuffer());
        return {
            requestId: 'stt-1',
            filePath,
            inputMimeType: 'audio/wav',
            packId: 'sherpa-stt-en-v1',
            packDir: rootDir,
            manifest: {
                packId: 'sherpa-stt-en-v1',
                kind: 'stt_sherpa',
                model: 'sherpa',
                version: '2026-04-17',
                files: [],
            },
            language: 'en',
            normalization: {
                inputTransport: 'upload_transfer',
                strategy: 'ui_pretranscoded_pcm16_fallback',
                systemFfmpegAllowed: false,
            },
        };
    }

    afterEach(async () => {
        envScope.restore();
        envScope = createEnvKeyScope(envKeys);
        vi.resetModules();
        vi.doUnmock('@/packagedRuntime/assets/resolveCliRuntimeAssetPath');
        await Promise.all(tempDirs.splice(0).map(async (dir) => await rm(dir, { recursive: true, force: true }).catch(() => undefined)));
    });

    it('prefers the env override module before the packaged runtime asset loader when explicitly configured', async () => {
        const runtimeRoot = await createTempDir();
        const overrideRoot = await createTempDir();
        const packagedModulePath = join(runtimeRoot, 'scripts', 'runtime', 'loadVoiceInferenceRuntime.mjs');
        const overrideModulePath = join(overrideRoot, 'voiceInferenceOverride.mjs');

        await createRuntimeModule({ filePath: packagedModulePath, transcribeText: 'packaged-runtime' });
        await createRuntimeModule({ filePath: overrideModulePath, transcribeText: 'env-override-runtime' });
        process.env.HAPPIER_VOICE_INFERENCE_RUNTIME_MODULE = pathToFileURL(overrideModulePath).href;
        vi.doMock('@/packagedRuntime/assets/resolveCliRuntimeAssetPath', () => ({
            resolveCliRuntimeAssetPath: (...segments: string[]) => join(runtimeRoot, ...segments),
        }));

        const { loadDefaultVoiceInferenceRuntime } = await importLoaderModule();
        const runtime = await loadDefaultVoiceInferenceRuntime();
        const input = await createInputFixture(runtimeRoot);

        await expect(runtime?.transcribeAudio(input)).resolves.toMatchObject({
            text: 'env-override-runtime',
            language: 'en',
        });
    });

    it('falls back to the env override module when the packaged runtime asset is absent', async () => {
        const runtimeRoot = await createTempDir();
        const overrideRoot = await createTempDir();
        const overrideModulePath = join(overrideRoot, 'voiceInferenceOverride.mjs');

        await createRuntimeModule({ filePath: overrideModulePath, transcribeText: 'env-override-runtime' });
        process.env.HAPPIER_VOICE_INFERENCE_RUNTIME_MODULE = pathToFileURL(overrideModulePath).href;
        vi.doMock('@/packagedRuntime/assets/resolveCliRuntimeAssetPath', () => ({
            resolveCliRuntimeAssetPath: (...segments: string[]) => join(runtimeRoot, ...segments),
        }));

        const { loadDefaultVoiceInferenceRuntime } = await importLoaderModule();
        const runtime = await loadDefaultVoiceInferenceRuntime();
        const input = await createInputFixture(overrideRoot);

        await expect(runtime?.transcribeAudio(input)).resolves.toMatchObject({
            text: 'env-override-runtime',
            language: 'en',
        });
    });

    it('falls back to the packaged runtime when the configured override module is missing', async () => {
        const runtimeRoot = await createTempDir();
        const packagedModulePath = join(runtimeRoot, 'scripts', 'runtime', 'loadVoiceInferenceRuntime.mjs');

        await createRuntimeModule({ filePath: packagedModulePath, transcribeText: 'packaged-runtime' });
        process.env.HAPPIER_VOICE_INFERENCE_RUNTIME_MODULE = pathToFileURL(
            join(runtimeRoot, 'missing', 'voiceInferenceOverride.mjs'),
        ).href;
        vi.doMock('@/packagedRuntime/assets/resolveCliRuntimeAssetPath', () => ({
            resolveCliRuntimeAssetPath: (...segments: string[]) => join(runtimeRoot, ...segments),
        }));

        const { loadDefaultVoiceInferenceRuntime } = await importLoaderModule();
        const runtime = await loadDefaultVoiceInferenceRuntime();
        const input = await createInputFixture(runtimeRoot);

        await expect(runtime?.transcribeAudio(input)).resolves.toMatchObject({
            text: 'packaged-runtime',
            language: 'en',
        });
    });

    it('forwards releaseModel through the default runtime engine wrapper', async () => {
        const runtimeRoot = await createTempDir();
        const packagedModulePath = join(runtimeRoot, 'scripts', 'runtime', 'loadVoiceInferenceRuntime.mjs');

        await mkdir(dirname(packagedModulePath), { recursive: true });
        await writeFile(
            packagedModulePath,
            [
                'globalThis.__voiceInferenceReleasedPackIds = [];',
                'export const voiceInferenceRuntimeEngine = {',
                '    warmModel: async () => {},',
                '    releaseModel: async ({ packId }) => {',
                '        globalThis.__voiceInferenceReleasedPackIds.push(packId);',
                '    },',
                "    synthesizeTts: async () => ({ bytes: Buffer.from('unused'), output: { codec: 'wav', mimeType: 'audio/wav' }, name: 'unused.wav' }),",
                '    transcribeAudio: async () => ({ text: "packaged-runtime", language: "en" }),',
                '};',
                '',
            ].join('\n'),
            'utf8',
        );
        vi.doMock('@/packagedRuntime/assets/resolveCliRuntimeAssetPath', () => ({
            resolveCliRuntimeAssetPath: (...segments: string[]) => join(runtimeRoot, ...segments),
        }));

        const { loadDefaultVoiceInferenceRuntime } = await importLoaderModule();
        const runtime = await loadDefaultVoiceInferenceRuntime();

        await runtime?.releaseModel?.({
            packId: 'kokoro-82m-v1.0-onnx-q8-wasm',
            packDir: runtimeRoot,
            manifest: {
                packId: 'kokoro-82m-v1.0-onnx-q8-wasm',
                kind: 'tts_sherpa',
                model: 'kokoro',
                version: '2026-04-17',
                files: [],
            },
        });

        expect((globalThis as { __voiceInferenceReleasedPackIds?: string[] }).__voiceInferenceReleasedPackIds).toEqual([
            'kokoro-82m-v1.0-onnx-q8-wasm',
        ]);
    });

    it('forwards optional streaming transcription sessions through the default runtime engine wrapper', async () => {
        const runtimeRoot = await createTempDir();
        const packagedModulePath = join(runtimeRoot, 'scripts', 'runtime', 'loadVoiceInferenceRuntime.mjs');

        await mkdir(dirname(packagedModulePath), { recursive: true });
        await writeFile(
            packagedModulePath,
            [
                'globalThis.__voiceInferenceStreamingSessionInputs = [];',
                'export const voiceInferenceRuntimeEngine = {',
                '    warmModel: async () => {},',
                "    synthesizeTts: async () => ({ bytes: Buffer.from('unused'), output: { codec: 'wav', mimeType: 'audio/wav' }, name: 'unused.wav' }),",
                '    transcribeAudio: async () => ({ text: "packaged-runtime", language: "en" }),',
                '    createStreamingTranscriptionSession: async (input) => {',
                '        globalThis.__voiceInferenceStreamingSessionInputs.push(input);',
                '        return {',
                "            appendPcm16: async ({ seq }) => ({ events: [{ type: 'partial', seq, text: 'hel', isEndpoint: false, confidence: null }] }),",
                "            finish: async ({ finalSeq }) => ({ text: 'hello', language: input.language, events: [{ type: 'final', seq: finalSeq, text: 'hello', language: input.language, modelPackId: input.packId }] }),",
                '            cancel: async () => {},',
                '            close: async () => {},',
                '        };',
                '    },',
                '};',
                '',
            ].join('\n'),
            'utf8',
        );
        vi.doMock('@/packagedRuntime/assets/resolveCliRuntimeAssetPath', () => ({
            resolveCliRuntimeAssetPath: (...segments: string[]) => join(runtimeRoot, ...segments),
        }));

        const { loadDefaultVoiceInferenceRuntime } = await importLoaderModule();
        const runtime = await loadDefaultVoiceInferenceRuntime();
        const session = await runtime?.createStreamingTranscriptionSession?.({
            requestId: 'stt-stream-1',
            packId: 'sherpa-stt-en-v1',
            packDir: runtimeRoot,
            manifest: {
                packId: 'sherpa-stt-en-v1',
                kind: 'stt_sherpa',
                model: 'sherpa',
                version: '2026-04-17',
                files: [],
            },
            language: 'en',
            format: {
                sampleRateHz: 16_000,
                channelCount: 1,
                bitsPerSample: 16,
                ffmpegCodec: 'pcm_s16le',
            },
        });

        await expect(session?.appendPcm16({ seq: 0, pcm16Bytes: new Uint8Array([0, 0]) })).resolves.toEqual({
            events: [{ type: 'partial', seq: 0, text: 'hel', isEndpoint: false, confidence: null }],
        });
        await expect(session?.finish({ finalSeq: 0 })).resolves.toEqual({
            text: 'hello',
            language: 'en',
            events: [{ type: 'final', seq: 0, text: 'hello', language: 'en', modelPackId: 'sherpa-stt-en-v1' }],
        });
        expect((globalThis as { __voiceInferenceStreamingSessionInputs?: Array<{ requestId: string }> }).__voiceInferenceStreamingSessionInputs).toEqual([
            expect.objectContaining({ requestId: 'stt-stream-1' }),
        ]);
    });

    it('deletes decoded temp files when daemon decode validation fails after the runtime facade decodes audio', async () => {
        const runtimeRoot = await createTempDir();
        const overrideModulePath = join(runtimeRoot, 'voiceInferenceOverride.mjs');
        const inputFilePath = join(runtimeRoot, 'input.webm');
        await writeFile(inputFilePath, Buffer.from('compressed-audio'));
        const input: VoiceInferenceRuntimeTranscribeInput = {
            requestId: 'stt-leak',
            filePath: inputFilePath,
            inputMimeType: 'audio/webm;codecs=opus',
            packId: 'sherpa-stt-en-v1',
            packDir: runtimeRoot,
            manifest: {
                packId: 'sherpa-stt-en-v1',
                kind: 'stt_sherpa',
                model: 'sherpa',
                version: '2026-04-17',
                files: [],
            },
            language: 'en',
            normalization: {
                inputTransport: 'upload_transfer',
                strategy: 'daemon_decode',
                systemFfmpegAllowed: false,
            },
        };
        const decodedFilePath = `${input.filePath}.decoded.wav`;

        await writeFile(
            overrideModulePath,
            [
                "import { writeFile } from 'node:fs/promises';",
                'export const voiceInferenceRuntimeEngine = {',
                '    warmModel: async () => {},',
                "    synthesizeTts: async () => ({ bytes: Buffer.from('unused'), output: { codec: 'wav', mimeType: 'audio/wav' }, name: 'unused.wav' }),",
                '    decodeAudioInput: async ({ filePath }) => {',
                "        const decodedFilePath = `${filePath}.decoded.wav`;",
                "        await writeFile(decodedFilePath, 'not-a-wav', 'utf8');",
                "        return { filePath: decodedFilePath, inputMimeType: 'audio/wav' };",
                '    },',
                "    transcribeAudio: async () => ({ text: 'unreachable', language: 'en' }),",
                '};',
                '',
            ].join('\n'),
            'utf8',
        );
        process.env.HAPPIER_VOICE_INFERENCE_RUNTIME_MODULE = pathToFileURL(overrideModulePath).href;
        vi.doMock('@/packagedRuntime/assets/resolveCliRuntimeAssetPath', () => ({
            resolveCliRuntimeAssetPath: (...segments: string[]) => join(runtimeRoot, ...segments),
        }));

        const { loadDefaultVoiceInferenceRuntime } = await importLoaderModule();
        const runtime = await loadDefaultVoiceInferenceRuntime();

        await expect(runtime?.transcribeAudio(input)).rejects.toMatchObject({
            code: 'invalid_audio_input',
        });
        await expect(readFile(decodedFilePath)).rejects.toThrow();
    });

    it('reports runtime_unavailable when the packaged runtime asset exists but its native closure is broken', async () => {
        const runtimeRoot = await createTempDir();
        const packagedModulePath = join(runtimeRoot, 'scripts', 'runtime', 'loadVoiceInferenceRuntime.mjs');

        await mkdir(dirname(packagedModulePath), { recursive: true });
        await writeFile(
            packagedModulePath,
            [
                "const error = Object.assign(new Error('native runtime missing'), { code: 'ERR_DLOPEN_FAILED' });",
                'throw error;',
                '',
            ].join('\n'),
            'utf8',
        );
        vi.doMock('@/packagedRuntime/assets/resolveCliRuntimeAssetPath', () => ({
            resolveCliRuntimeAssetPath: (...segments: string[]) => join(runtimeRoot, ...segments),
        }));

        const { loadDefaultVoiceInferenceRuntime } = await importLoaderModule();

        await expect(loadDefaultVoiceInferenceRuntime()).rejects.toMatchObject({
            code: 'runtime_unavailable',
        });
    });

    it('unpacks the deferred packaged runtime archive on first use when the native closure is not installed yet', async () => {
        const runtimeRoot = await createTempDir();
        const packagedModulePath = join(runtimeRoot, 'scripts', 'runtime', 'loadVoiceInferenceRuntime.mjs');
        const archivePath = join(
            runtimeRoot,
            'tools',
            'archives',
            `voice-inference-runtime-${normalizeNodePlatform(process.platform)}-${process.arch}.tar.gz`,
        );
        const payloadRoot = join(runtimeRoot, 'archive-payload');
        const sherpaNodeDir = join(payloadRoot, 'node_modules', 'sherpa-onnx-node');

        await createPackagedVoiceRuntimeLoader(packagedModulePath);
        await createRuntimeModule({
            filePath: join(runtimeRoot, 'package-dist', 'daemon', 'voiceInference', 'runtime', 'packagedVoiceInferenceRuntime.mjs'),
            transcribeText: 'packaged-runtime',
        });
        await mkdir(sherpaNodeDir, { recursive: true });
        await writeFile(
            join(sherpaNodeDir, 'package.json'),
            JSON.stringify({
                name: 'sherpa-onnx-node',
                version: '1.0.0',
                main: './index.js',
            }, null, 2),
            'utf8',
        );
        await writeFile(join(sherpaNodeDir, 'index.js'), 'module.exports = { version: "1.0.0" };\n', 'utf8');
        await mkdir(dirname(archivePath), { recursive: true });
        await tar.c({
            gzip: true,
            file: archivePath,
            cwd: payloadRoot,
            portable: true,
        }, ['node_modules']);
        vi.doMock('@/packagedRuntime/assets/resolveCliRuntimeAssetPath', () => ({
            resolveCliRuntimeAssetPath: (...segments: string[]) => join(runtimeRoot, ...segments),
        }));

        const { loadDefaultVoiceInferenceRuntime } = await importLoaderModule();
        const runtime = await loadDefaultVoiceInferenceRuntime();
        const input = await createInputFixture(runtimeRoot);

        await expect(runtime?.transcribeAudio(input)).resolves.toMatchObject({
            text: 'packaged-runtime',
            language: 'en',
        });
        expect(existsSync(join(runtimeRoot, 'node_modules', 'sherpa-onnx-node', 'index.js'))).toBe(true);
    });

    it('rejects a highly compressed deferred runtime archive without publishing partial output', async () => {
        const runtimeRoot = await createTempDir();
        const packagedModulePath = join(runtimeRoot, 'scripts', 'runtime', 'loadVoiceInferenceRuntime.mjs');
        const archivePath = join(
            runtimeRoot,
            'tools',
            'archives',
            `voice-inference-runtime-${normalizeNodePlatform(process.platform)}-${process.arch}.tar.gz`,
        );
        const payloadRoot = join(runtimeRoot, 'archive-payload');
        const sherpaNodeDir = join(payloadRoot, 'node_modules', 'sherpa-onnx-node');

        await createPackagedVoiceRuntimeLoader(packagedModulePath);
        await createRuntimeModule({
            filePath: join(runtimeRoot, 'package-dist', 'daemon', 'voiceInference', 'runtime', 'packagedVoiceInferenceRuntime.mjs'),
            transcribeText: 'packaged-runtime',
        });
        await mkdir(sherpaNodeDir, { recursive: true });
        await writeFile(
            join(sherpaNodeDir, 'package.json'),
            JSON.stringify({
                name: 'sherpa-onnx-node',
                version: '1.0.0',
                main: './index.js',
            }, null, 2),
            'utf8',
        );
        await writeFile(join(sherpaNodeDir, 'index.js'), 'module.exports = { version: "1.0.0" };\n', 'utf8');
        await writeFile(join(sherpaNodeDir, 'highly-compressible.bin'), Buffer.alloc(2 * 1024 * 1024));
        await mkdir(dirname(archivePath), { recursive: true });
        await tar.c({
            gzip: true,
            file: archivePath,
            cwd: payloadRoot,
            portable: true,
        }, ['node_modules']);
        vi.doMock('@/packagedRuntime/assets/resolveCliRuntimeAssetPath', () => ({
            resolveCliRuntimeAssetPath: (...segments: string[]) => join(runtimeRoot, ...segments),
        }));

        const { loadDefaultVoiceInferenceRuntime } = await importLoaderModule();

        await expect(loadDefaultVoiceInferenceRuntime()).rejects.toMatchObject({
            code: 'runtime_unavailable',
        });
        expect(existsSync(join(runtimeRoot, 'node_modules', 'sherpa-onnx-node'))).toBe(false);
    });

    it('rejects deferred runtime package promotion through a pre-existing scoped-package symlink', async () => {
        const runtimeRoot = await createTempDir();
        const outsideRoot = await createTempDir();
        const packagedModulePath = join(runtimeRoot, 'scripts', 'runtime', 'loadVoiceInferenceRuntime.mjs');
        const archivePath = join(
            runtimeRoot,
            'tools',
            'archives',
            `voice-inference-runtime-${normalizeNodePlatform(process.platform)}-${process.arch}.tar.gz`,
        );
        const payloadRoot = join(runtimeRoot, 'archive-payload');
        const transformersDir = join(payloadRoot, 'node_modules', '@huggingface', 'transformers');
        const sherpaNodeDir = join(payloadRoot, 'node_modules', 'sherpa-onnx-node');

        await createPackagedVoiceRuntimeLoader(packagedModulePath);
        await createRuntimeModule({
            filePath: join(runtimeRoot, 'package-dist', 'daemon', 'voiceInference', 'runtime', 'packagedVoiceInferenceRuntime.mjs'),
            transcribeText: 'packaged-runtime',
        });
        await mkdir(transformersDir, { recursive: true });
        await writeFile(
            join(transformersDir, 'package.json'),
            JSON.stringify({ name: '@huggingface/transformers', version: '1.0.0' }),
            'utf8',
        );
        await mkdir(sherpaNodeDir, { recursive: true });
        await writeFile(
            join(sherpaNodeDir, 'package.json'),
            JSON.stringify({
                name: 'sherpa-onnx-node',
                version: '1.0.0',
                main: './index.js',
            }, null, 2),
            'utf8',
        );
        await writeFile(join(sherpaNodeDir, 'index.js'), 'module.exports = { version: "1.0.0" };\n', 'utf8');
        await mkdir(dirname(archivePath), { recursive: true });
        await tar.c({
            gzip: true,
            file: archivePath,
            cwd: payloadRoot,
            portable: true,
        }, ['node_modules']);
        await mkdir(join(runtimeRoot, 'node_modules'), { recursive: true });
        await symlink(
            outsideRoot,
            join(runtimeRoot, 'node_modules', '@huggingface'),
            process.platform === 'win32' ? 'junction' : 'dir',
        );
        vi.doMock('@/packagedRuntime/assets/resolveCliRuntimeAssetPath', () => ({
            resolveCliRuntimeAssetPath: (...segments: string[]) => join(runtimeRoot, ...segments),
        }));

        const { loadDefaultVoiceInferenceRuntime } = await importLoaderModule();

        await expect(loadDefaultVoiceInferenceRuntime()).rejects.toMatchObject({
            code: 'runtime_unavailable',
        });
        expect(existsSync(join(outsideRoot, 'transformers'))).toBe(false);
        expect(existsSync(join(runtimeRoot, 'node_modules', 'sherpa-onnx-node'))).toBe(false);
    });

    it('rejects deferred runtime archives that attempt to install unsafe entries (symlinks/path traversal)', async () => {
        const runtimeRoot = await createTempDir();
        const packagedModulePath = join(runtimeRoot, 'scripts', 'runtime', 'loadVoiceInferenceRuntime.mjs');
        const archivePath = join(
            runtimeRoot,
            'tools',
            'archives',
            `voice-inference-runtime-${normalizeNodePlatform(process.platform)}-${process.arch}.tar.gz`,
        );
        const payloadRoot = join(runtimeRoot, 'archive-payload');
        const nodeModulesDir = join(payloadRoot, 'node_modules');
        const symlinkPath = join(nodeModulesDir, 'sherpa-onnx-node');
        const sherpaTargetDir = join(payloadRoot, 'sherpa-target');

        await createPackagedVoiceRuntimeLoader(packagedModulePath);
        await createRuntimeModule({
            filePath: join(runtimeRoot, 'package-dist', 'daemon', 'voiceInference', 'runtime', 'packagedVoiceInferenceRuntime.mjs'),
            transcribeText: 'packaged-runtime',
        });

        await mkdir(nodeModulesDir, { recursive: true });
        await mkdir(sherpaTargetDir, { recursive: true });
        await writeFile(
            join(sherpaTargetDir, 'package.json'),
            JSON.stringify({
                name: 'sherpa-onnx-node',
                version: '1.0.0',
                main: './index.js',
            }, null, 2),
            'utf8',
        );
        await writeFile(join(sherpaTargetDir, 'index.js'), 'module.exports = { version: "1.0.0" };\n', 'utf8');
        await symlink('../sherpa-target', symlinkPath);

        await mkdir(dirname(archivePath), { recursive: true });
        await tar.c({
            gzip: true,
            file: archivePath,
            cwd: payloadRoot,
            portable: true,
        }, ['node_modules', 'sherpa-target']);

        vi.doMock('@/packagedRuntime/assets/resolveCliRuntimeAssetPath', () => ({
            resolveCliRuntimeAssetPath: (...segments: string[]) => join(runtimeRoot, ...segments),
        }));

        const { loadDefaultVoiceInferenceRuntime } = await importLoaderModule();
        await expect(loadDefaultVoiceInferenceRuntime()).rejects.toMatchObject({
            code: 'runtime_unavailable',
        });
    });
});
