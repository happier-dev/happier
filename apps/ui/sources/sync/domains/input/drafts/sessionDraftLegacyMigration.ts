import { MENTION_KIND_V1, buildMentionRefForKindV1, type MentionRefV1 } from '@happier-dev/protocol/runtime/input/mentionRefV1';
import { pluginJsonValuesEqual } from '@happier-dev/protocol/plugins/contributions/jsonSchemaValues';
import type { StrictJsonValue } from '@happier-dev/protocol/drafts/sessionDrafts';
import {
    composerReferencesFromStructuredMentions,
    composerStructuredMentionsFromReferences,
    placePositionlessComposerReferences,
} from '@/components/sessions/composer/composerScopeAdapters';

import { randomUUID } from '@/platform/randomUUID';
import {
    clearNewSessionDraft,
    loadNewSessionDraft,
    loadSessionDrafts,
    saveSessionDrafts,
    type NewSessionDraft,
} from '@/sync/domains/state/persistence';
import {
    loadRawSessionDraftValues,
    saveRawSessionDraftValues,
    type RawSessionDraftValuesBySessionId,
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
import {
    parseComposerStructuredInputMentionsForText,
    ComposerStructuredInputMentionSchema,
    SESSION_DRAFT_VALUE_SCHEMAS,
    type ComposerStructuredInputMention,
    type ComposerStructuredInputMentionsForText,
} from '@/sync/domains/input/draftValues/sessionDraftValueTypes';
import { buildNewSessionDraftLocalState } from '@/sync/ops/sessionDrafts/newSessionDraftLocalState';

import { projectNewSessionDraftSyncedAuthoringFields } from './sessionAuthoringDraftProjection';

function asStrictJsonValue(value: unknown): StrictJsonValue {
    return value as StrictJsonValue;
}

/** Only the predecessor storage seam places absent ranges. Live draft reads remain exact. */
export function parseLegacySessionDraftMentions(value: unknown, text: string): ComposerStructuredInputMentionsForText {
    if (!Array.isArray(value)) return { mentions: [], fullyDecoded: false };
    const currentEntries: unknown[] = [];
    const legacyMentionsByReference = new Map<string, ComposerStructuredInputMention[]>();
    const legacyReferences: MentionRefV1[] = [];
    const referenceKey = (reference: MentionRefV1) => JSON.stringify([reference.kind, reference.ref, reference.token]);
    let fullyDecoded = true;
    for (const entry of value) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) { fullyDecoded = false; continue; }
        const record: Record<string, unknown> = entry;
        if ('start' in record || 'end' in record) { currentEntries.push(entry); continue; }
        if (typeof record.tokenText !== 'string' || record.tokenText.length === 0) { fullyDecoded = false; continue; }
        let candidate = record;
        if (record.kind === 'session') {
            if (typeof record.sessionId !== 'string' || record.sessionId.length === 0) { fullyDecoded = false; continue; }
            candidate = { ...record, kind: MENTION_KIND_V1.session,
                ref: buildMentionRefForKindV1(MENTION_KIND_V1.session, record.sessionId) };
        }
        const parsed = ComposerStructuredInputMentionSchema.safeParse({ ...candidate, start: 0, end: record.tokenText.length });
        if (!parsed.success) { fullyDecoded = false; continue; }
        const reference = composerReferencesFromStructuredMentions({ text: parsed.data.tokenText, mentions: [parsed.data] })[0];
        if (!reference) { fullyDecoded = false; continue; }
        const key = referenceKey(reference);
        const occurrences = legacyMentionsByReference.get(key) ?? [];
        occurrences.push(parsed.data);
        legacyMentionsByReference.set(key, occurrences);
        legacyReferences.push(reference);
    }
    const current = parseComposerStructuredInputMentionsForText(currentEntries, text);
    const placed = placePositionlessComposerReferences({ text, references: legacyReferences, occupied: current.mentions });
    // Keep each saved leaf's richer catalog fields: the general document adapter
    // groups by identity, but predecessor duplicate occurrences can have distinct context.
    const migrated = placed.flatMap(reference => {
        const existing = legacyMentionsByReference.get(referenceKey(reference))?.shift();
        return existing ? composerStructuredMentionsFromReferences({ references: [reference], existing: [existing] }) : [];
    });
    const mentions = [...current.mentions, ...migrated]
        .sort((left, right) => left.start - right.start || left.end - right.end);
    return { mentions, fullyDecoded: fullyDecoded && current.fullyDecoded && migrated.length === legacyReferences.length };
}

