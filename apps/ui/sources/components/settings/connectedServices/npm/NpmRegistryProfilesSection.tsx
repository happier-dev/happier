import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import type {
    DaemonNpmRegistryProfileMutationRequestV1,
    DaemonNpmRegistryProfileSnapshotV1,
} from '@happier-dev/protocol/rpc';
import type { MachineAdministrationTargetV1 } from '@happier-dev/protocol/account/settings/machineAdministrationSelectionsV1';
import { NpmRegistryProfileActionOutputSchemasV1 } from '@happier-dev/protocol/actions/npmRegistryProfileActionFamily';
import { isActionApprovalDeclinedErrorCode } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { MarketplaceSourcePresentationV1 } from '@/components/settings/plugins/model/usePluginRegistrySourceAdministration';

import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { ExpandableItem } from '@/components/ui/lists/ExpandableItem';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemRowActions } from '@/components/ui/lists/ItemRowActions';
import { buildActionRowAccessibilityLabel } from '@/components/ui/lists/actionRowAccessibility';
import { Modal } from '@/modal';
import { randomUUID } from '@/platform/randomUUID';
import {
    machineAdministrationTargetsEqual,
} from '@/sync/domains/machines/administration/targetSelection';
import {
    type FreshMachineAdministrationExecutionTargetV1,
    type MachineAdministrationTargetSelectionV1,
} from '@/sync/domains/machines/administration/useTargetSelection';
import { isMachineAdministrationExecutionTargetCurrent } from '@/sync/domains/machines/administration/operationCurrentness';
import {
    machineNpmRegistryProfilesGet,
} from '@/sync/ops/machineNpmRegistryProfiles';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import type { UiNpmRegistryProfileDelivery } from '@/sync/ops/actions/npmRegistryProfileActionDeps';
import { t } from '@/text';
import { Icon } from '@/components/ui/icons/Icon';
import { DisclosureCaret } from '@/components/ui/lists/DisclosureCaret';

import { showNpmRegistryProfileEditor, type NpmRegistryProfileEditorSubject } from './NpmRegistryProfileEditor';
import { RegistryCredentialEditor } from './RegistryCredentialEditor';
import { describeNpmRegistryOperationError } from './npmRegistryOperationError';
import type { ConnectSheetNpmRegistryResult } from '../setup/ConnectedServiceSetupModal';

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

/**
 * The "no private registry" choice in a source's binding menu.
 *
 * Profile ids are lowercase and non-empty by schema, so the empty string cannot
 * collide with one; unbinding is a real selectable choice rather than a second
 * control beside the menu.
 */
const UNBOUND_REGISTRY_PROFILE_ID = '';

type NpmRegistryProfilesTargetSelection = Pick<
    MachineAdministrationTargetSelectionV1,
    'selectedTarget' | 'canExecute' | 'resolveExecutionTarget'
>;

export type NpmRegistryProfilesSectionProps = Readonly<{
    daemonOperationsAvailable: boolean;
    targetSelection: NpmRegistryProfilesTargetSelection;
    marketplaceSources?: readonly MarketplaceSourcePresentationV1[];
    onSetMarketplaceSourceProfile?: (
        sourceId: string,
        profileId: string | null,
    ) => Promise<Readonly<{ status: 'success' | 'unavailable' | 'outcomeUnknown' | 'superseded' }>>;
    marketplaceSourceMutationInFlight?: boolean;
    /**
     * The profile a new one starts from, when the caller already knows which
     * registry is needed. The reader still reviews and edits every field.
     */
    createProfileSubject?: NpmRegistryProfileEditorSubject;
    currentProfileId?: string;
    projectDir?: string;
    onProfileResult?: (result: Exclude<ConnectSheetNpmRegistryResult, { kind: 'dismissed' }>) => void;
    onOperationError?: (code: string) => void;
    /** A host whose own heading already names npm registries (the Connect sheet) omits the section title. */
    titled?: boolean;
}>;

