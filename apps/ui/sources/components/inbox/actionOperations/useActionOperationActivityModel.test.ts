import { describe, expect, it } from 'vitest';

import { resolveActionOperationContext, resolveActionOperationSessionFolderById, resolveActionOperationSessionNameById } from './useActionOperationActivityModel';

describe('resolveActionOperationSessionNameById', () => {
    it('uses a renderable title when the source session is not in the full-session cache', () => {
        const result = resolveActionOperationSessionNameById([], [{
            id: 'session-1',
            metadata: {
                path: '/workspace/remote-dev',
                host: 'workstation',
                summary: { text: 'Stabilize CI and Nightly Releases', updatedAt: 123 },
            },
        }]);

        expect(result.get('session-1')).toBe('Stabilize CI and Nightly Releases');
    });

    it('prefers an explicit renderable title over a full-session path fallback', () => {
        const result = resolveActionOperationSessionNameById(
            [{ id: 'session-1', metadata: { path: '/workspace/remote-dev', host: 'workstation' } }],
            [{
                id: 'session-1',
                metadata: {
                    path: '/workspace/remote-dev',
                    host: 'workstation',
                    summary: { text: 'Canonical session title', updatedAt: 123 },
                },
            }],
        );

        expect(result.get('session-1')).toBe('Canonical session title');
    });
});

describe('resolveActionOperationContext', () => {
    const spawnOperation = {
        version: 1,
        operationId: 'op-1',
        revision: 3,
        actionId: 'session.spawn_new',
        state: 'succeeded',
        scope: { accountId: 'account-1', machineId: 'machine-1' },
        title: 'Create session',
        createdAt: 1,
        startedAt: 2,
        settledAt: 3,
        result: { sessionId: 'session-9' },
        cancellation: 'unsupported',
    } as const;

    it('names the created session together with its machine', () => {
        expect(resolveActionOperationContext(
            spawnOperation,
            new Map([['session-9', 'Fix login bug']]),
            new Map([['session-9', 'login-service']]),
            'build-host',
        )).toBe('Fix login bug · login-service · build-host');
    });

    it('falls back to the machine when the created session is unknown', () => {
        expect(resolveActionOperationContext(spawnOperation, new Map(), new Map(), 'build-host')).toBe('build-host');
    });

    it('keeps session-scoped operations labelled by their session alone', () => {
        expect(resolveActionOperationContext(
            { ...spawnOperation, actionId: 'session.fork', scope: { ...spawnOperation.scope, sessionId: 'session-1' } },
            new Map([['session-1', 'Source session']]),
            new Map([['session-1', 'login-service']]),
            'build-host',
        )).toBe('Source session');
    });
});

describe('resolveActionOperationSessionFolderById', () => {
    it('maps each session to the last segment of its project path', () => {
        const result = resolveActionOperationSessionFolderById([
            { id: 'session-1', metadata: { path: '/workspace/login-service', host: 'workstation' } },
        ]);

        expect(result.get('session-1')).toBe('login-service');
    });
});
