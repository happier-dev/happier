import * as React from 'react';
import { getRandomBytes } from 'expo-crypto';
import {
    arePluginMachineExecutionOriginsEqual,
    arePluginMachineMaterializationRefsEqual,
    PluginWebhookDeliveryMovePendingResultV1Schema,
    PluginWebhookEndpointCredentialConfigureResultV1Schema,
    PluginWebhookEndpointCredentialFinishRotationResultV1Schema,
    PluginWebhookEndpointCredentialRotateResultV1Schema,
    PluginWebhookEndpointRetargetResultV1Schema,
    PluginWebhookEndpointRevokeResultV1Schema,
    type PluginMachineMaterializationV1,
    type PluginMachineMaterializationRefV1,
} from '@happier-dev/protocol';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { Modal } from '@/modal';
import {
    createPluginWebhookAdministrationHttpClient,
    type PluginWebhookAdministrationHttpClient,
} from '@/sync/api/plugins/webhooks/endpointActions';
import { usePluginMachineExecutionOriginSelection } from '@/sync/domains/machines/administration/usePluginExecutionOriginSelection';
import {
    composePluginMachineExecutionOriginV1,
    type PluginMachineReleaseClassificationV1,
} from '@/sync/domains/machines/administration/pluginExecutionOrigin';
import { useActivePluginAccountAvailabilityReleaseClassifier } from '@/sync/domains/plugins/availability/projection';
import { createFrontDoorUiActionExecutor } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { t } from '@/text';

type AccountStatus = Awaited<ReturnType<PluginWebhookAdministrationHttpClient['readStatus']>>;
type EndpointStatus = AccountStatus['endpoints'][number];
type DeadLetterStatus = AccountStatus['deadLetters'][number];
type ReleaseClassifier = (materialization: PluginMachineMaterializationV1) => PluginMachineReleaseClassificationV1;

function describeAutomationAdmissionUnresolved(delivery: DeadLetterStatus): Readonly<{
    totalCount: number;
    sample: string;
    omittedCount: number;
}> | null {
    const unresolved = delivery.automationAdmissionUnresolved;
    if (!unresolved) return null;
    const sampleEntries = unresolved.entries.slice(0, 5);
    return {
        totalCount: unresolved.totalCount,
        sample: sampleEntries.map(({ automationId, status }) => (
            `${automationId} (${status.kind}:${status.reason})`
        )).join(', '),
        // The UI deliberately retains only a five-item diagnostic sample. This
        // count includes both protocol-prefix omissions and UI-only truncation.
        omittedCount: unresolved.totalCount - sampleEntries.length,
    };
}

function createOperationIdempotencyKey(): string {
    return Array.from(getRandomBytes(16))
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('');
}

function describeEndpoint(endpoint: EndpointStatus): string {
    return t('settingsPlugins.webhookAdministration.endpointSubtitle', {
        readiness: endpoint.readiness,
        routing: endpoint.routing,
        sourceInstanceId: endpoint.sourceInstanceId,
    });
}

function describeTarget(endpoint: EndpointStatus): string {
    return t('settingsPlugins.webhookAdministration.targetSubtitle', {
        machineId: endpoint.targetMaterialization.machineId,
        materializationId: endpoint.targetMaterialization.materializationId,
        status: endpoint.targetStatus,
    });
}

function describeQueue(endpoint: EndpointStatus): string {
    return t('settingsPlugins.webhookAdministration.queueSubtitle', endpoint.queue);
}