export function NpmRegistryProfilesSection({
    daemonOperationsAvailable,
    targetSelection,
    marketplaceSources = [],
    onSetMarketplaceSourceProfile,
    marketplaceSourceMutationInFlight = false,
    createProfileSubject,
    currentProfileId,
    titled = true,
    projectDir,
    onProfileResult,
    onOperationError,
}: NpmRegistryProfilesSectionProps): React.ReactElement {
    const { theme } = useUnistyles();
    const selectedTarget = targetSelection.selectedTarget;
    const selectionKey = selectedTarget
        ? `${selectedTarget.serverIdentityId}\0${selectedTarget.machineId}`
        : '';
    const selectionKeyRef = React.useRef(selectionKey);
    selectionKeyRef.current = selectionKey;
    const resolveExecutionTargetRef = React.useRef(targetSelection.resolveExecutionTarget);
    resolveExecutionTargetRef.current = targetSelection.resolveExecutionTarget;
    const daemonOperationsAvailableRef = React.useRef(daemonOperationsAvailable);
    daemonOperationsAvailableRef.current = daemonOperationsAvailable;
    const refreshGenerationRef = React.useRef(0);
    const refreshControllerRef = React.useRef<AbortController | null>(null);
    const mutationRequestIdRef = React.useRef(0);
    const mutationInFlightRef = React.useRef(false);
    const mutationDeliveryRef = React.useRef<Readonly<{
        requestId: number;
        mutationId: string;
        selectionKey: string;
        executionTarget: FreshMachineAdministrationExecutionTargetV1;
        credential: Extract<Extract<DaemonNpmRegistryProfileMutationRequestV1, { action: 'login' }>['credential'], { kind: 'bearer_token' }> | null;
    }> | null>(null);
    const [loaded, setLoaded] = React.useState<LoadedSnapshot | null>(null);
    const [loading, setLoading] = React.useState(false);
    const [loadError, setLoadError] = React.useState(false);
    const [busyProfileId, setBusyProfileId] = React.useState<string | null>(null);
    const [busyBindingSourceId, setBusyBindingSourceId] = React.useState<string | null>(null);
    const [openBindingSourceId, setOpenBindingSourceId] = React.useState<string | null>(null);
    const [loginProfileId, setLoginProfileId] = React.useState<string | null>(null);
    const snapshot = loaded?.selectionKey === selectionKey ? loaded.snapshot : null;

    const resolveExactExecutionTarget = React.useCallback((
        expectedTarget: MachineAdministrationTargetV1 | null,
    ): FreshMachineAdministrationExecutionTargetV1 | null => {
        const resolved = resolveExecutionTargetRef.current();
        return expectedTarget !== null
            && resolved !== null
            && machineAdministrationTargetsEqual(expectedTarget, resolved.target)
            ? resolved
            : null;
    }, []);

    const isExecutionTargetCurrent = React.useCallback((
        requestedSelection: string,
        executionTarget: FreshMachineAdministrationExecutionTargetV1,
    ): boolean => {
        return isMachineAdministrationExecutionTargetCurrent({
            expectedTarget: executionTarget,
            resolveCurrentTarget: resolveExecutionTargetRef.current,
            expectedSelectionKey: requestedSelection,
            currentSelectionKey: selectionKeyRef.current,
        });
    }, []);

    const delivery = React.useMemo((): UiNpmRegistryProfileDelivery => ({
        resolveExecutionTarget: (target) => {
            const current = mutationDeliveryRef.current;
            return current && machineAdministrationTargetsEqual(target, current.executionTarget.target)
                ? current.executionTarget : null;
        },
        isCurrent: (mutationId) => {
            const current = mutationDeliveryRef.current;
            return current !== null && daemonOperationsAvailableRef.current
                && current.mutationId === mutationId
                && current.requestId === mutationRequestIdRef.current
                && isExecutionTargetCurrent(current.selectionKey, current.executionTarget);
        },
        acquireCredential: async (mutationId) => mutationDeliveryRef.current?.mutationId === mutationId
            ? mutationDeliveryRef.current.credential : null,
    }), [isExecutionTargetCurrent]);
    const executorOptions = React.useMemo(() => ({ npmRegistryProfileDelivery: delivery }), [delivery]);
    const actions = useMountedActionExecution(selectedTarget?.serverIdentityId, { executorOptions, retainInvocation: true });

    const refresh = React.useCallback(async () => {
        const generation = ++refreshGenerationRef.current;
        refreshControllerRef.current?.abort();
        const controller = new AbortController();
        refreshControllerRef.current = controller;
        const requestedSelection = selectionKey;
        const requestedTarget = selectedTarget;
        if (!requestedTarget || !daemonOperationsAvailable) {
            if (!requestedTarget) setLoaded(null);
            setLoadError(false);
            setLoading(false);
            return;
        }
        const executionTarget = resolveExactExecutionTarget(requestedTarget);
        if (!executionTarget) {
            setLoadError(false);
            setLoading(false);
            return;
        }
        setLoading(true);
        setLoadError(false);
        try {
            const result = await machineNpmRegistryProfilesGet(executionTarget.machine.id, {
                serverId: executionTarget.serverId,
                signal: controller.signal,
            });
            if (
                generation !== refreshGenerationRef.current
                || !isExecutionTargetCurrent(requestedSelection, executionTarget)
            ) return;
            if (result.status === 'success') {
                setLoaded({ selectionKey: requestedSelection, snapshot: result.snapshot });
            } else {
                setLoadError(true);
            }
        } catch {
            if (
                generation === refreshGenerationRef.current
                && isExecutionTargetCurrent(requestedSelection, executionTarget)
            ) {
                setLoadError(true);
            }
        } finally {
            if (
                generation === refreshGenerationRef.current
                && isExecutionTargetCurrent(requestedSelection, executionTarget)
            ) {
                setLoading(false);
            }
        }
    }, [daemonOperationsAvailable, isExecutionTargetCurrent, resolveExactExecutionTarget, selectedTarget, selectionKey]);

    React.useEffect(() => {
        void refresh();
        return () => {
            refreshGenerationRef.current += 1;
            refreshControllerRef.current?.abort();
            refreshControllerRef.current = null;
        };
    }, [refresh]);

    React.useEffect(() => {
        mutationRequestIdRef.current += 1;
        mutationInFlightRef.current = false;
        mutationDeliveryRef.current = null;
        setBusyProfileId(null);
        setBusyBindingSourceId(null);
        // An open binding menu lists the previous machine's profiles; it must
        // not survive into a selection those profiles do not belong to.
        setOpenBindingSourceId(null);
        setLoginProfileId(null);
    }, [daemonOperationsAvailable, selectionKey]);

    const presentOperationError = React.useCallback(async (code: string) => {
        if (onOperationError) onOperationError(code);
        else await Modal.alert(t('settingsPlugins.registriesErrorTitle'),
            describeNpmRegistryOperationError(code) ?? `${t('settingsPlugins.registriesErrorBody')}\n${code}`);
    }, [onOperationError]);

    const openBrowserLogin = async (url: string) => {
        const outcome = await actions.execute('links.openExternal', { url });
        if (!outcome.ok) await presentOperationError(outcome.errorCode);
    };

    const mutate = React.useCallback(async (
        request: LocalRegistryMutation,
        signal?: AbortSignal,
    ) => {
        const cancellingBrowser = request.action === 'login' && request.credential.kind === 'browser'
            && request.credential.step === 'cancel';
        if (
            !daemonOperationsAvailableRef.current
            || !selectedTarget
            || !targetSelection.canExecute
            || !snapshot
            || mutationInFlightRef.current && !cancellingBrowser
        ) return;
        const requestedSelection = selectionKey;
        const executionTarget = resolveExactExecutionTarget(selectedTarget);
        if (!executionTarget) return;
        const requestId = ++mutationRequestIdRef.current;
        const profileId = 'profileId' in request ? request.profileId : 'registry';
        const mutationId = `registry-${request.action}-${randomUUID()}`;
        mutationInFlightRef.current = true;
        mutationDeliveryRef.current = { requestId, mutationId, selectionKey: requestedSelection, executionTarget,
            credential: request.action === 'login' && request.credential.kind === 'bearer_token' ? request.credential : null };
        setBusyProfileId(profileId);
        try {
            const actionId = `plugins.npm_registry_profiles.${request.action}` as const;
            const execution = await actions.execute(actionId, {
                target: executionTarget.target,
                profileId: request.profileId,
                ...('profile' in request ? { profile: request.profile } : {}),
                ...(request.action === 'login' && request.credential.kind !== 'bearer_token' ? { login: request.credential } : {}),
                expectedRevision: snapshot.revision,
                mutationId,
            }, signal ? { signal } : undefined);
            if (
                requestId !== mutationRequestIdRef.current
                || !daemonOperationsAvailableRef.current
                || !isExecutionTargetCurrent(requestedSelection, executionTarget)
            ) return;
            if (!execution.ok) {
                if (!isActionApprovalDeclinedErrorCode(execution.errorCode))
                    await presentOperationError(execution.errorCode);
                return;
            }
            const result = NpmRegistryProfileActionOutputSchemasV1[actionId].parse(execution.result);
            if (result.status === 'browser_login_required') return result;
            if (result.status === 'cancelled') return true;
            if (result.status === 'success') {
                setLoaded({ selectionKey: requestedSelection, snapshot: result.snapshot });
                if (request.action === 'login') {
                    const profile = result.snapshot.profiles.find((profile) => profile.profileId === request.profileId);
                    if (profile?.availability === 'available') onProfileResult?.({ kind: 'connected', profile });
                }
                // A profile is usable only once its owner's check has recorded
                // availability. Signing in runs that check inside the daemon's
                // own sign-in; a newly added profile is checked here at once
                // instead of staying "unknown" until a separate Test. A refused
                // or unreachable registry is recorded by the owner.
                if (request.action === 'add') {
                    const checkMutationId = `registry-test-${randomUUID()}`;
                    mutationDeliveryRef.current = { requestId, mutationId: checkMutationId,
                        selectionKey: requestedSelection, executionTarget, credential: null };
                    const checkedExecution = await actions.execute('plugins.npm_registry_profiles.test', {
                        target: executionTarget.target,
                        profileId: request.profileId,
                        expectedRevision: result.snapshot.revision,
                        mutationId: checkMutationId,
                    });
                    const checked = checkedExecution.ok
                        ? NpmRegistryProfileActionOutputSchemasV1['plugins.npm_registry_profiles.test'].parse(checkedExecution.result) : null;
                    if (
                        requestId === mutationRequestIdRef.current
                        && daemonOperationsAvailableRef.current
                        && isExecutionTargetCurrent(requestedSelection, executionTarget)
                        && checked?.status === 'success'
                    ) {
                        setLoaded({ selectionKey: requestedSelection, snapshot: checked.snapshot });
                    }
                }
                return true;
            }
            if (result.status === 'outcomeUnknown') {
                await refresh();
                if (
                    requestId !== mutationRequestIdRef.current
                    || !daemonOperationsAvailableRef.current
                    || !isExecutionTargetCurrent(requestedSelection, executionTarget)
                ) return;
                await Modal.alert(
                    t('settingsPlugins.sourceAdministration.operationOutcomeUnknownTitle'),
                    t('settingsPlugins.sourceAdministration.operationOutcomeUnknownBody'),
                );
                if (request.action === 'login' && request.credential.kind === 'browser') return;
                return true;
            }
            if (result.code === 'revision_conflict') {
                await refresh();
                if (
                    requestId !== mutationRequestIdRef.current
                    || !daemonOperationsAvailableRef.current
                    || !isExecutionTargetCurrent(requestedSelection, executionTarget)
                ) return;
                await Modal.alert(t('settingsPlugins.registriesConflictTitle'), t('settingsPlugins.registriesConflictBody'));
                return;
            }
            await presentOperationError(result.code);
        } catch {
            if (
                requestId === mutationRequestIdRef.current
                && daemonOperationsAvailableRef.current
                && isExecutionTargetCurrent(requestedSelection, executionTarget)
            ) {
                await presentOperationError('unavailable');
            }
        } finally {
            if (requestId === mutationRequestIdRef.current) {
                mutationInFlightRef.current = false;
                mutationDeliveryRef.current = null;
                setBusyProfileId(null);
            }
        }
    }, [actions.execute, isExecutionTargetCurrent, onProfileResult, presentOperationError, refresh, resolveExactExecutionTarget, selectedTarget, selectionKey, snapshot, targetSelection.canExecute]);

    /**
     * One form answers the whole profile, then one revisioned mutation sends it.
     *
     * Creating and editing differ only in which mutation carries the result, so
     * they share the form rather than each owning a private question chain that
     * can drift apart.
     */
    const openProfileEditor = React.useCallback(async (current: RegistryProfileView | null) => {
        if (!daemonOperationsAvailableRef.current) return;
        const profile = await showNpmRegistryProfileEditor(current === null
            ? { mode: 'create', ...(createProfileSubject ? { subject: createProfileSubject } : {}) }
            : {
                mode: 'edit',
                subject: {
                    displayName: current.displayName,
                    origin: current.origin,
                    scopes: current.scopes,
                    useAsDefault: current.useAsDefault,
                    allowPrivateNetwork: current.allowPrivateNetwork,
                },
            });
        if (!profile) return;
        await mutate(current === null
            ? {
                action: 'add',
                profileId: `registry_${randomUUID().replaceAll('-', '_')}`,
                profile,
            }
            : { action: 'update', profileId: current.profileId, profile });
    }, [createProfileSubject, mutate]);

    const remove = React.useCallback(async (profileId: string) => {
        if (!daemonOperationsAvailableRef.current) return;
        await mutate({ action: 'remove', profileId });
    }, [mutate]);

    const setMarketplaceBinding = React.useCallback(async (sourceId: string, profileId: string | null) => {
        if (
            !onSetMarketplaceSourceProfile
            || marketplaceSourceMutationInFlight
        ) return;
        setBusyBindingSourceId(sourceId);
        try {
            const settlement = await onSetMarketplaceSourceProfile(sourceId, profileId);
            if (settlement.status === 'outcomeUnknown') {
                await Modal.alert(
                    t('settingsPlugins.sourceAdministration.operationOutcomeUnknownTitle'),
                    t('settingsPlugins.sourceAdministration.operationOutcomeUnknownBody'),
                );
            } else if (settlement.status === 'unavailable') {
                await Modal.alert(t('settingsPlugins.registriesErrorTitle'), t('settingsPlugins.registriesErrorBody'));
            }
        } catch {
            await Modal.alert(t('settingsPlugins.registriesErrorTitle'), t('settingsPlugins.registriesErrorBody'));
        } finally {
            setBusyBindingSourceId(null);
        }
    }, [marketplaceSourceMutationInFlight, onSetMarketplaceSourceProfile]);

    return (
        <ItemGroup title={titled ? t('settingsPlugins.registriesTitle') : undefined} description={t('settingsPlugins.registriesFooter')}>
            {/* What the section needs comes first; Add follows the machine it acts on. */}
            {!selectedTarget ? (
                <Item testID="settings.plugins.registries.noMachine" title={t('settingsPlugins.registriesNoMachine')} mode="info" showChevron={false} />
            ) : null}
            <Item
                testID="settings.plugins.registries.add"
                title={t('settingsPlugins.registriesAdd')}
                onPress={() => { void openProfileEditor(null); }}
                disabled={!daemonOperationsAvailable || !targetSelection.canExecute || loading || busyProfileId !== null}
                showChevron={false}
            />
            {loading && !snapshot ? <Item title={t('common.loading')} mode="info" showChevron={false} /> : null}
            {loadError ? (
                <>
                    <Item testID="settings.plugins.registries.loadError" title={t('settingsPlugins.registriesLoadError')} mode="info" showChevron={false} />
                    <Item
                        testID="settings.plugins.registries.retry"
                        title={t('common.retry')}
                        onPress={() => { void refresh(); }}
                        disabled={!daemonOperationsAvailable || !targetSelection.canExecute || loading || busyProfileId !== null}
                        loading={loading}
                        showChevron={false}
                    />
                </>
            ) : null}
            {snapshot && snapshot.profiles.length === 0 && snapshot.pausedSources.length === 0 ? (
                <Item testID="settings.plugins.registries.empty" title={t('settingsPlugins.registriesEmpty')} mode="info" showChevron={false} />
            ) : null}
            {/*
              * One profile is one row. Edit, sign in or out, test and remove all
              * act on that same record, so they belong to its row rather than to
              * four look-alike rows a reader has to keep attributing back to the
              * profile above them — and that a screen reader traverses as five
              * separate list entries for one registry.
              */}
            {snapshot?.profiles.map((profile) => {
                const busy = busyProfileId === profile.profileId;
                const mutationsDisabled = !daemonOperationsAvailable || !targetSelection.canExecute || busyProfileId !== null;
                const status = t(`settingsPlugins.registriesAvailability.${profile.availability}`);
                const credentialAction = profile.hasCredentials
                    ? {
                        id: 'logout',
                        title: t('settingsPlugins.registriesLogout'),
                        icon: 'sign-out' as const,
                        inlineTestID: `settings.plugins.registries.logout.${profile.profileId}`,
                        onPress: () => { void mutate({ action: 'logout', profileId: profile.profileId }); },
                    }
                    : {
                        id: 'login',
                        title: t('settingsPlugins.registriesLogin'),
                        icon: 'sign-in' as const,
                        inlineTestID: `settings.plugins.registries.login.${profile.profileId}`,
                        onPress: () => setLoginProfileId(profile.profileId),
                    };
                const actions = [
                    ...(onProfileResult ? [{
                        id: 'select',
                        title: t('connectedServicesSetup.keyUse', { name: profile.displayName }),
                        icon: 'check' as const,
                        inlineTestID: `settings.plugins.registries.select.${profile.profileId}`,
                        disabled: !profile.hasCredentials || profile.availability !== 'available',
                        onPress: () => onProfileResult({ kind: 'selected', profile }),
                    }] : []),
                    {
                        id: 'edit',
                        title: t('settingsPlugins.registriesEdit'),
                        icon: 'pencil-simple' as const,
                        inlineTestID: `settings.plugins.registries.edit.${profile.profileId}`,
                        onPress: () => { void openProfileEditor(profile); },
                    },
                    credentialAction,
                    {
                        id: 'test',
                        title: t('settingsPlugins.registriesTest'),
                        icon: 'checks' as const,
                        inlineTestID: `settings.plugins.registries.test.${profile.profileId}`,
                        onPress: () => { void mutate({ action: 'test', profileId: profile.profileId }); },
                    },
                    {
                        id: 'remove',
                        title: t('settingsPlugins.registriesRemove'),
                        icon: 'trash' as const,
                        destructive: true,
                        inlineTestID: `settings.plugins.registries.remove.${profile.profileId}`,
                        onPress: () => { void remove(profile.profileId); },
                    },
                ].map((action) => ({
                    ...action,
                    // Icon controls repeat across profiles, so each one names the
                    // profile it acts on instead of only what it does.
                    accessibilityLabel: buildActionRowAccessibilityLabel([action.title, profile.displayName]),
                    disabled: mutationsDisabled || ('disabled' in action && action.disabled === true),
                }));
                return (
                    <ExpandableItem key={profile.profileId} expanded={loginProfileId === profile.profileId}
                        onExpandedChange={(next) => { if (!next) setLoginProfileId(null); }}
                        header={() => <Item
                        key={profile.profileId}
                        testID={`settings.plugins.registries.profile.${profile.profileId}`}
                        title={profile.displayName}
                        selected={profile.profileId === currentProfileId}
                        subtitle={`${profile.origin} · ${status}`}
                        subtitleLines={0}
                        mode="info"
                        showChevron={false}
                        // Progress belongs to the record being mutated, not to
                        // whichever control started it.
                        loading={busy}
                        rightElementOutsidePressable
                        rightElement={(
                            <ItemRowActions
                                title={profile.displayName}
                                compactActionIds={[onProfileResult && profile.hasCredentials && profile.availability === 'available' ? 'select' : profile.hasCredentials ? 'edit' : 'login']}
                                overflowTriggerTestID={`settings.plugins.registries.profile.${profile.profileId}.actions.overflow`}
                                actions={actions}
                            />
                        )}
                    />}>
                        {loginProfileId === profile.profileId ? <RegistryCredentialEditor
                            disabled={mutationsDisabled} onCancel={() => setLoginProfileId(null)}
                            onSave={async (secret) => await mutate({ action: 'login', profileId: profile.profileId,
                                credential: { kind: 'bearer_token', secret } }) === true}
                            onMachineLogin={async () => await mutate({ action: 'login', profileId: profile.profileId,
                                credential: { kind: 'machine', ...(projectDir ? { projectDir } : {}) } }) === true}
                            onStartBrowserLogin={async () => {
                                const result = await mutate({ action: 'login', profileId: profile.profileId,
                                    credential: { kind: 'browser', step: 'start' } });
                                return result && result !== true ? result : undefined;
                            }}
                            onCompleteBrowserLogin={async (loginId, signal) => await mutate({ action: 'login', profileId: profile.profileId,
                                credential: { kind: 'browser', step: 'complete', loginId } }, signal) === true}
                            onOpenBrowserLogin={openBrowserLogin}
                            onCancelBrowserLogin={(loginId) => mutate({ action: 'login', profileId: profile.profileId,
                                credential: { kind: 'browser', step: 'cancel', loginId } })} /> : null}
                    </ExpandableItem>
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
            {/*
              * A source's registry is one choice, so it is one row with a
              * selection menu. Listing every source against every profile made
              * the pane grow multiplicatively — and still could not express
              * "use a different profile" without unbinding first, because the
              * bound state hid the alternatives instead of marking the current
              * one among them.
              */}
            {snapshot ? marketplaceSources.map((source) => {
                const boundProfile = source.registryProfileId
                    ? snapshot.profiles.find((profile) => profile.profileId === source.registryProfileId) ?? null
                    : null;
                const bindingDisabled = !daemonOperationsAvailable
                    || !targetSelection.canExecute
                    || !onSetMarketplaceSourceProfile
                    || busyProfileId !== null
                    || busyBindingSourceId !== null
                    || marketplaceSourceMutationInFlight;
                return (
                    <DropdownMenu
                        key={`marketplace-binding:${source.id}`}
                        testID={`settings.plugins.registries.marketplaceBinding.${source.id}`}
                        open={openBindingSourceId === source.id}
                        onOpenChange={(next) => setOpenBindingSourceId(next ? source.id : null)}
                        variant="selectable"
                        rowKind="item"
                        showCategoryTitles={false}
                        matchTriggerWidth
                        connectToTrigger
                        selectedId={source.registryProfileId ?? UNBOUND_REGISTRY_PROFILE_ID}
                        trigger={({ open, toggle }) => (
                            <Item
                                testID={`settings.plugins.registries.marketplaceSource.${source.id}`}
                                title={source.title}
                                subtitle={boundProfile
                                    ? `${boundProfile.displayName} · ${boundProfile.origin}`
                                    : source.registryProfileId ?? source.sourceUrl}
                                subtitleLines={0}
                                rightElement={(
                                    <DisclosureCaret expanded={open} size={16} />
                                )}
                                onPress={toggle}
                                disabled={bindingDisabled}
                                loading={busyBindingSourceId === source.id}
                                accessibilityExpanded={open}
                                showChevron={false}
                            />
                        )}
                        items={[
                            {
                                id: UNBOUND_REGISTRY_PROFILE_ID,
                                testID: `settings.plugins.registries.unbind.${source.id}`,
                                title: t('settingsPlugins.registriesMarketplaceUnbind', { source: source.title }),
                            },
                            ...snapshot.profiles.map((profile) => ({
                                id: profile.profileId,
                                testID: `settings.plugins.registries.bind.${source.id}.${profile.profileId}`,
                                title: t('settingsPlugins.registriesMarketplaceBind', {
                                    profile: profile.displayName,
                                    source: source.title,
                                }),
                                subtitle: profile.origin,
                            })),
                        ]}
                        onSelect={(profileId) => {
                            void setMarketplaceBinding(
                                source.id,
                                profileId === UNBOUND_REGISTRY_PROFILE_ID ? null : profileId,
                            );
                        }}
                    />
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
