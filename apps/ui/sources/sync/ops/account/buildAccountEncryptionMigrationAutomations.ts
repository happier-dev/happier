import {
    AccountEncryptionMigrateAutomationsDirectiveSchema,
    AutomationStoredContentEnvelopeV1Schema,
    AutomationOccurrenceEvidenceV1Schema,
    AutomationOccurrenceKeyV1Schema,
    convertWorkflowRunAccountEncryptionV1,
    createAccountScopedCryptoMaterialSnapshotV1,
    convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1,
    deriveAutomationOccurrenceEvidenceEqualityTagV1,
    deriveAutomationTriggerEvidenceEqualityKeyV1,
    openAccountScopedBlobCiphertext,
    openAutomationTemplateStoredV1,
    openAutomationTemplateStoredForMigrationV1,
    parseAutomationStoredDefinitionExecutionRecipeV1,
    parseAutomationStoredWorkflowDefinitionRecipeV2,
    parseAutomationRunResultStoredEnvelopeV1,
    sealAccountScopedBlobCiphertext,
    type AccountScopedBlobKind,
    type AccountScopedCryptoMaterial,
    type AvailableAutomationAccountEncryptionV1,
    type AccountEncryptionMigrateAutomationsDirective,
    type AccountEncryptionMigrateAutomationsInventoryResponse,
    type AccountEncryptionAutomationTemplatesRecoverResultV1,
} from '@happier-dev/protocol';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import type { Encryption } from '@/sync/encryption/encryption';
import { resolveAccountScopedCryptoMaterialFromCredentials } from '@/sync/domains/connectedServices/resolveAccountScopedCryptoMaterialFromCredentials';
import { decodeAutomationTemplate } from '@/sync/domains/automations/automationTemplateCodec';
import { encodeAutomationTemplateForTransport, resolveAutomationTemplatePayload, tryDecodeAutomationTemplateEnvelope,
    AUTOMATION_TEMPLATE_ENVELOPE_KIND } from '@/sync/domains/automations/automationTemplateTransport';
import { AutomationTemplateEncryptionMaterialUnavailableError } from '@/sync/domains/automations/automationTemplateAvailability';
import { getRandomBytes } from '@/platform/cryptoRandom';

type MigrationTemplateSession = Readonly<{ sessionId: string; encryptionMode: 'plain' | 'e2ee' }>;
type MigrationTemplateSessionResolver = (sessionId: string) => Promise<MigrationTemplateSession | null>;

/**
 * Authenticated plain-Account inventory already validates current Run codecs on the server.
 * The explicit Forget listing also identifies retained summaries and trigger envelopes returned unchanged.
 */
export function isAccountEncryptionMigrationAutomationContentPlain(
    inventory: AccountEncryptionMigrateAutomationsInventoryResponse,
): boolean {
    const triggersPlain = inventory.templates.every(row => row.triggerDefinitionEnvelopes.every(trigger => {
        try {
            const envelope = AutomationStoredContentEnvelopeV1Schema.safeParse(JSON.parse(trigger.envelope));
            return envelope.success && envelope.data.t === 'plain';
        } catch { return false; }
    }));
    if (!triggersPlain) return false;
    return inventory.runs.every(run => {
        if (run.summaryCiphertext !== null) return false;
        const result = parseAutomationRunResultStoredEnvelopeV1(run.resultEnvelope);
        return result?.t !== 'legacySummaryCiphertext' && result?.t !== 'encrypted';
    });
}

/** Complete plain-content assessment shared by recovery and the explicit Forget listing. */
export function readAccountEncryptionMigrationPlainAutomationTarget(
    templateCiphertext: string,
): Readonly<{ existingSessionId: string | null }> | null {
    const definition = parseAutomationStoredDefinitionExecutionRecipeV1(templateCiphertext);
    if (definition.kind === 'available') return definition.recipe.template.t === 'plain'
        ? { existingSessionId: definition.recipe.target.kind === 'existingSession' ? definition.recipe.target.sessionId : null }
        : null;
    const workflow = parseAutomationStoredWorkflowDefinitionRecipeV2(templateCiphertext);
    if (workflow.kind === 'available') return workflow.recipe.workflow.t === 'plain' ? { existingSessionId: null } : null;
    const legacy = openAutomationTemplateStoredV1({ accountMode: 'plain', templateCiphertext });
    return legacy.ok ? { existingSessionId: legacy.template.existingSessionId ?? null } : null;
}

