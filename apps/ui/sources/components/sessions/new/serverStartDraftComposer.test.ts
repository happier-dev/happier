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
});
