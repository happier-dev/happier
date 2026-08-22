import { describe, expect, it, vi } from 'vitest';

import { runPluginDevelopmentCycle } from './developmentCycle';

const codeObservation = (changedPaths: readonly string[] | undefined = undefined) => ({
  ok: true as const,
  sourceKind: 'packageRoot' as const,
  authoringKind: 'code' as const,
  sourceRootPath: '/author/source',
  request: {
    kind: 'development' as const,
    pluginId: 'acme.author',
    projectRoot: '/author/source',
    ...(changedPaths === undefined ? {} : { changedPaths }),
  },
  developmentEntryPath: '/author/source/src/index.ts',
  observedRelativePaths: ['package.json', 'src/index.ts'],
  declaredDependencies: { '@happier-dev/plugin-sdk': '0.0.0' },
  observedDirectoryPaths: ['/author/source', '/author/source/src'],
});

describe('runPluginDevelopmentCycle', () => {
  it('submits one captured batch without CLI dependency or UI preparation', async () => {
    const submit = vi.fn(async () => ({ accepted: true as const }));

    const result = await runPluginDevelopmentCycle({
      observation: codeObservation(['package.json', 'src/ui/surface.tsx']),
      submit,
    });

    expect(result).toMatchObject({
      kind: 'submitted',
      dependencyInputChanged: true,
      dependencyInputChangeUnknown: false,
      changedPathCount: 2,
      submission: { accepted: true },
    });
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledWith({
      kind: 'development',
      pluginId: 'acme.author',
      projectRoot: '/author/source',
      changedPaths: ['package.json', 'src/ui/surface.tsx'],
    });
  });

  it('reports source-only batches without pretending an unobserved dependency change occurred', async () => {
    const submit = vi.fn(async () => ({ accepted: true as const }));

    await expect(runPluginDevelopmentCycle({
      observation: codeObservation(['src/index.ts']),
      submit,
    })).resolves.toMatchObject({
      kind: 'submitted',
      dependencyInputChanged: false,
      dependencyInputChangeUnknown: false,
      changedPathCount: 1,
    });

    expect(submit).toHaveBeenCalledWith(expect.objectContaining({
      changedPaths: ['src/index.ts'],
    }));
  });

  it('marks an explicit reload dependency state as unknown while submitting its original request', async () => {
    const submit = vi.fn(async () => ({ accepted: true as const }));

    await expect(runPluginDevelopmentCycle({
      observation: codeObservation(),
      submit,
    })).resolves.toMatchObject({
      kind: 'submitted',
      dependencyInputChanged: false,
      dependencyInputChangeUnknown: true,
      changedPathCount: null,
    });

    expect(submit).toHaveBeenCalledWith({
      kind: 'development',
      pluginId: 'acme.author',
      projectRoot: '/author/source',
    });
  });

  it('does not submit when cancelled before the captured batch reaches the daemon', async () => {
    const controller = new AbortController();
    controller.abort();
    const submit = vi.fn();

    await expect(runPluginDevelopmentCycle({
      observation: codeObservation(['src/index.ts']),
      submit,
      signal: controller.signal,
    })).resolves.toMatchObject({ kind: 'cancelled' });

    expect(submit).not.toHaveBeenCalled();
  });

  it('reports only a transport submission failure and leaves candidate ownership to the daemon', async () => {
    const submit = vi.fn(async () => {
      throw new Error('daemon transport closed');
    });

    await expect(runPluginDevelopmentCycle({
      observation: codeObservation(['src/index.ts']),
      submit,
    })).resolves.toMatchObject({
      kind: 'submissionFailed',
      diagnostics: [{
        code: 'plugin_dev_candidate_request_failed',
        message: expect.stringContaining('daemon transport closed'),
      }],
    });
  });
});
