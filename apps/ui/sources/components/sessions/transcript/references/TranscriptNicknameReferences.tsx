import * as React from 'react';
import { useShallow } from 'zustand/react/shallow';
import { compareTranscriptMessagesOldestFirst } from '@happier-dev/session-core/messages';

import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { getStorage, useSetting } from '@/sync/domains/state/storage';
import { readExternalSessionLink } from '@/sync/domains/session/external/readExternalSessionLink';
import { resolveSessionListHomeKey } from '@/sync/domains/session/listing/sessionListRowStateLookup';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { readSessionPresentationAgentId } from '@/sync/domains/session/presentation/readSessionPresentationAgentId';
import { selectHomeQualifiedSession } from '@/sync/domains/session/selectHomeQualifiedSession';
import { readNativeSubagentNicknameAnchors } from '@/sync/domains/session/subagents/subAgentSidechains/readNativeSubagentNicknameAnchors';
import { EMPTY_SESSION_RELATION_FACTS } from '@/sync/store/domains/sessionRelations';
import { subscribeSessionMessageChanges, type SessionMessageChanges } from '@/sync/store/sessionMessageChanges';
import type { SessionTranscriptSource } from '../source/types';
import { readMessageMentionedSessionIds } from './messageStructuredReferences';
import { selectNicknameTargets, type InlineSessionReferenceTarget, type NicknameCandidate } from './messageNicknameReferences';

type NicknameScope = Readonly<{
    candidates: readonly NicknameCandidate[];
    mentionedSessionIds: ReadonlySet<string>;
    navigate: NonNullable<SessionTranscriptSource['navigate']>;
}>;
const ScopeContext = React.createContext<NicknameScope | null>(null);
const TargetsContext = React.createContext<ReadonlyMap<string, InlineSessionReferenceTarget> | undefined>(undefined);
const NavigationContext = React.createContext<SessionTranscriptSource['navigate']>(null);
const sessionKey = (id: string) => `session:${id}`;
const nativeKey = (id: string) => `native:${id}`;
const noSessionIds: ReadonlySet<string> = new Set();
const noAnchors: ReturnType<typeof readNativeSubagentNicknameAnchors> = [];
const noSources = { anchors: noAnchors, mentionedSessionIds: noSessionIds };

function observeTranscriptNicknameSources(
    sessionId: string, rootThreadId: string | null, enabled: boolean, isCurrent: () => boolean,
) {
    const anchorsByMessage = new Map<string, typeof noAnchors>();
    const mentionsByMessage = new Map<string, readonly string[]>();
    let snapshot = noSources;
    return {
        read: () => snapshot,
        subscribe(notify: () => void) {
            if (!enabled) return () => {};
            const receive = (publication: SessionMessageChanges): void => {
                if (!isCurrent()) return;
                let changed = publication.kind === 'replaced';
                if (changed) {
                    anchorsByMessage.clear();
                    mentionsByMessage.clear();
                }
                for (const { previous, next } of publication.changes) {
                    if (previous?.meta !== next.meta) {
                        const mentioned = readMessageMentionedSessionIds(next.meta);
                        if (mentioned.length > 0) {
                            mentionsByMessage.set(next.id, mentioned);
                            changed = true;
                        } else if (mentionsByMessage.delete(next.id)) changed = true;
                    }
                    if (next.kind === 'tool-call' && (previous?.kind !== 'tool-call'
                        || previous.tool.input !== next.tool.input || previous.children !== next.children)) {
                        const anchors = readNativeSubagentNicknameAnchors([next], rootThreadId);
                        if (anchors.length > 0) {
                            anchorsByMessage.set(next.id, anchors);
                            changed = true;
                        } else if (anchorsByMessage.delete(next.id)) changed = true;
                    }
                }
                if (!changed) return;
                const anchors = new Map<string, typeof noAnchors[number]>();
                for (const row of anchorsByMessage.values()) for (const anchor of row) {
                    const earlier = anchors.get(anchor.sidechainId);
                    if (!earlier || (anchor.nickname !== null && (earlier.nickname === null
                        || compareTranscriptMessagesOldestFirst(anchor.message, earlier.message) < 0))) {
                        anchors.set(anchor.sidechainId, anchor);
                    }
                }
                const mentionedSessionIds = new Set<string>();
                for (const row of mentionsByMessage.values()) for (const sessionId of row) mentionedSessionIds.add(sessionId);
                snapshot = { anchors: [...anchors.values()], mentionedSessionIds };
                notify();
            };
            const unsubscribe = subscribeSessionMessageChanges(sessionId, receive);
            const rows = getStorage().getState().sessionMessages[sessionId]?.messagesById;
            receive({ kind: 'replaced', changes: Object.values(rows ?? {}).map(next => ({ previous: null, next })) });
            return unsubscribe;
        },
    };
}

export function useTranscriptNicknameTargets() {
    return React.useContext(TargetsContext);
}

export function useTranscriptNicknameNavigation() {
    return React.useContext(NavigationContext);
}

