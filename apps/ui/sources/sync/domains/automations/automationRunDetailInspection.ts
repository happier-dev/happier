import {
    AutomationRunTriggerEvidenceV1Schema,
    convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1,
    createAccountScopedCryptoMaterialSnapshotV1,
    createCanonicalJsonSigningInput,
    inspectAutomationRunExecutionRecipeOuterV1,
    materializeAutomationRunExecutionRecipeV1,
    openAccountScopedBlobCiphertext,
    openAutomationRunFailureDetailStoredEnvelopeV1,
    openAutomationRunResultStoredEnvelopeV1,
    parseAutomationRunFailureDetailStoredEnvelopeV1,
    parseAutomationRunResultStoredEnvelopeV1,
    parseAutomationRunExecutionRecipeV1,
    type AccountEncryptionCurrentnessResponse,
    type AccountScopedCryptoMaterial,
    type AutomationRunExecutionRecipeMaterializationResultV1,
    type AutomationRunResultCorrespondenceV1,
    type AutomationRunResultV1,
    type AutomationRunFailureDetailCorrespondenceV1,
    type AutomationRunTriggerEvidenceV1,
    type AutomationV3RunDetail,
} from '@happier-dev/protocol';

import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { isDataKeyAuthCredentials } from '@/auth/storage/tokenStorage';
import { decodeBase64 } from '@/encryption/base64';
import { resolveAccountScopedCryptoMaterialFromCredentials } from '@/sync/domains/connectedServices/resolveAccountScopedCryptoMaterialFromCredentials';

function toAutomationAccountCurrentnessWitness(
    currentness: AccountEncryptionCurrentnessResponse,
) {
    return {
        mode: currentness.mode,
        version: currentness.version,
        contentKeyFingerprint: currentness.contentKeyFingerprint,
    } as const;
}

type AutomationRunDetailMaterializedTarget = Extract<
    AutomationRunExecutionRecipeMaterializationResultV1,
    Readonly<{ kind: 'available' }>
>['target'];

export type AutomationRunDetailAccountMaterialResolution =
    | Readonly<{ kind: 'available'; material?: AccountScopedCryptoMaterial }>
    | Readonly<{ kind: 'unavailable' }>;

/**
 * Resolves only the current Account material needed by this routed private
 * read. Account mode/currentness remains supplied by the canonical endpoint;
 * a missing or mismatched E2EE key is unavailable rather than plaintext.
 */
export function resolveAutomationRunDetailAccountMaterial(params: Readonly<{
    credentials: AuthCredentials;
    accountCurrentness: AccountEncryptionCurrentnessResponse;
}>): AutomationRunDetailAccountMaterialResolution {
    if (params.accountCurrentness.mode === 'plain') {
        return { kind: 'available' };
    }
    if (!params.accountCurrentness.contentKeyFingerprint) {
        return { kind: 'unavailable' };
    }
    try {
        const material = resolveAccountScopedCryptoMaterialFromCredentials(params.credentials);
        const snapshot = createAccountScopedCryptoMaterialSnapshotV1({
            accountEncryptionMode: 'e2ee',
            material,
            ...(isDataKeyAuthCredentials(params.credentials)
                ? {
                    dataKeyPublicKey: decodeBase64(
                        params.credentials.encryption.publicKey,
                        'base64',
                    ),
                }
                : {}),
        });
        return convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(
            snapshot.contentPublicKeyFingerprint,
        ) === params.accountCurrentness.contentKeyFingerprint
            ? { kind: 'available', material }
            : { kind: 'unavailable' };
    } catch {
        return { kind: 'unavailable' };
    }
}

export type AutomationRunDetailRecipeInspection =
    | Readonly<{
        kind: 'available';
        templateVersion: number;
        evidence: AutomationRunTriggerEvidenceV1 | null;
        target: AutomationRunDetailMaterializedTarget;
    }>
    | Readonly<{ kind: 'absent' }>
    | Readonly<{ kind: 'unavailable'; reason: 'materialUnavailable' | 'currentnessUnavailable' }>
    | Readonly<{ kind: 'invalid'; reason: 'modeMismatch' | 'contentInvalid' }>;

export type AutomationRunDetailResultInspection =
    | Readonly<{
        kind: 'available';
        correspondence: AutomationRunResultCorrespondenceV1;
        result: AutomationRunResultV1;
    }>
    | Readonly<{ kind: 'absent' }>
    | Readonly<{ kind: 'predecessorSummary' }>
    | Readonly<{ kind: 'unavailable'; reason: 'materialUnavailable' | 'currentnessUnavailable' }>
    | Readonly<{ kind: 'invalid'; reason: 'modeMismatch' | 'contentInvalid' }>;

