import type { AutomationTriggerDefinitionInput } from '@happier-dev/protocol/automations/automationTriggerDefinition';
import { AutomationActionTriggerDefinitionEnvelopeV1Schema, AutomationActionTriggerSchema,
    projectAutomationActionTriggerStructuralV1, type AutomationActionTriggerDefinitionEnvelopeV1 } from '@happier-dev/protocol/automations/automationActionTriggerV1';
import { AutomationTriggerIdSchema } from '@happier-dev/protocol/automations/automationTriggerIdentity';
import { openAutomationTriggerDefinitionStoredEnvelopeV1, sealAutomationTriggerDefinitionStoredEnvelopeV1 } from '@happier-dev/protocol/automations/automationTriggerDefinitionStoredContent';
import { pluginJsonValuesEqual } from '@happier-dev/protocol/plugins/contributions/jsonSchemaValues';
import { parseWorkflowDefinitionRefV1 } from '@happier-dev/protocol/workflows/workflowDefinitionRefV1';
import { acquireArtifactPublicationLocksInTx, resolveArtifactAccessInTx } from '@/app/artifacts/artifactAccessService';
import type { ArtifactRevisionV1 } from '@happier-dev/protocol/artifacts/artifactRevisionV1';
import type { DeploymentAuthentication } from '@/app/deployments/deploymentAdmission';
import type { Tx } from '@/storage/inTx';
import { fetchAutomationAccountCurrentnessWitnessTx } from './automationAccountCurrentness';
import { resolveAutomationActionReachInTx } from './automationActionReachAdmission';
import { assertAutomationActionSubjectInTx } from './automationActionSubjectAdmission';
import { decodeAutomationActionTriggerConfiguration, type AutomationActionTriggerColumns } from './automationActionTriggerConfiguration';
import { AutomationStoredContentReadError, validateAutomationTriggerDefinitionEnvelopeOuterForMode } from './automationStoredContentRead';

type ActionInput = Exclude<Extract<AutomationTriggerDefinitionInput, { kind: 'action' }>, { consentFor: unknown }>;

/** Plain content and its server routing tuple must describe the same check. */
export function assertAutomationActionDefinitionStructuralMatch(definition: ReturnType<typeof AutomationActionTriggerSchema.parse>,
    structural: ReturnType<typeof projectAutomationActionTriggerStructuralV1>) {
    const { reachesOthers: _reach, ...matching } = structural;
    if (!pluginJsonValuesEqual(projectAutomationActionTriggerStructuralV1(definition), matching)) {
        throw new AutomationStoredContentReadError('contentInvalid');
    }
}

/** The carrier discriminator belongs to this writer, including retained Account-mode inventories. */
export function readAutomationActionDefinitionEnvelope(raw: string): AutomationActionTriggerDefinitionEnvelopeV1 {
    try { return AutomationActionTriggerDefinitionEnvelopeV1Schema.parse(JSON.parse(raw)); }
    catch { throw new AutomationStoredContentReadError('contentInvalid'); }
}

