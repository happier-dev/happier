import { describe, expect, it, vi } from 'vitest';

import { partitionProviderSessionArgs } from './providerSessionArgPartition';

function partition(args: readonly string[]) {
  return partitionProviderSessionArgs({ args: [...args], providerSubcommand: null });
}

describe('--secret-ref one-shot Saved Secret selection', () => {
  it('is absent when the flag is not used, preserving every existing launch', () => {
    const result = partition(['--permission-mode', 'default']);
    expect(result.secretReferenceOverlay).toBeUndefined();
    expect(result.providerArgs).toEqual([]);
  });

  it('collects one binding per requirement and never leaks into provider args', () => {
    const result = partition([
      '--secret-ref', 'ANTHROPIC_API_KEY=happier:shared-secret:v1:res-a@3',
      '--secret-ref=OPENAI_API_KEY=personal-secret-1',
      '--provider-only-flag',
    ]);
    expect(result.secretReferenceOverlay).toEqual({
      v: 1,
      bindings: {
        ANTHROPIC_API_KEY: { ref: 'happier:shared-secret:v1:res-a', revision: 3 },
        OPENAI_API_KEY: { ref: 'personal-secret-1' },
      },
    });
    expect(result.providerArgs).toEqual(['--provider-only-flag']);
  });

  it('treats only the last @ as the revision separator', () => {
    const result = partition(['--secret-ref', 'KEY=happier:shared-secret:v1:res@a@11']);
    expect(result.secretReferenceOverlay?.bindings.KEY)
      .toEqual({ ref: 'happier:shared-secret:v1:res@a', revision: 11 });
  });

  it('refuses a shared resource reference without its exact revision', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null): never => {
      throw new Error(`exit:${code ?? 0}`);
    });
    try {
      expect(() => partition([
        '--secret-ref',
        'ANTHROPIC_API_KEY=happier:shared-secret:v1:res-a',
      ])).toThrow('exit:1');
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Invalid --secret-ref selection'),
      );
    } finally {
      errorSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });
});