export type AutomationRunDetailFailureDetailInspection =
    | Readonly<{
        kind: 'available';
        correspondence: AutomationRunFailureDetailCorrespondenceV1;
        detail: string;
    }>
    | Readonly<{ kind: 'absent' }>
    | Readonly<{ kind: 'unavailable'; reason: 'materialUnavailable' | 'currentnessUnavailable' }>
    | Readonly<{ kind: 'invalid'; reason: 'modeMismatch' | 'contentInvalid' }>;

export type AutomationRunDetailPrivateContentInspection = Readonly<{
    recipe: AutomationRunDetailRecipeInspection;
    result: AutomationRunDetailResultInspection;
    failureDetail: AutomationRunDetailFailureDetailInspection;
}>;

/** One direct, route-local Run response plus its opened private projection. */
export type AutomationRunDetailRouteInspection = Readonly<{
    detail: AutomationV3RunDetail;
    privateContent: AutomationRunDetailPrivateContentInspection;
}>;

function contentInvalidRecipe(): AutomationRunDetailRecipeInspection {
    return { kind: 'invalid', reason: 'contentInvalid' };
}

function contentInvalidResult(): AutomationRunDetailResultInspection {
    return { kind: 'invalid', reason: 'contentInvalid' };
}

function contentInvalidFailureDetail(): AutomationRunDetailFailureDetailInspection {
    return { kind: 'invalid', reason: 'contentInvalid' };
}

function inspectRecipe(params: Readonly<{
    detail: AutomationV3RunDetail;
    accountCurrentness: AccountEncryptionCurrentnessResponse;
    material?: AccountScopedCryptoMaterial;
}>): AutomationRunDetailRecipeInspection {
    if (params.detail.executionInputEnvelope === null) {
        return params.detail.triggerEvidenceEnvelope === null
            ? { kind: 'absent' }
            : contentInvalidRecipe();
    }
    const parsed = parseAutomationRunExecutionRecipeV1(params.detail.executionInputEnvelope);
    if (parsed.kind !== 'available') return contentInvalidRecipe();

    const accountCurrentness = toAutomationAccountCurrentnessWitness(params.accountCurrentness);

    const outer = inspectAutomationRunExecutionRecipeOuterV1({
        recipe: parsed.recipe,
        accountCurrentness,
    });
    if (outer.kind === 'modeMismatch') {
        return { kind: 'invalid', reason: 'modeMismatch' };
    }
    if (outer.kind !== 'available') return contentInvalidRecipe();

    const recipe = outer.recipe;
    const expectedTriggerEvidenceEnvelope = recipe.triggerEvidence === null
        ? null
        : createCanonicalJsonSigningInput(recipe.triggerEvidence);
    if (params.detail.triggerEvidenceEnvelope !== expectedTriggerEvidenceEnvelope) {
        return contentInvalidRecipe();
    }

    const templateEnvelope = recipe.template;
    const triggerEvidenceEnvelope = recipe.triggerEvidence;
    let openedContent: Readonly<{ template: unknown; triggerEvidence: unknown | null }> | undefined;
    if (templateEnvelope.t === 'encrypted') {
        if (!params.material) {
            return { kind: 'unavailable', reason: 'materialUnavailable' };
        }
        const template = openAccountScopedBlobCiphertext({
            kind: 'automation_template_payload',
            material: params.material,
            ciphertext: templateEnvelope.c,
        });
        const triggerEvidence = triggerEvidenceEnvelope?.t === 'encrypted'
            ? openAccountScopedBlobCiphertext({
                kind: 'automation_trigger_evidence',
                material: params.material,
                ciphertext: triggerEvidenceEnvelope.c,
            })
            : null;
        if (!template || (triggerEvidenceEnvelope !== null && !triggerEvidence)) {
            return contentInvalidRecipe();
        }
        openedContent = {
            template: template.value,
            triggerEvidence: triggerEvidence?.value ?? null,
        };
    }

    const materialized = materializeAutomationRunExecutionRecipeV1({
        recipe,
        cause: params.detail.cause,
        accountCurrentness,
        runId: params.detail.id,
        ...(openedContent ? { openedContent } : {}),
    });
    if (materialized.kind === 'materialUnavailable') {
        return { kind: 'unavailable', reason: 'materialUnavailable' };
    }
    if (materialized.kind !== 'available') return contentInvalidRecipe();

    const rawEvidence = templateEnvelope.t === 'plain'
        ? (triggerEvidenceEnvelope?.t === 'plain' ? triggerEvidenceEnvelope.v : null)
        : openedContent?.triggerEvidence ?? null;
    const evidence = rawEvidence === null
        ? null
        : AutomationRunTriggerEvidenceV1Schema.safeParse(rawEvidence);
    if (evidence !== null && !evidence.success) return contentInvalidRecipe();

    return {
        kind: 'available',
        templateVersion: recipe.templateVersion,
        evidence: evidence?.data ?? null,
        target: materialized.target,
    };
}

