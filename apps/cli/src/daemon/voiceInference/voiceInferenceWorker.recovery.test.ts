import { describe, expect, it, vi } from 'vitest';

import type { DaemonPublicVoiceModelPackRuntime } from './publicModelPacks/runtime';
import { startVoiceInferenceWorker } from './voiceInferenceWorker';

describe('voice inference worker recovery ordering', () => {
  it('awaits public pack convergence before constructing an observable worker', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const ready = vi.fn(async () => gate);
    const publicModelPacks: DaemonPublicVoiceModelPackRuntime = {
      ready,
      list: async () => [],
      resolve: async () => null,
      install: async () => { throw new Error('not used'); },
      acceptLicense: async () => { throw new Error('not used'); },
      remove: async () => undefined,
    };

    let started = false;
    const workerPromise = startVoiceInferenceWorker({
      publicModelPacks,
      runtimeLoader: async () => null,
    }).then((worker) => {
      started = true;
      return worker;
    });
    await Promise.resolve();
    expect(ready).toHaveBeenCalledTimes(1);
    expect(started).toBe(false);

    release();
    const worker = await workerPromise;
    expect(started).toBe(true);
    await worker.stop();
  });
});
