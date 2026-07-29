import { afterAll, beforeAll, describe } from 'vitest';

import { resolveExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';

import { resolveDefaultScmBackendRegistry } from '../scmBackendCatalog';
import type { ScmBackend } from '../types';
import { runScmBackendContractSuite } from './scmBackendContractHarness';

describe('git SCM backend contract', () => {
    let backend: ScmBackend | null = null;
    let runtimeRegistry: Awaited<ReturnType<typeof resolveExecutablePluginRuntimeRegistry>> | null = null;

    beforeAll(async () => {
        runtimeRegistry = await resolveExecutablePluginRuntimeRegistry({
            pluginIds: ['happier.scm.backend.git'],
        });
        backend = (await resolveDefaultScmBackendRegistry({
            pluginRuntimeRegistry: runtimeRegistry,
        }))
            .listBackends()
            .find((candidate) => candidate.id === 'happier.scm.backend.git/git')
            ?? null;
        if (!backend) throw new Error('Git backend is not registered');
    });

    afterAll(async () => {
        await runtimeRegistry?.dispose();
    });

    runScmBackendContractSuite({
        createBackend: async () => {
            if (!backend) throw new Error('Git backend is not registered');
            return backend;
        },
        executable: 'git',
        repoMode: '.git',
        supportsExecutableMissingDiagnostic: true,
    });
});
