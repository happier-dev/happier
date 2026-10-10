import { afterAll, beforeAll, describe } from 'vitest';

import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';

import { resolveDefaultScmBackendRegistry } from '../scmBackendCatalog';
import type { ScmBackend } from '../types';
import { runScmBackendContractSuite } from './scmBackendContractHarness';

/**
 * Sapling-side execution of the shared SCM backend contract harness. Required by
 * SCM-BACKEND-CONTRACT-1 §3/§11 and SCM-SAPLING-AUDIT-1 §10a/§11 so the audited
 * Sapling backend exercises its advertised supported leaves through plugin
 * registration on a real `.sl` repository — proving the FD-0072 ABI works for a
 * deliberately limited backend, not just for Git.
 *
 * The harness reads the backend's grouped capability declarations and only runs
 * the leaves the backend advertises as supported. Sapling marks
 * branch/worktree/stash/PR/checkpoint/rollback as unsupported by design; the
 * harness asserts those leaves return typed unsupported results rather than
 * being silently skipped (truth-in-advertising guarantee).
 */
describe('sapling SCM backend contract', () => {
    let backend: ScmBackend | null = null;
    let runtimeFixture: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>> | null = null;

    beforeAll(async () => {
        runtimeFixture = await createAdmittedPluginRuntimeFixture();
        backend = (await resolveDefaultScmBackendRegistry({
            pluginRuntimeRegistry: runtimeFixture.registry,
        }))
            .listBackends()
            .find((candidate) => candidate.id === 'happier.scm.backend.sapling/sapling')
            ?? null;
        if (!backend) throw new Error('Sapling backend is not registered');
    });

    afterAll(async () => {
        await runtimeFixture?.dispose();
    });

    runScmBackendContractSuite({
        createBackend: async () => {
            if (!backend) throw new Error('Sapling backend is not registered');
            return backend;
        },
        executable: 'sl',
        repoMode: '.sl',
        supportsExecutableMissingDiagnostic: true,
    });
});
