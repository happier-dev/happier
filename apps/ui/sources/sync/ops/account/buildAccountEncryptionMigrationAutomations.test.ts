import { describe, expect, it } from 'vitest';
import { AutomationTriggerIdSchema, deriveAccountMachineKeyFromRecoverySecret, openAutomationTemplateStoredForMigrationV1,
    sealAccountScopedBlobCiphertext, serializeAutomationStoredDefinitionExecutionRecipeV1,
    serializeAutomationStoredWorkflowDefinitionRecipeV2, type AccountEncryptionMigrateAutomationsInventoryResponse,
    type AccountScopedCryptoMaterial } from '@happier-dev/protocol';
import {
    AUTOMATION_TEMPLATE_V02_ENCRYPTED,
    AUTOMATION_TEMPLATE_V02_EXISTING_ENCRYPTED,
    AUTOMATION_TEMPLATE_V02_EXISTING_RAW_ENCRYPTED,
    AUTOMATION_TEMPLATE_V02_RAW_ENCRYPTED,
} from '../../../../../../packages/protocol/src/automations/automationTemplateV02.testFixtures';
import {
    convertAccountEncryptionMigrationTemplate,
    isAccountEncryptionMigrationAutomationContentPlain,
    recoverAccountEncryptionMigrationAutomations,
} from './buildAccountEncryptionMigrationAutomations';

const historicalMaterial: AccountScopedCryptoMaterial = { type: 'legacy', secret: new Uint8Array(32).fill(7) };
const plainSession = async (sessionId: string) => ({ sessionId, encryptionMode: 'plain' as const });
const retainedSession = async (sessionId: string) => ({ sessionId, encryptionMode: 'e2ee' as const });
const row = (templateCiphertext: string) => ({ automationId: 'automation-old', expectedTemplateVersion: 4, templateCiphertext });

describe('Account transition Automation recovery', () => {
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
        for (const content of [JSON.stringify({ ...definition, template: { t: 'encrypted', c: 'unavailable' } }),
            JSON.stringify({ ...workflow, workflow: { t: 'encrypted', c: 'unavailable' } }),
            JSON.stringify({ ...workflow, unauthorized: true })]) {
            expect(await recoverAccountEncryptionMigrationAutomations({ templates: [row(content)], historicalMaterial,
                resolveSession: plainSession, commitTemplate: async (_id, _version, next) => { writes.push(next); },
            })).toEqual([{ automationId: 'automation-old', status: 'locked' }]);
        }
        expect(writes).toEqual([]);
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