const WebhookEndpointSection = React.memo(function WebhookEndpointSection(props: Readonly<{
    endpoint: EndpointStatus;
    client: PluginWebhookAdministrationHttpClient;
    classifyRelease: ReleaseClassifier;
    refresh: () => Promise<void>;
}>) {
    const { endpoint } = props;
    const selection = usePluginMachineExecutionOriginSelection({
        pluginId: endpoint.contribution.pluginId,
        classifyRelease: props.classifyRelease,
    });
    const operationKeys = React.useRef(new Map<string, string>());
    const [busyAction, setBusyAction] = React.useState<string | null>(null);
    const [recentPreviousCredentialVersionId, setRecentPreviousCredentialVersionId] = React.useState<string | null>(null);
    const previousCredentialVersionId = recentPreviousCredentialVersionId
        ?? endpoint.credentialRotation?.previousCredentialVersionId
        ?? null;

    const stableOperationKey = React.useCallback((operation: string): string => {
        const existing = operationKeys.current.get(operation);
        if (existing) return existing;
        const created = createOperationIdempotencyKey();
        operationKeys.current.set(operation, created);
        return created;
    }, []);

    const movePendingDeliveries = React.useCallback(async (params: Readonly<{
        endpointRevision: number;
        previousTargetMaterialization: PluginMachineMaterializationRefV1;
        targetMaterialization: PluginMachineMaterializationRefV1;
    }>): Promise<void> => {
        let cursor: string | undefined;
        do {
            const moved = PluginWebhookDeliveryMovePendingResultV1Schema.parse(await props.client.executeAction(
                'plugin.webhook.delivery.movePending',
                {
                    webhookEndpointId: endpoint.webhookEndpointId,
                    endpointRevision: params.endpointRevision,
                    previousTargetMaterialization: params.previousTargetMaterialization,
                    targetMaterialization: params.targetMaterialization,
                    ...(cursor ? { cursor } : {}),
                    pageSize: 500,
                },
            ));
            if ('kind' in moved) throw new Error(moved.kind);
            cursor = moved.nextCursor ?? undefined;
            if (moved.done) break;
        } while (cursor);
    }, [endpoint.webhookEndpointId, props.client]);

    const revoke = React.useCallback(async () => {
        if (!await Modal.confirm(
            t('settingsPlugins.webhookAdministration.revokeTitle'),
            t('settingsPlugins.webhookAdministration.revokeBody'),
            { confirmText: t('common.remove'), cancelText: t('common.cancel'), destructive: true },
        )) return;
        setBusyAction('revoke');
        const operation = `revoke:${endpoint.revision}`;
        try {
            PluginWebhookEndpointRevokeResultV1Schema.parse(await props.client.executeAction(
                'plugin.webhook.endpoint.revoke',
                {
                    webhookEndpointId: endpoint.webhookEndpointId,
                    expectedRevision: endpoint.revision,
                    idempotencyKey: stableOperationKey(operation),
                },
            ));
            operationKeys.current.delete(operation);
            await props.refresh();
        } catch {
            await Modal.alertAsync(t('common.error'), t('settingsPlugins.webhookAdministration.operationFailed'));
        } finally {
            setBusyAction(null);
        }
    }, [endpoint.revision, endpoint.webhookEndpointId, props, stableOperationKey]);

    const retarget = React.useCallback(async () => {
        const fresh = selection.resolveExecutionOrigin();
        if (!fresh) {
            await Modal.alertAsync(
                t('common.unavailable'),
                t('settingsPlugins.webhookAdministration.retargetUnavailable'),
            );
            return;
        }
        const target = fresh.origin.materializationRef;
        if (
            arePluginMachineMaterializationRefsEqual(target, endpoint.targetMaterialization)
        ) return;
        setBusyAction('retarget');
        const operation = `retarget:${endpoint.revision}:${target.machineId}:${target.materializationId}`;
        try {
            const result = PluginWebhookEndpointRetargetResultV1Schema.parse(await props.client.executeAction(
                'plugin.webhook.endpoint.retarget',
                {
                    webhookEndpointId: endpoint.webhookEndpointId,
                    expectedRevision: endpoint.revision,
                    targetMaterialization: target,
                    idempotencyKey: stableOperationKey(operation),
                },
            ));
            if (result.kind !== 'retargeted' && result.kind !== 'alreadyRetargeted') {
                throw new Error(result.kind);
            }
            operationKeys.current.delete(operation);
            const movePending = await Modal.confirm(
                t('settingsPlugins.webhookAdministration.movePendingTitle'),
                t('settingsPlugins.webhookAdministration.movePendingBody'),
                { confirmText: t('common.continue'), cancelText: t('common.cancel') },
            );
            if (movePending) {
                await movePendingDeliveries({
                    endpointRevision: result.revision,
                    previousTargetMaterialization: result.previousTargetMaterialization,
                    targetMaterialization: result.targetMaterialization,
                });
            }
            await props.refresh();
        } catch {
            await props.refresh().catch(() => undefined);
            await Modal.alertAsync(t('common.error'), t('settingsPlugins.webhookAdministration.operationFailed'));
        } finally {
            setBusyAction(null);
        }
    }, [endpoint, movePendingDeliveries, props, selection, stableOperationKey]);

    const resumePendingMove = React.useCallback(async () => {
        if (!endpoint.pendingTargetTransfer) return;
        setBusyAction('movePending');
        try {
            await movePendingDeliveries({
                endpointRevision: endpoint.revision,
                previousTargetMaterialization: endpoint.pendingTargetTransfer.previousTargetMaterialization,
                targetMaterialization: endpoint.targetMaterialization,
            });
            await props.refresh();
        } catch {
            await props.refresh().catch(() => undefined);
            await Modal.alertAsync(t('common.error'), t('settingsPlugins.webhookAdministration.operationFailed'));
        } finally {
            setBusyAction(null);
        }
    }, [endpoint, movePendingDeliveries, props]);

    const configureCredential = React.useCallback(async () => {
        setBusyAction('configure');
        try {
            const result = PluginWebhookEndpointCredentialConfigureResultV1Schema.parse(
                await props.client.executeAction('plugin.webhook.endpoint.credential.configure', {
                    webhookEndpointId: endpoint.webhookEndpointId,
                    expectedRevision: endpoint.revision,
                }),
            );
            if (result.oneTimeGeneratedSecret) {
                await Modal.alertAsync(
                    t('settingsPlugins.webhookAdministration.credentialSecretTitle'),
                    t('settingsPlugins.webhookAdministration.credentialSecretBody', {
                        secret: result.oneTimeGeneratedSecret,
                    }),
                );
            }
            await props.refresh();
        } catch {
            await Modal.alertAsync(t('common.error'), t('settingsPlugins.webhookAdministration.operationFailed'));
        } finally {
            setBusyAction(null);
        }
    }, [endpoint.revision, endpoint.webhookEndpointId, props]);

    const rotateCredential = React.useCallback(async () => {
        setBusyAction('rotate');
        try {
            const result = PluginWebhookEndpointCredentialRotateResultV1Schema.parse(await props.client.executeAction(
                'plugin.webhook.endpoint.credential.rotate',
                { webhookEndpointId: endpoint.webhookEndpointId, expectedRevision: endpoint.revision },
            ));
            setRecentPreviousCredentialVersionId(result.previousCredentialVersionId);
            if (result.oneTimeGeneratedSecret) {
                await Modal.alertAsync(
                    t('settingsPlugins.webhookAdministration.credentialSecretTitle'),
                    t('settingsPlugins.webhookAdministration.credentialSecretBody', {
                        secret: result.oneTimeGeneratedSecret,
                    }),
                );
            }
            await props.refresh();
        } catch {
            await Modal.alertAsync(t('common.error'), t('settingsPlugins.webhookAdministration.operationFailed'));
        } finally {
            setBusyAction(null);
        }
    }, [endpoint.revision, endpoint.webhookEndpointId, props]);

    const finishCredentialRotation = React.useCallback(async () => {
        if (!previousCredentialVersionId) return;
        setBusyAction('finishRotation');
        try {
            const result = PluginWebhookEndpointCredentialFinishRotationResultV1Schema.parse(
                await props.client.executeAction('plugin.webhook.endpoint.credential.finishRotation', {
                    webhookEndpointId: endpoint.webhookEndpointId,
                    expectedRevision: endpoint.revision,
                    expectedPreviousCredentialVersionId: previousCredentialVersionId,
                }),
            );
            if (result.kind !== 'retired' && result.kind !== 'alreadyRetired') throw new Error(result.kind);
            setRecentPreviousCredentialVersionId(null);
            await props.refresh();
        } catch {
            await Modal.alertAsync(t('common.error'), t('settingsPlugins.webhookAdministration.operationFailed'));
        } finally {
            setBusyAction(null);
        }
    }, [endpoint.revision, endpoint.webhookEndpointId, previousCredentialVersionId, props]);

    const selectedTarget = selection.state.kind === 'selected'
        ? selection.state.origin.materializationRef
        : null;
    const selectedTargetIsCurrent = selectedTarget !== null
        && arePluginMachineMaterializationRefsEqual(selectedTarget, endpoint.targetMaterialization);
    const selectableOrigins = selection.candidates.filter((candidate) => (
        candidate.validation.kind === 'admitted'
        && candidate.releaseContent === 'matched'
        && candidate.materialization.portableRelease
    ));

    return (
        <ItemGroup
            title={`${endpoint.contribution.pluginId} / ${endpoint.contribution.localId}`}
            footer={describeQueue(endpoint)}
        >
            <Item
                testID={`settings.plugins.webhooks.endpoint.${endpoint.webhookEndpointId}.status`}
                title={describeEndpoint(endpoint)}
                subtitle={describeTarget(endpoint)}
                detail={`${endpoint.webhookEndpointId} · ${endpoint.sourceInstanceId}`}
                mode="info"
                showChevron={false}
            />
            <Item
                testID={`settings.plugins.webhooks.endpoint.${endpoint.webhookEndpointId}.copyUrl`}
                title={t('settingsPlugins.webhookAdministration.copyUrl')}
                subtitle={endpoint.publicUrl}
                copy={endpoint.publicUrl}
                showChevron={false}
            />
            {selectableOrigins.length > 1 ? selectableOrigins.map((candidate) => {
                const origin = composePluginMachineExecutionOriginV1(candidate.materialization);
                const selected = selection.selectedOrigin !== null
                    && arePluginMachineExecutionOriginsEqual(selection.selectedOrigin, origin);
                return (
                    <Item
                        key={`${origin.serverIdentityId}:${origin.materializationRef.machineId}:${origin.materializationRef.materializationId}`}
                        title={t('settingsPlugins.webhookAdministration.selectTarget')}
                        subtitle={`${origin.materializationRef.machineId} / ${origin.materializationRef.materializationId}`}
                        selected={selected}
                        onPress={() => selection.selectOrigin(origin)}
                        showChevron={false}
                    />
                );
            }) : null}
            <Item
                testID={`settings.plugins.webhooks.endpoint.${endpoint.webhookEndpointId}.retarget`}
                title={t('settingsPlugins.webhookAdministration.retarget')}
                subtitle={selection.state.kind === 'selected'
                    ? t('settingsPlugins.webhookAdministration.originSelected')
                    : t('settingsPlugins.webhookAdministration.originUnavailable')}
                onPress={() => { void retarget(); }}
                disabled={!selection.canExecute || selectedTargetIsCurrent}
                loading={busyAction === 'retarget'}
                showChevron={false}
            />
            {endpoint.pendingTargetTransfer ? (
                <Item
                    testID={`settings.plugins.webhooks.endpoint.${endpoint.webhookEndpointId}.movePending`}
                    title={t('settingsPlugins.webhookAdministration.resumePendingMove')}
                    subtitle={t('settingsPlugins.webhookAdministration.resumePendingMoveSubtitle', {
                        count: endpoint.pendingTargetTransfer.eligibleDeliveryCount,
                    })}
                    onPress={() => { void resumePendingMove(); }}
                    disabled={busyAction !== null}
                    loading={busyAction === 'movePending'}
                    showChevron={false}
                />
            ) : null}
            {endpoint.routing === 'accountEndpoint' ? (
                <Item
                    testID={`settings.plugins.webhooks.endpoint.${endpoint.webhookEndpointId}.configureCredential`}
                    title={t('settingsPlugins.webhookAdministration.configureCredential')}
                    onPress={() => { void configureCredential(); }}
                    loading={busyAction === 'configure'}
                    disabled={busyAction !== null}
                    showChevron={false}
                />
            ) : null}
            {endpoint.routing === 'accountEndpoint' ? (
                <Item
                    testID={`settings.plugins.webhooks.endpoint.${endpoint.webhookEndpointId}.rotateCredential`}
                    title={t('settingsPlugins.webhookAdministration.rotateCredential')}
                    onPress={() => { void rotateCredential(); }}
                    loading={busyAction === 'rotate'}
                    disabled={busyAction !== null}
                    showChevron={false}
                />
            ) : null}
            {endpoint.routing === 'accountEndpoint' && previousCredentialVersionId ? (
                <Item
                    testID={`settings.plugins.webhooks.endpoint.${endpoint.webhookEndpointId}.finishRotation`}
                    title={t('settingsPlugins.webhookAdministration.finishRotation')}
                    subtitle={t('settingsPlugins.webhookAdministration.finishRotationSubtitle')}
                    onPress={() => { void finishCredentialRotation(); }}
                    loading={busyAction === 'finishRotation'}
                    disabled={busyAction !== null}
                    showChevron={false}
                />
            ) : null}
            <Item
                testID={`settings.plugins.webhooks.endpoint.${endpoint.webhookEndpointId}.revoke`}
                title={t('settingsPlugins.webhookAdministration.revoke')}
                onPress={() => { void revoke(); }}
                loading={busyAction === 'revoke'}
                disabled={busyAction !== null || endpoint.revokedAt !== undefined}
                destructive
                showChevron={false}
            />
        </ItemGroup>
    );
});

