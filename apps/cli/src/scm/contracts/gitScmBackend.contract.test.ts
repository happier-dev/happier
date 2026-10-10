import { afterAll, beforeAll, describe } from 'vitest';

import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';

import { resolveDefaultScmBackendRegistry } from '../scmBackendCatalog';
import { createPluginScmBackendRegistryFromRuntimeRegistry } from '../pluginBackends/runtimeRegistry';
import type { ScmBackend } from '../types';
import { runScmBackendContractSuite } from './scmBackendContractHarness';

describe('git SCM backend contract', () => {
    let backend: ScmBackend | null = null;
    let runtimeFixture: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>> | null = null;

    beforeAll(async () => {
        runtimeFixture = await createAdmittedPluginRuntimeFixture();
        backend = (await resolveDefaultScmBackendRegistry({
            pluginRuntimeRegistry: runtimeFixture.registry,
        }))
            .listBackends()
            .find((candidate) => candidate.id === 'happier.scm.backend.git/git')
            ?? null;
        if (!backend) {
            const catalog = createPluginScmBackendRegistryFromRuntimeRegistry(runtimeFixture.registry);
            const registrations = runtimeFixture.registry.scmBackendRegistrations
                ?? [...runtimeFixture.registry.scmBackendsById.values()];
            throw new Error(`Git backend is not registered: ${JSON.stringify({
                registeredIds: registrations.map((entry) => `${entry.pluginId}/${entry.registration.id}`),
                catalogIds: catalog.backends.map((candidate) => candidate.id),
                diagnostics: catalog.diagnostics,
            })}`);
        }
    });

    afterAll(async () => {
        await runtimeFixture?.dispose();
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
