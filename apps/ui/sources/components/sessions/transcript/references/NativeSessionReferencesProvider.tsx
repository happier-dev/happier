import * as React from 'react';
import { useShallow } from 'zustand/react/shallow';
import { NativeSessionAliasesV1Schema } from '@happier-dev/protocol';

import { getStorage } from '@/sync/domains/state/storageStore';
import { getSessionName } from '@/utils/sessions/sessionUtils';
import {
    EMPTY_MARKDOWN_TEXT_REFERENCES,
    MarkdownTextReferencesContext,
    type MarkdownTextReferences,
} from '@/components/markdown/MarkdownTextReferences';
import { resolveNativeSessionAlias } from './nativeSessionAlias';
import type { StorageState } from '@/sync/store/types';

type AliasSourceState = Pick<StorageState, 'sessions' | 'sessionListRenderables' | 'deletedSessionIds'>;

function buildAliasIndex(state: AliasSourceState) {
    const latest = new Map<string, AliasSourceState['sessions'][string] | AliasSourceState['sessionListRenderables'][string]>();
    for (const session of [...Object.values(state.sessionListRenderables), ...Object.values(state.sessions)]) {
        const previous = latest.get(session.id);
        if (!previous || session.metadataVersion >= previous.metadataVersion) latest.set(session.id, session);
    }
    const sessions = Array.from(latest.values(), (session) => ({ ...session, deleted: state.deletedSessionIds[session.id] === true }));
    const sessionsByAlias = new Map<string, typeof sessions>();
    for (const session of sessions) {
        const parsed = NativeSessionAliasesV1Schema.safeParse(session.metadata?.nativeSessionAliasesV1);
        if (!parsed.success) continue;
        for (const alias of new Set(parsed.data.assignments.map((assignment) => assignment.alias))) {
            const matches = sessionsByAlias.get(alias);
            if (matches) matches.push(session);
            else sessionsByAlias.set(alias, [session]);
        }
    }
    return { latest, sessionsByAlias };
}

let cachedIndex: Readonly<{ source: AliasSourceState; value: ReturnType<typeof buildAliasIndex> }> | null = null;

function readAliasIndex(state: AliasSourceState) {
    // One census per store update, shared by mounted rows; never a census per message.
    const previous = cachedIndex?.source;
    if (previous?.sessions === state.sessions && previous.sessionListRenderables === state.sessionListRenderables
        && previous.deletedSessionIds === state.deletedSessionIds) return cachedIndex!.value;
    const value = buildAliasIndex(state);
    cachedIndex = { source: { sessions: state.sessions, sessionListRenderables: state.sessionListRenderables, deletedSessionIds: state.deletedSessionIds }, value };
    return value;
}

export function NativeSessionReferencesProvider(props: Readonly<{
    sessionId: string;
    machineId?: string | null;
    text: string;
    createdAt: number;
    children: React.ReactNode;
}>) {
    // Strings keep the selected projection stable across unrelated thinking/presence updates.
    const selected = getStorage()(useShallow((state) => {
        if (!props.text) return [] as string[];
        const { latest, sessionsByAlias } = readAliasIndex(state);
        const machineId = props.machineId ?? latest.get(props.sessionId)?.metadata?.machineId ?? null;
        const result: string[] = [];
        for (const [alias, sessions] of sessionsByAlias) {
            if (!props.text.includes(alias)) continue;
            const id = resolveNativeSessionAlias({ alias, machineId, createdAt: props.createdAt, sessions });
            if (!id) continue;
            const target = latest.get(id);
            if (!target?.metadata) continue;
            result.push(alias, id, getSessionName(target));
        }
        return result;
    }));
    const references = React.useMemo<MarkdownTextReferences>(() => {
        if (selected.length === 0) return EMPTY_MARKDOWN_TEXT_REFERENCES;
        const result: Record<string, Readonly<{ text: string; url: string }>> = {};
        for (let index = 0; index < selected.length; index += 3) {
            result[selected[index]!] = { text: selected[index + 2]!, url: `/session/${encodeURIComponent(selected[index + 1]!)}` };
        }
        return result;
    }, [selected]);
    return <MarkdownTextReferencesContext.Provider value={references}>{props.children}</MarkdownTextReferencesContext.Provider>;
}
