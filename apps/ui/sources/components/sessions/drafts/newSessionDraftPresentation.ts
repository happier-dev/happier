import type { NewSessionDraftProjection } from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import { DEFAULT_AGENT_ID, resolveAgentIdFromFlavor } from '@/agents/catalog/catalog';
import { isActionOperationInFlight } from '@/sync/domains/actionOperations/actionOperationSelectors';
import type { PersistedNewSessionOperationIdentity } from '@/sync/domains/actionOperations/actionOperationReentry';
import { t, type TranslationKey } from '@/text';
import { resolveSessionDraftStatusKey } from './sessionDraftStatusPresentation';

/**
 * Where a draft stands in the launch it handed to the Action-operation owner: still starting, failed
 * to start, or settled while that owner still holds the draft's custody. Only the owner's operation
 * answers this; local launch metadata alone is not evidence that anything is running.
 */
export type NewSessionDraftLaunchState = 'launching' | 'failed' | 'settled';

export function resolveNewSessionDraftLaunchState(
    identity: PersistedNewSessionOperationIdentity | null | undefined,
): NewSessionDraftLaunchState | null {
    if (!identity) return null;
    if (isActionOperationInFlight(identity.operation)) return 'launching';
    return identity.operation.state === 'failed' ? 'failed' : 'settled';
}

export type NewSessionDraftRowPresentation = Readonly<{
    title: string;
    statusKey: TranslationKey | null;
    statusTone: 'danger' | null;
}>;

export type NewSessionDraftSummaryNames = Readonly<{
    unavailableMachineIds?: ReadonlySet<string>;
    attachmentNeedsAttentionDraftIds?: ReadonlySet<string>;
    launchStateByDraftId?: ReadonlyMap<string, NewSessionDraftLaunchState>;
}>;

function readAuthoringValue(draft: NewSessionDraftProjection, fieldId: string): unknown {
    if (draft.document.target.kind !== 'newSession') return null;
    const authoring = draft.document.target.authoring as Readonly<Record<string, Readonly<{ value: unknown }>>>;
    return authoring[fieldId]?.value ?? null;
}

function readNonblankString(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const normalized = value.trim();
    return normalized.length > 0 ? normalized : null;
}

function safeFinalPathSegment(value: unknown): string | null {
    const path = readNonblankString(value);
    if (!path) return null;
    const segments = path.replace(/[\\/]+$/g, '').split(/[\\/]+/);
    return readNonblankString(segments[segments.length - 1]);
}

function firstPromptLine(value: string): string | null {
    return readNonblankString(value.split(/\r?\n/, 1)[0]);
}

function readAutomationName(draft: NewSessionDraftProjection): string | null {
    const value = readAuthoringValue(draft, 'automation');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return readNonblankString((value as Readonly<Record<string, unknown>>).name);
}

export function resolveNewSessionDraftAgentId(draft: NewSessionDraftProjection) {
    return resolveAgentIdFromFlavor(readNonblankString(readAuthoringValue(draft, 'agentId'))) ?? DEFAULT_AGENT_ID;
}

type ResolvedDraftStatus = Readonly<{ key: TranslationKey; tone: 'danger' | null }>;

function resolveStatus(
    draft: NewSessionDraftProjection,
    names: NewSessionDraftSummaryNames,
): ResolvedDraftStatus | null {
    // What this draft is doing right now outranks how it is syncing: the launch the user just
    // started, or the one that could not start, is the fact they are looking for.
    const launchState = names.launchStateByDraftId?.get(draft.draftId) ?? null;
    if (launchState === 'launching') return { key: 'sessionDrafts.status.starting', tone: null };
    if (launchState === 'failed') return { key: 'sessionDrafts.status.startFailed', tone: 'danger' };
    if (draft.status === 'conflict' || draft.status === 'offline' || draft.status === 'error') {
        const key = resolveSessionDraftStatusKey(draft.status);
        return key ? { key, tone: draft.status === 'error' ? 'danger' : null } : null;
    }
    const machineId = readNonblankString(readAuthoringValue(draft, 'machineId'));
    if (machineId && names.unavailableMachineIds?.has(machineId)) {
        return { key: 'sessionDrafts.status.machineUnavailable', tone: null };
    }
    if (names.attachmentNeedsAttentionDraftIds?.has(draft.draftId)) {
        return { key: 'sessionDrafts.status.attachmentNeedsAttention', tone: null };
    }
    if (draft.status === 'pending') {
        const key = resolveSessionDraftStatusKey(draft.status);
        return key ? { key, tone: null } : null;
    }
    return null;
}

export function buildNewSessionDraftRowPresentation(
    draft: NewSessionDraftProjection,
    names: NewSessionDraftSummaryNames,
): NewSessionDraftRowPresentation {
    const promptLine = firstPromptLine(draft.document.composer.text.value);
    const automationName = readAutomationName(draft);
    const folderName = safeFinalPathSegment(readAuthoringValue(draft, 'directory'));
    const title = promptLine ?? automationName ?? folderName ?? t('sessionDrafts.untitled');
    const status = resolveStatus(draft, names);
    return {
        title,
        statusKey: status?.key ?? null,
        statusTone: status?.tone ?? null,
    };
}