/** The existing template transition, also used by schedule-only V4 request callers. */
export async function convertAccountEncryptionMigrationTemplate(params: Readonly<{
    id: string; templateCiphertext: string; toMode: 'plain' | 'e2ee';
    decryptRaw?: (ciphertext: string) => Promise<unknown | null>;
    targetMaterial?: AccountScopedCryptoMaterial;
    historicalMaterial?: AccountScopedCryptoMaterial;
    resolveSession?: MigrationTemplateSessionResolver;
}>): Promise<string> {
    const envelope = tryDecodeAutomationTemplateEnvelope(params.templateCiphertext);
    if (!envelope) throw new Error(`Invalid automation template envelope (${params.id})`);
    if (params.toMode === 'e2ee' && envelope.kind === AUTOMATION_TEMPLATE_ENVELOPE_KIND) return params.templateCiphertext;
    const historical = params.historicalMaterial ? openAutomationTemplateStoredForMigrationV1({
        templateCiphertext: params.templateCiphertext, material: params.historicalMaterial,
    }) : null;
    const opened = historical
        ? historical.ok ? { kind: 'ready' as const, payload: historical.template } : { kind: 'locked' as const }
        : await resolveAutomationTemplatePayload({ templateCiphertext: params.templateCiphertext, decryptRaw: params.decryptRaw });
    if (opened.kind === 'locked') throw new AutomationTemplateEncryptionMaterialUnavailableError();
    if (opened.kind !== 'ready') throw new Error(`Invalid automation template envelope (${params.id})`);
    let template = decodeAutomationTemplate(JSON.stringify(opened.payload));
    if (!template) throw new Error(`Invalid automation template payload (${params.id})`);
    if (params.toMode === 'plain' && template.existingSessionId) {
        const session = await params.resolveSession?.(template.existingSessionId);
        if (!session || session.sessionId !== template.existingSessionId) throw new AutomationTemplateEncryptionMaterialUnavailableError();
        // Session mode, not an embedded key or Account mode, owns retained E2EE custody.
        if (session.encryptionMode === 'e2ee') return params.templateCiphertext;
        const { sessionEncryptionKeyBase64: _key, sessionEncryptionVariant: _variant, ...plainTemplate } = template;
        template = { ...plainTemplate, sessionEncryptionMode: 'plain' };
    } else if (params.toMode === 'plain') {
        const { sessionEncryptionKeyBase64: _key, sessionEncryptionVariant: _variant,
            sessionEncryptionMode: _mode, ...plainTemplate } = template;
        template = plainTemplate;
    }
    return encodeAutomationTemplateForTransport({ accountMode: params.toMode, template,
        ...(params.targetMaterial ? { encryptRaw: async (payload: unknown) => sealAccountScopedBlobCiphertext({
            kind: 'automation_template_payload', material: params.targetMaterial!, payload, randomBytes: getRandomBytes,
        }) } : {}),
    });
}

export type AccountEncryptionAutomationRecoveryResult = Readonly<AccountEncryptionAutomationTemplatesRecoverResultV1['templates'][number]>;

