import { describe, expect, it } from 'vitest';
import {
    AutomationV3RunDetailSchema,
    convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1,
    createAccountScopedCryptoMaterialSnapshotV1,
    createCanonicalJsonSigningInput,
    deriveAutomationOccurrenceKeyV1,
    AutomationRunTriggerEvidenceV1Schema,
    materializeAutomationRunPromptV1,
    materializeAutomationRunExecutionRecipeV1,
    sealAccountScopedBlobCiphertext,
    sealAutomationRunFailureDetailStoredEnvelopeV1,
    sealAutomationRunResultStoredEnvelopeV1,
    parseAutomationRunExecutionRecipeV1,
    serializeAutomationRunExecutionRecipeV1,
} from '@happier-dev/protocol';

import { encodeBase64 } from '@/encryption/base64';
import {
    inspectAutomationRunDetailPrivateContent,
    resolveAutomationRunDetailAccountMaterial,
} from './automationRunDetailInspection';

const ACCOUNT_CURRENTNESS_PLAIN = {
    mode: 'plain' as const,
    version: 7,
    contentKeyFingerprint: null,
    signingKeyFingerprint: null,
    updatedAt: 7,
};

const ACCOUNT_MATERIAL = {
    type: 'legacy' as const,
    secret: new Uint8Array(32).fill(7),
};

const ACCOUNT_CURRENTNESS_E2EE = {
    mode: 'e2ee' as const,
    version: 8,
    contentKeyFingerprint: 'current-content-key',
    signingKeyFingerprint: null,
    updatedAt: 8,
};

const parsedEventEvidence = AutomationRunTriggerEvidenceV1Schema.parse({
    v: 1,
    kind: 'pluginEvent' as const,
    eventRef: {
        pluginId: 'com.example.github',
        localId: 'issue-opened',
    },
    sourceSelectorId: '9d5af559-2c82-4c22-b6a0-ecabce38a631',
    occurrenceId: 'occurrence-1',
    occurredAt: 1_700_000_000_000,
    payload: { action: 'opened', issue: { number: 42 } },
    sourceInstanceId: 'repository-acme-example',
    sourceContractVersion: 1,
    observationReceivedAt: 1_700_000_000_100,
    filter: { version: 1, result: 'matched' as const },
});
if (parsedEventEvidence.kind !== 'pluginEvent') {
    throw new Error('Expected plugin-event evidence fixture');
}
const EVENT_EVIDENCE = parsedEventEvidence;
const EVENT_TRIGGER_ID = 'trigger-event-1';

function deriveOccurrenceKey(): string {
    return deriveAutomationOccurrenceKeyV1({
        triggerId: EVENT_TRIGGER_ID,
        evidence: {
            v: EVENT_EVIDENCE.v,
            kind: EVENT_EVIDENCE.kind,
            eventRef: EVENT_EVIDENCE.eventRef,
            sourceSelectorId: EVENT_EVIDENCE.sourceSelectorId,
            occurrenceId: EVENT_EVIDENCE.occurrenceId,
            occurredAt: EVENT_EVIDENCE.occurredAt,
            payload: EVENT_EVIDENCE.payload,
        },
    });
}

function createPlainRecipe() {
    return {
        v: 1,
        templateVersion: 4,
        template: {
            t: 'plain' as const,
            v: { v: 1, prompt: 'Review this Event: {{input}}' },
        },
        triggerEvidence: {
            t: 'plain' as const,
            v: EVENT_EVIDENCE,
        },
        target: {
            kind: 'existingSession' as const,
            sessionId: 'session-1',
        },
        assignmentMachineIds: ['machine-1'],
    };
}

