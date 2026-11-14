import { describe, expect, it } from 'vitest';
import { AutomationTriggerIdSchema } from '@happier-dev/protocol/automations/automationTriggerIdentity';
import { deriveAccountMachineKeyFromRecoverySecret, openAccountScopedBlobCiphertext, sealAccountScopedBlobCiphertext,
    deriveAutomationTriggerEvidenceEqualityKeyV1, type AccountScopedCryptoMaterial } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { AutomationOccurrenceEvidenceV1Schema, deriveAutomationOccurrenceKeyV1, deriveAutomationOccurrenceEvidenceEqualityTagV1 } from '@happier-dev/protocol/automations/automationOccurrenceV1';
import { AutomationStoredContentEnvelopeV1Schema } from '@happier-dev/protocol/automations/automationStoredContentEnvelopeV1';
import { openAutomationTemplateStoredForMigrationV1 } from '@happier-dev/protocol/automations/automationTemplateStoredV1';
import { parseAutomationStoredDefinitionExecutionRecipeV1, serializeAutomationStoredDefinitionExecutionRecipeV1 } from '@happier-dev/protocol/automations/automationRunExecutionRecipeV1';
import { parseAutomationStoredWorkflowDefinitionRecipeV2, serializeAutomationStoredWorkflowDefinitionRecipeV2 } from '@happier-dev/protocol/automations/automationWorkflowRecipeV2';
import type { AccountEncryptionMigrateAutomationsInventoryResponse } from '@happier-dev/protocol/account/encryptionMigrate';
import {
    AUTOMATION_TEMPLATE_V02_ENCRYPTED,
    AUTOMATION_TEMPLATE_V02_EXISTING_ENCRYPTED,
    AUTOMATION_TEMPLATE_V02_EXISTING_RAW_ENCRYPTED,
    AUTOMATION_TEMPLATE_V02_RAW_ENCRYPTED,
} from '../../../../../../packages/protocol/src/automations/automationTemplateV02.testFixtures';
import {
    buildAccountEncryptionMigrationAutomations,
    convertAccountEncryptionMigrationTemplate,
    isAccountEncryptionMigrationAutomationContentPlain,
    recoverAccountEncryptionMigrationAutomations,
} from './buildAccountEncryptionMigrationAutomations';

const historicalMaterial: AccountScopedCryptoMaterial = { type: 'legacy', secret: new Uint8Array(32).fill(7) };
const plainSession = async (sessionId: string) => ({ sessionId, encryptionMode: 'plain' as const });
const retainedSession = async (sessionId: string) => ({ sessionId, encryptionMode: 'e2ee' as const });
const row = (templateCiphertext: string) => ({ automationId: 'automation-old', expectedTemplateVersion: 4, templateCiphertext });

