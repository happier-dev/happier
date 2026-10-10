import { type SessionMessageV1 } from '@happier-dev/protocol';
import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';
import { ItemList } from '@/components/ui/lists/ItemList';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Item } from '@/components/ui/lists/Item';
import { Avatar } from '@/components/ui/avatar/Avatar';
import { decryptDataKeyFromPublicShare } from '@/sync/encryption/publicShareEncryption';
import { AES256Encryption } from '@/sync/encryption/encryptor';
import { EncryptionCache } from '@/sync/encryption/encryptionCache';
import { SessionEncryption } from '@/sync/encryption/sessionEncryption';

import {
    normalizeRawMessages,
    type NormalizedMessage,
    type RawMessageNormalizationInput,
} from "@happier-dev/session-core/raw";
import { useAuth } from '@/auth/context/AuthContext';
import type { ReducerState } from "@happier-dev/session-core/reducer";
import { TranscriptList } from '@/components/sessions/transcript/TranscriptList';
import { createReadOnlySessionTranscriptSource } from '@/components/sessions/transcript/source/readOnlySessionTranscriptSource';
import { SessionTranscriptSourceProvider } from '@/components/sessions/transcript/source/SessionTranscriptSourceContext';
import { ChatHeaderView } from '@/components/sessions/transcript/ChatHeaderView';
import type { Message } from "@happier-dev/session-core/messages";
import { serverFetch } from '@/sync/http/client';
import type { TranscriptOlderPageLoadResult } from "@happier-dev/session-core/messages";
import type { Metadata } from '@happier-dev/session-core/state';
import type { AgentState } from '@happier-dev/session-core/state';
import { reducePublicShareTranscript } from '@/components/sessions/sharing/publicShareTranscript';
import {
    parseDecryptedSessionMetadata,
    parsePlainSessionMetadata,
} from '@/sync/engine/sessions/parsePlainSessionPayload';
import {
    readSharedMetadataPresentationCompletedRequests,
} from '@happier-dev/session-core/pending';
import { readStoredSessionRawRecord } from '@/sync/runtime/readStoredSessionContent';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { useChromeSafeAreaInsets } from '@/components/ui/layout/useChromeSafeAreaInsets';
import { useHeaderHeight } from '@/utils/platform/responsive';
import { Icon } from '@/components/ui/icons/Icon';

const SHARE_SCREEN_OPTIONS = { headerShown: false } as const;

type ShareOwner = {
    id: string;
    username: string | null;
    firstName: string | null;
    lastName: string | null;
    avatar: string | null;
};

type PublicShareResponse = {
    session: {
        id: string;
        seq: number;
        encryptionMode: 'e2ee' | 'plain';
        createdAt: number;
        updatedAt: number;
        active: boolean;
        activeAt: number;
        metadata: string;
        metadataVersion: number;
        metadataLayoutVersion?: number;
        agentState?: string | null;
        agentStateVersion?: number;
    };
    owner: ShareOwner;
    accessLevel: 'view';
    encryptedDataKey: string | null;
    isConsentRequired: boolean;
    messagesAccessToken?: string | null;
};

type PublicShareConsentResponse = {
    error: string;
    requiresConsent: true;
    sessionId: string;
    owner: ShareOwner | null;
};

type PublicShareMessagesResponse = {
    messages: SessionMessageV1[];
    hasMore?: boolean;
    nextBeforeSeq?: number | null;
};

type PublicShareDataset = Readonly<{
    share: PublicShareResponse;
    decryptedMetadata: Metadata | null;
    /** Presentation-reduced rows for every page loaded so far, oldest first. */
    messages: Message[];
    /** The actual fold state owns tool-route and sidechain relationships for this dataset. */
    reducerState: ReducerState;
    /**
     * Every normalized row this viewer has accepted. An older page is reduced TOGETHER
     * with the pages already on screen, so the transcript grows backwards instead of
     * being replaced (and the reducer keeps seeing one whole conversation).
     */
    normalized: NormalizedMessage[];
    agentState: AgentState;
    /** Decrypts an older e2ee page; `null` for a plaintext share. */
    sessionEncryption: SessionEncryption | null;
    hasMore: boolean;
    nextBeforeSeq: number | null;
    loadGeneration: number;
    tokenParam: string;
}>;

const PUBLIC_SHARE_MESSAGES_ACCESS_TOKEN_HEADER = 'x-public-share-messages-access-token';

