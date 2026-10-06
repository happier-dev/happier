import * as React from 'react';
import { Redirect, useLocalSearchParams, useNavigation } from '@/components/appShell/workspace/destinationRoute';

import type {
    BuiltInLegacyConnectedAccountOperation,
    ConnectedAccountPeerOperationTransport,
    PluginConnectedAccountAuthenticationModeV2,
    QualifiedConnectedAccountRef,
} from '@happier-dev/protocol';
import {
    BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY_BY_SERVICE_ID,
    ConnectedServiceIdSchema,
    removeAgentConnectedAccountDefaultsForDeletedTarget,
} from '@happier-dev/protocol';

import {
    useProjectedPluginLocalizedTextResolver,
    useProjectedConnectedServicesRegistry,
} from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { MachineAdministrationTargetSelector } from '@/components/settings/machines/MachineAdministrationTargetSelector';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { useQualifiedConnectedAccountGroups } from '@/hooks/server/connectedServices/useQualifiedConnectedAccountGroups';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { Modal } from '@/modal';
import { getPreferredLanguage, t } from '@/text';
import {
    readConnectedAccountAddRequest,
    buildConnectedAccountSettingsRoute,
    resolveQualifiedConnectedAccountSettingsRoute,
} from '@/sync/domains/connectedServices/connectedAccountSettingsRoute';
import { resolveConnectedAccountModeTitle } from '../model/resolveConnectedAccountModeTitle';
import { ConnectedAccountFormSection } from './ConnectedAccountFormSection';
import { MACHINE_ADMINISTRATION_SELECTION_KEYS_V1 } from '@/sync/domains/machines/administration/selectionPreferences';
import {
    useMachineAdministrationTargetSelection,
    type FreshMachineAdministrationExecutionTargetV1,
    type MachineAdministrationTargetSelectionV1,
} from '@/sync/domains/machines/administration/useTargetSelection';
import {
    isQualifiedConnectedAccountLegacyOperationSupported,
    type QualifiedConnectedAccountUiPeerTransport,
} from '@/sync/domains/connectedServices/qualifiedConnectedAccountUiSource';
import {
    pruneQualifiedConnectedAccountPreferences,
    resolveQualifiedConnectedAccountLabel,
    updateQualifiedConnectedAccountLabel,
} from '@/sync/domains/connectedServices/connectedServiceProfilePreferences';
import {
    runConnectedAccountAuthenticationCommand,
    runConnectedAccountControlCommand,
    type ConnectedAccountAttemptResponse,
    type ConnectedAccountConfigurationTarget,
    type ConnectedAccountControlTarget,
    type ConnectedAccountDaemonControlResponse,
} from '@/sync/ops/connectedAccounts/connectedAccountDaemon';
import {
    useActiveServerAccountScope,
    useProfile,
    useSettingsSelector,
} from '@/sync/store/hooks';
import { useApplySettings } from '@/sync/store/settingsWriters';
import { getStorage } from '@/sync/domains/state/storageStore';
import {
    captureActiveServerAccountScopeCurrentness,
} from '@/sync/domains/scope/activeServerAccountScope';
import { serverAccountScopeKeySuffix } from '@/sync/domains/scope/serverAccountScope';

import {
    isConnectedServiceCredentialReferencedByGroupError,
    readConnectedServiceSettingsErrorCode,
    resolveConnectedServiceSettingsErrorMessage,
} from '../connectedServiceSettingsErrors';
import { ConnectedAccountConfigurationForm } from './ConnectedAccountConfigurationForm';
import { ConnectedAccountDeviceForm } from './ConnectedAccountDeviceForm';
import { ConnectedAccountManualForm } from './ConnectedAccountManualForm';
import { ConnectedAccountOAuthForm } from './ConnectedAccountOAuthForm';
import {
    ConnectedAccountServiceContent,
    type ConnectedAccountServiceProfile,
} from './ConnectedAccountServiceContent';
import { resolveProjectedLocalizedText } from '@/components/plugins/surfaces/resolvePluginDisplayString';
import { SettingsPageHeader } from '@/components/settings/shell/SettingsPageHeader';
import { resolveConnectedServiceRegistryEntryDisplayName } from '../model/resolveConnectedServiceDisplayName';
import { ConnectedServiceMark } from '../ConnectedServiceMark';
import { getConnectedServiceSetupPresentation } from '@/sync/domains/connectedServices/connectedServiceRegistry';
import { rankConnectedAccountSetupModes } from '../setup/rankConnectedAccountSetupModes';
import { ConnectedServiceSetupFlowActions, ConnectedServiceSetupFlowBody } from '../setup/ConnectedServiceSetupFlowBody';
import {
    type PluginLocalizedTextResolver,
} from '@/sync/domains/plugins/ui/i18n';

type ServiceDescription = Extract<
    ConnectedAccountDaemonControlResponse,
    { status: 'described' }
>;
type ConfigurationDescription = Extract<
    ConnectedAccountDaemonControlResponse,
    { status: 'configuration' | 'configurationCommitted' }
>;
type ServiceConfigurationStatus =
    ConfigurationDescription['configuration']['status'];
type ServiceConfigurationStatusByModeId = Readonly<
    Record<string, ServiceConfigurationStatus | undefined>
>;
type PendingIntent =
    | Readonly<{
        kind: 'connect';
        service: QualifiedConnectedAccountRef['service'];
        modeId: string;
    }>
    | Readonly<{
        kind: 'reconnect';
        account: QualifiedConnectedAccountRef;
    }>;

function asStringParam(value: unknown): string {
    if (Array.isArray(value)) return typeof value[0] === 'string' ? value[0].trim() : '';
    return typeof value === 'string' ? value.trim() : '';
}

function toControlTarget(
    target: ConnectedAccountConfigurationTarget,
): ConnectedAccountControlTarget {
    switch (target.kind) {
        case 'service':
            return target;
        case 'account':
            return { kind: 'account', account: target.account };
        case 'attempt':
            return { kind: 'attempt', attemptId: target.attemptId };
    }
}

function isTerminalAttempt(response: ConnectedAccountAttemptResponse): boolean {
    return response.status === 'connected'
        || response.status === 'cancelled'
        || response.status === 'rejected'
        || response.status === 'unavailable'
        || response.status === 'conflict';
}

function readControlFailureCode(
    response: ConnectedAccountDaemonControlResponse,
    fallback: string,
): string {
    return response.status === 'conflict' || response.status === 'unavailable'
        ? response.code
        : fallback;
}

function readLegacyAuthenticationModeId(
    mapping: Readonly<Partial<Record<'oauth' | 'token', string>>>,
    kind: 'oauth' | 'token',
): string | null {
    return mapping[kind] ?? null;
}

function projectDaemonPeerTransport(
    transport: ConnectedAccountPeerOperationTransport,
): QualifiedConnectedAccountUiPeerTransport {
    return transport.kind === 'v4'
        ? { protocol: 'v4' }
        : {
            protocol: 'legacy',
            peerClass: transport.peerClass === 'exact_v0_2_1'
                ? 'exact-v0.2.1'
                : 'revisioned-v2-v3',
            legacyServiceId: transport.serviceId,
        };
}

function createLinkedAbortController(parentSignal: AbortSignal): Readonly<{
    signal: AbortSignal;
    dispose(): void;
}> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (parentSignal.aborted) {
        abort();
    } else {
        parentSignal.addEventListener('abort', abort, { once: true });
    }
    return {
        signal: controller.signal,
        dispose(): void {
            parentSignal.removeEventListener('abort', abort);
            controller.abort();
        },
    };
}

type ConnectedAccountServiceControllerProps = Readonly<{
    params: ReturnType<typeof useLocalSearchParams>;
    connectedServicesRegistry:
        ReturnType<typeof useProjectedConnectedServicesRegistry>;
    activeServer: ReturnType<typeof useActiveServerSnapshot>;
    targetSelection: MachineAdministrationTargetSelectionV1;
    executionTarget: FreshMachineAdministrationExecutionTargetV1 | null;
    localizePluginText: PluginLocalizedTextResolver;
    navigation: unknown;
    /**
     * Host the sign-in in a setup panel (the in-place Connect panel, its modal twin) instead of the
     * service page: the panel shows only the way to sign in and the running flow, starts the
     * recommended way by itself, and reports the connected account.
     */
    panel?: ConnectedAccountSetupPanelIntent;
}>;