describe('Account transition Automation recovery', () => {
    it('preserves observation-only intent while advancing the existing definition revision on a mode change', async () => {
        const observationOnly = JSON.stringify({ kind: 'observationOnly', templateVersion: 4 });
        const converted = await convertAccountEncryptionMigrationTemplate({ id: 'monitor',
            templateCiphertext: observationOnly, toMode: 'e2ee' });
        expect(JSON.parse(converted)).toEqual({ kind: 'observationOnly', templateVersion: 5 });
        const writes: string[] = [];
        expect(await recoverAccountEncryptionMigrationAutomations({ templates: [row(observationOnly)],
            historicalMaterial, resolveSession: plainSession,
            commitTemplate: async (_id, _version, content) => { writes.push(content); },
        })).toEqual([{ automationId: 'automation-old', status: 'already_plain' }]);
        expect(writes).toEqual([]);
    });
    it('normalizes retained occurrence evidence before deriving transition equality', async () => {
        const targetCredentials = { token: 'target', secret: Buffer.from(new Uint8Array(32).fill(7)).toString('base64url') };
        const knownEvidence = { v: 1 as const, kind: 'schedule' as const, scheduledFor: 1234 };
        const evidence = { ...knownEvidence, retired: true };
        const triggerId = AutomationTriggerIdSchema.parse('trigger-a');
        const occurrenceKey = deriveAutomationOccurrenceKeyV1({ triggerId, evidence: knownEvidence });
        const sealedInventory: AccountEncryptionMigrateAutomationsInventoryResponse = { templates: [], runs: [{
            runId: 'run-a', expectedRunRevision: 1, automationId: 'automation-a',
            occurrenceKey, triggerId,
            summaryCiphertext: null, triggerEvidenceEnvelope: JSON.stringify({ t: 'encrypted',
                c: sealAccountScopedBlobCiphertext({ kind: 'automation_trigger_evidence', material: historicalMaterial,
                    payload: knownEvidence, randomBytes: length => new Uint8Array(length).fill(9) }) }),
            occurrenceEvidenceEqualityTag: null, executionInputEnvelope: null, resultEnvelope: null,
            replyContextEnvelope: null, failureDetailEnvelope: null,
        }] };
        const produced = await buildAccountEncryptionMigrationAutomations({ accountId: 'account-a', fromMode: 'e2ee', toMode: 'plain',
            inventory: sealedInventory, sourceCredentials: targetCredentials, targetCredentials: null,
            sourceEncryption: null, targetEncryption: null });
        if (produced.action !== 'migrate') throw new Error('Expected canonical migration producer output');
        const stored = AutomationStoredContentEnvelopeV1Schema.parse(JSON.parse(produced.runs[0]!.triggerEvidenceEnvelope!));
        if (stored.t !== 'plain') throw new Error('Expected canonical plain producer output');
        const producedEvidence = AutomationOccurrenceEvidenceV1Schema.parse(stored.v);
        const inventory = { ...sealedInventory, runs: [{ ...sealedInventory.runs[0]!,
            triggerEvidenceEnvelope: JSON.stringify({ ...stored, v: { ...producedEvidence, retired: true } }),
        }] };
        const result = await buildAccountEncryptionMigrationAutomations({ accountId: 'account-a', fromMode: 'plain', toMode: 'e2ee',
            inventory, sourceCredentials: { token: 'source' }, targetCredentials,
            sourceEncryption: null, targetEncryption: null });
        expect(result.action).toBe('migrate');
        if (result.action !== 'migrate') throw new Error('Expected transition');
        expect(result.runs[0]?.occurrenceEvidenceEqualityTag).toBe(deriveAutomationOccurrenceEvidenceEqualityTagV1({
            accountId: 'account-a', automationId: 'automation-a', triggerId, occurrenceKey, evidence: knownEvidence,
            purposeSeparatedAccountKey: deriveAutomationTriggerEvidenceEqualityKeyV1({ material: historicalMaterial }),
        }));
        const opened = openAccountScopedBlobCiphertext({ kind: 'automation_trigger_evidence', material: historicalMaterial,
            ciphertext: JSON.parse(result.runs[0]!.triggerEvidenceEnvelope!).c });
        expect(opened?.value).toEqual(evidence);
        await expect(buildAccountEncryptionMigrationAutomations({ accountId: 'account-a', fromMode: 'plain', toMode: 'e2ee',
            inventory: { ...inventory, runs: [{ ...inventory.runs[0]!, triggerEvidenceEnvelope: JSON.stringify({ t: 'plain',
                v: { ...evidence, scheduledFor: -1 } }) }] }, sourceCredentials: { token: 'source' }, targetCredentials,
            sourceEncryption: null, targetEncryption: null })).rejects.toThrow();
    });
    it('does not declare historical material dispensable while trigger or retained Run content still needs it', () => {
        const plain = JSON.stringify({ t: 'plain', v: { retained: 'content' } });
        const inventory: AccountEncryptionMigrateAutomationsInventoryResponse = { templates: [], runs: [{
            runId: 'old-run', expectedRunRevision: 1, automationId: null, occurrenceKey: null, triggerId: null,
            summaryCiphertext: null, triggerEvidenceEnvelope: null, occurrenceEvidenceEqualityTag: null,
            executionInputEnvelope: null, resultEnvelope: plain, replyContextEnvelope: null, failureDetailEnvelope: null,
        }] };
        expect(isAccountEncryptionMigrationAutomationContentPlain(inventory)).toBe(true);
        expect(isAccountEncryptionMigrationAutomationContentPlain({ ...inventory, runs: [{ ...inventory.runs[0]!,
            summaryCiphertext: 'retained-summary', resultEnvelope: JSON.stringify({ t: 'legacySummaryCiphertext', c: 'retained-summary' }),
        }] })).toBe(false);
        expect(isAccountEncryptionMigrationAutomationContentPlain({ ...inventory, runs: [{ ...inventory.runs[0]!,
            resultEnvelope: JSON.stringify({ t: 'encrypted', c: 'retained-result' }),
        }] })).toBe(false);
        expect(isAccountEncryptionMigrationAutomationContentPlain({ templates: [{
            ...row(JSON.stringify({ kind: 'happier_automation_template_plain_v1', payload: { directory: '/repo', prompt: 'Review' } })),
            triggerDefinitionEnvelopes: [{ triggerId: AutomationTriggerIdSchema.parse('trigger-old'), triggerRevision: 1,
                envelope: JSON.stringify({ t: 'encrypted', c: 'retained-trigger' }) }],
        }], runs: [] })).toBe(false);
    });

    it('leaves valid current plain recipes untouched without treating current encrypted or malformed recipes as recovered', async () => {
        const definition = { v: 1, templateVersion: 2,
            template: { t: 'plain', v: { v: 1, prompt: 'Current task' } }, triggerEvidence: null,
            target: { kind: 'executionRun', request: { intent: 'task',
                backendTarget: { kind: 'builtInAgent', agentId: 'codex' }, permissionMode: 'read_only',
                retentionPolicy: 'ephemeral', runClass: 'bounded', ioMode: 'request_response' } } };
        const workflow = { v: 2, templateVersion: 3,
            workflow: { t: 'plain', v: { workspace: { directory: '/repo' }, executionTarget: { kind: 'session' } } },
            triggerEvidence: null };
        const current = [serializeAutomationStoredDefinitionExecutionRecipeV1(definition),
            serializeAutomationStoredWorkflowDefinitionRecipeV2(workflow)];
        const writes: string[] = [];
        for (const serialized of current) {
            if (serialized.kind !== 'available') throw new Error('Invalid current recipe fixture');
            expect(await recoverAccountEncryptionMigrationAutomations({ templates: [row(serialized.serialized)],
                historicalMaterial, resolveSession: plainSession,
                commitTemplate: async (_id, _version, content) => { writes.push(content); },
            })).toEqual([{ automationId: 'automation-old', status: 'already_plain' }]);
        }
        expect(await recoverAccountEncryptionMigrationAutomations({ templates: [row(JSON.stringify({ ...workflow, retired: true }))],
            historicalMaterial, resolveSession: plainSession,
            commitTemplate: async (_id, _version, next) => { writes.push(next); },
        })).toEqual([{ automationId: 'automation-old', status: 'already_plain' }]);
        expect(serializeAutomationStoredWorkflowDefinitionRecipeV2({ ...workflow, retired: true }).kind).toBe('contentInvalid');
        for (const content of [JSON.stringify({ ...definition, template: { t: 'encrypted', c: 'unavailable' } }),
            JSON.stringify({ ...workflow, workflow: { t: 'encrypted', c: 'unavailable' } }),
            JSON.stringify({ ...workflow, templateVersion: 'invalid' })]) {
            expect(await recoverAccountEncryptionMigrationAutomations({ templates: [row(content)], historicalMaterial,
                resolveSession: plainSession, commitTemplate: async (_id, _version, next) => { writes.push(next); },
            })).toEqual([{ automationId: 'automation-old', status: 'locked' }]);
        }
        expect(writes).toEqual([]);
    });

    it.each([
        {
            kind: 'Action',
            serialize: () => serializeAutomationStoredDefinitionExecutionRecipeV1({
                v: 1,
                templateVersion: 2,
                template: { t: 'encrypted', c: sealAccountScopedBlobCiphertext({
                    kind: 'automation_template_payload', material: historicalMaterial,
                    payload: { v: 1, prompt: 'Current task', display: { name: 'Private action', description: null } },
                    randomBytes: length => new Uint8Array(length).fill(3),
                }) },
                triggerEvidence: null,
                target: { kind: 'executionRun', request: { intent: 'task',
                    backendTarget: { kind: 'builtInAgent', agentId: 'codex' }, permissionMode: 'read_only',
                    retentionPolicy: 'ephemeral', runClass: 'bounded', ioMode: 'request_response' } },
            }),
            readDisplay: (serialized: string) => {
                const parsed = parseAutomationStoredDefinitionExecutionRecipeV1(serialized);
                if (parsed.kind !== 'available' || parsed.recipe.template.t !== 'plain') throw new Error('expected plain Action recipe');
                return parsed.recipe.template.v.display;
            },
        },
        {
            kind: 'Workflow',
            serialize: () => serializeAutomationStoredWorkflowDefinitionRecipeV2({
                v: 2,
                templateVersion: 2,
                workflow: { t: 'encrypted', c: sealAccountScopedBlobCiphertext({
                    kind: 'automation_template_payload', material: historicalMaterial,
                    payload: { workspace: { directory: '/repo' }, executionTarget: { kind: 'session' },
                        display: { name: 'Private workflow', description: 'Keep this title private' } },
                    randomBytes: length => new Uint8Array(length).fill(3),
                }) },
                triggerEvidence: null,
            }),
            readDisplay: (serialized: string) => {
                const parsed = parseAutomationStoredWorkflowDefinitionRecipeV2(serialized);
                if (parsed.kind !== 'available' || parsed.recipe.workflow.t !== 'plain') throw new Error('expected plain Workflow recipe');
                return parsed.recipe.workflow.v.display;
            },
        },
    ])('converts the current $kind display carrier with the existing Account transition', async ({ serialize, readDisplay }) => {
        const recipe = serialize();
        if (recipe.kind !== 'available') throw new Error('expected current recipe');
        const retainedOuterField = { introducedByANewerWriter: true };
        const retainedRecipe = JSON.stringify({ ...JSON.parse(recipe.serialized), retainedOuterField });
        const sourceCredentials = { token: 'source', secret: Buffer.from(new Uint8Array(32).fill(7)).toString('base64url') };
        const eventDisplay = { name: 'Private event monitor', description: 'Keep this Event title private' };
        const triggerEnvelope = JSON.stringify({ t: 'encrypted', c: sealAccountScopedBlobCiphertext({
            kind: 'automation_trigger_definition', material: historicalMaterial,
            payload: { v: 1, binding: { v: 1, automationId: 'automation-current', triggerId: 'trigger-current',
                triggerRevision: 1, triggerKind: 'pluginEvent',
                eventRef: { pluginId: 'com.example.events', localId: 'changed' },
                sourceSelectorId: '11111111-1111-4111-8111-111111111111' },
            definition: { v: 1, automationDisplay: eventDisplay } },
            randomBytes: length => new Uint8Array(length).fill(4),
        }) });
        const directive = await buildAccountEncryptionMigrationAutomations({
            accountId: 'account-current', fromMode: 'e2ee', toMode: 'plain',
            inventory: { templates: [{ ...row(retainedRecipe), automationId: 'automation-current',
                triggerDefinitionEnvelopes: [{ triggerId: AutomationTriggerIdSchema.parse('trigger-current'), triggerRevision: 1,
                    envelope: triggerEnvelope }] }], runs: [] },
            sourceCredentials, targetCredentials: null, sourceEncryption: null, targetEncryption: null,
        });
        if (directive.action !== 'migrate') throw new Error('expected migration directive');
        expect(readDisplay(directive.templates[0]!.templateCiphertext)).toMatchObject({ name: expect.stringMatching(/^Private /) });
        expect(JSON.parse(directive.templates[0]!.templateCiphertext)).toMatchObject({ retainedOuterField });
        const migratedTrigger = AutomationStoredContentEnvelopeV1Schema.parse(
            JSON.parse(directive.templates[0]!.triggerDefinitionEnvelopes[0]!.envelope),
        );
        if (migratedTrigger.t !== 'plain') throw new Error('expected plain Event envelope');
        expect(migratedTrigger.v).toMatchObject({ definition: { automationDisplay: eventDisplay } });
    });

    it.each([AUTOMATION_TEMPLATE_V02_ENCRYPTED, AUTOMATION_TEMPLATE_V02_RAW_ENCRYPTED,
        AUTOMATION_TEMPLATE_V02_EXISTING_ENCRYPTED, AUTOMATION_TEMPLATE_V02_EXISTING_RAW_ENCRYPTED])
        ('recovers exact predecessor bytes to canonical plain content and is idempotent', async (templateCiphertext) => {
            const writes: Array<{ id: string; version: number; content: string }> = [];
            const recover = (content: string) => recoverAccountEncryptionMigrationAutomations({
                templates: [row(content)], historicalMaterial, resolveSession: plainSession,
                commitTemplate: async (id, version, next) => { writes.push({ id, version, content: next }); },
            });
            expect(await recover(templateCiphertext)).toEqual([{ automationId: 'automation-old', status: 'recovered' }]);
            expect(writes).toHaveLength(1);
            expect(writes[0]).toMatchObject({ id: 'automation-old', version: 4 });
            expect(JSON.parse(writes[0]!.content)).toMatchObject({ kind: 'happier_automation_template_plain_v1',
                payload: { directory: '/repo', prompt: 'Review the release' } });
            expect(JSON.parse(writes[0]!.content)).not.toHaveProperty('existingSessionId');
            expect(await recover(writes[0]!.content)).toEqual([{ automationId: 'automation-old', status: 'already_plain' }]);
            expect(writes).toHaveLength(1);
        });

    it('preserves an exact retained E2EE Session template even when its Session key is not embedded', async () => {
        const converted = await convertAccountEncryptionMigrationTemplate({ id: 'automation-old',
            templateCiphertext: AUTOMATION_TEMPLATE_V02_EXISTING_ENCRYPTED, toMode: 'plain',
            historicalMaterial, resolveSession: retainedSession });
        expect(converted).toBe(AUTOMATION_TEMPLATE_V02_EXISTING_ENCRYPTED);
        const writes: string[] = [];
        expect(await recoverAccountEncryptionMigrationAutomations({ templates: [row(converted)],
            historicalMaterial, resolveSession: retainedSession,
            commitTemplate: async (_id, _version, content) => { writes.push(content); },
        })).toEqual([{ automationId: 'automation-old', status: 'retained_e2ee' }]);
        expect(writes).toEqual([]);
    });

    it.each([
        { templateCiphertext: AUTOMATION_TEMPLATE_V02_ENCRYPTED,
            machineKey: deriveAccountMachineKeyFromRecoverySecret(new Uint8Array(32).fill(7)) },
        { templateCiphertext: AUTOMATION_TEMPLATE_V02_RAW_ENCRYPTED, machineKey: new Uint8Array(32).fill(7) },
    ])('recovers scoped and raw predecessor bytes using genuine historical machine-key custody', async ({ templateCiphertext, machineKey }) => {
        let committed: string | null = null;
        expect(await recoverAccountEncryptionMigrationAutomations({ templates: [row(templateCiphertext)],
            historicalMaterial: { type: 'dataKey', machineKey }, resolveSession: plainSession,
            commitTemplate: async (_id, _version, content) => { committed = content; },
        })).toEqual([{ automationId: 'automation-old', status: 'recovered' }]);
        expect(JSON.parse(committed!)).toMatchObject({ kind: 'happier_automation_template_plain_v1',
            payload: { directory: '/repo', prompt: 'Review the release' } });
    });

    it('uses authoritative Session mode rather than a stale embedded key when recovering', async () => {
        const opened = openAutomationTemplateStoredForMigrationV1({
            templateCiphertext: AUTOMATION_TEMPLATE_V02_EXISTING_ENCRYPTED, material: historicalMaterial,
        });
        expect(opened.ok).toBe(true);
        if (!opened.ok) throw new Error('Pinned predecessor fixture unavailable');
        const encrypted = JSON.stringify({ kind: 'happier_automation_template_encrypted_v1', existingSessionId: 'session-old',
            payloadCiphertext: sealAccountScopedBlobCiphertext({ kind: 'automation_template_payload', material: historicalMaterial,
                payload: { ...opened.template, sessionEncryptionMode: 'e2ee', sessionEncryptionKeyBase64: 'old-session-key' },
                randomBytes: (size) => new Uint8Array(size).fill(1) }),
        });
        await expect(convertAccountEncryptionMigrationTemplate({ id: 'old', templateCiphertext: encrypted,
            toMode: 'plain', historicalMaterial })).rejects.toThrow('encryption material is unavailable');
        const converted = await convertAccountEncryptionMigrationTemplate({ id: 'old', templateCiphertext: encrypted,
            toMode: 'plain', historicalMaterial, resolveSession: plainSession });
        expect(JSON.parse(converted).payload).toMatchObject({ existingSessionId: 'session-old', sessionEncryptionMode: 'plain' });
        expect(JSON.parse(converted).payload).not.toHaveProperty('sessionEncryptionKeyBase64');
    });

    it('leaves failed decryptions and unavailable target Sessions locked with zero writes', async () => {
        const writes: string[] = [];
        const commitTemplate = async (_id: string, _version: number, content: string) => { writes.push(content); };
        expect(await recoverAccountEncryptionMigrationAutomations({ templates: [row(AUTOMATION_TEMPLATE_V02_ENCRYPTED)],
            historicalMaterial: { type: 'legacy', secret: new Uint8Array(32).fill(8) }, resolveSession: plainSession,
            commitTemplate,
        })).toEqual([{ automationId: 'automation-old', status: 'locked' }]);
        expect(await recoverAccountEncryptionMigrationAutomations({ templates: [row(AUTOMATION_TEMPLATE_V02_EXISTING_ENCRYPTED)],
            historicalMaterial, resolveSession: async () => null, commitTemplate,
        })).toEqual([{ automationId: 'automation-old', status: 'locked' }]);
        expect(writes).toEqual([]);
    });

    it('does not overwrite a CAS conflict or retry it and continues independent recovery', async () => {
        const attempts: string[] = [];
        const conflict = Object.assign(new Error('Changed elsewhere'), { code: 'automation_template_version_conflict' });
        expect(await recoverAccountEncryptionMigrationAutomations({ templates: [row(AUTOMATION_TEMPLATE_V02_ENCRYPTED),
            { ...row(AUTOMATION_TEMPLATE_V02_ENCRYPTED), automationId: 'next' }], historicalMaterial,
            resolveSession: plainSession, commitTemplate: async (id) => {
                attempts.push(id);
                if (id === 'automation-old') throw conflict;
            },
        })).toEqual([{ automationId: 'automation-old', status: 'conflict' }, { automationId: 'next', status: 'recovered' }]);
        expect(attempts).toEqual(['automation-old', 'next']);
    });

    it('stops before mutation when the captured Account scope is no longer current', async () => {
        const writes: string[] = [];
        let current = true;
        await expect(recoverAccountEncryptionMigrationAutomations({
            templates: [row(AUTOMATION_TEMPLATE_V02_EXISTING_ENCRYPTED)], historicalMaterial,
            resolveSession: async (sessionId) => { current = false; return plainSession(sessionId); },
            isCurrent: () => current, commitTemplate: async (id) => { writes.push(id); },
        })).rejects.toThrow('Account encryption scope changed');
        expect(writes).toEqual([]);
    });
});