function buildExistingPatch(
    text: string | undefined,
    values: RawSessionDraftValuesBySessionId[string] | undefined,
): Readonly<{ patch: ExistingSessionDraftPatch; fullyProjected: boolean }> {
    const patch: {
        text?: string;
        mentions?: readonly StrictJsonValue[];
        attachments?: readonly StrictJsonValue[];
        routing?: {
            recipient?: StrictJsonValue;
            agentContinuation?: StrictJsonValue;
            executionRunRequestedAction?: StrictJsonValue;
        };
    } = {};
    if (text !== undefined) patch.text = text;
    let fullyProjected = true;
    const routing: NonNullable<typeof patch.routing> = {};
    for (const [fieldId, envelope] of Object.entries(values ?? {})) {
        if (!(fieldId in SESSION_DRAFT_VALUE_SCHEMAS)) {
            fullyProjected = false;
            continue;
        }
        const typedFieldId = fieldId as keyof typeof SESSION_DRAFT_VALUE_SCHEMAS;
        if (typedFieldId === 'structuredInput.mentions') {
            if (text === undefined || !Array.isArray(envelope.value)) {
                fullyProjected = false;
                continue;
            }
            const mentions = parseLegacySessionDraftMentions(envelope.value, text);
            patch.mentions = mentions.mentions.map(asStrictJsonValue);
            if (!mentions.fullyDecoded) fullyProjected = false;
            continue;
        }
        const parsed = SESSION_DRAFT_VALUE_SCHEMAS[typedFieldId].safeParse(envelope.value);
        if (!parsed.success) {
            fullyProjected = false;
            continue;
        }
        if (typedFieldId === 'structuredInput.composerAttachments') {
            patch.attachments = (parsed.data as readonly unknown[]).map(asStrictJsonValue);
        } else if (typedFieldId === 'routing.recipient') {
            routing.recipient = asStrictJsonValue({ mode: 'manual', recipient: parsed.data });
        } else if (typedFieldId === 'routing.agentContinuation') {
            routing.agentContinuation = asStrictJsonValue(parsed.data);
        } else {
            routing.executionRunRequestedAction = asStrictJsonValue(parsed.data);
        }
    }
    if (Object.keys(routing).length > 0) patch.routing = routing;
    return { patch, fullyProjected };
}

function buildNewPatch(draft: NewSessionDraft, scopeServerId: string): Readonly<{
    text: string;
    attachments?: readonly StrictJsonValue[];
    authoring: ReturnType<typeof projectNewSessionDraftSyncedAuthoringFields>;
}> {
    return {
        text: draft.input,
        ...(draft.composerAttachments !== undefined
            ? { attachments: draft.composerAttachments.map(asStrictJsonValue) }
            : {}),
        authoring: projectNewSessionDraftSyncedAuthoringFields({ draft, scopeServerId }),
    };
}

/**
 * Captures retired draft stores into the canonical repository and removes each
 * legacy source only after the corresponding CAS write is remotely acknowledged.
 */
export async function migrateLegacySessionDrafts(scope: ServerAccountScope): Promise<void> {
    const legacyTexts = { ...loadSessionDrafts(scope) };
    const legacyValues = { ...loadRawSessionDraftValues(scope) };
    let textsChanged = false;
    let valuesChanged = false;
    const sessionIds = new Set([...Object.keys(legacyTexts), ...Object.keys(legacyValues)]);
    for (const sessionId of sessionIds) {
        const address = { kind: 'session', sessionId } as const;
        const captured = getSessionDraftSnapshot(scope, address);
        const alreadyCaptured = captured?.localSupplement.legacyExistingSessionDraftV1 === true;
        const { patch, fullyProjected } = buildExistingPatch(legacyTexts[sessionId], legacyValues[sessionId]);
        if (!alreadyCaptured && Object.keys(patch).length > 0) {
            writeExistingSessionDraft({ scope, sessionId, patch, materializationIntent: 'seeded' });
            writeSessionDraftLocalSupplement({ scope, address, patch: { legacyExistingSessionDraftV1: true } });
        }
        const flushResult = await flushSessionDraft({ scope, address });
        const remotelyAcknowledged = isSessionDraftRemoteAcknowledged(scope, address)
            || (flushResult.status === 'clean' && getSessionDraftSnapshot(scope, address) === null);
        // Older migration readers could mark a capture complete while dropping
        // positionless references. Their acknowledged empty projection is not
        // evidence those retained references reached canonical custody. Never
        // overwrite a subsequently edited document to repair that old capture.
        const capturedMentions = captured ? parseComposerStructuredInputMentionsForText(
            captured.document.composer.mentions?.value ?? [], captured.document.composer.text.value,
        ).mentions : [];
        const referencesCaptured = !alreadyCaptured || (patch.mentions ?? []).every(mention => (
            capturedMentions.some(current => pluginJsonValuesEqual(current, mention))
        ));
        if (fullyProjected && remotelyAcknowledged && referencesCaptured) {
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
    if (valuesChanged) saveRawSessionDraftValues(legacyValues, scope);

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
            patch: buildNewPatch(legacyNewDraft, scope.serverId),
            materializationIntent: 'seeded',
        });
        writeSessionDraftLocalSupplement({
            scope,
            address,
            patch: {
                ...(legacyNewDraft.launchUserAttemptId ? { launchUserAttemptId: legacyNewDraft.launchUserAttemptId } : {}),
                newSessionLocalState: buildNewSessionDraftLocalState(legacyNewDraft),
                legacyNewSessionDraftV1: true,
            },
        });
    }
    await flushSessionDraft({ scope, address });
    if (isSessionDraftRemoteAcknowledged(scope, address)) clearNewSessionDraft(scope);
}
