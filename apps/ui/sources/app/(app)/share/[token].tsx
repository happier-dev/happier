import React, { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
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
import { normalizeRawMessage, type NormalizedMessage } from '@/sync/typesRaw';
import { useAuth } from '@/auth/context/AuthContext';
import { createReducer, reducer } from '@/sync/reducer/reducer';
import { TranscriptList } from '@/components/sessions/transcript/TranscriptList';
import { ChatHeaderView } from '@/components/sessions/transcript/ChatHeaderView';
import type { Message } from '@/sync/domains/messages/messageTypes';
import { serverFetch } from '@/sync/http/client';
import type { Metadata } from '@/sync/domains/state/storageTypes';
import { deriveTranscriptInteraction } from '@/utils/sessions/deriveTranscriptInteraction';
import { sortNormalizedMessagesOldestFirst } from '@/utils/sessions/sortNormalizedMessagesOldestFirst';
import { parsePlainSessionAgentState, parsePlainSessionMetadata } from '@/sync/engine/sessions/parsePlainSessionPayload';
import { readStoredSessionRawRecord } from '@/sync/runtime/readStoredSessionContent';

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
        agentState: string | null;
        agentStateVersion: number;
    };
    owner: ShareOwner;
    accessLevel: 'view';
    encryptedDataKey: string | null;
    isConsentRequired: boolean;
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

async function normalizePlainPublicShareMessages(messages: ReadonlyArray<ApiMessage>): Promise<NormalizedMessage[]> {
    const normalized: NormalizedMessage[] = [];
    for (const message of messages) {
        if (!message) continue;

        const content = await readStoredSessionRawRecord({ content: message.content });
        if (!content) continue;

        const normalizedMessage = normalizeRawMessage(
            message.id,
            message.localId ?? null,
            message.createdAt,
            content,
            { seq: normalizeMessageSeq(message) },
        );
        if (!normalizedMessage) continue;

        normalized.push(normalizedMessage);
    }

    return normalized;
}

