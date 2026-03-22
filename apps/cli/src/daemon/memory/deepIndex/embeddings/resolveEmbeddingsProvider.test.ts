import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encryptSecretStringV1 } from '@happier-dev/protocol';

import { resolveOperationalMemoryEmbeddingsSettings } from '@/daemon/memory/resolveOperationalMemoryEmbeddingsSettings';

const transformersState = vi.hoisted(() => ({
  failPipelineInit: false,
  lastInputs: [] as string[],
}));

vi.mock('@huggingface/transformers', () => ({
  env: {},
  pipeline: async () => {
    if (transformersState.failPipelineInit) {
      throw new Error('missing onnx runtime');
    }
    return async (input: string | string[]) => {
      transformersState.lastInputs = Array.isArray(input) ? [...input] : [input];
      return {
        data: new Float32Array([1, 0]),
        dims: [1, 2],
      };
    };
  },
}));

function createPresetOperationalSettings() {
  const settings = resolveOperationalMemoryEmbeddingsSettings({
    mode: 'preset',
    presetId: 'balanced',
    custom: null,
    blend: { ftsWeight: 0.7, embeddingWeight: 0.3 },
  });
  if (!settings) {
    throw new Error('expected preset embeddings settings to resolve');
  }
  return settings;
}

function createRemoteOperationalSettings() {
  const settings = resolveOperationalMemoryEmbeddingsSettings({
    mode: 'custom',
    presetId: 'balanced',
    custom: {
      kind: 'openai_compatible',
      baseUrl: 'https://example.test/v1',
      apiKey: { _isSecretValue: true, value: 'sk-test' },
      model: 'text-embedding-3-small',
      dimensions: 256,
    },
    blend: { ftsWeight: 0.7, embeddingWeight: 0.3 },
  });
  if (!settings) {
    throw new Error('expected remote embeddings settings to resolve');
  }
  return settings;
}

function createEncryptedRemoteOperationalSettings() {
  const key = new Uint8Array(32).fill(3);
  const settings = resolveOperationalMemoryEmbeddingsSettings({
    mode: 'custom',
    presetId: 'balanced',
    custom: {
      kind: 'openai_compatible',
      baseUrl: 'https://example.test/v1',
      apiKey: {
        _isSecretValue: true,
        encryptedValue: encryptSecretStringV1(
          'sk-encrypted',
          key,
          (length) => new Uint8Array(length).fill(4),
        ),
      },
      model: 'text-embedding-3-small',
      dimensions: 256,
    },
    blend: { ftsWeight: 0.7, embeddingWeight: 0.3 },
  });
  if (!settings) {
    throw new Error('expected encrypted remote embeddings settings to resolve');
  }
  return { settings, key };
}

function createCustomLocalOperationalSettings(queryPrefix: string | null) {
  const settings = resolveOperationalMemoryEmbeddingsSettings({
    mode: 'custom',
    presetId: 'balanced',
    custom: {
      kind: 'local_transformers',
      modelId: 'Xenova/all-MiniLM-L6-v2',
      queryPrefix,
      documentPrefix: null,
    },
    blend: { ftsWeight: 0.7, embeddingWeight: 0.3 },
  });
  if (!settings) {
    throw new Error('expected local embeddings settings to resolve');
  }
  return settings;
}

