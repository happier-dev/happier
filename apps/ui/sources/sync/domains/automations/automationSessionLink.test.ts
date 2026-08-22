import { describe, expect, it } from 'vitest';

import {
    AutomationV3DefinitionDetailSchema,
    type AutomationV3DefinitionDetail,
} from '@happier-dev/protocol';

import type { Automation, AutomationDefinition } from './automationTypes';
import { createAutomationDefinitionFromDetail } from './automationDefinitionProjection';
import { encodeAutomationTemplateForTransport, sealAutomationTemplateForTransport } from './automationTemplateTransport';
import {
    countEnabledAutomationsLinkedToSession,
    countEnabledAutomationDefinitionsLinkedToSession,
    filterAutomationDefinitionsLinkedToSession,
    filterAutomationsLinkedToSession,
    projectAutomationDefinitionSessionLink,
    projectAutomationSessionLink,
} from './automationSessionLink';

type AutomationFixture = Partial<Automation> & Readonly<{
    linkedExistingSessionId?: string | null;
}>;

function makeAutomation(params: AutomationFixture & Pick<Automation, 'id' | 'targetType' | 'templateCiphertext'>): Automation {
    return {
        id: params.id,
        name: params.name ?? 'A',
        description: params.description ?? null,
        enabled: params.enabled ?? true,
        schedule: params.schedule ?? { kind: 'interval', everyMs: 60_000, scheduleExpr: null, timezone: null },
        targetType: params.targetType,
        templateCiphertext: params.templateCiphertext,
        templateVersion: params.templateVersion ?? 1,
        nextRunAt: params.nextRunAt ?? null,
        lastRunAt: params.lastRunAt ?? null,
        createdAt: params.createdAt ?? Date.now(),
        updatedAt: params.updatedAt ?? Date.now(),
        assignments: params.assignments ?? [],
        linkedExistingSessionId: params.linkedExistingSessionId ?? null,
    };
}

