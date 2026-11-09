import { afterEach, describe, expect, it } from 'vitest';

import { act, createRenderCommitCounter, renderHook, useRenderCommitCounter } from '@/dev/testkit';
import {
    configureSessionDraftRepository, resetSessionDraftRepositoryForTests, writeNewSessionDraft,
    type NewSessionDraftProjection,
} from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import {
    projectMaterializedTemporaryComputerRecoveryCandidates,
    useMaterializedTemporaryComputerRecoveryCandidates,
} from './useMaterializedTemporaryComputerSessionRecovery';

const mutationId = '00000000-0000-4000-8000-000000000010';

function draftWithActivation(value: unknown, launchUserAttemptId?: string, draftId = 'draft-a'): NewSessionDraftProjection {
    return {
        draftId,
        document: {
            v: 2,
            composer: null,
            target: {
                kind: 'newSession',
                authoring: {
                    temporaryComputerActivationRef: { mutationId, value },
                },
            },
            extensions: {},
        },
        readView: null,
        status: 'clean',
        conflict: null,
        createdAt: 1,
        updatedAt: 2,
        localSupplement: launchUserAttemptId ? { launchUserAttemptId } : {},
    };
}

describe('projectMaterializedTemporaryComputerRecoveryCandidates', () => {
    it('projects only valid synchronized activation references and preserves the crash-stable launch identity', () => {
        const valid = draftWithActivation({
            v: 1,
            activationId: '00000000-0000-4000-8000-000000000001',
            createdOnDeviceLabel: 'MacBook',
            retainedFutureMetadata: true,
        }, 'attempt-a');
        const malformed = draftWithActivation({ v: 1, activationId: 'not-an-activation' }, undefined, 'draft-b');
        expect(projectMaterializedTemporaryComputerRecoveryCandidates([valid, malformed])).toEqual([{
            draftId: 'draft-a',
            activationId: '00000000-0000-4000-8000-000000000001',
            launchUserAttemptId: 'attempt-a',
        }]);
    });
});

describe('useMaterializedTemporaryComputerRecoveryCandidates', () => {
    afterEach(() => resetSessionDraftRepositoryForTests());

    it('does not render its Session host for new Session draft edits that leave the candidates unchanged', async () => {
        resetSessionDraftRepositoryForTests();
        configureSessionDraftRepository({ syncEnabled: false });
        const scope = { serverId: 'home-a', accountId: 'account-a' };
        const activationId = '00000000-0000-4000-8000-000000000001';
        writeNewSessionDraft({ scope, draftId: 'draft-runner', materializationIntent: 'userEdit', patch: {
            text: 'run it',
            authoring: { temporaryComputerActivationRef: { v: 1, activationId, createdOnDeviceLabel: 'This device' } },
        } });
        const counter = createRenderCommitCounter();
        const hook = await renderHook(() => {
            useRenderCommitCounter(counter);
            return useMaterializedTemporaryComputerRecoveryCandidates(scope);
        });
        const candidates = hook.getCurrent();
        expect(candidates).toEqual([{ draftId: 'draft-runner', activationId, launchUserAttemptId: null }]);
        counter.reset();
        // Another device types in an ordinary new Session draft: the list republishes per edit.
        const text = 'another draft';
        for (let index = 1; index <= text.length; index++) {
            await act(async () => {
                writeNewSessionDraft({ scope, draftId: 'draft-other', materializationIntent: 'userEdit', patch: { text: text.slice(0, index) } });
            });
        }
        expect(counter.read()).toEqual({ renders: 0, commits: 0 });
        expect(hook.getCurrent()).toBe(candidates);
        // A real candidate change still reaches the host.
        const second = '00000000-0000-4000-8000-000000000002';
        await act(async () => {
            writeNewSessionDraft({ scope, draftId: 'draft-other', materializationIntent: 'userEdit', patch: {
                authoring: { temporaryComputerActivationRef: { v: 1, activationId: second, createdOnDeviceLabel: 'This device' } },
            } });
        });
        expect(hook.getCurrent()?.map((candidate) => candidate.activationId).sort()).toEqual([activationId, second]);
        expect(counter.read().renders).toBe(1);
        await hook.unmount();
    });
});