/** What a setup panel asks the controller for, and how it hears back. */
export type ConnectedAccountSetupPanelIntent = Readonly<{
    intent: Readonly<{ kind: 'add' }> | Readonly<{ kind: 'reconnect'; accountId: string }>;
    onConnected: (account: QualifiedConnectedAccountRef) => void;
    /** Cancel was pressed: the sign-in has already left; the panel steps back or closes. */
    onCancel?: () => void;
}>;

const ConnectedAccountServiceController = React.memo(
    function ConnectedAccountServiceController(
        controllerProps: ConnectedAccountServiceControllerProps,
    ) {
    const {
        params,
        connectedServicesRegistry,
        activeServer,
        targetSelection,
        executionTarget,
        navigation,
    } = controllerProps;
    const settings = useSettingsSelector((settings) => ({
        connectedServicesProfileLabelByKey: settings.connectedServicesProfileLabelByKey,
    }));
    const locale = getPreferredLanguage();
    const profile = useProfile();
    const applySettings = useApplySettings();
    const activeServerId = asStringParam(activeServer.serverId);
    const activeServerGeneration = activeServer.generation;
    const route = React.useMemo(
        () => resolveQualifiedConnectedAccountSettingsRoute(
            {
                pluginId: params.pluginId,
                localId: params.localId,
                serviceId: params.serviceId,
                accountId: params.accountId,
                groupId: params.groupId,
                newPool: params.newPool,
                serverId: params.serverId,
                machineId: params.machineId,
            },
            connectedServicesRegistry.entries,
        ),
        [
            connectedServicesRegistry.entries,
            params.localId,
            params.pluginId,
            params.serviceId,
            params.accountId,
            params.groupId,
            params.newPool,
            params.serverId,
            params.machineId,
        ],
    );
    const serverId = executionTarget?.serverId ?? '';
    const teamCredentialResourcesEnabled = useFeatureEnabled('teams.credentialResources', {
        scopeKind: 'spawn',
        serverId,
    });
    const machineId = executionTarget?.machine.id ?? '';
    const expectedActiveServer = React.useMemo(
        () => serverId === activeServerId
            ? {
                serverId,
                generation: activeServerGeneration,
            }
            : null,
        [activeServerGeneration, activeServerId, serverId],
    );
    const servicePluginId = route?.service.pluginId ?? '';
    const serviceLocalId = route?.service.localId ?? '';
    const service = React.useMemo(
        () => servicePluginId && serviceLocalId
            ? Object.freeze({
                pluginId: servicePluginId,
                localId: serviceLocalId,
            })
            : null,
        [serviceLocalId, servicePluginId],
    );
    const registryEntry = route?.entry ?? null;
    const serviceId = registryEntry?.serviceId ?? '';
    const localizeServiceText = React.useCallback(
        (value: Parameters<typeof resolveProjectedLocalizedText>[0]) => (
            servicePluginId ? controllerProps.localizePluginText(servicePluginId, value) : ''
        ),
        [controllerProps.localizePluginText, servicePluginId],
    );
    const parsedLegacyServiceId = ConnectedServiceIdSchema.safeParse(
        route?.legacyServiceId,
    );
    const legacyServiceId = parsedLegacyServiceId.success
        ? parsedLegacyServiceId.data
        : null;
    const exactRoute = route !== null;

    const [description, setDescription] = React.useState<ServiceDescription | null>(null);
    const [
        serviceConfigurationStatusByModeId,
        setServiceConfigurationStatusByModeId,
    ] = React.useState<ServiceConfigurationStatusByModeId>({});
    const [attempt, setAttempt] = React.useState<ConnectedAccountAttemptResponse | null>(null);
    // Pending replies omit the already issued code. Keep only that display projection for the
    // same attempt; the daemon response remains the lifecycle authority.
    const deviceCodeRef = React.useRef<Extract<ConnectedAccountAttemptResponse, { status: 'awaitingDeviceAuthorization' }> | null>(null);
    const draftDisplayNameRef = React.useRef<string | null>(null);
    const [configuration, setConfiguration] = React.useState<ConfigurationDescription | null>(null);
    const [
        configurationContinuationAttemptId,
        setConfigurationContinuationAttemptId,
    ] = React.useState<string | null>(null);
    const [pendingIntent, setPendingIntent] = React.useState<PendingIntent | null>(null);
    const [activeModeId, setActiveModeId] = React.useState<string | null>(null);
    const [busy, setBusy] = React.useState(false);
    const [errorCode, setErrorCode] = React.useState<string | null>(null);
    const panelRef = React.useRef(controllerProps.panel);
    panelRef.current = controllerProps.panel;
    // A panel starts its sign-in only once it knows no earlier attempt is waiting to be resumed.
    const [noPendingAttempt, setNoPendingAttempt] = React.useState(false);
    const panelStartedRef = React.useRef(false);
    const [retryingDescription, setRetryingDescription] = React.useState(false);
    // Advances when the setup flow is cancelled or changes method. An earlier reply
    // belongs to a sign-in the user abandoned: it is not shown, and a live attempt it
    // reports is cancelled.
    const setupAttemptEpochRef = React.useRef(0);
    const flowGenerationRef = React.useRef(0);
    const discoveredScopeRef = React.useRef<string | null>(null);
    const activeControllerRef = React.useRef(true);
    const accountLifetime = React.useMemo(
        () => captureActiveServerAccountScopeCurrentness(),
        [],
    );
    const lifecycleAbortControllerRef = React.useRef<AbortController | null>(null);
    if (lifecycleAbortControllerRef.current === null) {
        lifecycleAbortControllerRef.current = new AbortController();
    }
    const lifecycleSignal = lifecycleAbortControllerRef.current.signal;
    const isControllerCurrent = React.useCallback(() => (
        activeControllerRef.current
        && !lifecycleSignal.aborted
        && accountLifetime.isCurrent()
    ), [accountLifetime, lifecycleSignal]);
    React.useEffect(() => {
        const controller = lifecycleAbortControllerRef.current;
        if (!controller) return;
        activeControllerRef.current = true;
        const registration = accountLifetime.onRetire(() => {
            activeControllerRef.current = false;
            controller.abort();
        });
        return () => {
            activeControllerRef.current = false;
            registration.dispose();
            controller.abort();
        };
    }, [accountLifetime]);
    const accountPeer = React.useMemo(() => {
        if (description?.operationTransport) {
            return {
                status: 'ready' as const,
                transport:
                    projectDaemonPeerTransport(description.operationTransport),
                errorCode: null,
            };
        }
        // No transport AND a failed description read is the only way this route
        // learns the peer cannot be resolved at all; without emitting it, the
        // groups hook would report "unsupported" for what is really a failure.
        // The raw daemon code travels as a CODE; the groups hook owns turning it
        // into copy, exactly as this screen's own error row does below.
        return errorCode
            ? {
                status: 'error' as const,
                transport: null,
                errorCode,
            }
            : {
                status: 'loading' as const,
                transport: null,
                errorCode: null,
            };
    }, [description?.operationTransport, errorCode]);
    const groups = useQualifiedConnectedAccountGroups({
        serverId,
        service,
        peer: accountPeer,
    });
    const visibleAccounts = React.useMemo<
        readonly ConnectedAccountServiceProfile[]
    >(() => {
        const transport = description?.operationTransport;
        if (!description || !transport) return [];
        if (transport.kind === 'v4') return description.accounts;
        const compatibility =
            BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY_BY_SERVICE_ID[
                transport.serviceId
            ];
        if (!compatibility) return [];
        const legacyService = profile.connectedServicesV2.find(
            (candidate) => candidate.serviceId === transport.serviceId,
        );
        return Object.freeze((legacyService?.profiles ?? []).map(
            (legacyProfile) => {
                const kind = legacyProfile.kind === 'oauth'
                    || legacyProfile.kind === 'token'
                    ? legacyProfile.kind
                    : null;
                const authenticationModeId = kind
                    ? readLegacyAuthenticationModeId(
                        compatibility.authenticationModeByCredentialKind,
                        kind,
                    )
                        ?? readLegacyAuthenticationModeId(
                            compatibility
                                .unsupportedAuthenticationModeByCredentialKind,
                            kind,
                        )
                        ?? null
                    : compatibility.defaultAuthenticationModeId;
                return Object.freeze({
                    ref: Object.freeze({
                        service: description.service,
                        accountId: legacyProfile.profileId,
                    }),
                    status: legacyProfile.status,
                    authenticationModeId,
                    revisionSemantics: 'legacy_unfenced' as const,
                    credentialRevision: null,
                    configurationReady: false,
                    configurationRevision: null,
                    displayName: legacyProfile.providerEmail
                        ?? legacyProfile.providerAccountId
                        ?? legacyProfile.profileId,
                    scopes: [] as string[],
                    ...(legacyProfile.expiresAt === undefined
                        ? {}
                        : { expiresAt: legacyProfile.expiresAt }),
                    ...(legacyProfile.lastUsedAt === undefined
                        ? {}
                        : { lastUsedAt: legacyProfile.lastUsedAt }),
                });
            },
        ));
    }, [description, profile.connectedServicesV2]);

    const refreshDescription = React.useCallback(async (signal: AbortSignal = lifecycleSignal) => {
        if (
            !isControllerCurrent()
            || signal.aborted
            || !servicePluginId
            || !serviceLocalId
            || !serverId
            || !machineId
            || !exactRoute
        ) return;
        const result = await runConnectedAccountControlCommand({
            serverId,
            machineId,
            ...(expectedActiveServer ? { expectedActiveServer } : {}),
            command: {
                operation: 'describeService',
                service: {
                    pluginId: servicePluginId,
                    localId: serviceLocalId,
                },
                requiredOperation: 'account_list',
            },
            signal,
        });
        if (!isControllerCurrent() || signal.aborted) return;
        if (
            result.status !== 'described'
            || result.operationTransport === undefined
        ) {
            setErrorCode(readControlFailureCode(
                result,
                'connected_account_service_description_unavailable',
            ));
            return;
        }
        const serviceConfigurationStatusEntries = await Promise.all(
            result.descriptor.authentication.modes
                .filter((mode) => mode.configuration?.scope === 'service')
                .map(async (mode) => {
                    try {
                        const configurationResult =
                            await runConnectedAccountControlCommand({
                                serverId,
                                machineId,
                                ...(expectedActiveServer
                                    ? { expectedActiveServer }
                                    : {}),
                                command: {
                                    operation: 'readConfiguration',
                                    target: {
                                        kind: 'service',
                                        service: result.service,
                                        modeId: mode.id,
                                    },
                                },
                                signal,
                            });
                        const current =
                            configurationResult.status === 'configuration'
                            && configurationResult.target.kind === 'service'
                            && configurationResult.target.service.pluginId
                                === result.service.pluginId
                            && configurationResult.target.service.localId
                                === result.service.localId
                            && configurationResult.target.modeId === mode.id
                            && configurationResult.mode.id === mode.id
                            && configurationResult.occurrenceId
                                === result.occurrenceId;
                        return [
                            mode.id,
                            current
                                ? configurationResult.configuration.status
                                : 'configurationRequired',
                        ] as const;
                    } catch (error) {
                        if (signal.aborted) throw error;
                        return [
                            mode.id,
                            'configurationRequired',
                        ] as const;
                    }
                }),
        );
        if (!isControllerCurrent() || signal.aborted) return;
        setServiceConfigurationStatusByModeId(Object.freeze(
            Object.fromEntries(serviceConfigurationStatusEntries),
        ));
        setDescription(result);
        setErrorCode(null);
    }, [
        exactRoute,
        machineId,
        expectedActiveServer,
        isControllerCurrent,
        lifecycleSignal,
        serverId,
        serviceLocalId,
        servicePluginId,
    ]);

    React.useEffect(() => {
        const request = createLinkedAbortController(lifecycleSignal);
        void refreshDescription(request.signal).catch(() => {
            if (isControllerCurrent() && !request.signal.aborted) {
                setErrorCode('connected_account_daemon_unavailable');
            }
        });
        return () => request.dispose();
    }, [isControllerCurrent, lifecycleSignal, refreshDescription]);


    /** Cancels an abandoned attempt without showing its reply: its setup flow is gone. */
    const cancelDiscardedAttempt = React.useCallback((attemptIdToCancel: string) => {
        if (!serverId || !machineId) return;
        void runConnectedAccountAuthenticationCommand({
            serverId,
            machineId,
            ...(expectedActiveServer ? { expectedActiveServer } : {}),
            command: { operation: 'cancel', attemptId: attemptIdToCancel },
            signal: lifecycleSignal,
        }).catch(() => {
            // Best effort: the daemon expires an attempt nobody completes.
        });
    }, [expectedActiveServer, lifecycleSignal, machineId, serverId]);

    const readConfiguration = React.useCallback(async (
        target: ConnectedAccountConfigurationTarget,
        /** The setup epoch the flow that asks for this read started in (defaults to now). */
        requestEpoch: number = setupAttemptEpochRef.current,
    ): Promise<boolean> => {
        if (!isControllerCurrent() || !serverId || !machineId) return false;
        const result = await runConnectedAccountControlCommand({
            serverId,
            machineId,
            ...(expectedActiveServer ? { expectedActiveServer } : {}),
            command: {
                operation: 'readConfiguration',
                target: toControlTarget(target),
            },
            signal: lifecycleSignal,
        });
        if (!isControllerCurrent()) return false;
        // A form for a setup flow cancelled while it loaded is never shown.
        if (requestEpoch !== setupAttemptEpochRef.current) return false;
        if (result.status === 'configuration') {
            setConfiguration(result);
            setActiveModeId(result.mode.id);
            setErrorCode(null);
            return true;
        } else {
            setErrorCode(readControlFailureCode(
                result,
                'connected_account_configuration_unavailable',
            ));
            return false;
        }
    }, [expectedActiveServer, isControllerCurrent, lifecycleSignal, machineId, serverId]);

    /**
     * The one place an authentication reply is applied. `requestEpoch` is the setup epoch captured
     * when the request was sent: a reply to a request sent before the setup flow was
     * cancelled belongs to the abandoned sign-in, so it is not shown and a live attempt it reports
     * is cancelled. Every caller passes the epoch it captured, so no reply path is unfenced.
     */
    const acceptAttemptResponse = React.useCallback(async (
        response: ConnectedAccountAttemptResponse,
        requestEpoch: number,
        options?: Readonly<{
            /**
             * Set by a lost-reply recovery whose exact read proved the attempt neither
             * advanced nor settled. The outcome of the lost effectful command is still
             * unknown, so the shown uncertainty must survive this response.
             */
            retainUnresolvedError?: boolean;
        }>,
    ) => {
        if (!isControllerCurrent()) return;
        if (requestEpoch !== setupAttemptEpochRef.current) {
            if (!isTerminalAttempt(response) && 'attemptId' in response && response.attemptId) {
                cancelDiscardedAttempt(response.attemptId);
            }
            return;
        }
        if (response.status === 'awaitingDeviceAuthorization') deviceCodeRef.current = response;
        else if (response.status !== 'pending' || deviceCodeRef.current?.attemptId !== response.attemptId) deviceCodeRef.current = null;
        setAttempt(response);
        if (isTerminalAttempt(response)) {
            if (response.status === 'connected' || response.status === 'cancelled') {
                setPendingIntent(null);
            }
            setConfigurationContinuationAttemptId(null);
        }
        if (response.status === 'configurationRequired') {
            setConfigurationContinuationAttemptId(
                response.attemptId ?? null,
            );
            await readConfiguration(response.target, requestEpoch);
            return;
        }
        if (response.status === 'connected') {
            if (draftDisplayNameRef.current) {
                applySettings({ connectedServicesProfileLabelByKey: updateQualifiedConnectedAccountLabel({
                    service: response.account.service, legacyServiceId, accountId: response.account.accountId,
                    label: draftDisplayNameRef.current,
                    labelsByKey: getStorage().getState().settings.connectedServicesProfileLabelByKey,
                }) });
            }
            draftDisplayNameRef.current = null;
            panelRef.current?.onConnected(response.account);
            setAttempt(null);
            setConfiguration(null);
            // The new account joins the Collection; the setup flow closes.
            await refreshDescription();
            return;
        }
        if (
            response.status === 'rejected'
            || response.status === 'unavailable'
            || response.status === 'conflict'
            || response.status === 'reconnectRequired'
            || response.status === 'cleanupPending'
        ) {
            setErrorCode(response.code);
        } else if (!options?.retainUnresolvedError) {
            setErrorCode(null);
        }
    }, [applySettings, cancelDiscardedAttempt, isControllerCurrent, legacyServiceId, readConfiguration, refreshDescription]);

    React.useEffect(() => {
        if (!description || !service || !serverId || !machineId || attempt || busy) return;
        const scopeKey = JSON.stringify([serverId, machineId, service.pluginId, service.localId]);
        if (discoveredScopeRef.current === scopeKey) return;
        discoveredScopeRef.current = scopeKey;
        const generation = flowGenerationRef.current;
        const requestEpoch = setupAttemptEpochRef.current;
        const request = createLinkedAbortController(lifecycleSignal);
        let completed = false;
        void (async () => {
            const listed = await runConnectedAccountControlCommand({
                serverId,
                machineId,
                ...(expectedActiveServer ? { expectedActiveServer } : {}),
                command: { operation: 'listPendingAttempts', service },
                signal: request.signal,
            });
            if (!isControllerCurrent() || request.signal.aborted || generation !== flowGenerationRef.current) return;
            if (listed.status !== 'pendingAttempts') {
                discoveredScopeRef.current = null;
                setErrorCode(readControlFailureCode(listed, 'connected_account_attempt_discovery_unavailable'));
                return;
            }
            const pending = listed.attempts[0];
            if (!pending) {
                completed = true;
                setNoPendingAttempt(true);
                return;
            }
            setActiveModeId(pending.modeId);
            if (pending.intent === 'connect') {
            }
            const response = await runConnectedAccountAuthenticationCommand({
                serverId,
                machineId,
                ...(expectedActiveServer ? { expectedActiveServer } : {}),
                command: pending.kind === 'device'
                    ? { operation: 'resumeDevice', attemptId: pending.attemptId }
                    : { operation: 'read', attemptId: pending.attemptId, restoreKind: 'oauth' },
                signal: request.signal,
            });
            if (!isControllerCurrent() || request.signal.aborted || generation !== flowGenerationRef.current) return;
            await acceptAttemptResponse(response, requestEpoch);
            completed = true;
        })().catch((error) => {
            if (isControllerCurrent() && !request.signal.aborted && generation === flowGenerationRef.current) {
                discoveredScopeRef.current = null;
                setErrorCode(readConnectedServiceSettingsErrorCode(error) ?? 'connected_account_attempt_discovery_unavailable');
            }
        });
        return () => {
            request.dispose();
            if (!completed && discoveredScopeRef.current === scopeKey) {
                discoveredScopeRef.current = null;
            }
        };
    }, [acceptAttemptResponse, attempt, busy, description, expectedActiveServer, isControllerCurrent, lifecycleSignal, machineId, serverId, service]);

    const runAuthentication = React.useCallback(async (
        command: Parameters<typeof runConnectedAccountAuthenticationCommand>[0]['command'],
    ): Promise<boolean> => {
        if (!isControllerCurrent() || !serverId || !machineId) return false;
        const draftEpoch = setupAttemptEpochRef.current;
        setBusy(true);
        try {
            const response = await runConnectedAccountAuthenticationCommand({
                serverId,
                machineId,
                ...(expectedActiveServer ? { expectedActiveServer } : {}),
                command,
                signal: lifecycleSignal,
            });
            if (!isControllerCurrent()) return false;
            await acceptAttemptResponse(response, draftEpoch);
            return isControllerCurrent() && draftEpoch === setupAttemptEpochRef.current;
        } catch {
            if (!isControllerCurrent()) return false;
            setErrorCode('connected_account_daemon_unavailable');
            return false;
        } finally {
            if (isControllerCurrent()) setBusy(false);
        }
    }, [
        acceptAttemptResponse,
        expectedActiveServer,
        isControllerCurrent,
        lifecycleSignal,
        machineId,
        serverId,
    ]);

    const beginIntent = React.useCallback(async (
        intent: PendingIntent,
        expectedConfigurationRevision?: string,
    ) => {
        if (!isControllerCurrent()) return;
        flowGenerationRef.current += 1;
        setPendingIntent(intent);
        if (intent.kind === 'connect') {
            setActiveModeId(intent.modeId);
            await runAuthentication({
                operation: 'beginConnect',
                service: intent.service,
                modeId: intent.modeId,
                ...(expectedConfigurationRevision
                    ? { expectedConfigurationRevision }
                    : {}),
            });
            return;
        }
        const account = visibleAccounts.find((candidate) => (
            candidate.ref.accountId === intent.account.accountId
            && candidate.ref.service.pluginId === intent.account.service.pluginId
            && candidate.ref.service.localId === intent.account.service.localId
        ));
        setActiveModeId(account?.authenticationModeId ?? null);
        await runAuthentication({
            operation: 'beginReconnect',
            account: intent.account,
            ...(expectedConfigurationRevision
                ? { expectedConfigurationRevision }
            : {}),
        });
    }, [isControllerCurrent, runAuthentication, visibleAccounts]);

    const retryDescription = React.useCallback(async () => {
        if (!isControllerCurrent() || retryingDescription) return;
        setRetryingDescription(true);
        try {
            // A known rejection is finished. Retry starts the same intent with a fresh form;
            // uncertain transport outcomes still recover the exact existing attempt below.
            if (pendingIntent && attempt && (isTerminalAttempt(attempt) || attempt.status === 'reconnectRequired')) {
                await beginIntent(pendingIntent);
                return;
            }
            const recoverableAttemptId = attempt && 'attemptId' in attempt
                ? attempt.attemptId
                : null;
            if (recoverableAttemptId && serverId && machineId) {
                const requestEpoch = setupAttemptEpochRef.current;
                const response = await runConnectedAccountAuthenticationCommand({
                    serverId,
                    machineId,
                    ...(expectedActiveServer ? { expectedActiveServer } : {}),
                    command: { operation: 'read', attemptId: recoverableAttemptId },
                    signal: lifecycleSignal,
                });
                if (!isControllerCurrent()) return;
                // An unchanged non-terminal read does not resolve a lost effectful reply.
                await acceptAttemptResponse(response, requestEpoch, {
                    retainUnresolvedError: !isTerminalAttempt(response) && attempt !== null && response.status === attempt.status,
                });
                return;
            }
            await refreshDescription();
        } catch {
            if (isControllerCurrent()) setErrorCode('connected_account_daemon_unavailable');
        } finally {
            if (isControllerCurrent()) setRetryingDescription(false);
        }
    }, [acceptAttemptResponse, attempt, beginIntent, expectedActiveServer, isControllerCurrent, lifecycleSignal,
        machineId, pendingIntent, refreshDescription, retryingDescription, serverId]);

    const activeMode: PluginConnectedAccountAuthenticationModeV2 | null =
        description?.descriptor.authentication.modes.find(
            (candidate) => candidate.id === activeModeId,
        ) ?? null;
    const activeModeKind = activeMode?.kind ?? null;

    React.useEffect(() => {
        if (!attempt || busy) return;
        const attemptId = 'attemptId' in attempt ? attempt.attemptId : undefined;
        if (!attemptId) return;
        if (attempt.status !== 'starting' && attempt.status !== 'pending' && attempt.status !== 'awaitingDeviceAuthorization') return;
        if (attempt.status === 'awaitingDeviceAuthorization' && (attempt.pollIntervalMs === undefined || (attempt.expiresAtMs !== undefined && attempt.expiresAtMs <= Date.now()))) return;
        if (attempt.status === 'pending' && activeModeKind === 'oauthDeviceCode' && deviceCodeRef.current?.expiresAtMs !== undefined && deviceCodeRef.current.expiresAtMs <= Date.now()) return;
        if (attempt.status === 'pending' && activeModeKind === null) return;
        const delayMs = attempt.status === 'awaitingDeviceAuthorization'
            ? attempt.pollIntervalMs
            : attempt.status === 'pending'
            ? Math.max(250, attempt.retryAfterMs)
            : 250;
        const timeout = setTimeout(() => {
            void runAuthentication(
                attempt.status === 'awaitingDeviceAuthorization' || attempt.status === 'pending'
                    ? {
                        operation: attempt.status === 'awaitingDeviceAuthorization' || activeModeKind === 'oauthDeviceCode'
                            ? 'pollDevice'
                            : 'reconcile',
                        attemptId,
                    }
                    : { operation: 'read', attemptId },
            );
        }, delayMs);
        return () => clearTimeout(timeout);
    }, [activeModeKind, attempt, busy, runAuthentication]);

    // A setup panel opens on the sign-in itself: adding starts the recommended way, signing in
    // again starts the account's own way. Once per panel; switching ways is the person's choice.
    React.useEffect(() => {
        const panel = panelRef.current;
        if (!panel || panelStartedRef.current || !service || !description || attempt || busy || !noPendingAttempt) return;
        const modes = description.descriptor.authentication.modes;
        panelStartedRef.current = true;
        if (panel.intent.kind === 'reconnect') {
            void beginIntent({ kind: 'reconnect', account: { service, accountId: panel.intent.accountId } });
            return;
        }
        const recommended = rankConnectedAccountSetupModes(modes)[0]?.mode;
        if (!recommended) return;
        void beginIntent({ kind: 'connect', service, modeId: recommended.id });
    }, [attempt, beginIntent, busy, description, noPendingAttempt, service]);

    /**
     * Revoke one exact qualified account.
     *
     * `alreadyConfirmed` marks a caller that owns the destructive confirmation
     * itself (the account detail screen prompts before it calls), so exactly one
     * prompt is shown per surface. The group-reference cleanup prompt below is a
     * distinct, response-driven decision and always belongs to this operation.
     * Resolves to whether the account was revoked.
     */
    const revokeAccount = React.useCallback(async (
        account: QualifiedConnectedAccountRef,
        options?: Readonly<{ alreadyConfirmed?: boolean }>,
    ): Promise<boolean> => {
        const serviceLabel = resolveProjectedLocalizedText(description?.descriptor.title, localizeServiceText) || serviceId;
        const confirmed = options?.alreadyConfirmed === true || await Modal.confirm(
            t('modals.disconnect'),
            t('connectedServices.detail.disconnectConfirmBody', {
                service: serviceLabel,
                profileId: account.accountId,
            }),
            {
                confirmText: t('modals.disconnect'),
                cancelText: t('common.cancel'),
            },
        );
        if (!confirmed || !isControllerCurrent()) return false;

        const revoke = async (cleanupGroupReferences: boolean) => {
            try {
                return await runConnectedAccountControlCommand({
                    serverId,
                    machineId,
                    ...(expectedActiveServer ? { expectedActiveServer } : {}),
                    command: {
                        operation: 'revokeAccount',
                        account,
                        cleanupGroupReferences,
                    },
                    signal: lifecycleSignal,
                });
            } catch (error) {
                // Peers report this conflict either as a thrown failure or as a
                // `conflict` response; normalize to the response shape so the
                // cleanup decision below reads exactly one of them.
                if (isConnectedServiceCredentialReferencedByGroupError(error)) {
                    return {
                        status: 'conflict' as const,
                        code: 'connect_credential_referenced_by_group',
                    };
                }
                throw error;
            }
        };

        setBusy(true);
        try {
            let result = await revoke(false);
            if (!isControllerCurrent()) return false;
            if (isConnectedServiceCredentialReferencedByGroupError(result)) {
                const cleanupConfirmed = await Modal.confirm(
                    t('modals.disconnect'),
                    t('connectedServices.errors.credentialReferencedByGroup'),
                    {
                        confirmText: t('modals.disconnect'),
                        cancelText: t('common.cancel'),
                    },
                );
                if (!cleanupConfirmed || !isControllerCurrent()) return false;
                result = await revoke(true);
                if (!isControllerCurrent()) return false;
            }
            if (result.status === 'revoked') {
                const currentSettings = getStorage().getState().settings;
                const defaults = removeAgentConnectedAccountDefaultsForDeletedTarget({
                    settings: currentSettings,
                    target: { kind: 'account', account },
                });
                applySettings({ ...pruneQualifiedConnectedAccountPreferences({
                    service: account.service,
                    legacyServiceId,
                    accountId: account.accountId,
                    defaultAccountByServiceKey:
                        currentSettings.connectedServicesDefaultProfileByServiceId,
                    labelsByKey:
                        currentSettings.connectedServicesProfileLabelByKey,
                }), ...defaults });
                await refreshDescription();
                return true;
            }
            setErrorCode(
                result.status === 'outcomeUnknown'
                    ? 'connected_account_revoke_outcome_unknown'
                    : readControlFailureCode(
                        result,
                        'connected_account_revoke_unavailable',
                    ),
            );
            return false;
        } catch (error) {
            if (!isControllerCurrent()) return false;
            setErrorCode(
                readConnectedServiceSettingsErrorCode(error)
                ?? 'connected_account_daemon_unavailable',
            );
            return false;
        } finally {
            if (isControllerCurrent()) setBusy(false);
        }
    }, [
        applySettings,
        expectedActiveServer,
        description?.descriptor.title,
        isControllerCurrent,
        lifecycleSignal,
        locale,
        machineId,
        refreshDescription,
        legacyServiceId,
        serverId,
        serviceId,
    ]);

    if (controllerProps.panel && (!exactRoute || !service)) {
        return <ConnectedServiceSetupFlowBody state="unknownService" />;
    }
    if (!exactRoute || !service) {
        return (
            <ItemList>
                <SettingsPageHeader title={t('settings.connectedServices')} alwaysShowTitle />
                <ItemGroup>
                    <Item
                        title={t('connectedServices.detail.unknownService')}
                        mode="info"
                        showChevron={false}
                    />
                </ItemGroup>
            </ItemList>
        );
    }

    const serviceHeader = (headerTitle: string) => (
        <SettingsPageHeader
            testID="connected-account-service-header"
            title={headerTitle}
            alwaysShowTitle
            leading={<ConnectedServiceMark legacyServiceId={legacyServiceId} size="page" />}
            description={t('connectedServicesSettings.servicePurpose', { service: headerTitle })}
            actions={(
                <MachineAdministrationTargetSelector
                    selection={targetSelection}
                    presentation="chip"
                    testIDPrefix="connected-account-target"
                />
            )}
        />
    );

    if (controllerProps.panel && (!serverId || !machineId)) {
        return <ConnectedServiceSetupFlowBody state="chooseMachine" />;
    }
    if (!serverId || !machineId) {
        const pendingTitle = registryEntry
            ? resolveConnectedServiceRegistryEntryDisplayName(registryEntry, t, controllerProps.localizePluginText)
            : t('connectedServices.fallbackName');
        return (
            <ItemList>
                {serviceHeader(pendingTitle)}
                <ItemGroup>
                    <Item
                        testID="connected-account-choose-machine"
                        title={t('connectedServicesSettings.chooseMachineTitle')}
                        subtitle={t('connectedServicesSettings.chooseMachineDescription')}
                        subtitleLines={0}
                        mode="info"
                        showChevron={false}
                    />
                </ItemGroup>
            </ItemList>
        );
    }

    const title = resolveProjectedLocalizedText(description?.descriptor.title, localizeServiceText)
        || (registryEntry
            ? resolveConnectedServiceRegistryEntryDisplayName(registryEntry, t, controllerProps.localizePluginText)
            : t('connectedServices.fallbackName'));
    // ONE projection of the daemon transport (the `accountPeer` memo) answers
    // every peer-capability question on this route, so a second copy cannot drift
    // into a different peer-class answer.
    const peerTransport = accountPeer.transport;
    const supportsOperation = (
        operation: BuiltInLegacyConnectedAccountOperation,
    ): boolean => {
        if (!peerTransport) return false;
        if (peerTransport.protocol === 'v4') return true;
        return isQualifiedConnectedAccountLegacyOperationSupported({
            service,
            legacyServiceId: peerTransport.legacyServiceId,
            peerClass: peerTransport.peerClass,
            operation,
        });
    };
    const transport = description?.operationTransport;
    const descriptorModes =
        description?.descriptor.authentication.modes ?? [];
    const mutationModes = transport?.kind === 'v4'
        ? descriptorModes
        : transport?.kind === 'legacy'
            && transport.peerClass === 'revisioned_v2_v3'
            && descriptorModes.length === 1
            ? descriptorModes.filter((mode) => {
                const compatibility =
                    BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY_BY_SERVICE_ID[
                        transport.serviceId
                    ];
                return compatibility
                    ? (
                        Object.values(
                            compatibility.authenticationModeByCredentialKind,
                        ) as readonly string[]
                    ).includes(mode.id)
                    : false;
            })
            : [];
    const legacyMutationModeIds = new Set(
        mutationModes.map((mode) => mode.id),
    );
    const credentialWriteAllowed = supportsOperation('credential_write')
        && (
            transport?.kind === 'v4'
            || legacyMutationModeIds.size === 1
        );
    const credentialDeleteAllowed = supportsOperation('credential_delete')
        && (
            transport?.kind === 'v4'
            || (
                transport?.kind === 'legacy'
                && transport.peerClass === 'revisioned_v2_v3'
            )
        );
    const attemptId = attempt && 'attemptId' in attempt ? attempt.attemptId : null;
    const accountLabels = Object.fromEntries(visibleAccounts.filter((account) => (
        account.ref.service.pluginId === service.pluginId
        && account.ref.service.localId === service.localId
    )).map((account) => [
        account.ref.accountId,
        resolveQualifiedConnectedAccountLabel({
            service,
            legacyServiceId,
            accountId: account.ref.accountId,
            labelsByKey: settings.connectedServicesProfileLabelByKey,
        }) ?? undefined,
    ]));
    const renameAccount = (account: QualifiedConnectedAccountRef, label: string) => {
        if (!isControllerCurrent()) return;
        applySettings({
            connectedServicesProfileLabelByKey:
                updateQualifiedConnectedAccountLabel({
                    service,
                    legacyServiceId,
                    accountId: account.accountId,
                    label,
                    labelsByKey:
                        settings.connectedServicesProfileLabelByKey,
                }),
        });
    };

    /**
     * A focused detail screen (account or pool) renders its OWN scroll
     * container, so this route must not nest it inside another list. While an
     * authentication or configuration flow is in flight, that flow takes the
     * focused screen's place and the route supplies the list — one scroll
     * container either way.
     */
    const authenticationFlowActive = Boolean(attempt || configuration || errorCode);
    const focusedScreenOwnsScroll = description !== null
        && route.focus !== null
        && !authenticationFlowActive;

    /** Changing the setup method abandons and cancels the current sign-in. */
    const cancelSetupAttempt = () => {
        flowGenerationRef.current += 1;
        // Every reply still on its way now belongs to the abandoned sign-in (see `runAuthentication`).
        setupAttemptEpochRef.current += 1;
        setConfiguration(null);
        setPendingIntent(null);
        setConfigurationContinuationAttemptId(null);
        setErrorCode(null);
        setAttempt(null);
        deviceCodeRef.current = null;
        draftDisplayNameRef.current = null;
        setBusy(false);
        if (attemptId && attempt && !isTerminalAttempt(attempt)) {
            cancelDiscardedAttempt(attemptId);
        }
    };

    /**
     * A setup panel's Cancel is local: the sign-in leaves at once and the panel steps back, whatever
     * the machine is doing. The same cancellation owner releases a running attempt in the
     * background (never awaited, its reply never shown), so it is not offered for resume next time.
     */
    const cancelPanelFlow = () => {
        cancelSetupAttempt();
        panelRef.current?.onCancel?.();
    };
    const panelCancel = controllerProps.panel ? cancelPanelFlow : undefined;

    /**
     * The running sign-in or configuration flow (forms, progress, recovery). A new account's flow
     * runs inside the setup panel (`embedded`); reconnecting and configuring an existing
     * account or the service run as page sections.
     */
    const visibleDeviceCode = attempt?.status === 'awaitingDeviceAuthorization' ? attempt
        : attempt?.status === 'pending' && activeModeKind === 'oauthDeviceCode' && deviceCodeRef.current?.attemptId === attempt.attemptId ? deviceCodeRef.current : null;
    const setupPresentation = service ? getConnectedServiceSetupPresentation(service) : null;
    const manualGuide = setupPresentation && 'manual' in setupPresentation ? setupPresentation.manual : null;
    const renderFlow = (embedded: boolean) => (
        <>
            {attempt?.status === 'awaitingManual' && activeMode?.kind === 'manual' ? (
                <ConnectedAccountManualForm
                    embedded={embedded}
                    key={attempt.attemptId}
                    title={resolveProjectedLocalizedText(activeMode.title, localizeServiceText) || title}
                    localize={localizeServiceText}
                    fields={activeMode.fields}
                    guided={manualGuide ? { consoleUrl: manualGuide.consoleUrl, createKeyTitle: t(manualGuide.createKeyTitleKey),
                        billingNote: t(manualGuide.billingNoteKey), shapeHint: t(manualGuide.shapeHintKey) } : undefined}
                    submitting={busy}
                    navigation={navigation}
                    onCancel={panelCancel}
                    onSubmit={({ fields, displayName }) => {
                        draftDisplayNameRef.current = displayName ?? null;
                        return runAuthentication({ operation: 'submitManual', attemptId: attempt.attemptId, fields });
                    }}
                />
            ) : null}

            {attempt?.status === 'awaitingOAuth' ? (
                <ConnectedAccountOAuthForm
                    embedded={embedded}
                    key={attempt.attemptId}
                    authorizationUrl={attempt.authorizationUrl ?? ''}
                    callbackUrl={attempt.callbackUrl}
                    submitting={busy}
                    navigation={navigation}
                    onCancel={panelCancel}
                    onSubmit={(completion) => runAuthentication({
                        operation: 'completeOAuth',
                        attemptId: attempt.attemptId,
                        completion,
                    })}
                />
            ) : null}

            {visibleDeviceCode ? (
                <ConnectedAccountDeviceForm
                    embedded={embedded}
                    key={visibleDeviceCode.attemptId}
                    verificationUri={visibleDeviceCode.verificationUri}
                    verificationUriComplete={visibleDeviceCode.verificationUriComplete}
                    userCode={visibleDeviceCode.userCode}
                    expiresAtMs={visibleDeviceCode.expiresAtMs}
                    serviceTitle={title}
                    busy={busy}
                    automaticPolling={visibleDeviceCode.pollIntervalMs !== undefined || attempt?.status === 'pending'}
                    onCancel={panelCancel}
                    onPoll={async () => {
                        await runAuthentication({
                            operation: 'pollDevice',
                            attemptId: visibleDeviceCode.attemptId,
                        });
                    }}
                    onResume={async () => {
                        await runAuthentication({
                            operation: 'resumeDevice',
                            attemptId: visibleDeviceCode.attemptId,
                        });
                    }}
                />
            ) : null}

            {configuration && activeMode?.configuration ? (
                <ConnectedAccountConfigurationForm
                    embedded={embedded}
                    key={`${configuration.occurrenceId}:${configuration.configuration.revision ?? 'new'}`}
                    title={resolveProjectedLocalizedText(activeMode.title, localizeServiceText) || title}
                    localize={localizeServiceText}
                    fields={activeMode.configuration.fields}
                    values={configuration.configuration.values}
                    configuredSecretFieldIds={
                        configuration.configuration.configuredSecretFieldIds
                    }
                    saving={busy}
                    navigation={navigation}
                    onSubmit={async ({ values, secretValues }) => {
                        if (!isControllerCurrent()) return false;
                        // Replies to this submit belong to the draft as it is now (see `acceptAttemptResponse`).
                        const requestEpoch = setupAttemptEpochRef.current;
                        setBusy(true);
                        try {
                            const committed = await runConnectedAccountControlCommand({
                                serverId,
                                machineId,
                                ...(expectedActiveServer ? { expectedActiveServer } : {}),
                                command: {
                                    operation: 'replaceConfiguration',
                                    target: toControlTarget(configuration.target),
                                    expectedRevision: configuration.configuration.revision,
                                    values,
                                    secretValues,
                                },
                                signal: lifecycleSignal,
                            });
                            if (!isControllerCurrent()) return false;
                            // Discarded while saving: the abandoned attempt is not continued.
                            if (requestEpoch !== setupAttemptEpochRef.current) return false;
                            if (committed.status !== 'configurationCommitted') {
                                setErrorCode(readControlFailureCode(
                                    committed,
                                    'connected_account_configuration_unavailable',
                                ));
                                return false;
                            }
                            setConfiguration(null);
                            const revision = committed.configuration.revision ?? undefined;
                            const changeBehavior =
                                committed.mode.configuration?.changeBehavior;
                            if (configurationContinuationAttemptId) {
                                await acceptAttemptResponse(
                                    await runConnectedAccountAuthenticationCommand({
                                        serverId,
                                        machineId,
                                        ...(expectedActiveServer ? { expectedActiveServer } : {}),
                                        command: {
                                            operation: 'continueConnect',
                                            attemptId:
                                                configurationContinuationAttemptId,
                                            ...(revision
                                                ? { expectedConfigurationRevision: revision }
                                                : {}),
                                        },
                                        signal: lifecycleSignal,
                                    }),
                                    requestEpoch,
                                );
                                if (!isControllerCurrent() || requestEpoch !== setupAttemptEpochRef.current) return false;
                            } else if (pendingIntent) {
                                await beginIntent(pendingIntent, revision);
                            } else {
                                await refreshDescription();
                                if (changeBehavior) {
                                    await Modal.alert(
                                        t('connectedServices.account.configurationUpdatedTitle'),
                                        changeBehavior === 'refresh'
                                            ? t('connectedServices.account.configurationRefreshApplied')
                                            : t('connectedServices.account.configurationReconnectApplied'),
                                    );
                                }
                            }
                            return isControllerCurrent();
                        } catch {
                            if (!isControllerCurrent()) return false;
                            setErrorCode('connected_account_configuration_unavailable');
                            return false;
                        } finally {
                            if (isControllerCurrent()) setBusy(false);
                        }
                    }}
                />
            ) : null}

            {attempt?.status === 'outcomeUnknown' ? (panelCancel ? (
                <ConnectedServiceSetupFlowActions
                    onCancel={panelCancel}
                    primary={{
                        testID: 'connected-account:reconcile',
                        label: t('common.retry'),
                        disabled: busy,
                        onPress: () => void runAuthentication({ operation: 'reconcile', attemptId: attempt.attemptId }),
                    }}
                />
            ) : (
                <ConnectedAccountFormSection embedded={embedded} title={t('connectedServices.detail.actionsGroupTitle')}>
                    <Item
                        testID="connected-account:reconcile"
                        title={t('common.retry')}
                        disabled={busy}
                        onPress={() => {
                            void runAuthentication({
                                operation: 'reconcile',
                                attemptId: attempt.attemptId,
                            });
                        }}
                    />
                </ConnectedAccountFormSection>
            )) : null}

            {errorCode ? (
                <ConnectedAccountFormSection embedded={embedded} title={t('common.error')}>
                    <Item
                        testID="connected-account:error"
                        // ONE owner turns a daemon error code into copy, so this
                        // screen never re-decides which failures are explainable.
                        title={resolveConnectedServiceSettingsErrorMessage({
                            code: errorCode,
                        })}
                        mode="info"
                        showChevron={false}
                    />
                    <Item
                        testID="connected-account:error:retry"
                        title={t('common.retry')}
                        loading={retryingDescription}
                        disabled={busy || retryingDescription}
                        onPress={() => void retryDescription()}
                    />
                </ConnectedAccountFormSection>
            ) : null}

            {/* A setup panel cancels locally, from the flow's own footer (`panelCancel`). */}
            {!panelCancel && attemptId && attempt && !isTerminalAttempt(attempt) ? (
                <ConnectedAccountFormSection embedded={embedded} title={t('connectedServices.detail.actionsGroupTitle')}>
                    <Item
                        testID="connected-account:cancel"
                        title={t('common.cancel')}
                        disabled={busy}
                        onPress={() => {
                            void runAuthentication({ operation: 'cancel', attemptId });
                        }}
                    />
                </ConnectedAccountFormSection>
            ) : null}
        </>
    );

    if (controllerProps.panel) {
        const panelIntent = controllerProps.panel.intent;
        const ranked = panelIntent.kind === 'add' && credentialWriteAllowed
            ? rankConnectedAccountSetupModes(mutationModes)
            : [];
        const flowActive = Boolean(attempt || configuration || errorCode);
        return (
            <ConnectedServiceSetupFlowBody
                state={description === null && !errorCode ? 'preparing' : 'ready'}
                methods={ranked.length > 1 ? ranked.map((entry) => ({
                    id: entry.mode.id,
                    title: entry.mode.kind === 'oauthAuthorizationCode' ? t('connectedServicesSettings.methodBrowser')
                        : entry.mode.kind === 'oauthDeviceCode' ? t('connectedServicesSettings.methodCode')
                            : setupPresentation && 'manualMethodTitleKey' in setupPresentation ? t(setupPresentation.manualMethodTitleKey)
                            : resolveConnectedAccountModeTitle(entry.mode, localizeServiceText),
                    recommended: entry.recommended,
                })) : []}
                activeMethodId={activeModeId}
                methodsDisabled={busy}
                onSelectMethod={(modeId) => {
                    if (modeId === activeModeId && flowActive) return;
                    cancelSetupAttempt();
                    void beginIntent({ kind: 'connect', service, modeId });
                }}
                flow={flowActive ? renderFlow(true) : null}
            />
        );
    }

    const routeBody = (
        <>
            {description !== null
                && !(route.focus !== null && authenticationFlowActive) ? (
                <ConnectedAccountServiceContent
                    serverId={serverId}
                    teamCredentialResourcesEnabled={teamCredentialResourcesEnabled}
                    localize={localizeServiceText}
                    title={title}
                    quotaResetSupported={description.descriptor.recoveryCredits?.supported === true}
                    service={service}
                    legacyServiceId={legacyServiceId}
                    focus={route.focus}
                    modes={mutationModes}
                    accounts={visibleAccounts}
                    serviceConfigurationStatusByModeId={
                        serviceConfigurationStatusByModeId
                    }
                    accountLabels={accountLabels}
                    groups={groups}
                    busy={busy}
                    onRenameAccount={credentialWriteAllowed ? renameAccount : undefined}
                    onConfigureAccount={credentialWriteAllowed ? (account) => {
                        const modeId = visibleAccounts.find((candidate) => (
                            candidate.ref.accountId === account.accountId
                            && candidate.ref.service.pluginId
                                === account.service.pluginId
                            && candidate.ref.service.localId
                                === account.service.localId
                        ))?.authenticationModeId;
                        if (!modeId) return;
                        const mode =
                            description.descriptor.authentication.modes.find(
                                (candidate) => candidate.id === modeId,
                            );
                        if (!mode?.configuration) return;
                        setAttempt(null);
                        setPendingIntent(null);
                        setConfigurationContinuationAttemptId(null);
                        setActiveModeId(modeId);
                        void readConfiguration(
                            {
                                kind: 'account',
                                account,
                                modeId,
                            },
                        );
                    } : undefined}
                    onConfigureService={credentialWriteAllowed ? (modeId) => {
                        const mode =
                            description.descriptor.authentication.modes.find(
                                (candidate) => candidate.id === modeId,
                            );
                        if (mode?.configuration?.scope !== 'service') return;
                        setAttempt(null);
                        setPendingIntent(null);
                        setConfigurationContinuationAttemptId(null);
                        setActiveModeId(modeId);
                        void readConfiguration({
                            kind: 'service',
                            service,
                            modeId,
                        });
                    } : undefined}
                    onBeginReconnect={credentialWriteAllowed ? (account) => {
                        void beginIntent({ kind: 'reconnect', account });
                    } : undefined}
                    canReconnectAccount={(account) => (
                        transport?.kind === 'v4'
                        || (
                            account.authenticationModeId !== null
                            && legacyMutationModeIds.has(
                                account.authenticationModeId,
                            )
                        )
                    )}
                    onDisconnectAccount={credentialDeleteAllowed ? (account) => (
                        // The account detail screen already confirmed.
                        revokeAccount(account, { alreadyConfirmed: true })
                    ) : undefined}
                />
            ) : null}
            {description === null && !errorCode ? (
                <ItemGroup>
                    <Item
                        title={t('connectedServices.deviceAuth.preparing')}
                        mode="info"
                        showChevron={false}
                    />
                </ItemGroup>
            ) : null}

            {renderFlow(false)}
        </>
    );

    return focusedScreenOwnsScroll ? routeBody : (
        <ItemList
            keyboardAware={authenticationFlowActive}
            keyboardShouldPersistTaps={authenticationFlowActive ? 'handled' : undefined}
        >
            {route.focus === null ? serviceHeader(title) : null}
            {routeBody}
        </ItemList>
    );
});