/** Same transition converter, with per-template CAS for predecessor data on an already-plain Account. */
export async function recoverAccountEncryptionMigrationAutomations(params: Readonly<{
    templates: readonly Readonly<{ automationId: string; expectedTemplateVersion: number; templateCiphertext: string }>[];
    historicalMaterial?: AccountScopedCryptoMaterial;
    resolveSession: MigrationTemplateSessionResolver;
    commitTemplate: (automationId: string, expectedTemplateVersion: number, templateCiphertext: string) => Promise<void>;
    isCurrent?: () => boolean;
}>): Promise<readonly AccountEncryptionAutomationRecoveryResult[]> {
    const assertCurrent = () => {
        if (params.isCurrent && !params.isCurrent()) throw new Error('Account encryption scope changed');
    };
    const results: AccountEncryptionAutomationRecoveryResult[] = [];
    for (const row of params.templates) {
        assertCurrent();
        if (readAccountEncryptionMigrationPlainAutomationTarget(row.templateCiphertext)) {
            results.push({ automationId: row.automationId, status: 'already_plain' });
            continue;
        }
        let templateCiphertext: string;
        try {
            templateCiphertext = await convertAccountEncryptionMigrationTemplate({ id: row.automationId,
                templateCiphertext: row.templateCiphertext, toMode: 'plain', historicalMaterial: params.historicalMaterial,
                resolveSession: params.resolveSession });
        } catch {
            assertCurrent();
            results.push({ automationId: row.automationId, status: 'locked' });
            continue;
        }
        assertCurrent();
        if (templateCiphertext === row.templateCiphertext) {
            results.push({ automationId: row.automationId, status: 'retained_e2ee' });
            continue;
        }
        try {
            await params.commitTemplate(row.automationId, row.expectedTemplateVersion, templateCiphertext);
        } catch (error) {
            assertCurrent();
            if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'automation_template_version_conflict') throw error;
            results.push({ automationId: row.automationId, status: 'conflict' });
            continue;
        }
        assertCurrent();
        results.push({ automationId: row.automationId, status: 'recovered' });
    }
    return results;
}

