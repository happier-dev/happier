import { describe, expect, it } from 'vitest';

import { ScmBackendContributionSchema } from './scmBackends.js';

describe('plugin SDK SCM backend manifest surface', () => {
    it('re-exports the protocol SCM backend contribution schema for authoring', () => {
        expect(ScmBackendContributionSchema.safeParse({
            id: 'acme-vcs',
            displayName: 'Acme VCS',
            repoModes: ['.git'],
            detection: { rootMarkers: ['.acme'] },
            capabilities: {
                detection: {
                    repository: { support: 'supported' },
                    repoIdentity: { support: 'unsupported', reason: 'not_implemented' },
                    ignoredPath: { support: 'unsupported', reason: 'not_implemented' },
                    repoMode: { support: 'supported' },
                    executable: { support: 'supported' },
                },
                read: {
                    status: { support: 'supported' },
                    diffFile: { support: 'unsupported', reason: 'not_implemented' },
                    diffCommit: { support: 'unsupported', reason: 'not_implemented' },
                    log: { support: 'unsupported', reason: 'not_implemented' },
                    branches: { support: 'unsupported', reason: 'not_implemented' },
                    stash: { support: 'unsupported', reason: 'not_implemented' },
                    defaultBranch: { support: 'unsupported', reason: 'not_implemented' },
                    hostingProvider: { support: 'unsupported', reason: 'not_implemented' },
                    pullRequestStatus: { support: 'unsupported', reason: 'not_implemented' },
                },
                changeSet: {
                    model: 'working-copy',
                    diffAreas: ['pending'],
                    include: { support: 'unsupported', reason: 'not_implemented' },
                    exclude: { support: 'unsupported', reason: 'not_implemented' },
                    discard: { support: 'unsupported', reason: 'not_implemented' },
                },
                commit: {},
                remote: {},
                branch: {},
                worktree: {},
                lifecycle: {},
                hosting: {},
                checkpoints: {},
                workspaceIntegration: {},
                tooling: {
                    systemCliResolution: { support: 'supported' },
                    managedCliResolution: { support: 'supported' },
                    binarySafe: { support: 'supported' },
                },
                freshness: {},
            },
        }).success).toBe(true);
    });
});
