import { describe, expect, it, vi } from 'vitest';
import { createTextModuleMock } from '@/dev/testkit/mocks/text';

vi.mock('@/text', () => createTextModuleMock());

import { resolveSessionPermissionChoices, selectSessionPermissionChoiceForDecision } from './sessionPermissionChoices';
import { answerSessionPermission, resolveSessionPermissionBehavior } from './sessionPermissionAnswers';

describe('Session permission offered choices', () => {
    it.each([
        { label: 'available once', allowed: true, omitOnce: false, expected: 'opaque:once' },
        { label: 'unavailable once', allowed: false, omitOnce: false, expected: undefined },
        { label: 'only broader grants', allowed: true, omitOnce: true, expected: undefined },
    ])('maps Yes only to an available once grant ($label), and No to Deny rather than Stop', ({ allowed, omitOnce, expected }) => {
        const choices = resolveSessionPermissionChoices({ toolName: 'Shell', nativeChoices: {
            requirementId: 'spoken-occurrence', source: 'native-agent', choices: [
                { id: 'opaque:session', label: 'Grant session', decision: 'approved_for_session', scope: 'session',
                    response: { approved: true, decision: 'approved_for_session' } },
                { id: 'opaque:stop', label: 'Stop', decision: 'abort', scope: 'once', response: { approved: false, decision: 'abort' } },
                ...(!omitOnce ? [{ id: 'opaque:once', label: 'Grant once', decision: 'approved', scope: 'once',
                    response: { approved: true, decision: 'approved' } }] : []),
                { id: 'opaque:deny', label: 'Refuse', decision: 'denied', scope: 'once', response: { approved: false, decision: 'denied' } },
            ],
        }, nativeChoiceAvailability: [{ choiceId: 'opaque:once', allowed }] });
        expect(selectSessionPermissionChoiceForDecision(choices, 'approved')?.response.nativeChoice)
            .toEqual(expected ? { requirementId: 'spoken-occurrence', choiceId: expected } : undefined);
        expect(selectSessionPermissionChoiceForDecision(choices, 'denied')?.response.nativeChoice)
            .toEqual({ requirementId: 'spoken-occurrence', choiceId: 'opaque:deny' });
    });

    it('does not turn an empty offer or Stop-only offer into a Yes or No answer', () => {
        const choices = resolveSessionPermissionChoices({ toolName: 'Shell', nativeChoices: {
            requirementId: 'stop-only', source: 'native-agent', choices: [
                { id: 'stop-only', label: 'Stop', decision: 'abort', scope: 'once', response: { approved: false, decision: 'abort' } },
            ],
        } });
        expect(selectSessionPermissionChoiceForDecision(choices, 'approved')).toBeUndefined();
        expect(selectSessionPermissionChoiceForDecision(choices, 'denied')).toBeUndefined();
        expect(selectSessionPermissionChoiceForDecision([], 'approved')).toBeUndefined();
    });

    it.each(['claude', 'codex'])('keeps stored %s occurrences answerable after live descriptor policy removal', agentId => {
        const behavior = resolveSessionPermissionBehavior({ agentId, metadata: { flavor: agentId }, accountScope: null });
        const choices = resolveSessionPermissionChoices({ toolName: 'Bash', permissionBehavior: behavior });
        expect(choices.map(choice => choice.id)).toContain('allow');
        expect(choices.find(choice => choice.id === 'always_allow')?.response).toMatchObject(agentId === 'claude'
            ? { allowedTools: ['Bash'], updatedPermissions: [{ type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'allow', destination: 'session' }] }
            : { decision: 'approved_for_session' });
        expect(choices.find(choice => choice.id === 'stop')?.response).toEqual({ approved: false, decision: agentId === 'claude' ? 'abort' : 'denied' });
    });
    it('submits the native selection without inventing normalized aliases', async () => {
        const respondToPermission = vi.fn(async () => {});
        await answerSessionPermission({ requestId: 'pending', turnId: 'turn',
            nativeChoice: { requirementId: 'occurrence', choiceId: 'opaque:stop', feedback: 'Stop here' },
            respondToPermission });
        expect(respondToPermission).toHaveBeenCalledWith({ id: 'pending', turnId: 'turn',
            nativeChoice: { requirementId: 'occurrence', choiceId: 'opaque:stop', feedback: 'Stop here' } });
    });
    it('projects only the offered opaque IDs and submits occurrence-bound selections', () => {
        const nativeChoices = {
            requirementId: 'requirement-child-2', source: 'native-test',
            origin: { sessionId: 'child-session', subagentId: 'worker' },
            choices: [
                { id: 'grant-workspace:opaque', label: 'Grant workspace', decision: 'approved_for_session' as const,
                    scope: 'session' as const, rulePreview: 'workspace edits',
                    response: { approved: true as const, mode: 'acceptEdits' as const } },
                { id: 'halt:opaque', label: 'Stop this turn', decision: 'abort' as const,
                    scope: 'once' as const, response: { approved: false as const, decision: 'abort' as const } },
            ],
        };
        const choices = resolveSessionPermissionChoices({ toolName: 'Write', nativeChoices,
            permissionBehavior: undefined, canWriteCatalog: true });
        expect(choices).toEqual(nativeChoices.choices.map(choice => ({
            id: choice.id, label: choice.label, decision: choice.decision, scope: choice.scope,
            ...(choice.rulePreview ? { rulePreview: choice.rulePreview } : {}),
            response: { nativeChoice: { requirementId: 'requirement-child-2', choiceId: choice.id } },
        })));
    });

    it('preserves the frozen stored-request reader when no offered choices were recorded', () => {
        const choices = resolveSessionPermissionChoices({ toolName: 'Bash', permissionBehavior: {
            promptProtocol: 'claude', footer: { usePermissionUpdates: true, stopHandling: 'denyOnly' },
        } });
        expect(choices.find(choice => choice.id === 'always_allow')?.response).toMatchObject({
            approved: true, allowedTools: ['Bash'],
            updatedPermissions: [{ type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'allow', destination: 'session' }],
        });
        expect(choices.find(choice => choice.id === 'stop')?.response).toEqual({ approved: false, decision: 'denied' });
    });

    it('preserves an empty offer and the authority owner\'s unavailable-choice result', () => {
        expect(resolveSessionPermissionChoices({ toolName: 'Bash', permissionBehavior: undefined,
            nativeChoices: { requirementId: 'empty', source: 'agent', choices: [] } })).toEqual([]);
        const availability = { choiceId: 'persistent', allowed: false, reason: 'owner_required' as const };
        expect(resolveSessionPermissionChoices({ toolName: 'Bash', permissionBehavior: undefined,
            nativeChoices: { requirementId: 'restricted', source: 'agent', choices: [{ id: 'persistent',
                label: 'Save policy', decision: 'approved', scope: 'localPersistent', allowsFeedback: true,
                response: { approved: true, mode: 'acceptEdits' } }] },
            nativeChoiceAvailability: [availability],
        })).toEqual([{ id: 'persistent', label: 'Save policy', decision: 'approved', scope: 'localPersistent',
            allowsFeedback: true, availability,
            response: { nativeChoice: { requirementId: 'restricted', choiceId: 'persistent' } } }]);
    });

    it.each([null, {}, { requirementId: 'broken', source: 'agent', choices: 'invalid' }])('never downgrades malformed native facts to generic grants (%j)', nativeChoices => {
        expect(resolveSessionPermissionChoices({ toolName: 'Bash', nativeChoices,
            permissionBehavior: { promptProtocol: 'claude', footer: { usePermissionUpdates: true } },
        })).toEqual([]);
    });
});