describe('resolveEmbeddingsProvider', () => {
  let runtimeRoot: string | null = null;

  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock('@/runtime/assets/resolveCliRuntimeAssetPath');
    vi.doMock('@huggingface/transformers', () => ({
      env: {},
      pipeline: async () => {
        if (transformersState.failPipelineInit) {
          throw new Error('missing onnx runtime');
        }
        return async (input: string | string[]) => {
          transformersState.lastInputs = Array.isArray(input) ? [...input] : [input];
          return {
            data: new Float32Array([1, 0]),
            dims: [1, 2],
          };
        };
      },
    }));
    transformersState.failPipelineInit = false;
    transformersState.lastInputs = [];
  });

  afterEach(() => {
    vi.resetModules();
    vi.doUnmock('@/runtime/assets/resolveCliRuntimeAssetPath');
    transformersState.failPipelineInit = false;
    vi.unstubAllGlobals();
    if (runtimeRoot) {
      rmSync(runtimeRoot, { recursive: true, force: true });
      runtimeRoot = null;
    }
  });

  it('returns null when the local transformers runtime cannot be loaded', async () => {
    transformersState.failPipelineInit = true;

    const { resolveEmbeddingsProvider } = await import('./resolveEmbeddingsProvider');

    const resolution = await resolveEmbeddingsProvider({ settings: createPresetOperationalSettings(), cacheDir: '/tmp/happier-memory-embeddings-test' });

    expect(resolution.provider).toBeNull();
    expect(resolution.runtimeState).toBe('error');
  });

  it('retries provider initialization after a previous failure', async () => {
    const { resolveEmbeddingsProvider } = await import('./resolveEmbeddingsProvider');

    transformersState.failPipelineInit = true;
    const failed = await resolveEmbeddingsProvider({ settings: createPresetOperationalSettings(), cacheDir: '/tmp/happier-memory-embeddings-test' });

    transformersState.failPipelineInit = false;
    const recovered = await resolveEmbeddingsProvider({ settings: createPresetOperationalSettings(), cacheDir: '/tmp/happier-memory-embeddings-test' });

    expect(failed.provider).toBeNull();
    expect(failed.runtimeState).toBe('error');
    expect(recovered.provider).not.toBeNull();
    expect(recovered.runtimeState).toBe('ready');
  });

  it('preserves tensor tolist binding when extracting embeddings', async () => {
    vi.doMock('@huggingface/transformers', () => ({
      env: {},
      pipeline: async () => async () => ({
        data: [0.5, 0.25],
        dims: [1, 2],
        tolist() {
          return [this.data];
        },
      }),
    }));

    const { resolveEmbeddingsProvider } = await import('./resolveEmbeddingsProvider');

    const resolution = await resolveEmbeddingsProvider({ settings: createPresetOperationalSettings(), cacheDir: '/tmp/happier-memory-embeddings-test' });

    await expect(resolution.provider?.embedDocuments(['hello'])).resolves.toEqual([new Float32Array([0.5, 0.25])]);
  });

  it('falls back to the self-contained runtime node_modules copy when bare import resolution fails', async () => {
    runtimeRoot = mkdtempSync(join(tmpdir(), 'happier-embeddings-runtime-'));
    const distDir = join(runtimeRoot, 'node_modules', '@huggingface', 'transformers', 'dist');
    mkdirSync(distDir, { recursive: true });
    writeFileSync(
      join(distDir, 'transformers.node.mjs'),
      [
        'export const env = {};',
        'export async function pipeline() {',
        '  return async () => ({ data: new Float32Array([0.5, 0.25]), dims: [1, 2] });',
        '}',
        '',
      ].join('\n'),
      'utf8',
    );

    vi.doMock('@/runtime/assets/resolveCliRuntimeAssetPath', () => ({
      resolveCliRuntimeAssetPath: (...segments: string[]) => join(runtimeRoot as string, ...segments),
    }));

    const { importTransformersModuleWithFallback } = await import('./resolveEmbeddingsProvider');

    const runtimeImport = vi.fn(async () => ({
      env: {},
      pipeline: async () => {
        return async () => ({
          data: new Float32Array([0.5, 0.25]),
          dims: [1, 2],
        });
      },
    }));

    const mod = await importTransformersModuleWithFallback({
      packageImport: async () => {
        throw new Error("ResolveMessage: Cannot find module '@huggingface/transformers' from '/$bunfs/root/happier'");
      },
      runtimeImport,
    });

    expect(mod).toBeTruthy();
    expect(runtimeImport).toHaveBeenCalledTimes(1);
    const runtimeImportTarget = String(runtimeImport.mock.calls.at(0)?.at(0) ?? '');
    expect(runtimeImportTarget).toContain('/node_modules/@huggingface/transformers/dist/transformers.node.mjs');
  });

  it('falls back to the self-contained runtime node_modules copy when bundled runtimes cannot resolve onnxruntime-common', async () => {
    runtimeRoot = mkdtempSync(join(tmpdir(), 'happier-embeddings-runtime-'));
    const distDir = join(runtimeRoot, 'node_modules', '@huggingface', 'transformers', 'dist');
    mkdirSync(distDir, { recursive: true });
    writeFileSync(
      join(distDir, 'transformers.node.mjs'),
      [
        'export const env = {};',
        'export async function pipeline() {',
        '  return async () => ({ data: new Float32Array([0.5, 0.25]), dims: [1, 2] });',
        '}',
        '',
      ].join('\n'),
      'utf8',
    );

    vi.doMock('@/runtime/assets/resolveCliRuntimeAssetPath', () => ({
      resolveCliRuntimeAssetPath: (...segments: string[]) => join(runtimeRoot as string, ...segments),
    }));

    const { importTransformersModuleWithFallback } = await import('./resolveEmbeddingsProvider');

    const runtimeImport = vi.fn(async () => ({
      env: {},
      pipeline: async () => {
        return async () => ({
          data: new Float32Array([0.5, 0.25]),
          dims: [1, 2],
        });
      },
    }));

    const mod = await importTransformersModuleWithFallback({
      packageImport: async () => {
        throw new Error(
          "ResolveMessage: Cannot find package 'onnxruntime-common' from '/Users/test/runtime/current/cli/node_modules/@huggingface/transformers/dist/transformers.node.mjs'",
        );
      },
      runtimeImport,
    });

    expect(mod).toBeTruthy();
    expect(runtimeImport).toHaveBeenCalledTimes(1);
    const runtimeImportTarget = String(runtimeImport.mock.calls.at(0)?.at(0) ?? '');
    expect(runtimeImportTarget).toContain('/node_modules/@huggingface/transformers/dist/transformers.node.mjs');
  });

  it('retries feature-extraction pipeline creation against the runtime copy when bundled runtimes cannot resolve onnxruntime-common during pipeline init', async () => {
    runtimeRoot = mkdtempSync(join(tmpdir(), 'happier-embeddings-runtime-'));
    const distDir = join(runtimeRoot, 'node_modules', '@huggingface', 'transformers', 'dist');
    const runtimeScriptsDir = join(runtimeRoot, 'scripts', 'runtime');
    mkdirSync(distDir, { recursive: true });
    mkdirSync(runtimeScriptsDir, { recursive: true });
    writeFileSync(join(distDir, 'transformers.node.mjs'), 'export const env = {}; export async function pipeline() { return () => null; }', 'utf8');
    writeFileSync(
      join(runtimeScriptsDir, 'loadTransformersFromRuntime.mjs'),
      'export const env = {}; export async function pipeline() { return () => null; }',
      'utf8',
    );

    vi.doMock('@/runtime/assets/resolveCliRuntimeAssetPath', () => ({
      resolveCliRuntimeAssetPath: (...segments: string[]) => join(runtimeRoot as string, ...segments),
    }));

    const { createFeatureExtractionPipelineWithFallback } = await import('./resolveEmbeddingsProvider');

    const runtimeImport = vi.fn(async () => ({
      env: {},
      pipeline: async () => {
        return async () => ({
          data: new Float32Array([0.5, 0.25]),
          dims: [1, 2],
        });
      },
    }));

    const extractor = await createFeatureExtractionPipelineWithFallback({
      modelId: 'Xenova/all-MiniLM-L6-v2',
      cacheDir: '/tmp/happier-memory-embeddings-test',
      packageImport: async () => ({
        env: {},
        pipeline: async () => {
          throw new Error(
            "ResolveMessage: Cannot find package 'onnxruntime-common' from '/Users/test/runtime/current/cli/node_modules/@huggingface/transformers/dist/transformers.node.mjs'",
          );
        },
      }),
      runtimeImport,
    });

    expect(runtimeImport).toHaveBeenCalledTimes(1);
    const runtimeImportTarget = String(runtimeImport.mock.calls.at(0)?.at(0) ?? '');
    expect(runtimeImportTarget).toContain('/scripts/runtime/loadTransformersFromRuntime.mjs');
    await expect(extractor(['hello'], { pooling: 'mean', normalize: true })).resolves.toEqual({
      data: new Float32Array([0.5, 0.25]),
      dims: [1, 2],
    });
  });

  it('retries feature-extraction pipeline creation against the direct runtime module when the runtime loader env binding is not yet initialized', async () => {
    runtimeRoot = mkdtempSync(join(tmpdir(), 'happier-embeddings-runtime-'));
    const distDir = join(runtimeRoot, 'node_modules', '@huggingface', 'transformers', 'dist');
    const runtimeScriptsDir = join(runtimeRoot, 'scripts', 'runtime');
    mkdirSync(distDir, { recursive: true });
    mkdirSync(runtimeScriptsDir, { recursive: true });
    writeFileSync(join(distDir, 'transformers.node.mjs'), 'export const env = {}; export async function pipeline() { return () => null; }', 'utf8');
    writeFileSync(
      join(runtimeScriptsDir, 'loadTransformersFromRuntime.mjs'),
      'export const env = {}; export async function pipeline() { return () => null; }',
      'utf8',
    );

    vi.doMock('@/runtime/assets/resolveCliRuntimeAssetPath', () => ({
      resolveCliRuntimeAssetPath: (...segments: string[]) => join(runtimeRoot as string, ...segments),
    }));

    const { createFeatureExtractionPipelineWithFallback } = await import('./resolveEmbeddingsProvider');

    const runtimeImport = vi.fn(async (moduleUrl: string) => {
      if (moduleUrl.includes('/scripts/runtime/loadTransformersFromRuntime.mjs')) {
        return Object.defineProperty(
          {
            pipeline: async () => {
              throw new Error('runtime loader pipeline should not be used after env access fails');
            },
          },
          'env',
          {
            get() {
              throw new ReferenceError("Cannot access 'env' before initialization.");
            },
          },
        );
      }

      return {
        env: {},
        pipeline: async () => {
          return async () => ({
            data: new Float32Array([0.5, 0.25]),
            dims: [1, 2],
          });
        },
      };
    });

    const extractor = await createFeatureExtractionPipelineWithFallback({
      modelId: 'Xenova/all-MiniLM-L6-v2',
      cacheDir: '/tmp/happier-memory-embeddings-test',
      packageImport: async () =>
        Object.defineProperties(
          {},
          {
            env: {
              get() {
                throw new ReferenceError("Cannot access 'env' before initialization.");
              },
            },
            pipeline: {
              value: async () => {
                throw new Error('package pipeline should not be used after env access fails');
              },
            },
          },
        ),
      runtimeImport,
    });

    expect(runtimeImport).toHaveBeenCalledTimes(2);
    expect(String(runtimeImport.mock.calls.at(0)?.at(0) ?? '')).toContain('/scripts/runtime/loadTransformersFromRuntime.mjs');
    expect(String(runtimeImport.mock.calls.at(1)?.at(0) ?? '')).toContain('/node_modules/@huggingface/transformers/dist/transformers.node.mjs');
    await expect(extractor(['hello'], { pooling: 'mean', normalize: true })).resolves.toEqual({
      data: new Float32Array([0.5, 0.25]),
      dims: [1, 2],
    });
  });

  it('continues with the package pipeline when cache-dir env access is temporarily unavailable', async () => {
    const { createFeatureExtractionPipelineWithFallback } = await import('./createLocalTransformersEmbeddingsProvider');

    const extractor = await createFeatureExtractionPipelineWithFallback({
      modelId: 'Xenova/all-MiniLM-L6-v2',
      cacheDir: '/tmp/happier-memory-embeddings-test',
      runtimeAssetExists: () => false,
      packageImport: async () =>
        Object.defineProperties(
          {},
          {
            env: {
              get() {
                throw new ReferenceError("Cannot access 'env' before initialization.");
              },
            },
            pipeline: {
              value: async () => {
                return async () => ({
                  data: new Float32Array([0.5, 0.25]),
                  dims: [1, 2],
                });
              },
            },
          },
        ),
    });

    await expect(extractor(['hello'], { pooling: 'mean', normalize: true })).resolves.toEqual({
      data: new Float32Array([0.5, 0.25]),
      dims: [1, 2],
    });
  });

  it('retries package pipeline access after a recoverable initialization error', async () => {
    const { createFeatureExtractionPipelineWithFallback } = await import('./createLocalTransformersEmbeddingsProvider');

    let pipelineAccessCount = 0;

    const extractor = await createFeatureExtractionPipelineWithFallback({
      modelId: 'Xenova/all-MiniLM-L6-v2',
      cacheDir: '/tmp/happier-memory-embeddings-test',
      runtimeAssetExists: () => false,
      packageImport: async () =>
        Object.defineProperties(
          {},
          {
            env: {
              value: {},
            },
            pipeline: {
              get() {
                pipelineAccessCount += 1;
                if (pipelineAccessCount === 1) {
                  throw new ReferenceError("Cannot access 'pipeline' before initialization.");
                }
                return async () => {
                  return async () => ({
                    data: new Float32Array([0.5, 0.25]),
                    dims: [1, 2],
                  });
                };
              },
            },
          },
        ),
    });

    expect(pipelineAccessCount).toBe(2);
    await expect(extractor(['hello'], { pooling: 'mean', normalize: true })).resolves.toEqual({
      data: new Float32Array([0.5, 0.25]),
      dims: [1, 2],
    });
  });

  it('initializes the remote embeddings provider when remote settings are configured', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        data: [
          { embedding: [0.1, 0.2] },
          { embedding: [0.3, 0.4] },
        ],
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const { resolveEmbeddingsProvider } = await import('./resolveEmbeddingsProvider');

    const resolution = await resolveEmbeddingsProvider({
      settings: createRemoteOperationalSettings(),
      cacheDir: '/tmp/happier-memory-embeddings-test',
      settingsSecretsReadKeys: [],
    });

    expect(resolution.runtimeState).toBe('ready');
    await expect(resolution.provider?.embedDocuments(['hello', 'world'])).resolves.toEqual([
      new Float32Array([0.1, 0.2]),
      new Float32Array([0.3, 0.4]),
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://example.test/v1/embeddings',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          authorization: 'Bearer sk-test',
        }),
      }),
    );
  });

  it('refreshes the cached remote provider when the API key changes', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        data: [{ embedding: [0.1, 0.2] }],
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const { resolveEmbeddingsProvider } = await import('./resolveEmbeddingsProvider');

    const first = await resolveEmbeddingsProvider({
      settings: createRemoteOperationalSettings(),
      cacheDir: '/tmp/happier-memory-embeddings-test',
      settingsSecretsReadKeys: [],
    });
    await first.provider?.embedQuery('hello');

    const secondSettings = resolveOperationalMemoryEmbeddingsSettings({
      mode: 'custom',
      presetId: 'balanced',
      custom: {
        kind: 'openai_compatible',
        baseUrl: 'https://example.test/v1',
        apiKey: { _isSecretValue: true, value: 'sk-second' },
        model: 'text-embedding-3-small',
        dimensions: 256,
      },
      blend: { ftsWeight: 0.7, embeddingWeight: 0.3 },
    });
    if (!secondSettings) {
      throw new Error('expected remote embeddings settings to resolve');
    }

    const second = await resolveEmbeddingsProvider({
      settings: secondSettings,
      cacheDir: '/tmp/happier-memory-embeddings-test',
      settingsSecretsReadKeys: [],
    });
    await second.provider?.embedQuery('hello again');

    expect(fetchMock).toHaveBeenLastCalledWith(
      'https://example.test/v1/embeddings',
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: 'Bearer sk-second',
        }),
      }),
    );
  });

  it('accepts encrypted remote api keys when read keys are provided', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        data: [{ embedding: [0.1, 0.2] }],
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const { resolveEmbeddingsProvider } = await import('./resolveEmbeddingsProvider');
    const { settings, key } = createEncryptedRemoteOperationalSettings();

    const resolution = await resolveEmbeddingsProvider({
      settings,
      cacheDir: '/tmp/happier-memory-embeddings-test',
      settingsSecretsReadKeys: [key],
    });

    expect(resolution.runtimeState).toBe('ready');
    await resolution.provider?.embedQuery('hello');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://example.test/v1/embeddings',
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: 'Bearer sk-encrypted',
        }),
      }),
    );
  });

  it('refreshes the cached local provider when custom query prefixes change', async () => {
    const { resolveEmbeddingsProvider } = await import('./resolveEmbeddingsProvider');

    const first = await resolveEmbeddingsProvider({
      settings: createCustomLocalOperationalSettings('query: '),
      cacheDir: '/tmp/happier-memory-embeddings-test',
    });
    await first.provider?.embedQuery('hello');
    expect(transformersState.lastInputs[0]).toBe('query:hello');

    const second = await resolveEmbeddingsProvider({
      settings: createCustomLocalOperationalSettings('search: '),
      cacheDir: '/tmp/happier-memory-embeddings-test',
    });
    await second.provider?.embedQuery('hello');
    expect(transformersState.lastInputs[0]).toBe('search:hello');
  });

  it('treats incomplete remote settings as unavailable instead of retrying provider init', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const { resolveEmbeddingsProvider } = await import('./resolveEmbeddingsProvider');

    const settings = resolveOperationalMemoryEmbeddingsSettings({
      mode: 'custom',
      presetId: 'balanced',
      custom: {
        kind: 'openai_compatible',
        baseUrl: '',
        apiKey: { _isSecretValue: true, value: 'sk-test' },
        model: 'text-embedding-3-small',
        dimensions: null,
      },
      blend: { ftsWeight: 0.7, embeddingWeight: 0.3 },
    });
    if (!settings) {
      throw new Error('expected remote embeddings settings to resolve');
    }

    const resolution = await resolveEmbeddingsProvider({
      settings,
      cacheDir: '/tmp/happier-memory-embeddings-test',
      settingsSecretsReadKeys: [],
    });

    expect(resolution.provider).toBeNull();
    expect(resolution.runtimeState).toBe('unavailable');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('surfaces remote http failures from embed requests', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 401,
      json: async () => ({}),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const { resolveEmbeddingsProvider } = await import('./resolveEmbeddingsProvider');

    const resolution = await resolveEmbeddingsProvider({
      settings: createRemoteOperationalSettings(),
      cacheDir: '/tmp/happier-memory-embeddings-test',
      settingsSecretsReadKeys: [],
    });

    await expect(resolution.provider?.embedDocuments(['hello'])).rejects.toThrow('status 401');
  });

  it('surfaces remote schema failures from embed requests', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        data: [{ nope: [0.1, 0.2] }],
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const { resolveEmbeddingsProvider } = await import('./resolveEmbeddingsProvider');

    const resolution = await resolveEmbeddingsProvider({
      settings: createRemoteOperationalSettings(),
      cacheDir: '/tmp/happier-memory-embeddings-test',
      settingsSecretsReadKeys: [],
    });

    await expect(resolution.provider?.embedDocuments(['hello'])).rejects.toThrow();
  });
});
