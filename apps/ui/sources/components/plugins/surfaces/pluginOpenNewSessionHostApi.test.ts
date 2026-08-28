import { describe, expect, it, vi } from 'vitest';

import { createPluginOpenNewSessionHostApiHandler } from './pluginOpenNewSessionHostApi';

const accountLifetime = Object.freeze({
    scope: Object.freeze({ serverId: 'server-a', accountId: 'account-a' }),
    isCurrent: () => true,
    onRetire: () => Object.freeze({ dispose() {} }),
});

function request(payload: unknown) {
    return {
        method: 'openNewSession' as const,
        payload,
        requestId: 'request-1',
    };
}

const operation = {
    point: { pointId: 'triage-sources', protocol: { id: 'triage-sources', version: 1 } },
    contributor: {
        pluginId: 'happier.scm.github',
        contributionId: 'github',
        immutableGenerationId: 'github-generation-1',
    },
    role: 'prepareReviewWorkspace',
    action: { pluginId: 'happier.scm.github', localId: 'prepare-review-workspace' },
} as const;

const selected = {
    kind: 'submitted' as const,
    action: operation.action,
    input: { repository: 'happier-dev/happier' },
    selection: {
        target: { pluginId: 'happier.triage', immutableGenerationId: 'triage-generation-1' },
        point: operation.point,
        contributor: operation.contributor,
    },
    connectedAccount: { kind: 'none' as const },
};

const executeSelectedOperation = vi.fn(async () => ({
    kind: 'prepared',
    repositoryPath: '/workspaces/happier-review',
} as const));

describe('openNewSession Host API producer', () => {
    it('attributes the exact plugin and Account scope and settles with JSON null', async () => {
        const openNewSession = vi.fn(async () => ({ kind: 'opened' as const, dataId: 'handoff-1' }));
        const handler = createPluginOpenNewSessionHostApiHandler({
            pluginId: 'happier.triage',
            accountLifetime,
            isCurrent: () => true,
            executeSelectedOperation,
            openNewSession,
        });

        await expect(handler(request({ prompt: 'Repair CI' }))).resolves.toBeNull();
        expect(openNewSession).toHaveBeenCalledWith(expect.objectContaining({
            seed: { prompt: 'Repair CI' },
            pluginId: 'happier.triage',
            scope: accountLifetime.scope,
        }));
    });

    it('materializes the exact selected operation before opening on its exact machine', async () => {
        const openNewSession = vi.fn(async () => ({ kind: 'opened' as const, dataId: 'handoff-1' }));
        const handler = createPluginOpenNewSessionHostApiHandler({
            pluginId: 'happier.triage',
            accountLifetime,
            isCurrent: () => true,
            executionTarget: { serverId: 'server-a', machineId: 'machine-a' },
            executeSelectedOperation,
            openNewSession,
        });

        await expect(handler(
            request({ checkoutIntent: 'preparedReviewWorkspace', prompt: 'Review this' }),
            { targetedOperation: operation, selectedActionInput: selected },
        )).resolves.toBeNull();
        expect(executeSelectedOperation).toHaveBeenCalledWith(
            expect.objectContaining({
                method: 'executeAction',
                payload: { action: operation.action, input: selected.input },
            }),
            expect.objectContaining({
                targetedOperation: operation,
                selectedActionInput: selected,
            }),
        );
        expect(openNewSession).toHaveBeenCalledWith(expect.objectContaining({
            seed: {
                checkoutIntent: 'reuseWorkspace',
                prompt: 'Review this',
                placement: {
                    serverId: 'server-a',
                    machineId: 'machine-a',
                    directory: '/workspaces/happier-review',
                },
            },
        }));
    });

    it('refuses retired, malformed, stale-target, failed and cancelled preparation before navigation', async () => {
        const openNewSession = vi.fn(async () => ({ kind: 'opened' as const, dataId: 'handoff-1' }));
        const stale = createPluginOpenNewSessionHostApiHandler({
            pluginId: 'happier.triage',
            accountLifetime: { ...accountLifetime, isCurrent: () => false },
            isCurrent: () => true,
            executeSelectedOperation,
            openNewSession,
        });
        await expect(stale(request({ prompt: 'Repair CI' }))).resolves.toEqual({
            code: 'stale_surface',
            diagnostics: ['open_new_session_aborted'],
        });

        const handler = createPluginOpenNewSessionHostApiHandler({
            pluginId: 'happier.triage',
            accountLifetime,
            isCurrent: () => true,
            executionTarget: { serverId: 'server-a', machineId: 'machine-a' },
            executeSelectedOperation,
            openNewSession,
        });
        await expect(handler(request({ prompt: { text: 'old', mode: 'append' } }))).resolves.toEqual({
            code: 'invalid_payload',
            diagnostics: ['open_new_session_request_invalid'],
        });
        await expect(handler(request({
            checkoutIntent: 'preparedReviewWorkspace',
            placement: { machineId: 'machine-b' },
        }), { targetedOperation: operation, selectedActionInput: selected })).resolves.toEqual({
            code: 'invalid_payload',
            diagnostics: ['prepared_review_workspace_selection_invalid'],
        });
        expect(openNewSession).not.toHaveBeenCalled();

        const failed = createPluginOpenNewSessionHostApiHandler({
            pluginId: 'happier.triage',
            accountLifetime,
            isCurrent: () => true,
            executionTarget: { serverId: 'server-a', machineId: 'machine-a' },
            executeSelectedOperation: async () => ({ kind: 'workspaceMismatch' }),
            openNewSession,
        });
        await expect(failed(
            request({ checkoutIntent: 'preparedReviewWorkspace' }),
            { targetedOperation: operation, selectedActionInput: selected },
        )).resolves.toEqual({
            code: 'unavailable',
            diagnostics: ['prepared_review_workspace_unavailable'],
        });
        expect(openNewSession).not.toHaveBeenCalled();

        const controller = new AbortController();
        const cancelled = createPluginOpenNewSessionHostApiHandler({
            pluginId: 'happier.triage',
            accountLifetime,
            isCurrent: () => true,
            executionTarget: { serverId: 'server-a', machineId: 'machine-a' },
            executeSelectedOperation: async () => {
                controller.abort();
                return { kind: 'prepared', repositoryPath: '/workspaces/late' };
            },
            openNewSession,
        });
        await expect(cancelled(
            request({ checkoutIntent: 'preparedReviewWorkspace' }),
            { signal: controller.signal, targetedOperation: operation, selectedActionInput: selected },
        )).resolves.toEqual({
            code: 'unavailable',
            diagnostics: ['open_new_session_aborted'],
        });
        expect(openNewSession).not.toHaveBeenCalled();
    });
});
