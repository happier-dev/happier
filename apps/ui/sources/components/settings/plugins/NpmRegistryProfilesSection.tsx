import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';
import type {
    DaemonNpmRegistryProfileMutationRequestV1,
    DaemonNpmRegistryProfileSnapshotV1,
} from '@happier-dev/protocol/rpc';
import { NpmRegistryOriginV1Schema, NpmRegistryProfileInputV1Schema } from '@happier-dev/protocol/rpc';
import type { MarketplaceSourceV1 } from '@happier-dev/protocol';

import { usePrimaryMachineFromActiveSelection } from '@/components/settings/server/hooks/usePrimaryMachineFromActiveSelection';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Modal } from '@/modal';
import { randomUUID } from '@/platform/randomUUID';
import { getActiveServerId } from '@/sync/domains/server/serverProfiles';
import {
    machineNpmRegistryProfilesGet,
    machineNpmRegistryProfilesMutate,
} from '@/sync/ops/machineNpmRegistryProfiles';
import { t } from '@/text';

type LocalRegistryMutation = DaemonNpmRegistryProfileMutationRequestV1 extends infer TMutation
    ? TMutation extends DaemonNpmRegistryProfileMutationRequestV1
        ? Omit<TMutation, 'machineId' | 'expectedRevision' | 'mutationId'>
        : never
    : never;

type RegistryProfileView = DaemonNpmRegistryProfileSnapshotV1['profiles'][number];
type LoadedSnapshot = Readonly<{
    selectionKey: string;
    snapshot: DaemonNpmRegistryProfileSnapshotV1;
}>;

type NpmRegistryProfilesSectionProps = Readonly<{
    daemonOperationsAvailable: boolean;
    marketplaceSources?: readonly MarketplaceSourceV1[];
    onSetMarketplaceSourceProfile?: (sourceId: string, profileId: string | null) => Promise<void>;
}>;

