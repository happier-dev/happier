import { isPromptInvocationAvailable, type PromptInvocationEntryV1 } from '@happier-dev/protocol/prompts/library/promptInvocationsV1';
import type { PromptLibraryListItem } from '@happier-dev/protocol/prompts/library/promptLibraryActionOperations';
import type { BuiltInPrompt } from '@/sync/domains/input/slashCommands/builtInPrompts';
import type { UserMessageHistoryEntry } from '@/hooks/session/useUserMessageHistoryEntries';
import { isPromptLibraryReferenceInHome } from '@/sync/ops/promptLibrary/promptLibraryReferences';

export type PromptPickerRow = Readonly<{
    id: string;
    title: string;
    group: 'favorites' | 'library' | 'history';
    tokens: readonly string[];
}> & (
    | Readonly<{ kind: 'doc'; document: PromptLibraryListItem }>
    | Readonly<{ kind: 'builtIn'; prompt: BuiltInPrompt }>
    | Readonly<{ kind: 'history'; entry: UserMessageHistoryEntry }>
);

export function buildPromptPickerRows(input: Readonly<{
    documents: readonly PromptLibraryListItem[];
    invocations: readonly PromptInvocationEntryV1[];
    builtIns: readonly BuiltInPrompt[];
    history: readonly UserMessageHistoryEntry[];
    sessionId: string | null;
    serverId?: string | null;
    query: string;
}>): readonly PromptPickerRow[] {
    const query = input.query.trim().toLocaleLowerCase();
    const matches = (values: readonly string[]) => !query || values.some((value) => value.toLocaleLowerCase().includes(query));
    const rows: PromptPickerRow[] = [];
    const tokensByDocument = new Map<string, string[]>();
    for (const entry of input.invocations) {
        if (!isPromptInvocationAvailable(entry, { sessionId: input.sessionId })) continue;
        if (!isPromptLibraryReferenceInHome(entry.target, entry.target.artifactId, input.serverId ?? undefined)) continue;
        const tokens = tokensByDocument.get(entry.target.artifactId) ?? [];
        tokens.push(entry.token);
        tokensByDocument.set(entry.target.artifactId, tokens);
    }
    for (const favorite of [true, false]) {
        for (const document of input.documents) {
            const tokens = tokensByDocument.get(document.artifactId) ?? [];
            if (document.favorite !== favorite || !matches([document.title, ...document.tags, ...tokens])) continue;
            rows.push({ id: `doc:${document.artifactId}`, title: document.title, group: favorite ? 'favorites' : 'library', tokens, kind: 'doc', document });
        }
    }
    for (const prompt of input.builtIns) {
        if (matches([prompt.title, prompt.token])) rows.push({ id: `builtIn:${prompt.token}`, title: prompt.title, group: 'library', tokens: [prompt.token], kind: 'builtIn', prompt });
    }
    for (const entry of input.history) {
        if (matches([entry.text])) rows.push({ id: `history:${JSON.stringify([entry.serverId, entry.sessionId, entry.messageId])}`, title: entry.text, group: 'history', tokens: [], kind: 'history', entry });
    }
    return rows;
}