const WebhookDeadLetterSection = React.memo(function WebhookDeadLetterSection(props: Readonly<{
    delivery: DeadLetterStatus;
    client: PluginWebhookAdministrationHttpClient;
    refresh: () => Promise<void>;
}>) {
    const [busy, setBusy] = React.useState<'replay' | 'discard' | null>(null);
    const unresolved = describeAutomationAdmissionUnresolved(props.delivery);
    const replay = React.useCallback(async () => {
        setBusy('replay');
        try {
            const result = await props.client.replayDelivery({
                deliveryId: props.delivery.deliveryId,
                expectedRevision: props.delivery.revision,
            });
            if (result.kind !== 'requeued') throw new Error(result.kind);
            await props.refresh();
        } catch {
            await Modal.alertAsync(t('common.error'), t('settingsPlugins.webhookAdministration.operationFailed'));
        } finally {
            setBusy(null);
        }
    }, [props]);
    const discard = React.useCallback(async () => {
        if (!await Modal.confirm(
            t('settingsPlugins.webhookAdministration.discardTitle'),
            t('settingsPlugins.webhookAdministration.discardBody'),
            { confirmText: t('common.discard'), cancelText: t('common.cancel'), destructive: true },
        )) return;
        setBusy('discard');
        try {
            const result = await props.client.discardDelivery({
                deliveryId: props.delivery.deliveryId,
                expectedRevision: props.delivery.revision,
            });
            if (result.kind !== 'discarded') throw new Error(result.kind);
            await props.refresh();
        } catch {
            await Modal.alertAsync(t('common.error'), t('settingsPlugins.webhookAdministration.operationFailed'));
        } finally {
            setBusy(null);
        }
    }, [props]);

    return (
        <ItemGroup title={t('settingsPlugins.webhookAdministration.deliveryTitle', {
            digest: props.delivery.deliveryIdentityDigestPrefix,
        })}>
            <Item
                title={t('settingsPlugins.webhookAdministration.deliveryStatus')}
                subtitle={t('settingsPlugins.webhookAdministration.deliverySubtitle', {
                    errorCode: props.delivery.errorCode ?? t('common.unavailable'),
                    attempts: props.delivery.attemptCount,
                    replays: props.delivery.replayCount,
                    machineId: props.delivery.targetMaterialization.machineId,
                    materializationId: props.delivery.targetMaterialization.materializationId,
                })}
                detail={props.delivery.deliveryIdentityDigestPrefix}
                mode="info"
                showChevron={false}
            />
            {unresolved ? (
                <Item
                    testID={`settings.plugins.webhooks.delivery.${props.delivery.deliveryId}.automationAdmissionUnresolved`}
                    title={t('settingsPlugins.webhookAdministration.unresolvedAutomationAdmissionTitle', {
                        totalCount: unresolved.totalCount,
                    })}
                    subtitle={t('settingsPlugins.webhookAdministration.unresolvedAutomationAdmissionSubtitle', {
                        sample: unresolved.sample,
                        omittedCount: unresolved.omittedCount,
                    })}
                    mode="info"
                    showChevron={false}
                />
            ) : null}
            <Item
                testID={`settings.plugins.webhooks.delivery.${props.delivery.deliveryId}.replay`}
                title={t('settingsPlugins.webhookAdministration.replay')}
                onPress={() => { void replay(); }}
                loading={busy === 'replay'}
                disabled={busy !== null}
                showChevron={false}
            />
            <Item
                testID={`settings.plugins.webhooks.delivery.${props.delivery.deliveryId}.discard`}
                title={t('common.discard')}
                onPress={() => { void discard(); }}
                loading={busy === 'discard'}
                disabled={busy !== null}
                destructive
                showChevron={false}
            />
        </ItemGroup>
    );
});

