import { describe } from 'vitest';

import { resolveDefaultScmBackendRegistry } from '../scmBackendCatalog';
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
    runScmBackendContractSuite({
        createBackend: async () => {
            const backend = (await resolveDefaultScmBackendRegistry())
                .listBackends()
                .find((candidate) => candidate.id === 'sapling');
            if (!backend) throw new Error('Sapling backend is not registered');
            return backend;
        },
        executable: 'sl',
        repoMode: '.sl',
        supportsExecutableMissingDiagnostic: true,
    });
});
