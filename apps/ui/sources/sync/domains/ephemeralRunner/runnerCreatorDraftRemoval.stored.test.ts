import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionDraftDocumentV2 } from '@happier-dev/protocol/drafts/sessionDraftsV2';

import { createRunnerActivationKeyCustody, readRunnerActivationSigningKey } from './runnerActivationKeyCustody';
import { removeRunnerCreatorCustodyForRemovedDraft } from './runnerCreatorDraftRemoval';

describe('retained removed Runner draft', () => {
    afterEach(() => vi.unstubAllGlobals());

    it('removes exact retained activation custody even when another draft field prevents whole-document projection', async () => {
        const values = new Map<string, string>();
        vi.stubGlobal('window', { localStorage: {
            getItem: (key: string) => values.get(key) ?? null,
            setItem: (key: string, value: string) => { values.set(key, value); },
            removeItem: (key: string) => { values.delete(key); },
        } });
        const scope = { serverId: 'home-a', accountId: 'account-a' };
        const custody = await createRunnerActivationKeyCustody(scope);
        const retainedRef = {
            v: 1, activationId: custody.activationId, createdOnDeviceLabel: 'This device', retired: true,
        };
        const retained = {
            v: 2,
            composer: {
                text: { mutationId: 'text', value: '' },
                mentions: { mutationId: 'mentions', value: [] },
                attachments: { mutationId: 'attachments', value: [] },
            },
            target: { kind: 'newSession', authoring: {
                executionTarget: { mutationId: 'target', value: { kind: 'unsupported' } },
                temporaryComputerActivationRef: { mutationId: 'activation', value: retainedRef },
            } },
            extensions: {},
        } satisfies SessionDraftDocumentV2;
        await removeRunnerCreatorCustodyForRemovedDraft({ scope, document: {
            ...retained, target: { ...retained.target, authoring: {
                ...retained.target.authoring,
                temporaryComputerActivationRef: { mutationId: 'invalid', value: { ...retainedRef, activationId: 'invalid' } },
            } },
        } });
        await expect(readRunnerActivationSigningKey(scope, custody)).resolves.toEqual(expect.any(String));
        await removeRunnerCreatorCustodyForRemovedDraft({ scope, document: retained });
        const removal = await readRunnerActivationSigningKey(scope, custody).then(
            () => 'retained',
            (error: unknown) => error instanceof Error && 'code' in error ? error.code : null,
        );
        expect(removal).toBe('runner_activation_key_unavailable');
    });
});
