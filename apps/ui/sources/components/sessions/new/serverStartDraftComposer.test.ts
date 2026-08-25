import { describe, expect, it, vi } from 'vitest';
import type { SessionServerStartSpawnDraftV1 } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';

import {
    composeSessionServerStartDraft,
    type SessionServerStartDraftPresentation,
} from './serverStartDraftComposer';

const serverStartDraft: SessionServerStartSpawnDraftV1 = {
    executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
    directory: '/workspace',
    agentTarget: {
        kind: 'agent',
        identity: { pluginId: 'happier.agent.claude', localId: 'claude' },
    },
};

const target = { serverId: 'server-1', machineId: 'machine-1' } as const;

function presentResolved(
    result: unknown | null,
): SessionServerStartDraftPresentation {
    return {
        result: Promise.resolve(result),
        close: vi.fn(),
    };
}

describe('Session server-start draft composer', () => {
    it('whitelists only safe seed fields and settles an exact no-invoke Session draft', async () => {
        const present = vi.fn(() => presentResolved(serverStartDraft));

        const outcome = await composeSessionServerStartDraft({
            draft: { directory: '/workspace', agentId: 'claude', permissionMode: 'default' },
            isCurrent: () => true,
            target,
            present,
        });

        expect(outcome).toEqual({ kind: 'submitted', draft: serverStartDraft });
        expect(present).toHaveBeenCalledWith(expect.objectContaining({
            seed: { directory: '/workspace', agentId: 'claude', permissionMode: 'default' },
        }));
    });

    it('refuses secret-bearing or arbitrary host drafts before presentation', async () => {
        const present = vi.fn(() => presentResolved(serverStartDraft));

        await expect(composeSessionServerStartDraft({
            draft: { directory: '/workspace', environmentVariables: { TOKEN: 'secret' } },
            isCurrent: () => true,
            target,
            present,
        })).resolves.toEqual({ kind: 'invalid', reason: 'draft_invalid' });
        expect(present).not.toHaveBeenCalled();
    });

    it('closes without settlement when cancellation arrives while the composer is open', async () => {
        const controller = new AbortController();
        let resolve!: (value: unknown | null) => void;
        const close = vi.fn();
        const present = vi.fn((): SessionServerStartDraftPresentation => ({
            result: new Promise((nextResolve) => { resolve = nextResolve; }),
            close,
        }));

        const composing = composeSessionServerStartDraft({
            isCurrent: () => true,
            signal: controller.signal,
            target,
            present,
        });
        controller.abort();
        resolve(serverStartDraft);

        await expect(composing).resolves.toEqual({ kind: 'unavailable', reason: 'aborted' });
        expect(close).toHaveBeenCalledTimes(1);
    });

    it('withholds a completed draft after the bound surface becomes stale', async () => {
        let current = true;
        let resolve!: (value: unknown | null) => void;
        const present = vi.fn((): SessionServerStartDraftPresentation => ({
            result: new Promise((nextResolve) => { resolve = nextResolve; }),
            close: vi.fn(),
        }));

        const composing = composeSessionServerStartDraft({ isCurrent: () => current, target, present });
        current = false;
        resolve(serverStartDraft);

        await expect(composing).resolves.toEqual({ kind: 'stale', reason: 'host_retired' });
    });

    it('never projects caller-owned creation identity or initial input into the settlement', async () => {
        const present = vi.fn(() => presentResolved({
            ...serverStartDraft,
            creationKey: 'forbidden',
            initialMessage: 'forbidden',
        }));

        await expect(composeSessionServerStartDraft({ isCurrent: () => true, target, present }))
            .resolves.toEqual({ kind: 'invalid', reason: 'settlement_invalid' });
    });

    it('rejects an over-bound settled draft instead of returning it to the host', async () => {
        const present = vi.fn(() => presentResolved({
            ...serverStartDraft,
            directory: 'x'.repeat(8_193),
        }));

        await expect(composeSessionServerStartDraft({ isCurrent: () => true, target, present }))
            .resolves.toEqual({ kind: 'unavailable', reason: 'draft_too_large' });
    });

    it('never lets the composer change the host-stamped server or machine target', async () => {
        const present = vi.fn(() => presentResolved({
            ...serverStartDraft,
            executionTarget: { serverId: 'server-2', machineId: 'machine-1' },
        }));

        await expect(composeSessionServerStartDraft({ isCurrent: () => true, target, present }))
            .resolves.toEqual({ kind: 'invalid', reason: 'settlement_invalid' });
    });

    /**
     * The caller resolved WHERE the work is, not only what it is called.
     *
     * A plugin that has already joined an item to a checkout knows the machine
     * that checkout is on. Before this, only the path travelled and the machine
     * was always the surface's own — so a directory resolved on one machine was
     * paired with an execution target on another, and the Session started in a
     * path that does not exist there. The seed names the machine, and the draft
     * is composed and validated against it.
     */
    it('composes against a machine the seed names, within the host-stamped server', async () => {
        const onMachineTwo = {
            ...serverStartDraft,
            executionTarget: { serverId: 'server-1', machineId: 'machine-2' },
        };
        const present = vi.fn(() => presentResolved(onMachineTwo));

        const outcome = await composeSessionServerStartDraft({
            draft: {
                profileId: 'profile-repair',
                executionTarget: { serverId: 'server-1', machineId: 'machine-2' },
                directory: '/checkouts/api',
                checkoutIntent: 'reuseWorkspace',
                candidates: [{
                    projectKey: { id: 'project-api' },
                    serverId: 'server-1',
                    machineId: 'machine-2',
                    rootPath: '/checkouts/api',
                    reachable: true,
                    worktrees: [],
                }],
            },
            isCurrent: () => true,
            target,
            present,
        });

        expect(outcome).toEqual({ kind: 'submitted', draft: onMachineTwo });
        // The presentation is told which machine it is authoring for, so its
        // directory picker, readiness and Agent catalogue are that machine's.
        expect(present).toHaveBeenCalledWith({
            seed: {
                profileId: 'profile-repair',
                directory: '/checkouts/api',
                checkoutIntent: 'reuseWorkspace',
                candidates: [{
                    projectKey: { id: 'project-api' },
                    serverId: 'server-1',
                    machineId: 'machine-2',
                    rootPath: '/checkouts/api',
                    reachable: true,
                    worktrees: [],
                }],
            },
            target: { serverId: 'server-1', machineId: 'machine-2' },
        });
    });

    /**
     * The seed moves the MACHINE, never the server. A server is the account
     * boundary the host stamped, and a settlement that left it is refused
     * exactly as before.
     */
    it('settles on the exact server-scoped candidate the reader selected', async () => {
        const selectedDraft = {
            ...serverStartDraft,
            executionTarget: { serverId: 'server-2', machineId: 'machine-1' },
            directory: '/server-two/api',
        };
        const present = vi.fn(() => presentResolved(selectedDraft));

        await expect(composeSessionServerStartDraft({
            draft: {
                checkoutIntent: 'ask',
                candidates: [{
                    projectKey: { id: 'server-two-api' },
                    serverId: 'server-2',
                    machineId: 'machine-1',
                    rootPath: '/server-two/api',
                    reachable: true,
                    worktrees: [],
                }],
            },
            isCurrent: () => true,
            target,
            present,
        })).resolves.toEqual({ kind: 'submitted', draft: selectedDraft });
        expect(present).toHaveBeenCalledWith(expect.objectContaining({
            seed: expect.objectContaining({
                candidates: [expect.objectContaining({
                    serverId: 'server-2',
                    machineId: 'machine-1',
                    rootPath: '/server-two/api',
                })],
            }),
        }));
    });

    it('honours a complete fixed placement on another server', async () => {
        const fixedDraft = {
            ...serverStartDraft,
            executionTarget: { serverId: 'server-2', machineId: 'machine-1' },
        };
        const present = vi.fn(() => presentResolved(fixedDraft));

        await expect(composeSessionServerStartDraft({
            draft: {
                directory: '/workspace',
                executionTarget: { serverId: 'server-2', machineId: 'machine-1' },
                checkoutIntent: 'reuseWorkspace',
            },
            isCurrent: () => true,
            target,
            present,
        })).resolves.toEqual({ kind: 'submitted', draft: fixedDraft });
        expect(present).toHaveBeenCalledWith(expect.objectContaining({
            target: { serverId: 'server-2', machineId: 'machine-1' },
        }));
    });

    it('rejects a machine-only placement that lost its server identity', async () => {
        const present = vi.fn(() => presentResolved(serverStartDraft));

        await expect(composeSessionServerStartDraft({
            draft: { machineId: 'machine-2', directory: '/workspace' },
            isCurrent: () => true,
            target,
            present,
        })).resolves.toEqual({ kind: 'invalid', reason: 'draft_invalid' });
        expect(present).not.toHaveBeenCalled();
    });

    /**
     * The settlement is checked against the machine actually composed for. A
     * seed that named `machine-2` and came back on `machine-1` is the same
     * mismatch the host-stamped case has always refused.
     */
    it('refuses a settlement that left the machine the seed named', async () => {
        const present = vi.fn(() => presentResolved(serverStartDraft));

        await expect(composeSessionServerStartDraft({
            draft: {
                executionTarget: { serverId: 'server-1', machineId: 'machine-2' },
                checkoutIntent: 'reuseWorkspace',
            },
            isCurrent: () => true,
            target,
            present,
        })).resolves.toEqual({ kind: 'invalid', reason: 'settlement_invalid' });
    });
});
