import { describe, expect, it } from 'vitest';
import { NewSessionDraftDocumentV2Schema } from '@happier-dev/protocol/drafts/sessionDraftsV2';

import type { NewSessionDraftProjection } from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import { buildNewSessionDraftRowPresentation, resolveNewSessionDraftAgentId } from './newSessionDraftPresentation';
import { resolveRunnerDraftActivation } from './newSessionDraftDeletion';
import { t } from '@/text';

function draft(agentTarget: unknown, prompt = 'Review the project settings'): NewSessionDraftProjection {
    const document = NewSessionDraftDocumentV2Schema.parse({
            v: 2,
            composer: {
                text: { mutationId: '00000000-0000-4000-8000-000000000001', value: prompt },
                mentions: { mutationId: '00000000-0000-4000-8000-000000000002', value: [] },
                attachments: { mutationId: '00000000-0000-4000-8000-000000000003', value: [] },
            },
            target: {
                kind: 'newSession',
                authoring: agentTarget === undefined ? {} : {
                    agentTarget: { mutationId: '00000000-0000-4000-8000-000000000004', value: agentTarget },
                },
            },
            extensions: {},
        });
    return {
        draftId: '00000000-0000-4000-8000-000000000014',
        document,
        readView: {
            address: { kind: 'newSession', draftId: '00000000-0000-4000-8000-000000000014' },
            revision: 0, materialized: true, status: 'clean', conflict: null, createdAt: 0, updatedAt: 0, localSupplement: {},
            composer: document.composer, documentVersion: 2, targetKind: 'newSession',
        },
        status: 'clean',
        conflict: null,
        createdAt: 0,
        updatedAt: 0,
        localSupplement: {},
    };
}

describe('new Session draft Agent presentation', () => {
    it.each([
        ['[capture-uw2eme.png](happier-ref:attachment/capture-uw2eme)', 'capture-uw2eme.png'],
        ['\n# **Review** the [project](https://example.test/project)\nThen run checks', 'Review the project'],
        ['---\n- Check `session_id`', 'Check session_id'],
    ])('derives a readable plain title from the first prompt content (%s)', (prompt, title) => {
        expect(buildNewSessionDraftRowPresentation(draft(undefined, prompt)).title).toBe(title);
    });

    // A named draft lists by its name (the same identity the dock and its Delete read), not as "Untitled draft".
    it('lists a named draft by its name before its prompt', () => {
        const named = draft(undefined, '');
        const document = NewSessionDraftDocumentV2Schema.parse({ ...named.document, target: { kind: 'newSession', authoring: {
            sessionName: { mutationId: '00000000-0000-4000-8000-000000000021', value: 'Nightly build watcher' },
        } } });
        expect(buildNewSessionDraftRowPresentation({ ...named, document }).title).toBe('Nightly build watcher');
    });

    it('keeps retained malformed composer recovery visible with the existing fallback title and activation reference', () => {
        const publicRef = { v: 1, activationId: '00000000-0000-4000-8000-000000000015', createdOnDeviceLabel: 'Creator device' };
        const retained = {
            ...draft(undefined),
            document: { v: 2, composer: null, target: { kind: 'newSession', authoring: {
                temporaryComputerActivationRef: { mutationId: '00000000-0000-4000-8000-000000000004', value: { ...publicRef, retainedFutureMetadata: true } },
            } }, extensions: {} },
            readView: null,
        };
        expect(buildNewSessionDraftRowPresentation(retained).title).toBe(t('sessionDrafts.untitled'));
        expect(resolveRunnerDraftActivation(retained)).toEqual({ isTemporaryComputer: true, publicRef });
    });
    it('resolves an authored bundled Agent without crashing the Session list', () => {
        expect(resolveNewSessionDraftAgentId(draft({
            kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' },
        }))).toBe('claude');
    });

    it.each([undefined, null])('keeps a draft without an Agent unmarked (%s)', (target) => {
        expect(resolveNewSessionDraftAgentId(draft(target))).toBe('');
    });
});
