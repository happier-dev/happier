import * as React from 'react';
import { useLocalSearchParams, useNavigation } from 'expo-router';

import type {
    BuiltInLegacyConnectedAccountOperation,
    ConnectedAccountPeerOperationTransport,
    PluginConnectedAccountAuthenticationModeV2,
    QualifiedConnectedAccountRef,
} from '@happier-dev/protocol';
import {
    BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY_BY_SERVICE_ID,
    ConnectedServiceIdSchema,
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
import { Modal } from '@/modal';
import { t } from '@/text';
import { resolveQualifiedConnectedAccountSettingsRoute } from '@/sync/domains/connectedServices/connectedAccountSettingsRoute';
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
    resolveQualifiedConnectedAccountDefaultId,
    resolveQualifiedConnectedAccountLabel,
    updateQualifiedConnectedAccountDefaultId,
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
    useSettings,
} from '@/sync/store/hooks';
import { useApplySettings } from '@/sync/store/settingsWriters';
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
    const settings = useSettings();
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
            params.serverId,
            params.machineId,
        ],
    );
    const serverId = executionTarget?.serverId ?? '';
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
    const [configuration, setConfiguration] = React.useState<ConfigurationDescription | null>(null);
    const [
        configurationContinuationAttemptId,
        setConfigurationContinuationAttemptId,
    ] = React.useState<string | null>(null);
    const [pendingIntent, setPendingIntent] = React.useState<PendingIntent | null>(null);
    const [activeModeId, setActiveModeId] = React.useState<string | null>(null);
    const [busy, setBusy] = React.useState(false);
    const [errorCode, setErrorCode] = React.useState<string | null>(null);
    const [retryingDescription, setRetryingDescription] = React.useState(false);
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
                            && configurationResult.generation
                                === result.generation
                            && configurationResult.immutableGenerationId
                                === result.immutableGenerationId;
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


    const readConfiguration = React.useCallback(async (
        target: ConnectedAccountConfigurationTarget,
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

    const acceptAttemptResponse = React.useCallback(async (
        response: ConnectedAccountAttemptResponse,
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
        setAttempt(response);
        if (isTerminalAttempt(response)) {
            setPendingIntent(null);
            setConfigurationContinuationAttemptId(null);
        }
        if (response.status === 'configurationRequired') {
            setConfigurationContinuationAttemptId(
                response.attemptId ?? null,
            );
            await readConfiguration(response.target);
            return;
        }
        if (response.status === 'connected') {
            setAttempt(null);
            setConfiguration(null);
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
    }, [isControllerCurrent, readConfiguration, refreshDescription]);

    const retryDescription = React.useCallback(async () => {
        if (!isControllerCurrent() || retryingDescription) return;
        setRetryingDescription(true);
        try {
            // An effectful authentication command can settle in the daemon after
            // its reply is lost. The daemon owns the attempt outcome, so this
            // user-driven recovery performs exactly one exact read of that
            // attempt instead of resubmitting the command or polling; anything
            // else falls back to refreshing the surrounding description.
            const recoverableAttemptId = attempt && 'attemptId' in attempt
                ? attempt.attemptId
                : null;
            if (recoverableAttemptId && serverId && machineId) {
                const response = await runConnectedAccountAuthenticationCommand({
                    serverId,
                    machineId,
                    ...(expectedActiveServer ? { expectedActiveServer } : {}),
                    command: { operation: 'read', attemptId: recoverableAttemptId },
                    signal: lifecycleSignal,
                });
                if (!isControllerCurrent()) return;
                // Only a materially advanced phase or a terminal outcome resolves the
                // lost reply. An unchanged non-terminal read proves nothing, so
                // clearing the error there would re-enable the same effectful action
                // and let the user submit it twice.
                await acceptAttemptResponse(response, {
                    retainUnresolvedError: !isTerminalAttempt(response)
                        && attempt !== null
                        && response.status === attempt.status,
                });
                return;
            }
            await refreshDescription();
        } catch {
            if (isControllerCurrent()) {
                setErrorCode('connected_account_daemon_unavailable');
            }
        } finally {
            if (isControllerCurrent()) setRetryingDescription(false);
        }
    }, [
        acceptAttemptResponse,
        attempt,
        expectedActiveServer,
        isControllerCurrent,
        lifecycleSignal,
        machineId,
        refreshDescription,
        retryingDescription,
        serverId,
    ]);

    const runAuthentication = React.useCallback(async (
        command: Parameters<typeof runConnectedAccountAuthenticationCommand>[0]['command'],
    ): Promise<boolean> => {
        if (!isControllerCurrent() || !serverId || !machineId) return false;
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
            await acceptAttemptResponse(response);
            return isControllerCurrent();
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

    const activeMode: PluginConnectedAccountAuthenticationModeV2 | null =
        description?.descriptor.authentication.modes.find(
            (candidate) => candidate.id === activeModeId,
        ) ?? null;
    const activeModeKind = activeMode?.kind ?? null;

    React.useEffect(() => {
        if (!attempt || busy) return;
        const attemptId = 'attemptId' in attempt ? attempt.attemptId : undefined;
        if (!attemptId) return;
        if (attempt.status !== 'starting' && attempt.status !== 'pending') return;
        if (attempt.status === 'pending' && activeModeKind === null) return;
        const delayMs = attempt.status === 'pending'
            ? Math.max(250, attempt.retryAfterMs)
            : 250;
        const timeout = setTimeout(() => {
            void runAuthentication(
                attempt.status === 'pending'
                    ? {
                        operation: activeModeKind === 'oauthDeviceCode'
                            ? 'pollDevice'
                            : 'reconcile',
                        attemptId,
                    }
                    : { operation: 'read', attemptId },
            );
        }, delayMs);
        return () => clearTimeout(timeout);
    }, [activeModeKind, attempt, busy, runAuthentication]);

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
                applySettings(pruneQualifiedConnectedAccountPreferences({
                    service: account.service,
                    legacyServiceId,
                    accountId: account.accountId,
                    defaultAccountByServiceKey:
                        settings.connectedServicesDefaultProfileByServiceId,
                    labelsByKey:
                        settings.connectedServicesProfileLabelByKey,
                }));
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
        machineId,
        refreshDescription,
        legacyServiceId,
        serverId,
        serviceId,
        settings.connectedServicesDefaultProfileByServiceId,
        settings.connectedServicesProfileLabelByKey,
    ]);

    if (!exactRoute || !service) {
        return (
            <ItemList>
                <ItemGroup title={t('connectedServices.title')}>
                    <Item
                        title={t('connectedServices.detail.unknownService')}
                        mode="info"
                        showChevron={false}
                    />
                </ItemGroup>
            </ItemList>
        );
    }

    if (!serverId || !machineId) {
        return (
            <ItemList>
                <MachineAdministrationTargetSelector
                    selection={targetSelection}
                    testIDPrefix="connected-account-target"
                />
                <ItemGroup
                    title={resolveProjectedLocalizedText(registryEntry?.projectedTitle, localizeServiceText)
                        || serviceId
                        || t('connectedServices.title')}
                >
                    <Item
                        title={t('common.unavailable')}
                        mode="info"
                        showChevron={false}
                    />
                </ItemGroup>
            </ItemList>
        );
    }

    const title = resolveProjectedLocalizedText(description?.descriptor.title, localizeServiceText)
        || resolveProjectedLocalizedText(registryEntry?.projectedTitle, localizeServiceText)
        || serviceId;
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
    const connectedAccountIds = visibleAccounts
        .filter((account) => (
            account.ref.service.pluginId === service.pluginId
            && account.ref.service.localId === service.localId
        ))
        .map((account) => account.ref.accountId);
    const defaultAccountId = resolveQualifiedConnectedAccountDefaultId({
        service,
        legacyServiceId,
        connectedAccountIds,
        defaultAccountByServiceKey:
            settings.connectedServicesDefaultProfileByServiceId,
    });
    const accountLabels = Object.fromEntries(
        connectedAccountIds.map((accountId) => [
            accountId,
            resolveQualifiedConnectedAccountLabel({
                labelsByKey: settings.connectedServicesProfileLabelByKey,
                service,
                legacyServiceId,
                accountId,
            }) ?? undefined,
        ]),
    );

    const editAccountLabel = async (account: QualifiedConnectedAccountRef) => {
        const current = accountLabels[account.accountId] ?? '';
        const result = await Modal.prompt(
            t('connectedServices.detail.actions.editLabel'),
            t('connectedServices.detail.actions.editLabel'),
            {
                defaultValue: current,
                confirmText: t('common.save'),
                cancelText: t('common.cancel'),
            },
        );
        if (
            typeof result !== 'string'
            || !isControllerCurrent()
        ) return;
        applySettings({
            connectedServicesProfileLabelByKey:
                updateQualifiedConnectedAccountLabel({
                    service,
                    legacyServiceId,
                    accountId: account.accountId,
                    label: result,
                    labelsByKey:
                        settings.connectedServicesProfileLabelByKey,
                }),
        });
    };

    const toggleDefaultAccount = (account: QualifiedConnectedAccountRef) => {
        if (!isControllerCurrent()) return;
        applySettings({
            connectedServicesDefaultProfileByServiceId:
                updateQualifiedConnectedAccountDefaultId({
                    service,
                    legacyServiceId,
                    accountId: defaultAccountId === account.accountId
                        ? null
                        : account.accountId,
                    defaultAccountByServiceKey:
                        settings.connectedServicesDefaultProfileByServiceId,
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

    const routeBody = (
        <>
            {description !== null
                && !(route.focus !== null && authenticationFlowActive) ? (
                <ConnectedAccountServiceContent
                    localize={localizeServiceText}
                    title={title}
                    service={service}
                    legacyServiceId={legacyServiceId}
                    legacyPeerClass={peerTransport?.protocol === 'legacy'
                        ? peerTransport.peerClass
                        : null}
                    focus={route.focus}
                    modes={mutationModes}
                    accounts={visibleAccounts}
                    serviceConfigurationStatusByModeId={
                        serviceConfigurationStatusByModeId
                    }
                    accountLabels={accountLabels}
                    defaultAccountId={defaultAccountId}
                    groups={groups}
                    busy={busy}
                    onEditLabel={credentialWriteAllowed ? (account) => {
                        void editAccountLabel(account);
                    } : undefined}
                    onToggleDefault={
                        credentialWriteAllowed
                            ? toggleDefaultAccount
                            : undefined
                    }
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
                    onBeginConnect={credentialWriteAllowed ? (intent) => {
                        void beginIntent({ kind: 'connect', ...intent });
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
                    onRevoke={credentialDeleteAllowed ? (account) => {
                        void revokeAccount(account);
                    } : undefined}
                    onDisconnectAccount={credentialDeleteAllowed ? (account) => (
                        // The account detail screen already confirmed.
                        revokeAccount(account, { alreadyConfirmed: true })
                    ) : undefined}
                />
            ) : null}
            {description === null && !errorCode ? (
                <ItemGroup title={title || t('connectedServices.title')}>
                    <Item
                        title={t('connectedServices.deviceAuth.preparing')}
                        mode="info"
                        showChevron={false}
                    />
                </ItemGroup>
            ) : null}

            {attempt?.status === 'awaitingManual' && activeMode?.kind === 'manual' ? (
                <ConnectedAccountManualForm
                    key={attempt.attemptId}
                    title={resolveProjectedLocalizedText(activeMode.title, localizeServiceText) || title}
                    localize={localizeServiceText}
                    fields={activeMode.fields}
                    submitting={busy}
                    navigation={navigation}
                    onSubmit={({ fields }) => runAuthentication({
                        operation: 'submitManual',
                        attemptId: attempt.attemptId,
                        fields,
                    })}
                />
            ) : null}

            {attempt?.status === 'awaitingOAuth' ? (
                <ConnectedAccountOAuthForm
                    key={attempt.attemptId}
                    authorizationUrl={attempt.authorizationUrl ?? ''}
                    callbackUrl={attempt.callbackUrl}
                    submitting={busy}
                    navigation={navigation}
                    onSubmit={(completion) => runAuthentication({
                        operation: 'completeOAuth',
                        attemptId: attempt.attemptId,
                        completion,
                    })}
                />
            ) : null}

            {attempt?.status === 'awaitingDeviceAuthorization' ? (
                <ConnectedAccountDeviceForm
                    key={attempt.attemptId}
                    verificationUri={attempt.verificationUri}
                    verificationUriComplete={attempt.verificationUriComplete}
                    userCode={attempt.userCode}
                    busy={busy}
                    onPoll={async () => {
                        await runAuthentication({
                            operation: 'pollDevice',
                            attemptId: attempt.attemptId,
                        });
                    }}
                    onResume={async () => {
                        await runAuthentication({
                            operation: 'resumeDevice',
                            attemptId: attempt.attemptId,
                        });
                    }}
                />
            ) : null}

            {configuration && activeMode?.configuration ? (
                <ConnectedAccountConfigurationForm
                    key={`${configuration.generation}:${configuration.configuration.revision ?? 'new'}`}
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
                                );
                                if (!isControllerCurrent()) return false;
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

            {attempt?.status === 'outcomeUnknown' ? (
                <ItemGroup title={t('connectedServices.detail.actionsGroupTitle')}>
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
                </ItemGroup>
            ) : null}

            {errorCode ? (
                <ItemGroup title={t('common.error')}>
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
                </ItemGroup>
            ) : null}

            {(
                pendingIntent
                && attempt
                && (
                    attempt.status === 'reconnectRequired'
                    || attempt.status === 'rejected'
                    || attempt.status === 'unavailable'
                    || attempt.status === 'conflict'
                )
            ) ? (
                <ItemGroup title={t('connectedServices.detail.actionsGroupTitle')}>
                    <Item
                        testID="connected-account:retry"
                        title={t('common.retry')}
                        disabled={busy}
                        onPress={() => {
                            void beginIntent(pendingIntent);
                        }}
                    />
                </ItemGroup>
            ) : null}

            {attemptId && attempt && !isTerminalAttempt(attempt) ? (
                <ItemGroup title={t('connectedServices.detail.actionsGroupTitle')}>
                    <Item
                        testID="connected-account:cancel"
                        title={t('common.cancel')}
                        disabled={busy}
                        onPress={() => {
                            void runAuthentication({ operation: 'cancel', attemptId });
                        }}
                    />
                </ItemGroup>
            ) : null}
        </>
    );

    return focusedScreenOwnsScroll ? routeBody : (
        <ItemList
            keyboardAware={authenticationFlowActive}
            keyboardShouldPersistTaps={authenticationFlowActive ? 'handled' : undefined}
        >
            {route.focus === null ? (
                <MachineAdministrationTargetSelector
                    selection={targetSelection}
                    testIDPrefix="connected-account-target"
                />
            ) : null}
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
        // `useNavigation` returns null when this renders outside a navigator
        // (embedded previews / tests), so the header wiring stays opt-in.
        if (!navigation) return;
        navigation.setOptions({ headerTitle });
    }, [headerTitle, navigation]);

    if (targetSelection.selectedTarget && !targetSelection.selectedTargetServerMatchesActiveAccount) {
        return (
            <ItemList>
                <MachineAdministrationTargetSelector
                    selection={targetSelection}
                    testIDPrefix="connected-account-target"
                />
                <ItemGroup title={t('settings.connectedServices')}>
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