export async function buildAccountEncryptionMigrationAutomations(params: Readonly<{
    accountId: string; fromMode: 'plain' | 'e2ee'; toMode: 'plain' | 'e2ee';
    inventory: AccountEncryptionMigrateAutomationsInventoryResponse;
    sourceCredentials: AuthCredentials; targetCredentials: AuthCredentials | null;
    sourceEncryption: Encryption | null; targetEncryption: Encryption | null;
    resolveSession?: MigrationTemplateSessionResolver;
}>): Promise<AccountEncryptionMigrateAutomationsDirective> {
    if (!params.inventory.templates.length && !params.inventory.runs.length) return { action: 'assert_empty' };
    const snapshot = (mode: 'plain' | 'e2ee', credentials: AuthCredentials | null, encryption: Encryption | null) => {
        if (mode === 'plain') return undefined;
        if (!credentials) throw new AutomationTemplateEncryptionMaterialUnavailableError();
        const material = resolveAccountScopedCryptoMaterialFromCredentials(credentials);
        return createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee', material,
            ...(material.type === 'dataKey' ? { dataKeyPublicKey: encryption?.contentDataKey } : {}),
        });
    };
    const sourceMaterial = snapshot(params.fromMode, params.sourceCredentials, params.sourceEncryption);
    const targetMaterial = snapshot(params.toMode, params.targetCredentials, params.targetEncryption);
    const open = (serialized: string, kind: AccountScopedBlobKind): unknown => {
        const envelope = AutomationStoredContentEnvelopeV1Schema.parse(JSON.parse(serialized));
        if (params.fromMode === 'plain') {
            if (envelope.t !== 'plain') throw new Error('automation_stored_content_unavailable');
            return envelope.v;
        }
        if (envelope.t !== 'encrypted' || !sourceMaterial) throw new Error('automation_stored_content_unavailable');
        const opened = openAccountScopedBlobCiphertext({ kind, material: sourceMaterial.material, ciphertext: envelope.c });
        if (!opened) throw new Error('automation_stored_content_unavailable');
        return opened.value;
    };
    const seal = (payload: unknown, kind: AccountScopedBlobKind): string => JSON.stringify(
        params.toMode === 'plain' ? { t: 'plain', v: payload } : { t: 'encrypted', c: sealAccountScopedBlobCiphertext({
            kind, material: targetMaterial!.material, payload, randomBytes: getRandomBytes,
        }) },
    );
    const convert = (serialized: string | null, kind: AccountScopedBlobKind) => serialized === null ? null : seal(open(serialized, kind), kind);
    const templates = await Promise.all(params.inventory.templates.map(async row => ({
        automationId: row.automationId, expectedTemplateVersion: row.expectedTemplateVersion,
        templateCiphertext: await convertAccountEncryptionMigrationTemplate({ id: row.automationId,
            templateCiphertext: row.templateCiphertext, toMode: params.toMode,
            decryptRaw: sourceMaterial ? async ciphertext => openAccountScopedBlobCiphertext({ kind: 'automation_template_payload',
                material: sourceMaterial.material, ciphertext })?.value ?? null : undefined,
            targetMaterial: targetMaterial?.material, historicalMaterial: sourceMaterial?.material,
            resolveSession: params.resolveSession }),
        triggerDefinitionEnvelopes: row.triggerDefinitionEnvelopes.map(trigger => ({ ...trigger,
            envelope: convert(trigger.envelope, 'automation_trigger_definition')! })),
    })));
    const runs = params.inventory.runs.map(row => {
        // No supported legacy-summary opener exists in the canonical content owner.
        if (row.summaryCiphertext !== null) throw new Error('automation_legacy_summary_unsupported');
        let workflowTarget: ReturnType<typeof convertWorkflowRunAccountEncryptionV1> | undefined;
        if (row.workflow) {
            const witness = row.workflow.keyCensus.ownerAccountCurrentness;
            if (witness.mode !== params.fromMode) throw new Error('automation_stored_content_unavailable');
            if (sourceMaterial && witness.contentKeyFingerprint !== convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(sourceMaterial.contentPublicKeyFingerprint)) {
                throw new Error('automation_stored_content_unavailable');
            }
            const sourceEncryption: AvailableAutomationAccountEncryptionV1 = sourceMaterial
                ? { kind: 'available', witness: { ...witness, mode: 'e2ee', contentKeyFingerprint: witness.contentKeyFingerprint! }, material: sourceMaterial }
                : { kind: 'available', witness: { ...witness, mode: 'plain', contentKeyFingerprint: null } };
            // Proposed target only; Account activation remains owned by the signed V4 transaction.
            const targetEncryption: AvailableAutomationAccountEncryptionV1 = targetMaterial
                ? { kind: 'available', witness: { mode: 'e2ee', version: witness.version + 1,
                    contentKeyFingerprint: convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(targetMaterial.contentPublicKeyFingerprint) }, material: targetMaterial }
                : { kind: 'available', witness: { mode: 'plain', version: witness.version + 1, contentKeyFingerprint: null } };
            workflowTarget = convertWorkflowRunAccountEncryptionV1({ accountId: params.accountId, run: row,
                sourceEncryption, targetEncryption, randomBytes: getRandomBytes });
        }
        let occurrenceEvidenceEqualityTag: string | null = null;
        if (row.triggerEvidenceEnvelope !== null && targetMaterial) {
            if (!row.automationId || !row.occurrenceKey) throw new Error('automation_occurrence_binding_unavailable');
            const evidence = AutomationOccurrenceEvidenceV1Schema.parse(open(row.triggerEvidenceEnvelope, 'automation_trigger_evidence'));
            const binding = { accountId: params.accountId, automationId: row.automationId,
                occurrenceKey: AutomationOccurrenceKeyV1Schema.parse(row.occurrenceKey),
                purposeSeparatedAccountKey: deriveAutomationTriggerEvidenceEqualityKeyV1({ material: targetMaterial.material }) };
            if (evidence.kind === 'conversation') occurrenceEvidenceEqualityTag = deriveAutomationOccurrenceEvidenceEqualityTagV1({ ...binding, evidence });
            else {
                if (!row.triggerId) throw new Error('automation_occurrence_binding_unavailable');
                occurrenceEvidenceEqualityTag = deriveAutomationOccurrenceEvidenceEqualityTagV1({ ...binding, triggerId: row.triggerId, evidence });
            }
        }
        return { runId: row.runId, expectedRunRevision: row.expectedRunRevision,
            triggerEvidenceEnvelope: convert(row.triggerEvidenceEnvelope, 'automation_trigger_evidence'), occurrenceEvidenceEqualityTag,
            executionInputEnvelope: convert(row.executionInputEnvelope, 'automation_template_payload'),
            resultEnvelope: workflowTarget ? workflowTarget.resultEnvelope : convert(row.resultEnvelope, 'automation_run_result'),
            replyContextEnvelope: convert(row.replyContextEnvelope, 'automation_conversation_reply_context'),
            failureDetailEnvelope: convert(row.failureDetailEnvelope, 'automation_run_failure_detail'),
            ...(workflowTarget ? { workflow: workflowTarget.workflow } : {}),
        };
    });
    return AccountEncryptionMigrateAutomationsDirectiveSchema.parse({ action: 'migrate', templates, runs });
}