describe('automationSessionLink', () => {
    it('derives encrypted associations from authenticated payload content and rejects a mismatched predecessor outer id', async () => {
        const currentEncrypted = await sealAutomationTemplateForTransport({
            template: {
                directory: '/tmp/project',
                existingSessionId: 's1',
            },
            encryptRaw: async () => 'current-ciphertext',
        });

        const projectedCurrent = await projectAutomationSessionLink({
            automation: makeAutomation({
                id: 'current',
                targetType: 'existing_session',
                templateCiphertext: currentEncrypted,
            }),
            decryptRaw: async () => ({ directory: '/tmp/project', existingSessionId: 's1' }),
        });

        const projectedMismatchedPredecessor = await projectAutomationSessionLink({
            automation: makeAutomation({
                id: 'legacy-mismatch',
                targetType: 'existing_session',
                templateCiphertext: JSON.stringify({
                    kind: 'happier_automation_template_encrypted_v1',
                    payloadCiphertext: 'legacy-ciphertext',
                    existingSessionId: 's1',
                }),
            }),
            decryptRaw: async () => ({ directory: '/tmp/project', existingSessionId: 's2' }),
        });

        const projectedLockedPredecessor = await projectAutomationSessionLink({
            automation: makeAutomation({
                id: 'legacy-locked',
                targetType: 'existing_session',
                templateCiphertext: JSON.stringify({
                    kind: 'happier_automation_template_encrypted_v1',
                    payloadCiphertext: 'legacy-ciphertext',
                    existingSessionId: 's1',
                }),
            }),
        });

        const projectedMatchingPredecessor = await projectAutomationSessionLink({
            automation: makeAutomation({
                id: 'legacy-match',
                targetType: 'existing_session',
                templateCiphertext: JSON.stringify({
                    kind: 'happier_automation_template_encrypted_v1',
                    payloadCiphertext: 'legacy-ciphertext',
                    existingSessionId: 's1',
                }),
            }),
            decryptRaw: async () => ({ directory: '/tmp/project', existingSessionId: 's1' }),
        });

        expect(projectedCurrent.linkedExistingSessionId).toBe('s1');
        expect(projectedMatchingPredecessor.linkedExistingSessionId).toBe('s1');
        expect(projectedMismatchedPredecessor.linkedExistingSessionId).toBeNull();
        expect(projectedLockedPredecessor.linkedExistingSessionId).toBeNull();
        expect(filterAutomationsLinkedToSession([
            projectedCurrent,
            projectedMatchingPredecessor,
            projectedMismatchedPredecessor,
            projectedLockedPredecessor,
        ], 's1').map((automation) => automation.id)).toEqual(['current', 'legacy-match']);
    });

    it('projects the current plaintext payload without a decryptor', async () => {
        const currentPlaintext = await encodeAutomationTemplateForTransport({
            accountMode: 'plain',
            template: {
                directory: '/tmp/project',
                existingSessionId: 'plain-session',
            },
        });

        const projected = await projectAutomationSessionLink({
            automation: makeAutomation({
                id: 'plain',
                targetType: 'existing_session',
                templateCiphertext: currentPlaintext,
            }),
        });

        const projectedPredecessor = await projectAutomationSessionLink({
            automation: makeAutomation({
                id: 'legacy-plain',
                targetType: 'existing_session',
                templateCiphertext: JSON.stringify({
                    kind: 'happier_automation_template_plain_v1',
                    payload: { directory: '/tmp/project', existingSessionId: 'plain-session' },
                    existingSessionId: 'plain-session',
                }),
            }),
        });

        expect(projected.linkedExistingSessionId).toBe('plain-session');
        expect(projectedPredecessor.linkedExistingSessionId).toBe('plain-session');
    });

    it('filters automations linked to a session from the canonical client projection', () => {
        const linked = makeAutomation({
            id: 'a1',
            targetType: 'existing_session',
            templateCiphertext: JSON.stringify({
                kind: 'happier_automation_template_encrypted_v1',
                payloadCiphertext: 'cipher',
            }),
            linkedExistingSessionId: 's1',
        });
        const otherSession = makeAutomation({
            id: 'a2',
            targetType: 'existing_session',
            templateCiphertext: JSON.stringify({
                kind: 'happier_automation_template_encrypted_v1',
                payloadCiphertext: 'cipher',
            }),
            linkedExistingSessionId: 's2',
        });
        const newSession = makeAutomation({
            id: 'a3',
            targetType: 'new_session',
            templateCiphertext: JSON.stringify({
                kind: 'happier_automation_template_encrypted_v1',
                payloadCiphertext: 'cipher',
            }),
        });

        expect(filterAutomationsLinkedToSession([linked, otherSession, newSession], 's1').map((a) => a.id)).toEqual(['a1']);
    });

    it('counts enabled automations linked to a session', () => {
        const enabledLinked = makeAutomation({
            id: 'a1',
            enabled: true,
            targetType: 'existing_session',
            templateCiphertext: JSON.stringify({
                kind: 'happier_automation_template_encrypted_v1',
                payloadCiphertext: 'cipher',
            }),
            linkedExistingSessionId: 's1',
        });
        const disabledLinked = makeAutomation({
            id: 'a2',
            enabled: false,
            targetType: 'existing_session',
            templateCiphertext: JSON.stringify({
                kind: 'happier_automation_template_encrypted_v1',
                payloadCiphertext: 'cipher',
            }),
            linkedExistingSessionId: 's1',
        });
        const other = makeAutomation({
            id: 'a3',
            enabled: true,
            targetType: 'existing_session',
            templateCiphertext: JSON.stringify({
                kind: 'happier_automation_template_encrypted_v1',
                payloadCiphertext: 'cipher',
            }),
            linkedExistingSessionId: 's2',
        });

        expect(countEnabledAutomationsLinkedToSession([enabledLinked, disabledLinked, other], 's1')).toBe(1);
    });

    it('filters the V3 store projection only when direct detail established its existing-session link', () => {
        const linked = {
            id: 'event-linked',
            enabled: true,
            targetType: 'existingSession',
            linkedExistingSessionId: 's1',
        } as AutomationDefinition;
        const summaryOnly = {
            id: 'event-summary-only',
            enabled: true,
            targetType: 'existingSession',
            linkedExistingSessionId: null,
        } as AutomationDefinition;
        const newSession = {
            id: 'event-new-session',
            enabled: true,
            targetType: 'newSession',
            linkedExistingSessionId: 's1',
        } as AutomationDefinition;

        expect(filterAutomationDefinitionsLinkedToSession([linked, summaryOnly, newSession], 's1').map((item) => item.id))
            .toEqual(['event-linked']);
        expect(countEnabledAutomationDefinitionsLinkedToSession([linked, summaryOnly, newSession], 's1')).toBe(1);
    });

    it('derives a legacy direct V3 definition link through the existing template reader without treating a summary as content', async () => {
        const templateCiphertext = await sealAutomationTemplateForTransport({
            template: {
                directory: '/tmp/project',
                existingSessionId: 'legacy-session',
            },
            encryptRaw: async () => 'legacy-template-ciphertext',
        });
        const detail = {
            id: 'legacy-v3-definition',
            name: 'Legacy schedule',
            description: null,
            enabled: true,
            trigger: {
                kind: 'schedule' as const,
                schedule: {
                    kind: 'interval' as const,
                    scheduleExpr: null,
                    everyMs: 60_000,
                    timezone: null,
                },
            },
            targetType: 'existingSession' as const,
            existingSessionId: null,
            templateVersion: 2,
            nextRunAt: null,
            lastRunAt: null,
            createdAt: 1_786_257_600_000,
            updatedAt: 1_786_257_600_000,
            assignments: [],
            triggerDefinitionEnvelope: null,
            templateCiphertext,
        } satisfies AutomationV3DefinitionDetail;

        const resolved = await projectAutomationDefinitionSessionLink({
            automation: createAutomationDefinitionFromDetail(detail),
            decryptRaw: async (ciphertext) => {
                expect(ciphertext).toBe('legacy-template-ciphertext');
                return { directory: '/tmp/project', existingSessionId: 'legacy-session' };
            },
        });

        expect(resolved.linkedExistingSessionId).toBe('legacy-session');
    });

    it('fails closed when a legacy direct V3 detail is missing its optional template', async () => {
        const detail = {
            id: 'missing-legacy-template',
            name: 'Missing legacy template',
            description: null,
            enabled: true,
            trigger: {
                kind: 'schedule' as const,
                schedule: {
                    kind: 'interval' as const,
                    scheduleExpr: null,
                    everyMs: 60_000,
                    timezone: null,
                },
            },
            targetType: 'existingSession' as const,
            existingSessionId: null,
            templateVersion: 2,
            nextRunAt: null,
            lastRunAt: null,
            createdAt: 1_786_257_600_000,
            updatedAt: 1_786_257_600_000,
            assignments: [],
            triggerDefinitionEnvelope: null,
        } satisfies AutomationV3DefinitionDetail;

        const resolved = await projectAutomationDefinitionSessionLink({
            automation: {
                ...createAutomationDefinitionFromDetail(detail),
                linkedExistingSessionId: 'stale-session',
            },
        });

        expect(resolved.linkedExistingSessionId).toBeNull();
        expect(countEnabledAutomationDefinitionsLinkedToSession([resolved], 'stale-session')).toBe(0);
    });

    it('does not restore a session link or count from a schema-valid mismatched direct recipe revision', async () => {
        const detail = AutomationV3DefinitionDetailSchema.parse({
            id: 'mismatched-recipe-revision',
            name: 'Revision mismatch',
            description: null,
            enabled: true,
            trigger: {
                kind: 'schedule',
                schedule: {
                    kind: 'interval',
                    scheduleExpr: null,
                    everyMs: 60_000,
                    timezone: null,
                },
            },
            targetType: 'existingSession',
            existingSessionId: 'session-1',
            templateVersion: 2,
            nextRunAt: null,
            lastRunAt: null,
            createdAt: 1_786_257_600_000,
            updatedAt: 1_786_257_600_000,
            assignments: [],
            triggerDefinitionEnvelope: null,
            executionRecipe: {
                v: 1,
                templateVersion: 1,
                template: { t: 'plain', v: { v: 1, prompt: 'Review {{input}}' } },
                triggerEvidence: null,
                target: { kind: 'existingSession', sessionId: 'session-1' },
            },
        });
        const resolved = await projectAutomationDefinitionSessionLink({
            automation: createAutomationDefinitionFromDetail(detail),
        });

        expect(resolved.linkedExistingSessionId).toBeNull();
        expect(countEnabledAutomationDefinitionsLinkedToSession([resolved], 'session-1')).toBe(0);
    });
});