function createDetail(params: Readonly<{
    recipe: unknown;
    resultEnvelope?: string | null;
    triggerEvidenceEnvelope?: string | null;
    errorDetailEnvelope?: string | null;
}>) {
    const serialized = serializeAutomationRunExecutionRecipeV1(params.recipe);
    if (serialized.kind !== 'available') {
        throw new Error('Expected the strict test recipe to serialize');
    }
    const parsedRecipe = parseAutomationRunExecutionRecipeV1(serialized.serialized);
    if (parsedRecipe.kind !== 'available') {
        throw new Error('Expected the strict test recipe to parse');
    }
    return AutomationV3RunDetailSchema.parse({
        id: 'run-1',
        automationId: 'automation-1',
        revision: 1,
        state: 'succeeded',
        triggerId: EVENT_TRIGGER_ID,
        triggerRetired: false,
        cause: {
            kind: 'trigger',
            triggerId: EVENT_TRIGGER_ID,
            triggerRevision: 1,
            triggerKind: 'pluginEvent',
            occurrenceKey: deriveOccurrenceKey(),
            occurredAt: EVENT_EVIDENCE.occurredAt,
            evidence: {
                eventRef: EVENT_EVIDENCE.eventRef,
                sourceSelectorId: EVENT_EVIDENCE.sourceSelectorId,
            },
        },
        dueAt: EVENT_EVIDENCE.occurredAt,
        claimedAt: EVENT_EVIDENCE.occurredAt,
        startedAt: EVENT_EVIDENCE.occurredAt,
        finishedAt: EVENT_EVIDENCE.occurredAt + 1,
        claimedByMachineId: 'machine-1',
        leaseExpiresAt: null,
        attempt: 2,
        errorCode: null,
        producedSessionId: null,
        executionDispatchState: null,
        executionAttempt: 0,
        replyHandoffState: 'none',
        replyHandoffAttempt: 0,
        replyHandoffDueAt: null,
        createdAt: EVENT_EVIDENCE.occurredAt,
        updatedAt: EVENT_EVIDENCE.occurredAt + 1,
        triggerEvidenceEnvelope: params.triggerEvidenceEnvelope
            ?? createCanonicalJsonSigningInput(parsedRecipe.recipe.triggerEvidence),
        executionInputEnvelope: serialized.serialized,
        resultEnvelope: params.resultEnvelope ?? null,
        legacySummaryCiphertext: null,
        executionNativeRunId: null,
        executionNativeCallId: null,
        executionNativeSidechainId: null,
        events: [],
        errorDetailEnvelope: params.errorDetailEnvelope ?? null,
    });
}

function createPlainResultEnvelope(): string {
    return JSON.stringify(sealAutomationRunResultStoredEnvelopeV1({
        mode: 'plain',
        correspondence: {
            accountId: 'account-1',
            automationId: 'automation-1',
            runId: 'run-1',
        },
        result: { v: 1, kind: 'text', text: 'The issue was reviewed.' },
    }));
}

