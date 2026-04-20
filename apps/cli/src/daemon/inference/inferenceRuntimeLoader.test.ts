import { describe, expect, it, vi } from 'vitest';

import {
  createInferenceRuntimeLoader,
  readInferenceRuntimeModuleFieldWithRecoverableRetry,
} from './inferenceRuntimeLoader';

describe('inferenceRuntimeLoader', () => {
  it('falls back to runtime import URLs when package import fails with a recoverable error', async () => {
    const runtimeImport = vi.fn(async (_moduleUrl: string) => ({ env: {}, pipeline: async () => null }));
    const loader = createInferenceRuntimeLoader({
      resolveCandidates: () => [
        async () => {
          throw new Error("Cannot find module '@huggingface/transformers'");
        },
        async () => await runtimeImport('file:///runtime-a.mjs'),
        async () => await runtimeImport('file:///runtime-b.mjs'),
      ],
      isRecoverableLoadError: (error) => String(error).includes('Cannot find module'),
    });

    const mod = await loader.load('transformers');

    expect(mod).toEqual({ env: {}, pipeline: expect.any(Function) });
    expect(runtimeImport).toHaveBeenCalledTimes(1);
    expect(runtimeImport).toHaveBeenCalledWith('file:///runtime-a.mjs');
  });

  it('can resolve to null when the canonical loader is configured with no candidates', async () => {
    const loader = createInferenceRuntimeLoader<null>({
      resolveCandidates: () => [],
      isRecoverableLoadError: () => true,
      onNoCandidates: async () => null,
    });

    await expect(loader.load('missing-runtime')).resolves.toBeNull();
  });

  it('retries field access once for recoverable initialization errors', async () => {
    let accessCount = 0;
    const mod = Object.defineProperty({}, 'pipeline', {
      get() {
        accessCount += 1;
        if (accessCount === 1) {
          throw new ReferenceError("Cannot access 'pipeline' before initialization");
        }
        return async () => 'ok';
      },
    });

    const result = await readInferenceRuntimeModuleFieldWithRecoverableRetry({
      mod,
      field: 'pipeline',
      isRecoverableRuntimeError: (error) => String(error).includes('before initialization'),
    });

    expect(accessCount).toBe(2);
    expect(typeof result.value).toBe('function');
    expect(result.error).toBeNull();
  });
});