export function TranscriptNicknameSidechainScope({ sidechainId, children }: Readonly<{
    sidechainId: string;
    children: React.ReactNode;
}>) {
    const scope = React.useContext(ScopeContext);
    const targets = React.useMemo(() => scope ? selectNicknameTargets({
        ...scope,
        currentId: nativeKey(sidechainId),
    }) : undefined, [scope, sidechainId]);
    return <TargetsContext.Provider value={targets}>{children}</TargetsContext.Provider>;
}

export function TranscriptNicknameReferences({ source, children }: Readonly<{
    source: SessionTranscriptSource;
    children: React.ReactNode;
}>) {
    const enabled = useSetting('transcriptLinkAgentNames');
    return <TranscriptNicknameProjection source={source} navigate={enabled === true ? source.navigate : null}>
        {children}
    </TranscriptNicknameProjection>;
}

function TranscriptNicknameProjection({ source, navigate, children }: Readonly<{
    source: SessionTranscriptSource;
    navigate: SessionTranscriptSource['navigate'];
    children: React.ReactNode;
}>) {
    const activeServerId = useActiveServerSnapshot(Boolean(navigate && !source.serverId)).serverId;
    const serverId = source.serverId ?? activeServerId;
    const [available, agentId, rootThreadId] = getStorage()(useShallow(state => {
        const session = navigate ? selectHomeQualifiedSession(state, source.sessionId, serverId, activeServerId) : null;
        if (!session) return [false, null, null] as const;
        const metadata = readSessionOwnerMetadataView(session);
        return [true, readSessionPresentationAgentId(session), metadata?.codexSessionId ?? readExternalSessionLink(metadata)?.remoteSessionId ?? null] as const;
    }));
    const currentId = sessionKey(source.sessionId);
    const relations = getStorage()(state => {
        const home = navigate ? resolveSessionListHomeKey(state.sessionRelationsByServerId, serverId) : null;
        return home ? state.sessionRelationsByServerId[home] ?? EMPTY_SESSION_RELATION_FACTS : EMPTY_SESSION_RELATION_FACTS;
    });
    const observer = React.useMemo(() => observeTranscriptNicknameSources(source.sessionId, rootThreadId, available,
        () => selectHomeQualifiedSession(getStorage().getState(), source.sessionId, serverId, activeServerId) !== null),
    [activeServerId, available, rootThreadId, serverId, source.sessionId]);
    const { anchors, mentionedSessionIds } = React.useSyncExternalStore(observer.subscribe, observer.read, observer.read);
    const sessionIds = React.useMemo(() => {
        const parent = relations[source.sessionId]?.managerSessionId;
        const ids = new Set([source.sessionId, ...mentionedSessionIds]);
        if (parent) ids.add(parent);
        for (const [id, { managerSessionId }] of Object.entries(relations)) {
            if (managerSessionId === source.sessionId || (parent && managerSessionId === parent)) ids.add(id);
        }
        return [...ids];
    }, [mentionedSessionIds, relations, source.sessionId]);
    const nicknames = getStorage()(useShallow(state => sessionIds.map(id => {
        const session = navigate ? selectHomeQualifiedSession(state, id, serverId, activeServerId) : null;
        if (!session) return null;
        const nickname = readExternalSessionLink(readSessionOwnerMetadataView(session))?.linkData?.nativeAgentNickname;
        return typeof nickname === 'string' ? nickname : null;
    })));
    const candidates = React.useMemo(() => {
        const native = agentId ? anchors.map(({ sidechainId, parentSidechainId, nickname, toolMessageRouteId }): NicknameCandidate => ({
            id: nativeKey(sidechainId),
            parentId: parentSidechainId ? nativeKey(parentSidechainId) : currentId,
            nickname,
            target: { kind: 'nativeChild', parentSessionId: source.sessionId, toolMessageRouteId, agentId },
        })) : [];
        return [...native, ...sessionIds.map((sessionId, index): NicknameCandidate => {
            const parent = relations[sessionId]?.managerSessionId;
            return { id: sessionKey(sessionId), parentId: parent ? sessionKey(parent) : null,
                nickname: nicknames[index] ?? null, target: { kind: 'session', sessionId } };
        })];
    }, [agentId, anchors, currentId, nicknames, relations, sessionIds, source.sessionId]);
    // Ordinary transcript growth with the same admitted targets keeps every row's projection stable.
    const nextKey = React.useMemo(() => navigate ? JSON.stringify([candidates, [...mentionedSessionIds]]) : null,
        [candidates, mentionedSessionIds, navigate]);
    const retained = React.useRef<{ key: string; scope: NicknameScope } | null>(null);
    if (nextKey === null || navigate === null) retained.current = null;
    else if (retained.current?.key !== nextKey || retained.current.scope.navigate !== navigate) {
        retained.current = { key: nextKey, scope: { candidates, mentionedSessionIds, navigate } };
    }
    const scope = retained.current?.scope ?? null;
    const targets = React.useMemo(() => scope ? selectNicknameTargets({ ...scope, currentId }) : undefined, [scope, currentId]);
    return <NavigationContext.Provider value={navigate}>
        <ScopeContext.Provider value={scope}>
            <TargetsContext.Provider value={targets}>{children}</TargetsContext.Provider>
        </ScopeContext.Provider>
    </NavigationContext.Provider>;
}
