import { describe, expect, it, vi } from 'vitest';

import { runPluginAuthorDoctor } from './doctor';

const resolveSingleFileEntry = async (locator: string) => ({
  kind: 'singleFile' as const,
  locator,
  packageRoot: '/fixture',
  entryPath: locator,
});

describe('plugin author doctor', () => {
  it('reports the canonical projection and observable evaluation timing without purity claims', async () => {
    const evaluate = vi.fn(async () => ({
      entry: {
        kind: 'singleFile' as const,
        locator: '/plugin.ts',
        packageRoot: '/',
        entryPath: '/plugin.ts',
      },
      manifest: { id: 'example.doctor', version: '0.1.0' },
      canonicalManifestJson: '{"id":"example.doctor"}\n',
      module: { activate: vi.fn() },
    }));
    const nowMs = vi.fn()
      .mockReturnValueOnce(100)
      .mockReturnValueOnce(145);

    await expect(runPluginAuthorDoctor({
      locator: '/plugin.ts',
      resolveEntry: resolveSingleFileEntry,
      evaluate: evaluate as never,
      nowMs,
      slowEvaluationMs: 100,
    })).resolves.toEqual({
      ok: true,
      pluginId: 'example.doctor',
      version: '0.1.0',
      entryPath: '/plugin.ts',
      evaluationMs: 45,
      canonicalManifestJson: '{"id":"example.doctor"}\n',
      diagnostics: [],
    });
    expect(evaluate).toHaveBeenCalledOnce();
  });

  it('reports slowness and import failures as diagnostics rather than reproducibility proof', async () => {
    const slow = await runPluginAuthorDoctor({
      locator: '/plugin.ts',
      resolveEntry: resolveSingleFileEntry,
      evaluate: (async () => ({
        entry: { kind: 'singleFile', locator: '/plugin.ts', packageRoot: '/', entryPath: '/plugin.ts' },
        manifest: { id: 'example.slow', version: '0.1.0' },
        canonicalManifestJson: '{}\n',
        module: { activate() {} },
      })) as never,
      nowMs: vi.fn().mockReturnValueOnce(0).mockReturnValueOnce(250),
      slowEvaluationMs: 100,
    });
    expect(slow).toMatchObject({
      ok: true,
      diagnostics: [{ code: 'plugin_author_evaluation_slow' }],
    });

    await expect(runPluginAuthorDoctor({
      locator: '/broken.ts',
      resolveEntry: resolveSingleFileEntry,
      evaluate: async () => { throw new Error('top-level boom'); },
    })).resolves.toEqual({
      ok: false,
      diagnostics: [{
        code: 'plugin_author_evaluation_failed',
        message: 'Plugin author evaluation failed: top-level boom',
      }],
    });
  });

  it('reports an evaluator source location relative to the author project without leaking stack paths', async () => {
    const evaluationError = new Error('top-level boom at /private/runtime-secret.ts');
    evaluationError.stack = [
      'Error: top-level boom at /private/runtime-secret.ts',
      '    at activate (/author/plugin/src/index.ts:7:11)',
      '    at load (/private/runtime-secret.ts:2:3)',
    ].join('\n');

    const result = await runPluginAuthorDoctor({
      locator: '/author/plugin',
      resolveEntry: async () => ({
        kind: 'packageRoot',
        locator: '/author/plugin',
        packageRoot: '/author/plugin',
        entryPath: '/author/plugin/src/index.ts',
      }),
      prepareDependencies: async () => ({ ok: true, projectRoot: '/author/plugin' }),
      evaluate: async () => { throw evaluationError; },
    });

    expect(result).toEqual({
      ok: false,
      diagnostics: [{
        code: 'plugin_author_evaluation_failed',
        message: 'Plugin author evaluation failed: top-level boom at <path>',
        location: { file: 'src/index.ts', line: 7, column: 11 },
      }],
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('/author/plugin');
    expect(serialized).not.toContain('/private/runtime-secret.ts');
    expect(serialized).not.toContain('at activate');
  });

  it('prepares a package-root author source before evaluating it', async () => {
    const order: string[] = [];
    const prepareDependencies = vi.fn(async () => {
      order.push('prepare');
      return { ok: true as const, projectRoot: '/plugin' };
    });
    const evaluate = vi.fn(async () => {
      order.push('evaluate');
      return {
        entry: {
          kind: 'packageRoot' as const,
          locator: '/plugin',
          packageRoot: '/plugin',
          entryPath: '/plugin/src/index.ts',
        },
        manifest: { id: 'example.prepared', version: '0.1.0' },
        canonicalManifestJson: '{"id":"example.prepared"}\n',
        module: { activate: vi.fn() },
      };
    });

    await expect(runPluginAuthorDoctor({
      locator: '/plugin',
      resolveEntry: async () => ({
        kind: 'packageRoot',
        locator: '/plugin',
        packageRoot: '/plugin',
        entryPath: '/plugin/src/index.ts',
      }),
      prepareDependencies: prepareDependencies as never,
      evaluate: evaluate as never,
    })).resolves.toMatchObject({ ok: true, pluginId: 'example.prepared' });
    expect(order).toEqual(['prepare', 'evaluate']);
    expect(prepareDependencies).toHaveBeenCalledWith({ projectRoot: '/plugin' });
  });
});