export default memo(function PublicShareViewerScreen() {
    const { token } = useLocalSearchParams<{ token: string }>();
    const { credentials } = useAuth();
    const router = useRouter();
    const { theme } = useUnistyles();
    const tokenParam = typeof token === 'string' ? token : null;

    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [consentInfo, setConsentInfo] = useState<PublicShareConsentResponse | null>(null);
    const [share, setShare] = useState<PublicShareResponse | null>(null);
    const [decryptedMetadata, setDecryptedMetadata] = useState<Metadata | null>(null);
    const [messages, setMessages] = useState<Message[]>([]);

    const authHeader = useMemo(() => {
        if (!credentials?.token) return null;
        return `Bearer ${credentials.token}`;
    }, [credentials?.token]);

    const load = useCallback(async (withConsent: boolean) => {
        if (!tokenParam) {
            setError(t('errors.invalidShareLink'));
            setIsLoading(false);
            return;
        }

        setIsLoading(true);
        setError(null);
        setConsentInfo(null);
        setShare(null);
        setDecryptedMetadata(null);
        setMessages([]);

        try {
            const path = withConsent
                ? `/v1/public-share/${tokenParam}?consent=true`
                : `/v1/public-share/${tokenParam}`;

            const headers: Record<string, string> = {};
            if (authHeader) {
                headers['Authorization'] = authHeader;
            }

            const response = await serverFetch(path, { method: 'GET', headers }, { includeAuth: false });
            if (!response.ok) {
                if (response.status === 403) {
                    const data = await response.json();
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

            const messagesPath = withConsent
                ? `/v1/public-share/${tokenParam}/messages?consent=true`
                : `/v1/public-share/${tokenParam}/messages`;
            const messagesResponse = await serverFetch(messagesPath, { method: 'GET', headers }, { includeAuth: false });
            if (!messagesResponse.ok) {
                setError(t('errors.operationFailed'));
                setIsLoading(false);
                return;
            }
            const messagesData = (await messagesResponse.json()) as PublicShareMessagesResponse;
            const shareMessages = Array.isArray(messagesData.messages) ? messagesData.messages : null;
            if (!shareMessages) {
                setError(t('errors.operationFailed'));
                setIsLoading(false);
                return;
            }

            const sessionEncryptionMode = data.session.encryptionMode === 'plain' ? 'plain' : 'e2ee';
            const plainMetadata = sessionEncryptionMode === 'plain'
                ? parsePlainSessionMetadata(data.session.metadata)
                : null;
            const plainAgentState = sessionEncryptionMode === 'plain'
                ? parsePlainSessionAgentState(data.session.agentState)
                : {};

            if (sessionEncryptionMode === 'plain') {
                const normalized = await normalizePlainPublicShareMessages(shareMessages);
                sortNormalizedMessagesOldestFirst(normalized);

                const reducerState = createReducer();
                const reduced = reducer(reducerState, normalized, plainAgentState);

                setShare(data);
                setDecryptedMetadata(plainMetadata);
                setMessages(reduced.messages.slice(-200));
                setIsLoading(false);
                return;
            } else {
                if (!data.encryptedDataKey) {
                    setError(t('session.sharing.failedToDecrypt'));
                    setIsLoading(false);
                    return;
                }

                const decryptedKey = await decryptDataKeyFromPublicShare(data.encryptedDataKey, tokenParam);
                if (!decryptedKey) {
                    setError(t('session.sharing.failedToDecrypt'));
                    setIsLoading(false);
                    return;
                }

                const sessionEncryptor = new AES256Encryption(decryptedKey);
                const cache = new EncryptionCache();
                const sessionEncryption = new SessionEncryption(data.session.id, sessionEncryptor, cache);

                const e2eeMetadata = await sessionEncryption.decryptMetadata(
                    data.session.metadataVersion,
                    data.session.metadata
                );
                if (!e2eeMetadata) {
                    setError(t('session.sharing.failedToDecrypt'));
                    setIsLoading(false);
                    return;
                }

                const e2eeAgentState = await sessionEncryption.decryptAgentState(
                    data.session.agentStateVersion,
                    data.session.agentState
                );

                const decryptedMessages = await sessionEncryption.decryptMessages(shareMessages);
                const normalized: NormalizedMessage[] = [];
                for (const m of decryptedMessages) {
                    if (!m || !m.content) {
                        setError(t('session.sharing.failedToDecrypt'));
                        setIsLoading(false);
                        return;
                    }
                    const normalizedMessage = normalizeRawMessage(
                        m.id,
                        m.localId ?? null,
                        m.createdAt,
                        m.content,
                        { seq: normalizeMessageSeq(m) },
                    );
                    if (normalizedMessage) normalized.push(normalizedMessage);
                }

                sortNormalizedMessagesOldestFirst(normalized);

                const reducerState = createReducer();
                const reduced = reducer(reducerState, normalized, e2eeAgentState);

                setShare(data);
                setDecryptedMetadata(e2eeMetadata);
                setMessages(reduced.messages.slice(-200));
                setIsLoading(false);
                return;
            }
        } catch {
            setError(t('errors.operationFailed'));
            setIsLoading(false);
        }
    }, [authHeader, tokenParam]);

    useEffect(() => {
        void load(false);
    }, [load]);

    if (isLoading) {
        return (
            <View style={[styles.center, { backgroundColor: theme.colors.groupped.background }]}>
                <ActivityIndicator size="large" color={theme.colors.textLink} />
            </View>
        );
    }

    if (error) {
        return (
            <View style={[styles.center, { backgroundColor: theme.colors.groupped.background }]}>
                <Ionicons name="alert-circle-outline" size={64} color={theme.colors.textDestructive} />
                <ItemList>
                    <ItemGroup>
                        <Item title={t('common.error')} subtitle={error} showChevron={false} />
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
                        icon={<Ionicons name="person-outline" size={29} color={theme.colors.accent.blue} />}
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
                        icon={<Ionicons name="checkmark-circle-outline" size={29} color={theme.colors.success} />}
                        onPress={() => load(true)}
                    />
                    <Item
                        title={t('common.cancel')}
                        icon={<Ionicons name="close-circle-outline" size={29} color={theme.colors.warningCritical} />}
                        onPress={() => router.back()}
                    />
                </ItemGroup>
            </ItemList>
        );
    }

    if (!share) {
        return null;
    }

    const ownerName = getOwnerDisplayName(share.owner);
    const sessionName = decryptedMetadata?.name || decryptedMetadata?.path || t('session.sharing.session');
    const interaction = deriveTranscriptInteraction({ kind: 'public', disableToolNavigation: true });

    return (
        <>
            <Stack.Screen options={SHARE_SCREEN_OPTIONS} />
            <View style={{ flex: 1, backgroundColor: theme.colors.surface }}>
                <View style={{ position: 'absolute', top: 0, left: 0, right: 0, zIndex: 1000 }}>
                    <ChatHeaderView
                        title={sessionName}
                        subtitle={t('session.sharing.sharedBy', { name: ownerName })}
                        onBackPress={() => router.back()}
                        isConnected={false}
                        flavor={null}
                    />
                </View>
                <TranscriptList
                    sessionId={share.session.id}
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
