import { describe, expect, it } from 'vitest';
import { readExecutionRunSelectedModelStructuredOutputSupport } from './structuredOutputAdmission';

describe('Review native output selection', () => {
  it.each(['supported', 'unsupported', 'unknown'] as const)('uses the selected native model fact: %s', async structuredOutput => {
    expect(await readExecutionRunSelectedModelStructuredOutputSupport({
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' }, modelId: 'selected',
      readNativeOfferedModel: async () => ({ id: 'selected', name: 'Selected', capabilities: { structuredOutput } }),
    })).toBe(structuredOutput === 'supported');
  });

  it('uses the prepared Provider fact without reading the native catalog', async () => {
    let catalogReads = 0;
    expect(await readExecutionRunSelectedModelStructuredOutputSupport({
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' }, modelId: 'selected',
      prepared: { providerBinding: { model: { id: 'selected', name: 'Selected', capabilities: { structuredOutput: 'supported' } } } },
      readNativeOfferedModel: async () => { catalogReads += 1; return undefined; },
    })).toBe(true);
    expect(catalogReads).toBe(0);
  });

  it('reuses the native model already read for review preparation', async () => {
    let catalogReads = 0;
    expect(await readExecutionRunSelectedModelStructuredOutputSupport({
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' }, modelId: 'selected',
      nativeOfferedModel: { id: 'selected', name: 'Selected', capabilities: { structuredOutput: 'supported' } },
      readNativeOfferedModel: async () => { catalogReads += 1; return undefined; },
    })).toBe(true);
    expect(catalogReads).toBe(0);
  });

  it('preserves a failed catalog read instead of treating it as unsupported discovery', async () => {
    await expect(readExecutionRunSelectedModelStructuredOutputSupport({
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      readNativeOfferedModel: async () => { throw Object.assign(new Error('Catalog unavailable'), { code: 'model_catalog_unavailable' }); },
    })).rejects.toMatchObject({ code: 'model_catalog_unavailable' });
  });

  it('preserves cancellation instead of starting prompt fallback', async () => {
    const controller = new AbortController();
    controller.abort(new DOMException('Stopped', 'AbortError'));
    await expect(readExecutionRunSelectedModelStructuredOutputSupport({
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' }, signal: controller.signal,
    })).rejects.toMatchObject({ name: 'AbortError' });
  });
});
