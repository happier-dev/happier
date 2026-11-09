import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionDraftDocumentV2 } from '@happier-dev/protocol/drafts/sessionDraftsV2';

const custody = vi.hoisted(() => ({
    removeLaunch: vi.fn(async () => undefined),
    removeKey: vi.fn(async () => undefined),
    list: vi.fn(async () => [] as string[]),
    forget: vi.fn(async () => undefined),
}));

vi.mock('./runnerCreatorLaunchCustody', () => ({
    removeRunnerCreatorLaunchCustody: custody.removeLaunch,
    listRunnerCreatorCustodyActivationIds: custody.list,
    forgetRunnerCreatorCustodyActivation: custody.forget,
}));
vi.mock('./runnerActivationKeyCustody', () => ({
    removeRunnerActivationKeyCustodyByActivationId: custody.removeKey,
}));

import {
    removeRunnerCreatorCustodyForAccount,
    removeRunnerCreatorCustodyForRemovedDraft,
} from './runnerCreatorDraftRemoval';

const scope = { serverId: 'home-a', accountId: 'account-a' } as const;

function document(activationId?: string): SessionDraftDocumentV2 {
    return {
        v: 2,
        composer: {
            text: { mutationId: 'text', value: 'Run it' },
            mentions: { mutationId: 'mentions', value: [] },
            attachments: { mutationId: 'attachments', value: [] },
        },
        target: {
            kind: 'newSession',
            authoring: {
                executionTarget: {
                    mutationId: 'target',
                    value: {
                        kind: 'temporary_computer',
                        serverId: scope.serverId,
                        artifactTarget: 'linux-x64',
                        workspace: { kind: 'choose_on_endpoint' },
                    },
                },
                ...(activationId ? {
                    temporaryComputerActivationRef: {
                        mutationId: 'activation',
                        value: { v: 1, activationId, createdOnDeviceLabel: 'This device' },
                    },
                } : {}),
            },
        },
        extensions: {},
    };
}

describe('removed Runner draft creator custody', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        custody.removeLaunch.mockResolvedValue(undefined);
        custody.removeKey.mockResolvedValue(undefined);
        custody.list.mockResolvedValue([]);
        custody.forget.mockResolvedValue(undefined);
    });

    it('clears both exact device-local custody owners after authoritative draft removal', async () => {
        const activationId = '00000000-0000-4000-8000-000000000099';
        await removeRunnerCreatorCustodyForRemovedDraft({ scope, document: document(activationId) });
        expect(custody.removeLaunch).toHaveBeenCalledWith(scope, activationId);
        expect(custody.removeKey).toHaveBeenCalledWith(scope, activationId);
        expect(custody.forget).toHaveBeenCalledWith(scope, activationId);
    });

    it('does not infer custody for a temporary target without a synchronized public reference', async () => {
        await removeRunnerCreatorCustodyForRemovedDraft({ scope, document: document() });
        expect(custody.removeLaunch).not.toHaveBeenCalled();
        expect(custody.removeKey).not.toHaveBeenCalled();
    });

    it('enumerates and removes every exact Account/Home activation while leaving other scopes to their own index', async () => {
        const first = '00000000-0000-4000-8000-000000000091';
        const second = '00000000-0000-4000-8000-000000000092';
        custody.list.mockResolvedValueOnce([first, second]);

        await removeRunnerCreatorCustodyForAccount(scope);

        expect(custody.list).toHaveBeenCalledWith(scope);
        expect(custody.removeLaunch.mock.calls).toEqual([[scope, first], [scope, second]]);
        expect(custody.removeKey.mock.calls).toEqual([[scope, first], [scope, second]]);
        expect(custody.forget.mock.calls).toEqual([[scope, first], [scope, second]]);
    });

    it('retains the indexed activation when exact byte removal fails so Account deletion can retry', async () => {
        const activationId = '00000000-0000-4000-8000-000000000093';
        custody.list.mockResolvedValueOnce([activationId]);
        custody.removeLaunch.mockRejectedValueOnce(new Error('file busy'));

        await expect(removeRunnerCreatorCustodyForAccount(scope)).rejects.toThrow('file busy');
        expect(custody.removeKey).not.toHaveBeenCalled();
        expect(custody.forget).not.toHaveBeenCalled();
    });
});
