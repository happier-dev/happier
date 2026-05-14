import { describe, expect, it } from 'vitest';

import { createGitScmBackendRuntimeRegistration } from './backend.js';
import { GIT_SCM_BACKEND_CAPABILITIES } from './capabilities.js';
import { GIT_SCM_BACKEND_CONTRIBUTION } from './manifest.js';

describe('git SCM backend runtime registration', () => {
    it('registers Git executable leaves through the plugin backend ABI', () => {
        const registration = createGitScmBackendRuntimeRegistration();

        expect(registration.id).toBe('git');
        expect(registration.handlers).toEqual(expect.objectContaining({
            detection: expect.objectContaining({
                detectRepo: expect.any(Function),
                describeBackend: expect.any(Function),
            }),
            read: expect.objectContaining({
                statusSnapshot: expect.any(Function),
                worktreesEnrichment: expect.any(Function),
                diffFile: expect.any(Function),
                diffCommit: expect.any(Function),
                logList: expect.any(Function),
            }),
            branch: expect.objectContaining({
                list: expect.any(Function),
                create: expect.any(Function),
                checkout: expect.any(Function),
            }),
            workspaceIntegration: expect.objectContaining({
                inspectWorkspaceLocation: expect.any(Function),
                realizeWorkspaceCheckout: expect.any(Function),
                createWorkspaceCheckout: expect.any(Function),
                materializeWorkspaceCheckout: expect.any(Function),
                resolveWorkspaceTransferEntries: expect.any(Function),
                resolveWorkspaceTransferMetadata: expect.any(Function),
                assertPortableWorkspaceEntries: expect.any(Function),
                classifyPortableWorkspacePath: expect.any(Function),
            }),
        }));
    });

    it('advertises repository publish-target reads when the handler is registered', () => {
        const registration = createGitScmBackendRuntimeRegistration();

        expect(registration.handlers.hosting?.repositoryDescribePublishTargets).toEqual(expect.any(Function));
        expect(GIT_SCM_BACKEND_CAPABILITIES.hosting.repositoryPublishTargets.support).toBe('supported');
    });

    it('does not advertise managed Git resolution when the installable has no managed fallback', () => {
        expect(GIT_SCM_BACKEND_CONTRIBUTION.tooling.managedFallback).toBe(false);
        expect(GIT_SCM_BACKEND_CAPABILITIES.tooling.managedCliResolution.support).toBe('unsupported');
    });
});