export const PluginWebhookAdministrationScreen = React.memo(function PluginWebhookAdministrationScreen(props: Readonly<{
    client?: PluginWebhookAdministrationHttpClient;
}>) {
    const executeAction = React.useMemo(() => createFrontDoorUiActionExecutor(), []);
    const client = React.useMemo(
        () => props.client ?? createPluginWebhookAdministrationHttpClient({ executeAction }),
        [executeAction, props.client],
    );
    // The administration API this screen reads is behind the same server
    // feature as public ingress, so an unavailable server has nothing to
    // administer and the read would only surface as a load failure.
    const webhooksAvailable = useFeatureEnabled('plugins.webhooks');
    const classifyRelease = useActivePluginAccountAvailabilityReleaseClassifier();
    const [status, setStatus] = React.useState<AccountStatus | null>(null);
    const [loading, setLoading] = React.useState(true);
    const [error, setError] = React.useState(false);
    const refresh = React.useCallback(async () => {
        setLoading(true);
        try {
            const first = await client.readStatus({ pageSize: 100, deadLetterPageSize: 100 });
            const endpoints = [...first.endpoints];
            let cursor = first.nextEndpointCursor;
            while (cursor) {
                const next = await client.readStatus({
                    endpointCursor: cursor,
                    pageSize: 100,
                    deadLetterPageSize: 0,
                });
                endpoints.push(...next.endpoints);
                cursor = next.nextEndpointCursor;
            }
            setStatus({ ...first, endpoints, nextEndpointCursor: null });
            setError(false);
        } catch {
            setError(true);
        } finally {
            setLoading(false);
        }
    }, [client]);

    React.useEffect(() => {
        if (!webhooksAvailable) return;
        void refresh();
    }, [refresh, webhooksAvailable]);

    if (!webhooksAvailable) {
        return (
            <ItemList style={{ paddingTop: 0 }} testID="settings.plugins.webhooks.screen">
                <ItemGroup title={t('settingsPlugins.webhookAdministration.title')}>
                    <Item
                        testID="settings.plugins.webhooks.unavailable"
                        title={t('settingsPlugins.webhookAdministration.unavailableTitle')}
                        subtitle={t('settingsPlugins.webhookAdministration.unavailableSubtitle')}
                        mode="info"
                        showChevron={false}
                    />
                </ItemGroup>
            </ItemList>
        );
    }

    return (
        <ItemList style={{ paddingTop: 0 }} testID="settings.plugins.webhooks.screen">
            <ItemGroup
                title={t('settingsPlugins.webhookAdministration.title')}
                footer={t('settingsPlugins.webhookAdministration.footer')}
            >
                <Item
                    testID="settings.plugins.webhooks.refresh"
                    title={t('common.refresh')}
                    subtitle={loading
                        ? t('common.loading')
                        : error
                            ? t('settingsPlugins.webhookAdministration.loadError')
                            : undefined}
                    onPress={() => { void refresh(); }}
                    loading={loading}
                    showChevron={false}
                />
            </ItemGroup>
            {!loading && !error && status?.endpoints.length === 0 ? (
                <ItemGroup title={t('settingsPlugins.webhookAdministration.endpointsTitle')}>
                    <Item
                        title={t('settingsPlugins.webhookAdministration.emptyTitle')}
                        subtitle={t('settingsPlugins.webhookAdministration.emptySubtitle')}
                        mode="info"
                        showChevron={false}
                    />
                </ItemGroup>
            ) : null}
            {status?.endpoints.map((endpoint) => (
                <WebhookEndpointSection
                    key={endpoint.webhookEndpointId}
                    endpoint={endpoint}
                    client={client}
                    classifyRelease={classifyRelease}
                    refresh={refresh}
                />
            ))}
            {status?.deadLetters.length ? status.deadLetters.map((delivery) => (
                <WebhookDeadLetterSection
                    key={delivery.deliveryId}
                    delivery={delivery}
                    client={client}
                    refresh={refresh}
                />
            )) : null}
        </ItemList>
    );
});
