import { describe, expect, it } from 'vitest';

import { createGitScmBackendRuntimeRegistration } from './backend.js';

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
});