export function NpmRegistryProfilesSection({
    daemonOperationsAvailable,
    marketplaceSources = [],
    onSetMarketplaceSourceProfile,
}: NpmRegistryProfilesSectionProps): React.ReactElement {
    const { theme } = useUnistyles();
    const machineId = usePrimaryMachineFromActiveSelection();
    const serverId = getActiveServerId();
    const selectionKey = `${serverId ?? ''}\0${machineId ?? ''}`;
    const selectionKeyRef = React.useRef(selectionKey);
    selectionKeyRef.current = selectionKey;
    const daemonOperationsAvailableRef = React.useRef(daemonOperationsAvailable);
    daemonOperationsAvailableRef.current = daemonOperationsAvailable;
    const refreshGenerationRef = React.useRef(0);
    const mutationRequestIdRef = React.useRef(0);
    const mutationInFlightRef = React.useRef(false);
    const bindingRequestIdRef = React.useRef(0);
    const bindingInFlightRef = React.useRef(false);
    const [loaded, setLoaded] = React.useState<LoadedSnapshot | null>(null);
    const [loading, setLoading] = React.useState(false);
    const [loadError, setLoadError] = React.useState(false);
    const [busyProfileId, setBusyProfileId] = React.useState<string | null>(null);
    const [busyBindingSourceId, setBusyBindingSourceId] = React.useState<string | null>(null);
    const snapshot = loaded?.selectionKey === selectionKey ? loaded.snapshot : null;

    const refresh = React.useCallback(async () => {
        const generation = ++refreshGenerationRef.current;
        const requestedSelection = selectionKey;
        if (!machineId || !daemonOperationsAvailable) {
            if (!machineId) setLoaded(null);
            setLoadError(false);
            setLoading(false);
            return;
        }
        setLoading(true);
        setLoadError(false);
        try {
            const result = await machineNpmRegistryProfilesGet(machineId, { serverId });
            if (generation !== refreshGenerationRef.current || selectionKeyRef.current !== requestedSelection) return;
            if (result.status === 'success') {
                setLoaded({ selectionKey: requestedSelection, snapshot: result.snapshot });
            } else {
                setLoadError(true);
            }
        } catch {
            if (generation === refreshGenerationRef.current && selectionKeyRef.current === requestedSelection) {
                setLoadError(true);
            }
        } finally {
            if (generation === refreshGenerationRef.current && selectionKeyRef.current === requestedSelection) {
                setLoading(false);
            }
        }
    }, [daemonOperationsAvailable, machineId, selectionKey, serverId]);

    React.useEffect(() => { void refresh(); }, [refresh]);

    React.useEffect(() => {
        mutationRequestIdRef.current += 1;
        mutationInFlightRef.current = false;
        bindingRequestIdRef.current += 1;
        bindingInFlightRef.current = false;
        setBusyProfileId(null);
        setBusyBindingSourceId(null);
    }, [daemonOperationsAvailable, selectionKey]);

    const mutate = React.useCallback(async (
        request: LocalRegistryMutation,
    ) => {
        if (!daemonOperationsAvailableRef.current || !machineId || !snapshot || mutationInFlightRef.current) return;
        const requestedSelection = selectionKey;
        const requestId = ++mutationRequestIdRef.current;
        const profileId = 'profileId' in request ? request.profileId : 'registry';
        mutationInFlightRef.current = true;
        setBusyProfileId(profileId);
        try {
            const result = await machineNpmRegistryProfilesMutate(machineId, {
                ...request,
                machineId,
                expectedRevision: snapshot.revision,
                mutationId: `registry-${request.action}-${randomUUID()}`,
            } as DaemonNpmRegistryProfileMutationRequestV1, { serverId });
            if (
                requestId !== mutationRequestIdRef.current
                || !daemonOperationsAvailableRef.current
                || selectionKeyRef.current !== requestedSelection
            ) return;
            if (result.status === 'success') {
                setLoaded({ selectionKey: requestedSelection, snapshot: result.snapshot });
                return;
            }
            if (result.code === 'revision_conflict') await refresh();
            await Modal.alert(t('settingsPlugins.registriesErrorTitle'), t('settingsPlugins.registriesErrorBody'));
        } catch {
            if (
                requestId === mutationRequestIdRef.current
                && daemonOperationsAvailableRef.current
                && selectionKeyRef.current === requestedSelection
            ) {
                await Modal.alert(t('settingsPlugins.registriesErrorTitle'), t('settingsPlugins.registriesErrorBody'));
            }
        } finally {
            if (requestId === mutationRequestIdRef.current) {
                mutationInFlightRef.current = false;
                setBusyProfileId(null);
            }
        }
    }, [machineId, refresh, selectionKey, serverId, snapshot]);

    const add = React.useCallback(async () => {
        if (!daemonOperationsAvailableRef.current) return;
        const origin = (await Modal.prompt(
            t('settingsPlugins.registriesAddTitle'),
            t('settingsPlugins.registriesAddOriginBody'),
            { placeholder: 'https://registry.example.com', confirmText: t('common.next'), cancelText: t('common.cancel') },
        ))?.trim();
        if (!origin) return;
        const parsedOrigin = NpmRegistryOriginV1Schema.safeParse(origin);
        if (!parsedOrigin.success) {
            await Modal.alert(t('settingsPlugins.registriesInvalidOriginTitle'), t('settingsPlugins.registriesInvalidOriginBody'));
            return;
        }
        const displayName = (await Modal.prompt(
            t('settingsPlugins.registriesNameTitle'),
            t('settingsPlugins.registriesNameBody'),
            { defaultValue: new URL(parsedOrigin.data).hostname, confirmText: t('common.next'), cancelText: t('common.cancel') },
        ))?.trim();
        if (!displayName) return;
        const scopeInput = (await Modal.prompt(
            t('settingsPlugins.registriesScopesTitle'),
            t('settingsPlugins.registriesScopesBody'),
            { placeholder: t('settingsPlugins.registriesScopesPlaceholder'), confirmText: t('common.add'), cancelText: t('common.cancel') },
        ))?.trim() ?? '';
        const useAsDefault = await Modal.confirm(
            t('settingsPlugins.registriesDefaultTitle'),
            t('settingsPlugins.registriesDefaultBody'),
            { confirmText: t('settingsPlugins.registriesUseAsDefault'), cancelText: t('settingsPlugins.registriesScopedOnly') },
        );
        const allowPrivateNetwork = await Modal.confirm(
            t('settingsPlugins.registriesPrivateNetworkTitle'),
            t('settingsPlugins.registriesPrivateNetworkBody'),
            { confirmText: t('settingsPlugins.registriesAllowPrivateNetwork'), cancelText: t('settingsPlugins.registriesPublicOnly') },
        );
        const profile = NpmRegistryProfileInputV1Schema.safeParse({
            displayName,
            origin: parsedOrigin.data,
            scopes: scopeInput.split(',').map((scope) => scope.trim()).filter(Boolean),
            useAsDefault,
            allowPrivateNetwork,
        });
        if (!profile.success) {
            await Modal.alert(t('settingsPlugins.registriesInvalidProfileTitle'), t('settingsPlugins.registriesInvalidProfileBody'));
            return;
        }
        await mutate({
            action: 'add',
            profileId: `registry_${randomUUID().replaceAll('-', '_')}`,
            profile: profile.data,
        });
    }, [mutate]);

    const edit = React.useCallback(async (current: RegistryProfileView) => {
        if (!daemonOperationsAvailableRef.current) return;
        const displayName = (await Modal.prompt(
            t('settingsPlugins.registriesNameTitle'),
            t('settingsPlugins.registriesNameBody'),
            { defaultValue: current.displayName, confirmText: t('common.next'), cancelText: t('common.cancel') },
        ))?.trim();
        if (!displayName) return;
        const scopeInput = (await Modal.prompt(
            t('settingsPlugins.registriesScopesTitle'),
            t('settingsPlugins.registriesScopesBody'),
            { defaultValue: current.scopes.join(', '), confirmText: t('common.next'), cancelText: t('common.cancel') },
        ))?.trim() ?? '';
        const useAsDefault = await Modal.confirm(
            t('settingsPlugins.registriesDefaultTitle'),
            t('settingsPlugins.registriesDefaultBody'),
            { confirmText: t('settingsPlugins.registriesUseAsDefault'), cancelText: t('settingsPlugins.registriesScopedOnly') },
        );
        const allowPrivateNetwork = await Modal.confirm(
            t('settingsPlugins.registriesPrivateNetworkTitle'),
            t('settingsPlugins.registriesPrivateNetworkBody'),
            { confirmText: t('settingsPlugins.registriesAllowPrivateNetwork'), cancelText: t('settingsPlugins.registriesPublicOnly') },
        );
        const profile = NpmRegistryProfileInputV1Schema.safeParse({
            displayName,
            origin: current.origin,
            scopes: scopeInput.split(',').map((scope) => scope.trim()).filter(Boolean),
            useAsDefault,
            allowPrivateNetwork,
        });
        if (!profile.success) {
            await Modal.alert(t('settingsPlugins.registriesInvalidProfileTitle'), t('settingsPlugins.registriesInvalidProfileBody'));
            return;
        }
        await mutate({ action: 'update', profileId: current.profileId, profile: profile.data });
    }, [mutate]);

    const login = React.useCallback(async (profileId: string) => {
        if (!daemonOperationsAvailableRef.current) return;
        const secret = (await Modal.prompt(
            t('settingsPlugins.registriesLoginTitle'),
            t('settingsPlugins.registriesLoginBody'),
            { inputType: 'secure-text', confirmText: t('settingsPlugins.registriesLogin'), cancelText: t('common.cancel') },
        ))?.trim();
        if (!secret) return;
        await mutate({ action: 'login', profileId, credential: { kind: 'bearer_token', secret } });
    }, [mutate]);

    const remove = React.useCallback(async (profileId: string, displayName: string) => {
        if (!daemonOperationsAvailableRef.current) return;
        if (!await Modal.confirm(
            t('settingsPlugins.registriesRemoveTitle'),
            t('settingsPlugins.registriesRemoveBody', { name: displayName }),
            { destructive: true, confirmText: t('common.remove'), cancelText: t('common.cancel') },
        )) return;
        await mutate({ action: 'remove', profileId });
    }, [mutate]);

    const setMarketplaceBinding = React.useCallback(async (sourceId: string, profileId: string | null) => {
        if (
            !daemonOperationsAvailableRef.current
            || !onSetMarketplaceSourceProfile
            || bindingInFlightRef.current
        ) return;
        const requestId = ++bindingRequestIdRef.current;
        const requestedSelection = selectionKey;
        bindingInFlightRef.current = true;
        setBusyBindingSourceId(sourceId);
        try {
            await onSetMarketplaceSourceProfile(sourceId, profileId);
        } catch {
            if (
                requestId !== bindingRequestIdRef.current
                || !daemonOperationsAvailableRef.current
                || selectionKeyRef.current !== requestedSelection
            ) return;
            await Modal.alert(t('settingsPlugins.registriesErrorTitle'), t('settingsPlugins.registriesErrorBody'));
        } finally {
            if (
                requestId !== bindingRequestIdRef.current
                || selectionKeyRef.current !== requestedSelection
            ) return;
            bindingInFlightRef.current = false;
            setBusyBindingSourceId(null);
        }
    }, [onSetMarketplaceSourceProfile, selectionKey]);

    return (
        <ItemGroup title={t('settingsPlugins.registriesTitle')} footer={t('settingsPlugins.registriesFooter')}>
            <Item
                testID="settings.plugins.registries.add"
                title={t('settingsPlugins.registriesAdd')}
                icon={<Ionicons name="add-circle-outline" size={29} color={theme.colors.accent.blue} />}
                onPress={() => { void add(); }}
                disabled={!daemonOperationsAvailable || !machineId || loading || busyProfileId !== null}
                showChevron={false}
            />
            {!machineId ? (
                <Item testID="settings.plugins.registries.noMachine" title={t('settingsPlugins.registriesNoMachine')} mode="info" showChevron={false} />
            ) : null}
            {loading && !snapshot ? <Item title={t('common.loading')} mode="info" showChevron={false} /> : null}
            {loadError ? (
                <>
                    <Item testID="settings.plugins.registries.loadError" title={t('settingsPlugins.registriesLoadError')} mode="info" showChevron={false} />
                    <Item
                        testID="settings.plugins.registries.retry"
                        title={t('common.retry')}
                        onPress={() => { void refresh(); }}
                        disabled={!daemonOperationsAvailable || loading || busyProfileId !== null}
                        loading={loading}
                        showChevron={false}
                    />
                </>
            ) : null}
            {snapshot && snapshot.profiles.length === 0 && snapshot.pausedSources.length === 0 ? (
                <Item testID="settings.plugins.registries.empty" title={t('settingsPlugins.registriesEmpty')} mode="info" showChevron={false} />
            ) : null}
            {snapshot?.profiles.map((profile) => {
                const busy = busyProfileId === profile.profileId;
                const mutationsDisabled = !daemonOperationsAvailable || busyProfileId !== null;
                const status = t(`settingsPlugins.registriesAvailability.${profile.availability}`);
                return (
                    <React.Fragment key={profile.profileId}>
                        <Item
                            testID={`settings.plugins.registries.profile.${profile.profileId}`}
                            title={profile.displayName}
                            subtitle={`${profile.origin} · ${status}`}
                            mode="info"
                            showChevron={false}
                        />
                        <Item
                            testID={`settings.plugins.registries.edit.${profile.profileId}`}
                            title={t('settingsPlugins.registriesEdit')}
                            onPress={() => { void edit(profile); }}
                            disabled={mutationsDisabled}
                            showChevron={false}
                        />
                        {!profile.hasCredentials ? (
                            <Item
                                testID={`settings.plugins.registries.login.${profile.profileId}`}
                                title={t('settingsPlugins.registriesLogin')}
                                onPress={() => { void login(profile.profileId); }}
                                disabled={mutationsDisabled}
                                loading={busy}
                                showChevron={false}
                            />
                        ) : (
                            <Item
                                testID={`settings.plugins.registries.logout.${profile.profileId}`}
                                title={t('settingsPlugins.registriesLogout')}
                                onPress={() => { void mutate({ action: 'logout', profileId: profile.profileId }); }}
                                disabled={mutationsDisabled}
                                loading={busy}
                                showChevron={false}
                            />
                        )}
                        <Item
                            testID={`settings.plugins.registries.test.${profile.profileId}`}
                            title={t('settingsPlugins.registriesTest')}
                            onPress={() => { void mutate({ action: 'test', profileId: profile.profileId }); }}
                            disabled={mutationsDisabled}
                            loading={busy}
                            showChevron={false}
                        />
                        <Item
                            testID={`settings.plugins.registries.remove.${profile.profileId}`}
                            title={t('settingsPlugins.registriesRemove')}
                            onPress={() => { void remove(profile.profileId, profile.displayName); }}
                            disabled={mutationsDisabled}
                            destructive
                            showChevron={false}
                        />
                    </React.Fragment>
                );
            })}
            {snapshot && marketplaceSources.length > 0 ? (
                <Item
                    testID="settings.plugins.registries.marketplaceBindings"
                    title={t('settingsPlugins.registriesMarketplaceBindingsTitle')}
                    mode="info"
                    showChevron={false}
                />
            ) : null}
            {snapshot ? marketplaceSources.map((source) => {
                const boundProfile = source.registryProfileId
                    ? snapshot.profiles.find((profile) => profile.profileId === source.registryProfileId) ?? null
                    : null;
                const bindingDisabled = !daemonOperationsAvailable
                    || !machineId
                    || !onSetMarketplaceSourceProfile
                    || busyProfileId !== null
                    || busyBindingSourceId !== null;
                return (
                    <React.Fragment key={`marketplace-binding:${source.id}`}>
                        <Item
                            testID={`settings.plugins.registries.marketplaceSource.${source.id}`}
                            title={source.title}
                            subtitle={boundProfile
                                ? `${boundProfile.displayName} · ${boundProfile.origin}`
                                : source.registryProfileId ?? source.sourceUrl}
                            mode="info"
                            showChevron={false}
                        />
                        {source.registryProfileId ? (
                            <Item
                                testID={`settings.plugins.registries.unbind.${source.id}`}
                                title={t('settingsPlugins.registriesMarketplaceUnbind', { source: source.title })}
                                onPress={() => { void setMarketplaceBinding(source.id, null); }}
                                disabled={bindingDisabled}
                                loading={busyBindingSourceId === source.id}
                                showChevron={false}
                            />
                        ) : snapshot.profiles.map((profile) => (
                            <Item
                                key={`bind:${source.id}:${profile.profileId}`}
                                testID={`settings.plugins.registries.bind.${source.id}.${profile.profileId}`}
                                title={t('settingsPlugins.registriesMarketplaceBind', { profile: profile.displayName, source: source.title })}
                                onPress={() => { void setMarketplaceBinding(source.id, profile.profileId); }}
                                disabled={bindingDisabled}
                                loading={busyBindingSourceId === source.id}
                                showChevron={false}
                            />
                        ))}
                    </React.Fragment>
                );
            }) : null}
            {snapshot?.pausedSources.map((source) => (
                <Item
                    key={`paused:${source.origin}`}
                    testID={`settings.plugins.registries.paused.${source.origin}`}
                    title={t('settingsPlugins.registriesUpdatePaused')}
                    subtitle={`${source.origin} · ${t(`settingsPlugins.registriesPauseReason.${source.reason}`)}`}
                    mode="info"
                    showChevron={false}
                />
            ))}
        </ItemGroup>
    );
}
