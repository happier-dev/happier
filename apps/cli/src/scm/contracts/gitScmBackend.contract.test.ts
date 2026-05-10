import { describe } from 'vitest';

import { resolveDefaultScmBackendRegistry } from '../scmBackendCatalog';
import { runScmBackendContractSuite } from './scmBackendContractHarness';

describe('git SCM backend contract', () => {
    runScmBackendContractSuite({
        createBackend: async () => {
            const backend = (await resolveDefaultScmBackendRegistry())
                .listBackends()
                .find((candidate) => candidate.id === 'git');
            if (!backend) throw new Error('Git backend is not registered');
            return backend;
        },
        executable: 'git',
        repoMode: '.git',
        supportsExecutableMissingDiagnostic: true,
    });
});
