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
import type { ApiMessage } from '@/sync/api/types/apiTypes';
import {
    normalizeRawMessages,
    type NormalizedMessage,
    type RawMessageNormalizationInput,
} from '@/sync/typesRaw';
import { useAuth } from '@/auth/context/AuthContext';
import { createReducer, reducer } from '@/sync/reducer/reducer';
import { TranscriptList } from '@/components/sessions/transcript/TranscriptList';
import { ChatHeaderView } from '@/components/sessions/transcript/ChatHeaderView';
import type { Message } from '@/sync/domains/messages/messageTypes';
import { serverFetch } from '@/sync/http/client';
import type { Metadata } from '@/sync/domains/state/storageTypes';
import type { AgentState } from '@/sync/domains/state/storageTypes';
import { deriveTranscriptInteraction } from '@/utils/sessions/deriveTranscriptInteraction';
import { sortNormalizedMessagesOldestFirst } from '@/utils/sessions/sortNormalizedMessagesOldestFirst';
import {
    parseDecryptedSessionMetadata,
    parsePlainSessionMetadata,
} from '@/sync/engine/sessions/parsePlainSessionPayload';
import {
    readSharedMetadataPresentationCompletedRequests,
} from '@/sync/domains/session/presentation/readSessionPresentationCompletedRequests';
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
    messages: ApiMessage[];
};

type PublicShareDataset = Readonly<{
    share: PublicShareResponse;
    decryptedMetadata: Metadata | null;
    messages: Message[];
    loadGeneration: number;
    tokenParam: string;
}>;

const PUBLIC_SHARE_MESSAGES_ACCESS_TOKEN_HEADER = 'x-public-share-messages-access-token';

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

async function normalizePlainPublicShareMessages(messages: ReadonlyArray<ApiMessage>): Promise<NormalizedMessage[]> {
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

export default memo(function PublicShareViewerScreen() {
    const { token } = useLocalSearchParams<{ token: string }>();
    const { credentials } = useAuth();
    const router = useRouter();
    const { theme } = useUnistyles();
    const safeArea = useChromeSafeAreaInsets();
    const headerHeight = useHeaderHeight();
    const tokenParam = typeof token === 'string' ? token : null;

    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [errorKind, setErrorKind] = useState<'generic' | 'transcript_unavailable'>('generic');
    const [consentInfo, setConsentInfo] = useState<PublicShareConsentResponse | null>(null);
    const [dataset, setDataset] = useState<PublicShareDataset | null>(null);
    const loadGenerationRef = useRef(0);

    const authHeader = useMemo(() => {
        if (!credentials?.token) return null;
        return `Bearer ${credentials.token}`;
    }, [credentials?.token]);

    const load = useCallback(async (withConsent: boolean) => {
        const loadGeneration = ++loadGenerationRef.current;
        const requestedTokenParam = tokenParam;
        const isCurrentLoad = () => loadGenerationRef.current === loadGeneration;

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

            const response = await serverFetch(path, { method: 'GET', headers }, { includeAuth: false });
            if (!isCurrentLoad()) return;
            if (!response.ok) {
                const data = await response.json().catch(() => null);
                if (!isCurrentLoad()) return;
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

            const messagesPath = withConsent
                ? `/v1/public-share/${requestedTokenParam}/messages?consent=true`
                : `/v1/public-share/${requestedTokenParam}/messages`;
            const messagesHeaders = { ...headers };
            if (typeof data.messagesAccessToken === 'string' && data.messagesAccessToken.trim().length > 0) {
                messagesHeaders[PUBLIC_SHARE_MESSAGES_ACCESS_TOKEN_HEADER] = data.messagesAccessToken;
            }
            const messagesResponse = await serverFetch(messagesPath, { method: 'GET', headers: messagesHeaders }, { includeAuth: false });
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

            if (sessionEncryptionMode === 'plain') {
                const normalized = await normalizePlainPublicShareMessages(shareMessages);
                if (!isCurrentLoad()) return;
                sortNormalizedMessagesOldestFirst(normalized);

                const reducerState = createReducer();
                const reduced = reducer(reducerState, normalized, plainAgentState);

                setDataset({
                    share: data,
                    decryptedMetadata: plainMetadata,
                    messages: reduced.messages.slice(-200),
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

                const decryptedMessages = await sessionEncryption.decryptMessages(shareMessages);
                if (!isCurrentLoad()) return;
                const inputs: RawMessageNormalizationInput[] = [];
                for (const m of decryptedMessages) {
                    if (!m || !m.content) {
                        setError(t('session.sharing.failedToDecrypt'));
                        setIsLoading(false);
                        return;
                    }
                    inputs.push({
                        id: m.id,
                        localId: m.localId ?? null,
                        createdAt: m.createdAt,
                        raw: m.content,
                        seq: normalizeMessageSeq(m),
                        messageRole: m.messageRole ?? undefined,
                    });
                }

                const normalized = normalizePublicShareRawInputs(inputs);

                const reducerState = createReducer();
                const reduced = reducer(reducerState, normalized, e2eePresentationAgentState);

                setDataset({
                    share: data,
                    decryptedMetadata: e2eeMetadata,
                    messages: reduced.messages.slice(-200),
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
                <Icon name="warning-circle" size={64} color={theme.colors.state.danger.foreground} />
                <ItemList>
                    <ItemGroup>
                        <Item
                            title={errorKind === 'transcript_unavailable'
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
            <ItemList style={{ paddingTop: 0 }}>
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

    const { share, decryptedMetadata, messages } = dataset;
    const ownerName = getOwnerDisplayName(share.owner);
    const sessionName = decryptedMetadata?.name || decryptedMetadata?.path || t('session.sharing.session');
    const interaction = deriveTranscriptInteraction({ kind: 'public', disableToolNavigation: true });

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
                    <TranscriptList
                        key={publicDatasetKey}
                        sessionId={share.session.id}
                        datasetKey={publicDatasetKey}
                        metadata={decryptedMetadata}
                        messages={messages}
                        interaction={interaction}
                        bottomNotice={{
                            title: t('session.sharing.publicReadOnlyTitle'),
                            body: t('session.sharing.publicReadOnlyBody'),
                        }}
                        isLoaded={!isLoading}
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
