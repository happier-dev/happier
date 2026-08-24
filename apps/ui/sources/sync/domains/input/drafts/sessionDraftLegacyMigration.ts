import type { StrictJsonValue } from '@happier-dev/protocol';

import { randomUUID } from '@/platform/randomUUID';
import {
    clearNewSessionDraft,
    loadNewSessionDraft,
    loadSessionDrafts,
    saveSessionDrafts,
    type NewSessionDraft,
} from '@/sync/domains/state/persistence';
import {
    loadPersistedSessionDraftValues,
    savePersistedSessionDraftValues,
    type PersistedSessionDraftValuesBySessionId,
} from '@/sync/domains/state/sessionDraftValuesPersistence';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import {
    flushSessionDraft,
    getSessionDraftSnapshot,
    isSessionDraftRemoteAcknowledged,
    listNewSessionDraftProjections,
    writeExistingSessionDraft,
    writeNewSessionDraft,
    writeSessionDraftLocalSupplement,
    type ExistingSessionDraftPatch,
} from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import { SessionDraftValueFieldSchemas } from '@/sync/domains/input/draftValues/sessionDraftValueTypes';

import { projectSyncedSessionAuthoringFields } from './sessionAuthoringDraftProjection';

function asStrictJsonValue(value: unknown): StrictJsonValue {
    return value as StrictJsonValue;
}

function buildExistingPatch(
    text: string | undefined,
    values: PersistedSessionDraftValuesBySessionId[string] | undefined,
): Readonly<{ patch: ExistingSessionDraftPatch; fullyProjected: boolean }> {
    const patch: {
        text?: string;
        mentions?: readonly StrictJsonValue[];
        routing?: {
            recipient?: StrictJsonValue;
            agentContinuation?: StrictJsonValue;
            executionRunDelivery?: StrictJsonValue;
        };
    } = {};
    if (text !== undefined) patch.text = text;
    let fullyProjected = true;
    const routing: NonNullable<typeof patch.routing> = {};
    for (const [fieldId, envelope] of Object.entries(values ?? {})) {
        if (!(fieldId in SessionDraftValueFieldSchemas)) {
            fullyProjected = false;
            continue;
        }
        const typedFieldId = fieldId as keyof typeof SessionDraftValueFieldSchemas;
        const parsed = SessionDraftValueFieldSchemas[typedFieldId].safeParse(envelope.value);
        if (!parsed.success) {
            fullyProjected = false;
            continue;
        }
        if (typedFieldId === 'structuredInput.mentions') {
            patch.mentions = parsed.data as readonly StrictJsonValue[];
        } else if (typedFieldId === 'routing.recipient') {
            routing.recipient = asStrictJsonValue({ mode: 'manual', recipient: parsed.data });
        } else if (typedFieldId === 'routing.agentContinuation') {
            routing.agentContinuation = asStrictJsonValue(parsed.data);
        } else {
            routing.executionRunDelivery = asStrictJsonValue(parsed.data);
        }
    }
    if (Object.keys(routing).length > 0) patch.routing = routing;
    return { patch, fullyProjected };
}

function buildNewPatch(draft: NewSessionDraft): Readonly<{
    text: string;
    authoring: ReturnType<typeof projectSyncedSessionAuthoringFields>;
}> {
    return {
        text: draft.input,
        authoring: projectSyncedSessionAuthoringFields({
            targetType: 'new_session',
            ...(draft.selectedMachineId ? { machineId: draft.selectedMachineId } : {}),
            ...(draft.targetServerId ? { serverId: draft.targetServerId } : {}),
            ...(draft.selectedPath ? { directory: draft.selectedPath } : {}),
            ...(draft.checkoutCreationDraft ? { checkoutCreationDraft: draft.checkoutCreationDraft } : {}),
            agentId: draft.agentType,
            ...(draft.backendTarget !== undefined ? { backendTarget: draft.backendTarget } : {}),
            ...(draft.transcriptStorage !== undefined ? { transcriptStorage: draft.transcriptStorage } : {}),
            profileId: draft.selectedProfileId,
            ...(draft.resumeSessionId ? { resumeSessionId: draft.resumeSessionId } : {}),
            permissionMode: draft.permissionMode,
            modelId: draft.modelMode === 'default' ? null : draft.modelMode,
            ...(draft.mcpSelection !== undefined ? { mcpSelection: draft.mcpSelection } : {}),
            ...(draft.codexBackendMode !== undefined ? { codexBackendMode: draft.codexBackendMode } : {}),
            acpSessionModeId: draft.acpSessionModeId,
            ...(draft.automationDraft ? { automation: draft.automationDraft } : {}),
        }),
    };
}

/**
 * Captures retired draft stores into the canonical repository and removes each
 * legacy source only after the corresponding CAS write is remotely acknowledged.
 */
export async function migrateLegacySessionDrafts(scope: ServerAccountScope): Promise<void> {
    const legacyTexts = { ...loadSessionDrafts(scope) };
    const legacyValues = { ...loadPersistedSessionDraftValues(scope) };
    let textsChanged = false;
    let valuesChanged = false;
    const sessionIds = new Set([...Object.keys(legacyTexts), ...Object.keys(legacyValues)]);
    for (const sessionId of sessionIds) {
        const address = { kind: 'session', sessionId } as const;
        const alreadyCaptured = getSessionDraftSnapshot(scope, address)?.localSupplement.legacyExistingSessionDraftV1 === true;
        const { patch, fullyProjected } = buildExistingPatch(legacyTexts[sessionId], legacyValues[sessionId]);
        if (!alreadyCaptured && Object.keys(patch).length > 0) {
            writeExistingSessionDraft({ scope, sessionId, patch, materializationIntent: 'seeded' });
            writeSessionDraftLocalSupplement({ scope, address, patch: { legacyExistingSessionDraftV1: true } });
        }
        await flushSessionDraft({ scope, address });
        if (fullyProjected && isSessionDraftRemoteAcknowledged(scope, address)) {
            if (Object.prototype.hasOwnProperty.call(legacyTexts, sessionId)) {
                delete legacyTexts[sessionId];
                textsChanged = true;
            }
            if (Object.prototype.hasOwnProperty.call(legacyValues, sessionId)) {
                delete legacyValues[sessionId];
                valuesChanged = true;
            }
        }
    }
    if (textsChanged) saveSessionDrafts(legacyTexts, scope);
    if (valuesChanged) savePersistedSessionDraftValues(legacyValues, scope);

    const legacyNewDraft = loadNewSessionDraft(scope);
    if (!legacyNewDraft) return;
    const existingLegacyProjection = listNewSessionDraftProjections(scope)
        .find((projection) => projection.localSupplement.legacyNewSessionDraftV1 === true);
    const draftId = existingLegacyProjection?.draftId ?? randomUUID();
    const address = { kind: 'newSession', draftId } as const;
    if (!existingLegacyProjection) {
        writeNewSessionDraft({
            scope,
            draftId,
            patch: buildNewPatch(legacyNewDraft),
            materializationIntent: 'seeded',
        });
        writeSessionDraftLocalSupplement({
            scope,
            address,
            patch: {
                ...(legacyNewDraft.launchUserAttemptId ? { launchUserAttemptId: legacyNewDraft.launchUserAttemptId } : {}),
                legacyNewSessionDraftV1: true,
            },
        });
    }
    await flushSessionDraft({ scope, address });
    if (isSessionDraftRemoteAcknowledged(scope, address)) clearNewSessionDraft(scope);
}
