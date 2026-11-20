import { ItemLoadStateRows } from '@/components/ui/lists/ItemLoadStateRows';
import React from 'react';
import { Linking } from 'react-native';
import { useRouter } from 'expo-router';
import { Image } from 'expo-image';
import { useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { SafeIonicons } from '@/components/ui/icons/SafeIonicons';
import { Switch } from '@/components/ui/forms/Switch';
import type { Profile } from '@/sync/domains/profiles/profile';
import { getLinkedProvider } from '@/sync/domains/profiles/profile';
import { useHappyAction } from '@/hooks/ui/useHappyAction';
import { Modal } from '@/modal';
import { t } from '@/text';
import { sync } from '@/sync/sync';
import { HappyError } from '@/utils/errors/errors';
import { setAccountIdentityShowOnProfile } from '@/sync/api/account/apiIdentity';
import { storage } from '@/sync/domains/state/storageStore';
import { TokenStorage, type AuthCredentials } from '@/auth/storage/tokenStorage';
import { authProviderRegistry, getAuthProvider, normalizeProviderId } from '@/auth/providers/registry';
import { fetchHomeAuthEntry } from '@/auth/entry/authEntryClient';
import {
    isNativeAuthenticationMethodId,
    projectAuthEntryMethodCapabilities,
    projectAuthenticationMethodCapabilities,
    type AuthenticationMethodCapabilities,
} from '@/auth/capabilities/authMethodCapabilities';
import { useOAuthProviderConfigured } from '@/hooks/server/useOAuthProviderConfigured';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { isSafeExternalAuthUrl } from '@/auth/providers/externalAuthUrl';
import { Icon } from '@/components/ui/icons/Icon';
import { teamAuthenticationPath } from '@/components/settings/teams/teamsRoutes';
import { useServerFeaturesRuntimeSnapshot } from '@/sync/domains/features/featureDecisionRuntime';
import { identityAdministrationFailureMessage } from '@/components/settings/identity/identityAdministrationFailure';

type ProviderIdentityItemsProps = Readonly<{
    profile: Profile;
    credentials: AuthCredentials | null;
    applyProfile: (profile: Profile) => void;
    returnTo: string;
}>;

type ProviderDescriptor = Readonly<{
    id: string;
    displayName: string;
    iconHint?: string | null;
    canConnect: boolean;
}>;

type ManagedTeamAddress = Readonly<{
    serverId: string;
    teamId: string;
}>;

type ProviderCatalogState =
    | Readonly<{ kind: 'loading' }>
    | Readonly<{ kind: 'legacy' }>
    | Readonly<{ kind: 'current'; descriptors: readonly ProviderDescriptor[] }>
    | Readonly<{ kind: 'unavailable' }>;

type ProviderCatalogSnapshot = Readonly<{
    targetKey: string;
    catalog: ProviderCatalogState;
    requestStatus: 'loading' | 'ready' | 'failed' | 'retrying';
}>;

function mapIdentityErrorToMessage(error: unknown, providerDisplayName: string): string {
    if (!(error instanceof HappyError)) return t('errors.operationFailed');
    const code = error.code ?? error.message;
    switch (code) {
        case 'username-taken':
            return t('friends.username.taken');
        case 'invalid-username':
            return t('friends.username.invalid');
        case 'username-disabled':
            return t('friends.username.disabled');
        case 'friends-disabled':
            return t('friends.disabled');
        case 'provider-already-linked':
            return t('errors.providerAlreadyLinked', { provider: providerDisplayName });
        default:
            return identityAdministrationFailureMessage(code);
    }
}

async function openProviderConnectUrl(params: {
    url: string;
}): Promise<boolean> {
    if (!isSafeExternalAuthUrl(params.url)) {
        await TokenStorage.clearPendingExternalConnect();
        await Modal.alert(t('common.error'), t('errors.operationFailed'));
        return false;
    }

    const supported = await Linking.canOpenURL(params.url);
    if (!supported) {
        await TokenStorage.clearPendingExternalConnect();
        await Modal.alert(t('common.error'), t('errors.operationFailed'));
        return false;
    }

    try {
        await Linking.openURL(params.url);
        return true;
    } catch {
        await TokenStorage.clearPendingExternalConnect();
        await Modal.alert(t('common.error'), t('errors.operationFailed'));
        return false;
    }
}

/**
 * Whether this Home can host a managed identity at all.
 *
 * A Home that predates managed integrations answers "no management metadata"
 * correctly, and its members keep the disconnect and profile-publication
 * controls that Home has always enforced server-side. Only a Home that could
 * have sent management metadata and did not is unclassified, and there the
 * destructive and publication controls fail closed rather than guessing
 * "personal".
 */
/** The connections a catalog offers, one per non-native method, as this list draws them. */
function providerDescriptorsFrom(methods: AuthenticationMethodCapabilities['catalog']['methods']): readonly ProviderDescriptor[] {
    const descriptors = new Map<string, ProviderDescriptor>();
    for (const method of methods) {
        const id = normalizeProviderId(method.id);
        if (!id || isNativeAuthenticationMethodId(id)) continue;
        descriptors.set(id, {
            id,
            displayName: method.presentation?.displayName ?? id,
            ...(method.presentation?.iconHint !== undefined
                ? { iconHint: method.presentation.iconHint }
                : {}),
            canConnect: method.enabledActions.some((action) => action.id === 'connect'),
        });
    }
    return [...descriptors.values()];
}

function releasedIdentityControlsApply(catalog: ProviderCatalogState): boolean {
    return catalog.kind === 'legacy';
}

function ProviderIdentityItem(props: Readonly<{
    provider: (typeof authProviderRegistry)[number];
    management: NonNullable<Profile['linkedIdentityManagementV1']>[number] | null;
    /** The Home cannot host managed identities, so its released controls stand. */
    releasedControls: boolean;
    /** Undefined means the released feature-capability fallback owns availability. */
    connectAvailable?: boolean | null;
    profile: Profile;
    credentials: AuthCredentials | null;
    applyProfile: (profile: Profile) => void;
    returnTo: string;
    managedTeamAddress?: ManagedTeamAddress;
}>) {
    const { theme } = useUnistyles();
    const router = useRouter();
    const providerId = normalizeProviderId(props.provider.id);
    const providerDisplayName = props.provider.displayName ?? props.provider.id;
    const identity = providerId ? getLinkedProvider(props.profile, providerId) : null;
    const oauthSupported = useOAuthProviderConfigured(providerId ?? '__none__');
    const connectAvailable = props.connectAvailable === undefined
        ? oauthSupported
        : props.connectAvailable;
    const canDisconnect = props.management?.canDisconnect ?? props.releasedControls;
    const canPublishProfile = props.management?.canPublishProfile ?? props.releasedControls;
    const openManagedTeam = React.useCallback(() => {
        if (!props.managedTeamAddress) return;
        router.push(teamAuthenticationPath(props.managedTeamAddress));
    }, [props.managedTeamAddress, router]);
    const [savingShowOnProfile, setSavingShowOnProfile] = React.useState(false);

    const [disconnecting, disconnect] = useHappyAction(async () => {
        if (!canDisconnect) return;
        if (!props.credentials) return;
        const confirmed = await Modal.confirm(
            t('modals.disconnectService', { service: providerDisplayName }),
            t('modals.disconnectServiceConfirm', { service: providerDisplayName }),
            { confirmText: t('modals.disconnect'), destructive: true },
        );
        if (!confirmed) return;
        await props.provider.disconnect(props.credentials);
        await sync.refreshProfile();
    });

    const [connecting, connect] = useHappyAction(async () => {
        if (connectAvailable !== true) return;
        if (!props.credentials || !providerId) return;

        try {
            await TokenStorage.setPendingExternalConnect({ provider: providerId, returnTo: props.returnTo });
            const url = await props.provider.getConnectUrl(props.credentials);
            await openProviderConnectUrl({ url });
        } catch (error) {
            await TokenStorage.clearPendingExternalConnect();
            await Modal.alert(t('common.error'), mapIdentityErrorToMessage(error, providerDisplayName));
        }
    });

    const onToggleShowOnProfile = async (value: boolean) => {
        if (
            !canPublishProfile
            || !props.credentials
            || !identity
            || savingShowOnProfile
        ) return;

        setSavingShowOnProfile(true);
        try {
            await setAccountIdentityShowOnProfile({
                credentials: props.credentials,
                providerId: identity.id,
                showOnProfile: value,
            });

            const currentProfile = storage.getState().profile;
            props.applyProfile({
                ...currentProfile,
                linkedProviders: (currentProfile.linkedProviders ?? []).map((linkedProvider) =>
                    normalizeProviderId(linkedProvider.id) === normalizeProviderId(identity.id)
                        ? { ...linkedProvider, showOnProfile: value }
                        : linkedProvider,
                ),
            });
        } catch (error) {
            await Modal.alert(t('common.error'), mapIdentityErrorToMessage(error, providerDisplayName));
        } finally {
            setSavingShowOnProfile(false);
        }
    };

    const iconName = props.provider.badgeIconName ?? 'key-outline';
    const iconColor = theme.colors.text.secondary;
    const icon =
        identity?.avatarUrl ? (
            <Image
                source={{ uri: identity.avatarUrl }}
                style={{ width: 29, height: 29, borderRadius: 14.5 }}
                contentFit="cover"
                transition={200}
                cachePolicy="memory-disk"
            />
        ) : (
            <Icon name={iconName as any} size={29} color={iconColor} />
        );

    if (!identity) {
        return (
            <Item
                title={providerDisplayName}
                subtitle={
                    connectAvailable === false
                        ? t('friends.providerGate.notConfigured', { provider: providerDisplayName })
                        : t('friends.providerGate.title', { provider: providerDisplayName })
                }
                mode="info"
                showChevron={false}
                icon={icon}
                rightElementOutsidePressable
                rightElement={connectAvailable === false ? undefined : (
                    <RoundButton
                        testID={`settings-account-identity-${providerId ?? props.provider.id}-connect`}
                        size="small"
                        display="secondary"
                        title={t('settingsAccount.connect')}
                        accessibilityLabel={t('friends.providerGate.connect', { provider: providerDisplayName })}
                        onPress={connect}
                        disabled={connectAvailable !== true || connecting}
                        loading={connecting || connectAvailable == null}
                    />
                )}
            />
        );
    }

    return (
        <>
            <Item
                title={providerDisplayName}
                detail={identity.login ? `@${identity.login}` : identity.displayName ?? undefined}
                subtitle={canDisconnect
                    ? undefined
                    : props.management?.managedBy?.kind === 'team'
                        ? t('teams.groups.managedBy', { source: props.management.managedBy.team.name })
                        : props.management?.managedBy?.kind === 'home'
                            ? t('teams.groups.managedBy', { source: t('identityAdministration.providerOwnerHome') })
                            : props.management?.requiredByTeams.length
                                ? t('teams.groups.managedBy', {
                                    source: props.management.requiredByTeams.map((team) => team.name).join(', '),
                                })
                                : undefined}
                onPress={!canDisconnect && props.managedTeamAddress ? openManagedTeam : undefined}
                mode={!canDisconnect && props.managedTeamAddress ? 'interactive' : 'info'}
                showChevron={!canDisconnect && props.managedTeamAddress !== undefined}
                icon={icon}
                rightElementOutsidePressable
                rightElement={canDisconnect ? (
                    <RoundButton
                        testID={`settings-account-identity-${providerId ?? props.provider.id}-disconnect`}
                        size="small"
                        display="secondary"
                        title={t('modals.disconnect')}
                        accessibilityLabel={t('modals.disconnectService', { service: providerDisplayName })}
                        onPress={disconnect}
                        loading={disconnecting}
                    />
                ) : undefined}
            />
            {canPublishProfile ? (
                <Item
                    title={t('settingsAccount.showProviderOnProfile', { provider: providerDisplayName })}
                    rightElement={(
                        <Switch
                            value={identity.showOnProfile}
                            onValueChange={(value) => {
                                void onToggleShowOnProfile(value);
                            }}
                            disabled={savingShowOnProfile}
                        />
                    )}
                    showChevron={false}
                />
            ) : null}
        </>
    );
}

export const ProviderIdentityItems = React.memo((props: ProviderIdentityItemsProps) => {
    const activeServer = useActiveServerSnapshot();
    const featuresSnapshot = useServerFeaturesRuntimeSnapshot();
    const targetKey = `${activeServer.serverId}\u0000${activeServer.serverUrl}`;
    const [catalogSnapshot, setCatalogSnapshot] = React.useState<ProviderCatalogSnapshot>(() => ({
        targetKey,
        catalog: { kind: 'loading' },
        requestStatus: 'loading',
    }));
    const [retryAttempt, setRetryAttempt] = React.useState(0);
    const liveCatalog: ProviderCatalogState = catalogSnapshot.targetKey === targetKey
        ? catalogSnapshot.catalog
        : { kind: 'loading' };
    // While the live entry is read, the methods the Home already released (its features, read before this page)
    // stand for it: the connections draw at once and nothing below them moves when the entry agrees.
    const releasedCatalog = React.useMemo<ProviderCatalogState | null>(() => {
        if (liveCatalog.kind !== 'loading' || featuresSnapshot.status !== 'ready') return null;
        const capabilities = projectAuthenticationMethodCapabilities(featuresSnapshot.features);
        return capabilities.usesStructuredMethods
            ? { kind: 'current', descriptors: providerDescriptorsFrom(capabilities.catalog.methods) }
            : null;
    }, [featuresSnapshot, liveCatalog.kind]);
    const catalog = releasedCatalog ?? liveCatalog;
    const liveRequestStatus = catalogSnapshot.targetKey === targetKey ? catalogSnapshot.requestStatus : 'loading';
    const requestStatus = releasedCatalog && liveRequestStatus === 'loading' ? 'ready' : liveRequestStatus;

    React.useEffect(() => {
        const abortController = new AbortController();
        setCatalogSnapshot((previous) => ({
            targetKey,
            catalog: previous.targetKey === targetKey ? previous.catalog : { kind: 'loading' },
            requestStatus: previous.targetKey === targetKey && (previous.requestStatus === 'failed' || previous.requestStatus === 'retrying')
                ? 'retrying'
                : 'loading',
        }));
        const fail = (retainCatalog: boolean) => {
            if (abortController.signal.aborted) return;
            setCatalogSnapshot((previous) => ({
                targetKey,
                catalog: retainCatalog && previous.targetKey === targetKey && previous.catalog.kind !== 'loading'
                    ? previous.catalog
                    : { kind: 'unavailable' },
                requestStatus: 'failed',
            }));
        };
        void fetchHomeAuthEntry({ signal: abortController.signal })
            .then((result) => {
                if (abortController.signal.aborted) return;
                if (result.kind === 'unsupported') {
                    setCatalogSnapshot({ targetKey, catalog: { kind: 'legacy' }, requestStatus: 'ready' });
                    return;
                }
                if (result.kind !== 'ready' || result.projection.state !== 'ready') {
                    fail(result.kind === 'unavailable');
                    return;
                }

                const capabilities = projectAuthEntryMethodCapabilities(result.projection);
                setCatalogSnapshot({
                    targetKey,
                    catalog: { kind: 'current', descriptors: providerDescriptorsFrom(capabilities.catalog.methods) },
                    requestStatus: 'ready',
                });
            })
            .catch(() => fail(true));
        return () => abortController.abort();
    }, [activeServer.generation, targetKey, retryAttempt]);

    const rows = React.useMemo(() => {
        const byId = new Map<string, Readonly<{
            provider: (typeof authProviderRegistry)[number];
            connectAvailable?: boolean | null;
            management: NonNullable<Profile['linkedIdentityManagementV1']>[number] | null;
        }>>();
        // While the catalog loads nothing is guessed from the registry: a guessed row would vanish
        // or change on arrival. The loading line below holds the place instead.
        if (catalog.kind === 'legacy') {
            for (const provider of authProviderRegistry) {
                const id = normalizeProviderId(provider.id);
                if (!id) continue;
                byId.set(id, { provider, management: null });
            }
            if (featuresSnapshot.status === 'ready') {
                for (const [rawId, descriptor] of Object.entries(featuresSnapshot.features.capabilities.auth.providers)) {
                    const id = normalizeProviderId(rawId);
                    if (!id || !descriptor.enabled || !descriptor.configured) continue;
                    const provider = getAuthProvider(id, {
                        displayName: descriptor.ui?.displayName ?? rawId,
                        ...(descriptor.ui?.iconHint ? { badgeIconName: descriptor.ui.iconHint } : {}),
                    });
                    if (!provider) continue;
                    byId.set(id, {
                        provider,
                        connectAvailable: true,
                        management: null,
                    });
                }
            }
        } else if (catalog.kind === 'current') {
            for (const descriptor of catalog.descriptors) {
                if (!descriptor.canConnect && !getLinkedProvider(props.profile, descriptor.id)) continue;
                const provider = getAuthProvider(descriptor.id, {
                    displayName: descriptor.displayName,
                    ...(descriptor.iconHint ? { badgeIconName: descriptor.iconHint } : {}),
                });
                if (provider) byId.set(descriptor.id, {
                    provider,
                    connectAvailable: descriptor.canConnect,
                    management: null,
                });
            }
        }

        const managementByProviderId = new Map(
            (props.profile.linkedIdentityManagementV1 ?? []).map((management) => [
                normalizeProviderId(management.providerId),
                management,
            ]),
        );
        for (const identity of props.profile.linkedProviders ?? []) {
            const id = normalizeProviderId(identity.id);
            if (!id) continue;
            const management = managementByProviderId.get(id) ?? null;
            const existing = byId.get(id);
            const provider = (management
                ? getAuthProvider(id, {
                    displayName: management.descriptor.displayName ?? id,
                    ...(management.descriptor.iconHint
                        ? { badgeIconName: management.descriptor.iconHint }
                        : {}),
                })
                : getAuthProvider(id)) ?? existing?.provider;
            if (provider) byId.set(id, {
                provider,
                connectAvailable: existing?.connectAvailable ?? false,
                management,
            });
        }
        return [...byId.values()];
    }, [catalog, featuresSnapshot, props.profile]);

    const releasedControls = releasedIdentityControlsApply(catalog);

    // Retry stays pending (and not pressable again) until the retried read settles.
    const retrySettledRef = React.useRef<(() => void) | null>(null);
    React.useEffect(() => {
        if (requestStatus === 'retrying') return;
        retrySettledRef.current?.();
        retrySettledRef.current = null;
    }, [requestStatus]);
    const retryCatalog = React.useCallback(() => new Promise<void>((resolve) => {
        retrySettledRef.current = resolve;
        setRetryAttempt((attempt) => attempt + 1);
    }), []);

    return (
        <>
            {/* The connections line is held while the catalog loads, and a failed read takes that
                same line with Retry: the sheet never gains or loses a row on arrival. */}
            {requestStatus !== 'ready' ? (
                <ItemLoadStateRows
                    testID="settings-account-identity-catalog"
                    state={requestStatus === 'loading'
                        ? { kind: 'loading' }
                        : {
                            kind: 'failed',
                            reason: t('settingsAccount.providerCatalogUnavailable'),
                            onRetry: retryCatalog,
                        }}
                    rows={1}
                    lines={2}
                    accessibilityLabel={t('common.loading')}
                />
            ) : null}
            {rows.map(({ provider, connectAvailable, management }) => (
                <ProviderIdentityItem
                    key={provider.id}
                    provider={provider}
                    management={management}
                    releasedControls={releasedControls}
                    {...(connectAvailable !== undefined ? { connectAvailable } : {})}
                    profile={props.profile}
                    credentials={props.credentials}
                    applyProfile={props.applyProfile}
                    returnTo={props.returnTo}
                    {...(management?.managedBy?.kind === 'team'
                        ? { managedTeamAddress: { serverId: activeServer.serverId, teamId: management.managedBy.team.id } }
                        : {})}
                />
            ))}
        </>
    );
});