export function ConnectedAccountServiceView() {
    const params = useLocalSearchParams();
    const localizePluginText = useProjectedPluginLocalizedTextResolver();
    const connectedServicesRegistry =
        useProjectedConnectedServicesRegistry();
    const activeServer = useActiveServerSnapshot();
    const activeAccountScope = useActiveServerAccountScope();
    const targetSelection = useMachineAdministrationTargetSelection(
        MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.connectedAccounts,
    );
    const executionTarget = targetSelection.resolveExecutionTarget();
    const controllerKey = [
        activeAccountScope
            ? serverAccountScopeKeySuffix(activeAccountScope)
            : 'no-active-account',
        String(activeServer.generation ?? ''),
        executionTarget?.target.serverIdentityId ?? '',
        executionTarget?.target.machineId ?? '',
        executionTarget?.serverId ?? '',
        asStringParam(params.pluginId),
        asStringParam(params.localId),
        asStringParam(params.serviceId),
        asStringParam(params.accountId),
        asStringParam(params.groupId),
    ].join('\u0000');

    // One route renders three screens, so the header title has to follow the
    // focus. The static registry title ("Profile id") described none of them.
    // Resolved here, above the controller, so it never depends on the
    // controller's conditional hooks.
    const focusedRoute = React.useMemo(
        () => resolveQualifiedConnectedAccountSettingsRoute(params, connectedServicesRegistry.entries),
        [connectedServicesRegistry.entries, params],
    );
    const focusedServicePluginId = focusedRoute?.service.pluginId ?? '';
    const headerTitle = focusedRoute?.focus?.kind === 'group'
        ? t('connectedServices.detail.groupDetail.routeTitle')
        : resolveProjectedLocalizedText(
            focusedRoute?.entry.projectedTitle,
            (value) => focusedServicePluginId ? localizePluginText(focusedServicePluginId, value) : '',
        ) || t('settings.connectedServices');
    const navigation = useNavigation();
    React.useLayoutEffect(() => {
        // Every screen of this route is an entity page whose `PageHeader` names the service,
        // account or pool (`alwaysShowTitle`), so the native header keeps an empty title: one
        // title on phones. `useNavigation` returns null outside a navigator (previews, tests).
        if (!navigation) return;
        navigation.setOptions({ headerTitle: '' });
    }, [navigation]);

    if (focusedRoute && focusedRoute.focus === null) {
        return <Redirect href={buildConnectedAccountSettingsRoute(
            focusedRoute.service,
            null,
            { add: readConnectedAccountAddRequest(params) },
        )} />;
    }

    if (targetSelection.selectedTarget && !targetSelection.selectedTargetServerMatchesActiveAccount) {
        return (
            <ItemList>
                <SettingsPageHeader
                    title={headerTitle}
                    alwaysShowTitle
                    actions={(
                        <MachineAdministrationTargetSelector
                            selection={targetSelection}
                            presentation="chip"
                            testIDPrefix="connected-account-target"
                        />
                    )}
                />
                <ItemGroup>
                    <Item
                        testID="connected-account-account-scope-mismatch"
                        mode="info"
                        title={t('connectedServices.accountScopeMismatchTitle')}
                        subtitle={t('connectedServices.accountScopeMismatchDescription')}
                        showChevron={false}
                    />
                </ItemGroup>
            </ItemList>
        );
    }

    return (
        <ConnectedAccountServiceController
            key={controllerKey}
            params={params}
            connectedServicesRegistry={connectedServicesRegistry}
            activeServer={activeServer}
            targetSelection={targetSelection}
            executionTarget={executionTarget}
            localizePluginText={localizePluginText}
            navigation={navigation}
        />
    );
}

