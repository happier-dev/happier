import { DEFAULT_AGENT_ID } from '@/agents/catalog/catalog';
import {
    loadNewSessionDraft as loadPersistedNewSessionDraft,
    saveNewSessionDraft as savePersistedNewSessionDraft,
    type NewSessionDraft,
} from '@/sync/domains/state/persistence';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

export type AppendTranscriptSelectionToNewSessionDraftInput = Readonly<{
    promptText: string;
    sourceServerId: string | null | undefined;
    scope?: ServerAccountScope | null;
    nowMs?: () => number;
    loadNewSessionDraft?: (scope?: ServerAccountScope | null) => NewSessionDraft | null;
    saveNewSessionDraft?: (draft: NewSessionDraft, scope?: ServerAccountScope | null) => void;
}>;

function normalizeNonEmptyString(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function appendDraftInput(existingInput: string, promptText: string): string {
    if (existingInput.trim().length === 0) return promptText;
    return `${existingInput.trimEnd()}\n\n${promptText.trimStart()}`;
}

function createNewSessionDraft(params: Readonly<{
    promptText: string;
    sourceServerId: string | null;
    updatedAt: number;
}>): NewSessionDraft {
    return {
        input: params.promptText,
        selectedMachineId: null,
        selectedPath: null,
        entryIntent: 'session',
        selectedProfileId: null,
        selectedSecretId: null,
        agentType: DEFAULT_AGENT_ID,
        permissionMode: 'default',
        modelMode: 'default',
        acpSessionModeId: null,
        ...(params.sourceServerId ? { targetServerId: params.sourceServerId } : {}),
        updatedAt: params.updatedAt,
    };
}

export function appendTranscriptSelectionToNewSessionDraft(input: AppendTranscriptSelectionToNewSessionDraftInput): void {
    const promptText = typeof input.promptText === 'string' ? input.promptText : '';
    if (!promptText.trim()) return;

    const scope = input.scope ?? null;
    const loadNewSessionDraft = input.loadNewSessionDraft ?? loadPersistedNewSessionDraft;
    const saveNewSessionDraft = input.saveNewSessionDraft ?? savePersistedNewSessionDraft;
    const existingDraft = loadNewSessionDraft(scope);
    const sourceServerId = normalizeNonEmptyString(input.sourceServerId);
    const updatedAt = input.nowMs?.() ?? Date.now();

    if (existingDraft) {
        saveNewSessionDraft({
            ...existingDraft,
            input: appendDraftInput(existingDraft.input, promptText),
            entryIntent: 'session',
            ...(existingDraft.targetServerId || !sourceServerId ? {} : { targetServerId: sourceServerId }),
            updatedAt,
        }, scope);
        return;
    }

    saveNewSessionDraft(createNewSessionDraft({
        promptText,
        sourceServerId,
        updatedAt,
    }), scope);
}
