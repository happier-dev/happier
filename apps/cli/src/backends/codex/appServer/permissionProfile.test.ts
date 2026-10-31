import { describe, expect, it } from 'vitest';

import {
    buildCodexAppServerLegacyPermissionParams,
    buildCodexAppServerPermissionsParams,
} from './permissionProfile';

describe('permissionProfile', () => {
    it('maps Happier read-only mode to the Codex built-in read-only permission profile', () => {
        expect(buildCodexAppServerPermissionsParams({ permissionMode: 'read-only', directory: '/repo' })).toEqual({
            permissions: ':read-only',
            approvalPolicy: 'never',
        });
    });

    it('maps workspace write modes to the Codex workspace profile', () => {
        expect(buildCodexAppServerPermissionsParams({ permissionMode: 'acceptEdits', directory: '/repo' })).toEqual({
            permissions: ':workspace',
            approvalPolicy: { granular: expect.objectContaining({ sandbox_approval: true, request_permissions: true }) },
            approvalsReviewer: 'auto_review',
        });
        expect(buildCodexAppServerPermissionsParams({ permissionMode: 'safe-yolo', directory: '/repo' })).toEqual({
            permissions: ':workspace',
            approvalPolicy: { granular: expect.objectContaining({ sandbox_approval: true, request_permissions: true }) },
            approvalsReviewer: 'auto_review',
        });
    });

    it('maps bypass modes to the Codex full-access profile', () => {
        expect(buildCodexAppServerPermissionsParams({ permissionMode: 'yolo', directory: '/repo' })).toEqual({
            permissions: ':danger-full-access',
            approvalPolicy: 'never',
        });
        expect(buildCodexAppServerPermissionsParams({ permissionMode: 'bypassPermissions', directory: '/repo' })).toEqual({
            permissions: ':danger-full-access',
            approvalPolicy: 'never',
        });
    });

    it('omits native permission profile params for default mode', () => {
        expect(buildCodexAppServerPermissionsParams({ permissionMode: 'default', directory: '/repo' })).toEqual({});
    });

    it('keeps legacy thread and turn params separate from native permissions params', () => {
        expect(buildCodexAppServerLegacyPermissionParams({
            permissionMode: 'read-only',
            directory: '/repo',
            target: 'turn',
        })).toEqual({
            approvalPolicy: 'never',
            sandboxPolicy: {
                type: 'readOnly',
                access: { type: 'fullAccess' },
                networkAccess: false,
            },
        });

        expect(buildCodexAppServerLegacyPermissionParams({
            permissionMode: 'acceptEdits',
            directory: '/repo',
            target: 'thread',
        })).toEqual({
            approvalPolicy: {
                granular: expect.objectContaining({
                    mcp_elicitations: true,
                    request_permissions: true,
                    sandbox_approval: true,
                }),
            },
            approvalsReviewer: 'auto_review',
            sandbox: 'workspace-write',
        });

        expect(buildCodexAppServerLegacyPermissionParams({
            permissionMode: 'acceptEdits',
            directory: '/repo',
            target: 'thread',
            managedScalarFallback: true,
        })).toMatchObject({
            approvalPolicy: 'on-request',
            approvalsReviewer: 'user',
            sandbox: 'workspace-write',
        });
    });
});