describe('inspectAutomationRunDetailPrivateContent', () => {
    it('opens the admitted plain recipe, evidence, and result without retaining transport envelopes', () => {
        const detail = createDetail({
            recipe: createPlainRecipe(),
            resultEnvelope: createPlainResultEnvelope(),
        });
        const parsedRecipe = parseAutomationRunExecutionRecipeV1(detail.executionInputEnvelope);
        expect(parsedRecipe).toMatchObject({ kind: 'available' });
        if (parsedRecipe.kind !== 'available') throw new Error('Expected a strict recipe');
        expect(detail.triggerEvidenceEnvelope).toBe(
            createCanonicalJsonSigningInput(parsedRecipe.recipe.triggerEvidence),
        );
        const triggerEvidence = parsedRecipe.recipe.triggerEvidence;
        expect(triggerEvidence).not.toBeNull();
        if (triggerEvidence?.t !== 'plain') throw new Error('Expected plain trigger evidence');
        const parsedTriggerEvidence = AutomationRunTriggerEvidenceV1Schema.safeParse(triggerEvidence.v);
        expect(parsedTriggerEvidence.success).toBe(true);
        if (!parsedTriggerEvidence.success || parsedTriggerEvidence.data.kind !== 'pluginEvent') {
            throw new Error('Expected strict plugin-event trigger evidence');
        }
        const cause = detail.cause;
        expect(cause).toMatchObject({ kind: 'trigger', triggerKind: 'pluginEvent' });
        if (cause.kind !== 'trigger' || cause.triggerKind !== 'pluginEvent') {
            throw new Error('Expected plugin-event cause');
        }
        expect(deriveAutomationOccurrenceKeyV1({
            triggerId: cause.triggerId,
            evidence: {
                v: parsedTriggerEvidence.data.v,
                kind: parsedTriggerEvidence.data.kind,
                eventRef: parsedTriggerEvidence.data.eventRef,
                sourceSelectorId: parsedTriggerEvidence.data.sourceSelectorId,
                occurrenceId: parsedTriggerEvidence.data.occurrenceId,
                occurredAt: parsedTriggerEvidence.data.occurredAt,
                payload: parsedTriggerEvidence.data.payload,
            },
        })).toBe(cause.occurrenceKey);
        expect(materializeAutomationRunPromptV1({
            template: parsedRecipe.recipe.template.t === 'plain'
                ? parsedRecipe.recipe.template.v
                : null,
            triggerEvidence: parsedTriggerEvidence.data,
        })).toMatchObject({ kind: 'available' });
        expect(materializeAutomationRunExecutionRecipeV1({
            recipe: parsedRecipe.recipe,
            cause: detail.cause,
            accountCurrentness: {
                mode: ACCOUNT_CURRENTNESS_PLAIN.mode,
                version: ACCOUNT_CURRENTNESS_PLAIN.version,
                contentKeyFingerprint: ACCOUNT_CURRENTNESS_PLAIN.contentKeyFingerprint,
            },
            runId: detail.id,
        })).toMatchObject({ kind: 'available' });
        const inspection = inspectAutomationRunDetailPrivateContent({
            detail,
            accountCurrentness: ACCOUNT_CURRENTNESS_PLAIN,
        });

        expect(inspection).toMatchObject({
            recipe: {
                kind: 'available',
                templateVersion: 4,
                evidence: {
                    kind: 'pluginEvent',
                    sourceInstanceId: 'repository-acme-example',
                    filter: { result: 'matched' },
                },
                target: {
                    kind: 'existingSession',
                    sessionId: 'session-1',
                    prompt: expect.stringContaining('<automation_input v="1">'),
                },
            },
            result: {
                kind: 'available',
                result: { kind: 'text', text: 'The issue was reviewed.' },
            },
        });
        expect(JSON.stringify(inspection)).not.toContain('"t":"plain"');
    });

    it('opens E2EE recipe/evidence/result only with the supplied canonical Account material', () => {
        const plainRecipe = createPlainRecipe();
        const encryptedRecipe = {
            ...plainRecipe,
            template: {
                t: 'encrypted' as const,
                c: sealAccountScopedBlobCiphertext({
                    kind: 'automation_template_payload',
                    material: ACCOUNT_MATERIAL,
                    payload: plainRecipe.template.v,
                    randomBytes: (length) => new Uint8Array(length).fill(1),
                }),
            },
            triggerEvidence: {
                t: 'encrypted' as const,
                c: sealAccountScopedBlobCiphertext({
                    kind: 'automation_trigger_evidence',
                    material: ACCOUNT_MATERIAL,
                    payload: EVENT_EVIDENCE,
                    randomBytes: (length) => new Uint8Array(length).fill(2),
                }),
            },
        };
        const resultEnvelope = JSON.stringify(sealAutomationRunResultStoredEnvelopeV1({
            mode: 'e2ee',
            material: ACCOUNT_MATERIAL,
            randomBytes: (length) => new Uint8Array(length).fill(3),
            correspondence: {
                accountId: 'account-1',
                automationId: 'automation-1',
                runId: 'run-1',
            },
            result: { v: 1, kind: 'text', text: 'Encrypted result.' },
        }));
        const inspection = inspectAutomationRunDetailPrivateContent({
            detail: createDetail({
                recipe: encryptedRecipe,
                resultEnvelope,
            }),
            accountCurrentness: ACCOUNT_CURRENTNESS_E2EE,
            material: ACCOUNT_MATERIAL,
        });

        expect(inspection).toMatchObject({
            recipe: {
                kind: 'available',
                evidence: { payload: { issue: { number: 42 } } },
            },
            result: {
                kind: 'available',
                result: { text: 'Encrypted result.' },
            },
        });
        expect(JSON.stringify(inspection)).not.toContain('automation_template_payload');
    });

    it('keeps E2EE private content unavailable instead of treating it as absent when material is unavailable', () => {
        const plainRecipe = createPlainRecipe();
        const encryptedRecipe = {
            ...plainRecipe,
            template: {
                t: 'encrypted' as const,
                c: sealAccountScopedBlobCiphertext({
                    kind: 'automation_template_payload',
                    material: ACCOUNT_MATERIAL,
                    payload: plainRecipe.template.v,
                    randomBytes: (length) => new Uint8Array(length).fill(4),
                }),
            },
            triggerEvidence: {
                t: 'encrypted' as const,
                c: sealAccountScopedBlobCiphertext({
                    kind: 'automation_trigger_evidence',
                    material: ACCOUNT_MATERIAL,
                    payload: EVENT_EVIDENCE,
                    randomBytes: (length) => new Uint8Array(length).fill(5),
                }),
            },
        };
        const inspection = inspectAutomationRunDetailPrivateContent({
            detail: createDetail({ recipe: encryptedRecipe }),
            accountCurrentness: ACCOUNT_CURRENTNESS_E2EE,
        });

        expect(inspection).toEqual({
            recipe: { kind: 'unavailable', reason: 'materialUnavailable' },
            result: { kind: 'absent' },
            failureDetail: { kind: 'absent' },
        });
    });

    it('admits E2EE material only when the credential-derived key matches Account currentness', () => {
        const credentials = {
            token: 'token-1',
            secret: encodeBase64(ACCOUNT_MATERIAL.secret, 'base64url'),
        };
        const contentKeyFingerprint =
            convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(
                createAccountScopedCryptoMaterialSnapshotV1({
                    accountEncryptionMode: 'e2ee',
                    material: ACCOUNT_MATERIAL,
                }).contentPublicKeyFingerprint,
            );

        expect(resolveAutomationRunDetailAccountMaterial({
            credentials,
            accountCurrentness: {
                ...ACCOUNT_CURRENTNESS_E2EE,
                contentKeyFingerprint,
            },
        })).toEqual({ kind: 'available', material: ACCOUNT_MATERIAL });
        expect(resolveAutomationRunDetailAccountMaterial({
            credentials,
            accountCurrentness: {
                ...ACCOUNT_CURRENTNESS_E2EE,
                contentKeyFingerprint: 'other-current-content-key',
            },
        })).toEqual({ kind: 'unavailable' });
    });

    it('distinguishes a mode mismatch and invalid retained content from an absent result', () => {
        const plainRecipe = createPlainRecipe();
        const modeMismatchedRecipe = {
            ...plainRecipe,
            template: {
                t: 'encrypted' as const,
                c: 'invalid-but-mode-tagged',
            },
            triggerEvidence: {
                t: 'encrypted' as const,
                c: 'invalid-but-mode-tagged-evidence',
            },
        };
        const modeMismatch = inspectAutomationRunDetailPrivateContent({
            detail: createDetail({ recipe: modeMismatchedRecipe }),
            accountCurrentness: ACCOUNT_CURRENTNESS_PLAIN,
        });
        expect(modeMismatch).toEqual({
            recipe: { kind: 'invalid', reason: 'modeMismatch' },
            result: { kind: 'absent' },
            failureDetail: { kind: 'absent' },
        });

        const invalidDetail = {
            ...createDetail({ recipe: createPlainRecipe() }),
            executionInputEnvelope: '{"not":"a recipe"}',
            triggerEvidenceEnvelope: null,
        };
        expect(inspectAutomationRunDetailPrivateContent({
            detail: invalidDetail,
            accountCurrentness: ACCOUNT_CURRENTNESS_PLAIN,
        })).toEqual({
            recipe: { kind: 'invalid', reason: 'contentInvalid' },
            result: { kind: 'absent' },
            failureDetail: { kind: 'absent' },
        });
    });

    it('opens a Run-bound private failure detail only from the direct detail response', () => {
        const privateDetail = 'The worker could not start /private/project.';
        const detail = createDetail({
            recipe: createPlainRecipe(),
            errorDetailEnvelope: JSON.stringify({
                t: 'plain',
                v: {
                    v: 1,
                    correspondence: {
                        automationId: 'automation-1',
                        runId: 'run-1',
                    },
                    detail: privateDetail,
                },
            }),
        });
        const failedDetail = {
            ...detail,
            state: 'failed' as const,
            errorCode: 'worker_crashed',
        };

        const inspection = inspectAutomationRunDetailPrivateContent({
            detail: failedDetail,
            accountCurrentness: ACCOUNT_CURRENTNESS_PLAIN,
        });

        expect(inspection.failureDetail).toEqual({
            kind: 'available',
            correspondence: {
                automationId: 'automation-1',
                runId: 'run-1',
            },
            detail: privateDetail,
        });
    });

    it('opens an E2EE Run failure detail only with the current Account material', () => {
        const detail = createDetail({
            recipe: createPlainRecipe(),
            errorDetailEnvelope: JSON.stringify(sealAutomationRunFailureDetailStoredEnvelopeV1({
                mode: 'e2ee',
                material: ACCOUNT_MATERIAL,
                randomBytes: (length) => new Uint8Array(length).fill(23),
                correspondence: { automationId: 'automation-1', runId: 'run-1' },
                detail: 'The E2EE worker could not reach /private/project.',
            })),
        });

        expect(inspectAutomationRunDetailPrivateContent({
            detail,
            accountCurrentness: ACCOUNT_CURRENTNESS_E2EE,
        }).failureDetail).toEqual({
            kind: 'unavailable',
            reason: 'materialUnavailable',
        });
        expect(inspectAutomationRunDetailPrivateContent({
            detail,
            accountCurrentness: ACCOUNT_CURRENTNESS_E2EE,
            material: ACCOUNT_MATERIAL,
        }).failureDetail).toEqual({
            kind: 'available',
            correspondence: { automationId: 'automation-1', runId: 'run-1' },
            detail: 'The E2EE worker could not reach /private/project.',
        });
    });
});