/** One admission for the private definition, its public projection, and resource-owned reach. */
export async function normalizeAutomationActionTriggerWriteInTx(params: Readonly<{
    tx: Tx;
    accountId: string;
    authentication?: DeploymentAuthentication;
    automation: Readonly<{ id: string; workflowDefinitionId: string | null }>;
    triggerId: string;
    triggerRevision: number;
    input: ActionInput;
}>) {
    const binding = { v: 1 as const, automationId: params.automation.id,
        triggerId: AutomationTriggerIdSchema.parse(params.triggerId),
        triggerRevision: params.triggerRevision, triggerKind: 'action' as const };
    const { enabled: _enabled, ...submitted } = params.input;
    const structural = 'triggerDefinitionEnvelope' in submitted
        ? (({ triggerDefinitionEnvelope: _envelope, ...facts }) => facts)(submitted)
        : projectAutomationActionTriggerStructuralV1(submitted);
    let envelope = 'triggerDefinitionEnvelope' in submitted ? submitted.triggerDefinitionEnvelope : undefined;
    const reference = parseWorkflowDefinitionRefV1(params.automation.workflowDefinitionId);
    let workflowRevision: ArtifactRevisionV1 | undefined;
    let mode: 'plain' | 'e2ee';
    if (reference?.kind === 'artifact') {
        // The Artifact writer's parent lock serializes this child write with key replacement.
        await acquireArtifactPublicationLocksInTx(params.tx, reference.artifactId, [params.accountId], { intent: 'content' });
        const access = await resolveArtifactAccessInTx(params.tx, { actorAccountId: params.accountId,
            artifactId: reference.artifactId });
        if (!access?.encryptionMode) throw new AutomationStoredContentReadError('contentInvalid');
        mode = access.encryptionMode;
        const revision = await params.tx.artifact.findUnique({ where: { id: reference.artifactId },
            select: { headerVersion: true, bodyVersion: true } });
        if (!revision) throw new AutomationStoredContentReadError('contentInvalid');
        workflowRevision = revision;
        if (envelope?.t === 'workflow') {
            if (envelope.revision.headerVersion !== revision.headerVersion || envelope.revision.bodyVersion !== revision.bodyVersion) {
                throw new AutomationStoredContentReadError('contentInvalid');
            }
        } else if (envelope?.t === 'encrypted') {
            throw new AutomationStoredContentReadError('modeMismatch');
        } else if (envelope) {
            envelope = { t: 'workflow', revision, content: envelope };
        }
    } else {
        if (envelope?.t === 'workflow') throw new AutomationStoredContentReadError('contentInvalid');
        const currentness = await fetchAutomationAccountCurrentnessWitnessTx(params.tx, params.accountId);
        if (!currentness) throw new AutomationStoredContentReadError('contentInvalid');
        mode = currentness.mode;
    }
    if (!envelope) {
        if (mode !== 'plain') throw new AutomationStoredContentReadError('modeMismatch');
        const content = sealAutomationTriggerDefinitionStoredEnvelopeV1({ mode: 'plain', binding,
            definition: AutomationActionTriggerSchema.parse(submitted) });
        envelope = workflowRevision ? { t: 'workflow', revision: workflowRevision, content } : content;
    }
    const content = envelope.t === 'workflow' ? envelope.content : envelope;
    if ((mode === 'plain') !== (content.t === 'plain')) throw new AutomationStoredContentReadError('modeMismatch');
    let reachesOthers: boolean;
    if (content.t === 'plain') {
        const opened = openAutomationTriggerDefinitionStoredEnvelopeV1({ mode: 'plain', binding, envelope: content });
        if (opened.kind !== 'available') throw new AutomationStoredContentReadError('contentInvalid');
        const definition = AutomationActionTriggerSchema.parse(opened.definition);
        await assertAutomationActionSubjectInTx(params.tx, { accountId: params.accountId,
            actionIds: definition.actionIds, subject: definition.subject });
        assertAutomationActionDefinitionStructuralMatch(definition, structural);
        reachesOthers = await resolveAutomationActionReachInTx(params.tx, { accountId: params.accountId,
            authentication: params.authentication, definition: { mode: 'plain', subject: definition.subject } });
    } else {
        if (envelope.t !== 'workflow' && validateAutomationTriggerDefinitionEnvelopeOuterForMode({
            raw: JSON.stringify(envelope), mode, binding,
        }).kind !== 'available') throw new AutomationStoredContentReadError('contentInvalid');
        reachesOthers = await resolveAutomationActionReachInTx(params.tx, { accountId: params.accountId,
            authentication: params.authentication, definition: { mode: 'e2ee', subjectKind: structural.subjectKind,
                subjectKey: structural.subjectKey, claimedReachesOthers: structural.reachesOthers } });
    }
    return { kind: 'action' as const,
        actionId: structural.actionIds.length === 1 ? structural.actionIds[0] : null,
        actionIdsJson: JSON.stringify(structural.actionIds), phase: structural.phase,
        mode: structural.mode ?? null, onFailure: structural.onFailure ?? null,
        subjectKind: structural.subjectKind ?? null, subjectKey: structural.subjectKey ?? null,
        reachesOthers, definitionEnvelope: JSON.stringify(envelope) };
}

/** Enable-only writes retain the authored definition while advancing its exact binding. */
export async function resealAutomationActionTriggerWriteInTx(params: Readonly<{
    tx: Tx;
    accountId: string;
    authentication?: DeploymentAuthentication;
    automation: Readonly<{ id: string; workflowDefinitionId: string | null }>;
    trigger: AutomationActionTriggerColumns & Readonly<{ id: string; revision: number; definitionEnvelope: string | null }>;
    enabled: boolean;
    nextEnvelope?: AutomationActionTriggerDefinitionEnvelopeV1;
}>) {
    let nextEnvelope = params.nextEnvelope;
    const configuration = decodeAutomationActionTriggerConfiguration(params.trigger);
    if ('consentFor' in configuration || params.trigger.definitionEnvelope === null) {
        throw new AutomationStoredContentReadError('contentInvalid');
    }
    const binding = { v: 1 as const, automationId: params.automation.id,
        triggerId: AutomationTriggerIdSchema.parse(params.trigger.id), triggerRevision: params.trigger.revision,
        triggerKind: 'action' as const };
    const triggerRevision = binding.triggerRevision + 1;
    if (!nextEnvelope) {
        const previous = readAutomationActionDefinitionEnvelope(params.trigger.definitionEnvelope);
        const content = previous.t === 'workflow' ? previous.content : previous;
        if (content.t !== 'plain') throw new AutomationStoredContentReadError('contentInvalid');
        const opened = openAutomationTriggerDefinitionStoredEnvelopeV1({ mode: 'plain',
            binding, envelope: content });
        if (opened.kind !== 'available') throw new AutomationStoredContentReadError('contentInvalid');
        const resealed = sealAutomationTriggerDefinitionStoredEnvelopeV1({ mode: 'plain',
            binding: { ...binding, triggerRevision }, definition: opened.definition });
        // The server can reseal plain content against the locked current Artifact revision.
        nextEnvelope = resealed;
    }
    const { reachesOthers: _previousReach, ...structural } = configuration;
    return normalizeAutomationActionTriggerWriteInTx({ ...params,
        triggerId: binding.triggerId, triggerRevision,
        input: { ...structural, enabled: params.enabled, triggerDefinitionEnvelope: nextEnvelope } });
}