export function resolvePublicShareTokenParam(
    routeToken: string | null | undefined,
    pathname: string | null | undefined,
): string | null {
    const normalizedRouteToken = typeof routeToken === 'string' ? routeToken.trim() : '';
    if (normalizedRouteToken && normalizedRouteToken !== ':token' && normalizedRouteToken !== '[token]') {
        return normalizedRouteToken;
    }

    const match = typeof pathname === 'string' ? pathname.match(/\/share\/([^/?#]+)\/?$/) : null;
    if (!match?.[1]) return null;
    try {
        const decoded = decodeURIComponent(match[1]).trim();
        return decoded && decoded !== ':token' && decoded !== '[token]' ? decoded : null;
    } catch {
        return null;
    }
}

function getOwnerDisplayName(owner: ShareOwner | null): string {
    if (!owner) return t('status.unknown');
    if (owner.username) return `@${owner.username}`;
    const fullName = [owner.firstName, owner.lastName].filter(Boolean).join(' ');
    return fullName || t('status.unknown');
}

function normalizeMessageSeq(message: Readonly<{ seq?: number | null }>): number | undefined {
    return typeof message.seq === 'number' && Number.isFinite(message.seq)
        ? Math.trunc(message.seq)
        : undefined;
}

function comparePublicShareRawInputsOldestFirst(
    a: RawMessageNormalizationInput,
    b: RawMessageNormalizationInput,
): number {
    const aSeq = typeof a.seq === 'number' && Number.isFinite(a.seq) ? Math.trunc(a.seq) : null;
    const bSeq = typeof b.seq === 'number' && Number.isFinite(b.seq) ? Math.trunc(b.seq) : null;
    if (aSeq !== null && bSeq !== null && aSeq !== bSeq) return aSeq - bSeq;
    if (aSeq !== null && bSeq === null) return -1;
    if (aSeq === null && bSeq !== null) return 1;
    return a.createdAt - b.createdAt;
}

function normalizePublicShareRawInputs(inputs: RawMessageNormalizationInput[]): NormalizedMessage[] {
    inputs.sort(comparePublicShareRawInputsOldestFirst);
    return normalizeRawMessages(inputs);
}

function createPublicSharePresentationAgentState(
    metadata: Metadata | null,
    metadataLayoutVersion: unknown,
): AgentState {
    return {
        completedRequests: readSharedMetadataPresentationCompletedRequests(
            metadata,
            metadataLayoutVersion,
        ),
    } as AgentState;
}

async function normalizePlainPublicShareMessages(messages: ReadonlyArray<SessionMessageV1>): Promise<NormalizedMessage[]> {
    const inputs: RawMessageNormalizationInput[] = [];
    for (const message of messages) {
        if (!message) continue;

        const content = await readStoredSessionRawRecord({ content: message.content });
        if (!content) continue;

        inputs.push({
            id: message.id,
            localId: message.localId ?? null,
            createdAt: message.createdAt,
            raw: content,
            seq: normalizeMessageSeq(message),
            messageRole: message.messageRole ?? undefined,
        });
    }

    return normalizePublicShareRawInputs(inputs);
}

/**
 * Decrypts one e2ee page. A row that will not decrypt fails the whole page rather than
 * being dropped: silently serving a hole is exactly the truncation this viewer is fixing.
 */
async function normalizeEncryptedPublicShareMessages(
    sessionEncryption: SessionEncryption,
    messages: ReadonlyArray<SessionMessageV1>,
): Promise<NormalizedMessage[] | null> {
    const decryptedMessages = await sessionEncryption.decryptMessages([...messages]);
    const inputs: RawMessageNormalizationInput[] = [];
    for (const m of decryptedMessages) {
        if (!m || !m.content) return null;
        inputs.push({
            id: m.id,
            localId: m.localId ?? null,
            createdAt: m.createdAt,
            raw: m.content,
            seq: normalizeMessageSeq(m),
            messageRole: m.messageRole ?? undefined,
        });
    }
    return normalizePublicShareRawInputs(inputs);
}

function buildPublicShareMessagesPath(params: Readonly<{
    token: string;
    withConsent: boolean;
    beforeSeq?: number | null;
}>): string {
    const query = new URLSearchParams();
    if (params.withConsent) query.set('consent', 'true');
    if (typeof params.beforeSeq === 'number' && Number.isFinite(params.beforeSeq)) {
        query.set('beforeSeq', String(Math.trunc(params.beforeSeq)));
    }
    const search = query.toString();
    return `/v1/public-share/${params.token}/messages${search ? `?${search}` : ''}`;
}

function mergePublicShareNormalizedPages(
    existing: readonly NormalizedMessage[],
    incoming: readonly NormalizedMessage[],
): NormalizedMessage[] {
    const byId = new Map<string, NormalizedMessage>();
    for (const message of existing) byId.set(message.id, message);
    for (const message of incoming) byId.set(message.id, message);
    return [...byId.values()];
}

function PublicShareTranscript(props: Readonly<{
    dataset: PublicShareDataset;
    datasetKey: string;
    loadOlder: () => Promise<TranscriptOlderPageLoadResult>;
}>) {
    const snapshot = useMemo(() => ({
        messages: props.dataset.messages,
        reducerState: props.dataset.reducerState,
        metadata: props.dataset.decryptedMetadata,
        agentState: props.dataset.agentState,
        metadataLayoutVersion: props.dataset.share.session.metadataLayoutVersion,
        workspacePath: null,
        authorship: { viewerScope: null, hasOtherNamedCollaborator: false } as const,
        historyState: {
            isLoaded: true,
            hasOlder: props.dataset.hasMore && props.dataset.nextBeforeSeq !== null,
            // The source's loadOlder wrapper owns the pending-page fact.
            isLoadingOlder: false,
        },
    }), [props.dataset]);
    const [source] = useState(() => createReadOnlySessionTranscriptSource({
        sessionId: props.dataset.share.session.id,
        loadOlder: props.loadOlder,
        ...snapshot,
    }));
    const publishedSnapshot = useRef(snapshot);
    React.useLayoutEffect(() => {
        if (publishedSnapshot.current === snapshot) return;
        publishedSnapshot.current = snapshot;
        source.update(snapshot);
    }, [snapshot, source]);

    return (
        <SessionTranscriptSourceProvider source={source}>
            <TranscriptList
                datasetKey={props.datasetKey}
                metadata={props.dataset.decryptedMetadata}
                messages={props.dataset.messages}
                bottomNotice={{
                    title: t('session.sharing.publicReadOnlyTitle'),
                    body: t('session.sharing.publicReadOnlyBody'),
                }}
            />
        </SessionTranscriptSourceProvider>
    );
}

export default memo(function PublicShareViewerScreen() {
    const { token } = useLocalSearchParams<{ token: string }>();
    const { credentials } = useAuth();
    const router = useRouter();
    const { theme } = useUnistyles();
    const safeArea = useChromeSafeAreaInsets();
    const headerHeight = useHeaderHeight();
    const tokenParam = resolvePublicShareTokenParam(
        typeof token === 'string' ? token : null,
        typeof window === 'undefined' ? null : window.location.pathname,
    );

    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [errorKind, setErrorKind] = useState<'generic' | 'transcript_unavailable' | 'metadata_privacy_upgrade_required'>('generic');
    const [consentInfo, setConsentInfo] = useState<PublicShareConsentResponse | null>(null);
    const [dataset, setDataset] = useState<PublicShareDataset | null>(null);
    const loadGenerationRef = useRef(0);
    const datasetRef = useRef<PublicShareDataset | null>(dataset);
    datasetRef.current = dataset;
    // Older pages must repeat the consent the viewer already gave, or the server refuses them.
    const consentedRef = useRef(false);

    const authHeader = useMemo(() => {
        if (!credentials?.token) return null;
        return `Bearer ${credentials.token}`;
    }, [credentials?.token]);

    const load = useCallback(async (withConsent: boolean) => {
        const loadGeneration = ++loadGenerationRef.current;
        const requestedTokenParam = tokenParam;
        const isCurrentLoad = () => loadGenerationRef.current === loadGeneration;
        consentedRef.current = withConsent;

        if (!requestedTokenParam) {
            setConsentInfo(null);
            setDataset(null);
            setError(t('errors.invalidShareLink'));
            setIsLoading(false);
            return;
        }

        setIsLoading(true);
        setError(null);
        setErrorKind('generic');
        setConsentInfo(null);
        setDataset(null);

        try {
            const path = withConsent
                ? `/v1/public-share/${requestedTokenParam}?consent=true`
                : `/v1/public-share/${requestedTokenParam}`;

            const headers: Record<string, string> = {};
            if (authHeader) {
                headers['Authorization'] = authHeader;
            }

            const response = await serverFetch(path, { method: 'GET', headers }, { includeAuth: false, retry: 'none' });
            if (!isCurrentLoad()) return;
            if (!response.ok) {
                const data = await response.json().catch(() => null);
                if (!isCurrentLoad()) return;
                if (response.status === 409 && data?.code === 'metadata_privacy_upgrade_required') {
                    setErrorKind('metadata_privacy_upgrade_required');
                    setError(t('shareSheet.publicLink.ownerUpdateRequiredDescription'));
                    setIsLoading(false);
                    return;
                }
                if (data?.code === 'session_transcript_unavailable') {
                    setErrorKind('transcript_unavailable');
                    setError(t('externalSessions.sharingTranscriptUnavailable'));
                    setIsLoading(false);
                    return;
                }
                if (response.status === 403) {
                    if (data?.requiresConsent) {
                        setConsentInfo(data as PublicShareConsentResponse);
                        setIsLoading(false);
                        return;
                    }
                }
                setError(t('session.sharing.shareNotFound'));
                setIsLoading(false);
                return;
            }

            const data = (await response.json()) as PublicShareResponse;
            if (!isCurrentLoad()) return;

            const messagesPath = buildPublicShareMessagesPath({
                token: requestedTokenParam,
                withConsent,
            });
            const messagesHeaders = { ...headers };
            if (typeof data.messagesAccessToken === 'string' && data.messagesAccessToken.trim().length > 0) {
                messagesHeaders[PUBLIC_SHARE_MESSAGES_ACCESS_TOKEN_HEADER] = data.messagesAccessToken;
            }
            const messagesResponse = await serverFetch(messagesPath, { method: 'GET', headers: messagesHeaders }, { includeAuth: false, retry: 'none' });
            if (!isCurrentLoad()) return;
            if (!messagesResponse.ok) {
                setError(t('errors.operationFailed'));
                setIsLoading(false);
                return;
            }
            const messagesData = (await messagesResponse.json()) as PublicShareMessagesResponse;
            if (!isCurrentLoad()) return;
            const shareMessages = Array.isArray(messagesData.messages) ? messagesData.messages : null;
            if (!shareMessages) {
                setError(t('errors.operationFailed'));
                setIsLoading(false);
                return;
            }

            const sessionEncryptionMode = data.session.encryptionMode === 'plain' ? 'plain' : 'e2ee';
            const plainMetadata = sessionEncryptionMode === 'plain'
                ? parsePlainSessionMetadata(
                    data.session.metadata,
                    data.session.metadataLayoutVersion,
                )
                : null;
            const plainAgentState = createPublicSharePresentationAgentState(
                plainMetadata,
                data.session.metadataLayoutVersion,
            );

            const hasMore = messagesData.hasMore === true;
            const nextBeforeSeq = typeof messagesData.nextBeforeSeq === 'number'
                ? messagesData.nextBeforeSeq
                : null;

            if (sessionEncryptionMode === 'plain') {
                const normalized = await normalizePlainPublicShareMessages(shareMessages);
                if (!isCurrentLoad()) return;

                setDataset({
                    share: data,
                    decryptedMetadata: plainMetadata,
                    ...reducePublicShareTranscript(normalized, plainAgentState, messagesData.hasMore === false),
                    normalized,
                    agentState: plainAgentState,
                    sessionEncryption: null,
                    hasMore,
                    nextBeforeSeq,
                    loadGeneration,
                    tokenParam: requestedTokenParam,
                });
                setIsLoading(false);
                return;
            } else {
                if (!data.encryptedDataKey) {
                    setError(t('session.sharing.failedToDecrypt'));
                    setIsLoading(false);
                    return;
                }

                const decryptedKey = await decryptDataKeyFromPublicShare(data.encryptedDataKey, requestedTokenParam);
                if (!isCurrentLoad()) return;
                if (!decryptedKey) {
                    setError(t('session.sharing.failedToDecrypt'));
                    setIsLoading(false);
                    return;
                }

                const sessionEncryptor = new AES256Encryption(decryptedKey);
                const cache = new EncryptionCache();
                const sessionEncryption = new SessionEncryption(data.session.id, sessionEncryptor, cache);

                const e2eeMetadata = parseDecryptedSessionMetadata(
                    await sessionEncryption.decryptMetadataPayload(
                        data.session.metadataVersion,
                        data.session.metadata
                    ),
                    data.session.metadataLayoutVersion,
                );
                if (!isCurrentLoad()) return;
                if (!e2eeMetadata) {
                    setError(t('session.sharing.failedToDecrypt'));
                    setIsLoading(false);
                    return;
                }

                const e2eePresentationAgentState = createPublicSharePresentationAgentState(
                    e2eeMetadata,
                    data.session.metadataLayoutVersion,
                );

                const normalized = await normalizeEncryptedPublicShareMessages(
                    sessionEncryption,
                    shareMessages,
                );
                if (!isCurrentLoad()) return;
                if (!normalized) {
                    setError(t('session.sharing.failedToDecrypt'));
                    setIsLoading(false);
                    return;
                }

                setDataset({
                    share: data,
                    decryptedMetadata: e2eeMetadata,
                    ...reducePublicShareTranscript(normalized, e2eePresentationAgentState, messagesData.hasMore === false),
                    normalized,
                    agentState: e2eePresentationAgentState,
                    sessionEncryption,
                    hasMore,
                    nextBeforeSeq,
                    loadGeneration,
                    tokenParam: requestedTokenParam,
                });
                setIsLoading(false);
                return;
            }
        } catch {
            if (!isCurrentLoad()) return;
            setError(t('errors.operationFailed'));
            setIsLoading(false);
        }
    }, [authHeader, tokenParam]);

    useEffect(() => {
        void load(false);
        return () => {
            loadGenerationRef.current += 1;
        };
    }, [load]);

    const loadOlder = useCallback(async (): Promise<TranscriptOlderPageLoadResult> => {
        const current = datasetRef.current;
        if (!current || current.tokenParam !== tokenParam) {
            return { loaded: 0, hasMore: true, status: 'not_ready' };
        }
        if (!current.hasMore || current.nextBeforeSeq === null) {
            return { loaded: 0, hasMore: false, status: 'no_more' };
        }
        // The page grant issued by the share read is reused for every page: paging is one
        // authorized visit, not a new use per screenful.
        const headers: Record<string, string> = {};
        if (authHeader) headers['Authorization'] = authHeader;
        const accessToken = current.share.messagesAccessToken;
        if (typeof accessToken === 'string' && accessToken.trim().length > 0) {
            headers[PUBLIC_SHARE_MESSAGES_ACCESS_TOKEN_HEADER] = accessToken;
        }
        const isCurrentDataset = () => (
            datasetRef.current === current
            && loadGenerationRef.current === current.loadGeneration
        );
        try {
            const response = await serverFetch(
                buildPublicShareMessagesPath({
                    token: current.tokenParam,
                    withConsent: consentedRef.current,
                    beforeSeq: current.nextBeforeSeq,
                }),
                { method: 'GET', headers },
                { includeAuth: false, retry: 'none' },
            );
            if (!isCurrentDataset()) {
                return { loaded: 0, hasMore: true, status: 'not_ready' };
            }
            if (!response.ok) {
                return { loaded: 0, hasMore: true, status: 'retryable_error' };
            }
            const page = (await response.json()) as PublicShareMessagesResponse;
            if (!isCurrentDataset()) {
                return { loaded: 0, hasMore: true, status: 'not_ready' };
            }
            const pageMessages = Array.isArray(page.messages) ? page.messages : null;
            if (!pageMessages) {
                return { loaded: 0, hasMore: true, status: 'retryable_error' };
            }
            const normalizedPage = current.sessionEncryption
                ? await normalizeEncryptedPublicShareMessages(
                    current.sessionEncryption,
                    pageMessages,
                )
                : await normalizePlainPublicShareMessages(pageMessages);
            if (!isCurrentDataset()) {
                return { loaded: 0, hasMore: true, status: 'not_ready' };
            }
            if (!normalizedPage) {
                return { loaded: 0, hasMore: true, status: 'retryable_error' };
            }
            const hasMore = page.hasMore === true;
            const nextBeforeSeq = typeof page.nextBeforeSeq === 'number'
                ? page.nextBeforeSeq
                : null;
            const mergedNormalized = mergePublicShareNormalizedPages(
                current.normalized,
                normalizedPage,
            );
            const loaded = mergedNormalized.length - current.normalized.length;
            setDataset({
                ...current,
                ...reducePublicShareTranscript(mergedNormalized, current.agentState, page.hasMore === false),
                normalized: mergedNormalized,
                hasMore,
                nextBeforeSeq,
            });
            return {
                loaded,
                hasMore,
                status: hasMore && nextBeforeSeq !== null ? 'loaded' : 'no_more',
            };
        } catch {
            if (!isCurrentDataset()) {
                return { loaded: 0, hasMore: true, status: 'not_ready' };
            }
            return { loaded: 0, hasMore: true, status: 'retryable_error' };
        }
    }, [authHeader, tokenParam]);

    const hasCurrentPublishedDataset = dataset?.tokenParam === tokenParam;
    const publicDatasetKey = dataset && hasCurrentPublishedDataset
        ? `public-share:${dataset.share.session.id}:${dataset.loadGeneration}`
        : null;

    if (isLoading || (dataset !== null && !hasCurrentPublishedDataset)) {
        return (
            <View style={[styles.center, { backgroundColor: theme.colors.background.canvas }]}>
                <ActivitySpinner size="large" color={theme.colors.text.link} />
            </View>
        );
    }

    if (error) {
        return (
            <View style={[styles.center, { backgroundColor: theme.colors.background.canvas }]}>
                <Icon
                    name={errorKind === 'metadata_privacy_upgrade_required' ? 'clock' : 'warning-circle'}
                    size={64}
                    color={errorKind === 'metadata_privacy_upgrade_required' ? theme.colors.text.secondary : theme.colors.state.danger.foreground}
                />
                <ItemList presentation="grouped">
                    <ItemGroup>
                        <Item
                            title={errorKind === 'metadata_privacy_upgrade_required'
                                ? t('shareSheet.publicLink.ownerUpdateRequired')
                                : errorKind === 'transcript_unavailable'
                                ? t('externalSessions.sharingTranscriptUnavailableTitle')
                                : t('common.error')}
                            subtitle={error}
                            showChevron={false}
                        />
                    </ItemGroup>
                </ItemList>
            </View>
        );
    }

    if (consentInfo?.requiresConsent) {
        const ownerName = getOwnerDisplayName(consentInfo.owner);
        return (
            <ItemList presentation="grouped" style={{ paddingTop: 0 }}>
                <ItemGroup title={t('session.sharing.consentRequired')}>
                    <Item
                        title={t('session.sharing.sharedBy', { name: ownerName })}
                        icon={<Icon name="person" size={29} color={theme.colors.accent.blue} />}
                        showChevron={false}
                    />
                    <Item
                        title={t('session.sharing.consentDescription')}
                        showChevron={false}
                    />
                </ItemGroup>
                <ItemGroup>
                    <Item
                        title={t('session.sharing.acceptAndView')}
                        icon={<Icon name="check-circle" size={29} color={theme.colors.state.success.foreground} />}
                        onPress={() => load(true)}
                    />
                    <Item
                        title={t('common.cancel')}
                        icon={<Icon name="x-circle" size={29} color={theme.colors.state.danger.foreground} />}
                        onPress={() => router.back()}
                    />
                </ItemGroup>
            </ItemList>
        );
    }

    if (!dataset || !publicDatasetKey) {
        return null;
    }

    const { share, decryptedMetadata } = dataset;
    const ownerName = getOwnerDisplayName(share.owner);
    const sessionName = decryptedMetadata?.name || decryptedMetadata?.path || t('session.sharing.session');

    return (
        <>
            <Stack.Screen options={SHARE_SCREEN_OPTIONS} />
            <View style={{ flex: 1, backgroundColor: theme.colors.surface.base }}>
                <View style={{ position: 'absolute', top: 0, left: 0, right: 0, zIndex: 1000 }}>
                    <ChatHeaderView
                        title={sessionName}
                        subtitle={t('session.sharing.sharedBy', { name: ownerName })}
                        onBackPress={() => router.back()}
                        isConnected={false}
                        flavor={null}
                    />
                </View>
                <View style={{ flex: 1, paddingTop: safeArea.top + headerHeight }}>
                    <PublicShareTranscript
                        key={publicDatasetKey}
                        dataset={dataset}
                        datasetKey={publicDatasetKey}
                        loadOlder={loadOlder}
                    />
                </View>
            </View>
        </>
    );
});

const styles = StyleSheet.create(() => ({
    center: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 24,
    },
}));