/**
 * The sign-in for one service hosted in a setup panel (the in-place Connect panel on Connected
 * services and Home, the account's "Sign in again", and their modal twin). It is the same controller
 * as the service page — same commands, forms, recovery and pending-attempt resume — presenting only
 * the way to sign in and the running flow. The panel owns the machine choice (`targetSelection`).
 */
export function ConnectedAccountSetupController(props: Readonly<{
    service: Readonly<{ pluginId: string; localId: string }>;
    panel: ConnectedAccountSetupPanelIntent;
    targetSelection: MachineAdministrationTargetSelectionV1;
}>) {
    const localizePluginText = useProjectedPluginLocalizedTextResolver();
    const connectedServicesRegistry = useProjectedConnectedServicesRegistry();
    const activeServer = useActiveServerSnapshot();
    const activeAccountScope = useActiveServerAccountScope();
    const navigation = useNavigation();
    const executionTarget = props.targetSelection.resolveExecutionTarget();
    const params = React.useMemo(
        () => ({ pluginId: props.service.pluginId, localId: props.service.localId }),
        [props.service.localId, props.service.pluginId],
    );
    const intentKey = props.panel.intent.kind === 'reconnect' ? `reconnect:${props.panel.intent.accountId}` : 'add';
    // A new machine, account scope or intent is a new sign-in: the controller starts over.
    const controllerKey = [
        activeAccountScope ? serverAccountScopeKeySuffix(activeAccountScope) : 'no-active-account',
        String(activeServer.generation ?? ''),
        executionTarget?.target.serverIdentityId ?? '',
        executionTarget?.target.machineId ?? '',
        executionTarget?.serverId ?? '',
        props.service.pluginId,
        props.service.localId,
        intentKey,
    ].join('\u0000');
    return (
        <ConnectedAccountServiceController
            key={controllerKey}
            params={params as ReturnType<typeof useLocalSearchParams>}
            connectedServicesRegistry={connectedServicesRegistry}
            activeServer={activeServer}
            targetSelection={props.targetSelection}
            executionTarget={executionTarget}
            localizePluginText={localizePluginText}
            navigation={navigation}
            panel={props.panel}
        />
    );
}
