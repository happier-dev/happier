import { describe, expect, it } from 'vitest';

import {
    buildCodexAppServerLegacyPermissionParams,
    buildCodexAppServerPermissionsParams,
} from './permissionProfile';

describe('permissionProfile', () => {
    it('maps Happier read-only mode to the Codex built-in read-only permission profile', () => {
        expect(buildCodexAppServerPermissionsParams({ permissionMode: 'read-only', directory: '/repo', target: 'turn' })).toEqual({
            permissions: ':read-only',
            approvalPolicy: 'never',
        });
    });

    it.each(['acceptEdits', 'safe-yolo', 'plan'] as const)('preserves workspace network and writable roots for %s through legacy policy fields', (permissionMode) => {
        expect(buildCodexAppServerPermissionsParams({ permissionMode, directory: '/repo', target: 'turn' })).toEqual({
            sandboxPolicy: {
                type: 'workspaceWrite',
                writableRoots: ['/repo'],
                readOnlyAccess: { type: 'fullAccess' },
                networkAccess: true,
                excludeTmpdirEnvVar: false,
                excludeSlashTmp: false,
            },
            approvalPolicy: { granular: expect.objectContaining({ sandbox_approval: true, request_permissions: true }) },
            approvalsReviewer: permissionMode === 'plan' ? 'user' : 'auto_review',
        });
    });

    it('maps bypass modes to the Codex full-access profile', () => {
        expect(buildCodexAppServerPermissionsParams({ permissionMode: 'yolo', directory: '/repo', target: 'turn' })).toEqual({
            permissions: ':danger-full-access',
            approvalPolicy: 'never',
        });
        expect(buildCodexAppServerPermissionsParams({ permissionMode: 'bypassPermissions', directory: '/repo', target: 'turn' })).toEqual({
            permissions: ':danger-full-access',
            approvalPolicy: 'never',
        });
    });

    it('omits native permission profile params for default mode', () => {
        expect(buildCodexAppServerPermissionsParams({ permissionMode: 'default', directory: '/repo', target: 'turn' })).toEqual({});
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