function inspectResult(params: Readonly<{
    detail: AutomationV3RunDetail;
    accountCurrentness: AccountEncryptionCurrentnessResponse;
    material?: AccountScopedCryptoMaterial;
}>): AutomationRunDetailResultInspection {
    if (params.detail.resultEnvelope === null) {
        return params.detail.legacySummaryCiphertext === null
            ? { kind: 'absent' }
            : { kind: 'predecessorSummary' };
    }
    const envelope = parseAutomationRunResultStoredEnvelopeV1(params.detail.resultEnvelope);
    if (envelope === null) return contentInvalidResult();
    const opened = openAutomationRunResultStoredEnvelopeV1({
        mode: params.accountCurrentness.mode,
        ...(params.material ? { material: params.material } : {}),
        envelope,
    });
    if (opened.kind === 'modeMismatch') {
        return { kind: 'invalid', reason: 'modeMismatch' };
    }
    if (opened.kind === 'materialUnavailable') {
        return { kind: 'unavailable', reason: 'materialUnavailable' };
    }
    if (opened.kind !== 'available') return contentInvalidResult();
    if (
        opened.correspondence.automationId !== params.detail.automationId
        || opened.correspondence.runId !== params.detail.id
    ) {
        return contentInvalidResult();
    }
    return {
        kind: 'available',
        correspondence: opened.correspondence,
        result: opened.result,
    };
}

function inspectFailureDetail(params: Readonly<{
    detail: AutomationV3RunDetail;
    accountCurrentness: AccountEncryptionCurrentnessResponse;
    material?: AccountScopedCryptoMaterial;
}>): AutomationRunDetailFailureDetailInspection {
    const serialized = params.detail.errorDetailEnvelope;
    if (serialized === null || serialized === undefined) return { kind: 'absent' };
    const envelope = parseAutomationRunFailureDetailStoredEnvelopeV1(serialized);
    if (envelope === null) return contentInvalidFailureDetail();
    const opened = openAutomationRunFailureDetailStoredEnvelopeV1({
        mode: params.accountCurrentness.mode,
        ...(params.material ? { material: params.material } : {}),
        envelope,
    });
    if (opened.kind === 'modeMismatch') {
        return { kind: 'invalid', reason: 'modeMismatch' };
    }
    if (opened.kind === 'materialUnavailable') {
        return { kind: 'unavailable', reason: 'materialUnavailable' };
    }
    if (opened.kind !== 'available') return contentInvalidFailureDetail();
    if (
        opened.correspondence.automationId !== params.detail.automationId
        || opened.correspondence.runId !== params.detail.id
    ) {
        return contentInvalidFailureDetail();
    }
    return {
        kind: 'available',
        correspondence: opened.correspondence,
        detail: opened.detail,
    };
}

/**
 * Opens the exact private Run-detail envelopes only for one routed response.
 * The caller owns currentness acquisition and never persists this projection in
 * the bounded Automation Run cache.
 */
export function inspectAutomationRunDetailPrivateContent(params: Readonly<{
    detail: AutomationV3RunDetail;
    accountCurrentness: AccountEncryptionCurrentnessResponse;
    material?: AccountScopedCryptoMaterial;
}>): AutomationRunDetailPrivateContentInspection {
    return {
        recipe: inspectRecipe(params),
        result: inspectResult(params),
        failureDetail: inspectFailureDetail(params),
    };
}

export function createAutomationRunDetailPrivateContentCurrentnessUnavailable(): AutomationRunDetailPrivateContentInspection {
    return {
        recipe: { kind: 'unavailable', reason: 'currentnessUnavailable' },
        result: { kind: 'unavailable', reason: 'currentnessUnavailable' },
        failureDetail: { kind: 'unavailable', reason: 'currentnessUnavailable' },
    };
}
