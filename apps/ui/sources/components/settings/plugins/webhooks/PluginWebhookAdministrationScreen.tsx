import * as React from 'react';
import { getRandomBytes } from 'expo-crypto';
import { isActionApprovalDeclinedErrorCode } from '@happier-dev/protocol/actions/actionExecutionResult';
import { HappyError } from '@/utils/errors/errors';
import { arePluginMachineExecutionOriginsEqual, arePluginMachineMaterializationRefsEqual } from '@happier-dev/protocol/machines/administration/pluginMachineExecutionOriginV1';
import { PluginWebhookDeliveryMovePendingResultV1Schema, PluginWebhookEndpointCredentialConfigureResultV1Schema, PluginWebhookEndpointCredentialFinishRotationResultV1Schema, PluginWebhookEndpointCredentialRotateResultV1Schema, PluginWebhookEndpointRetargetResultV1Schema, PluginWebhookEndpointRevokeResultV1Schema } from '@happier-dev/protocol/plugins/webhooks/endpointV1';
import type { PluginMachineMaterializationV1 } from '@happier-dev/protocol/plugins/availability/v1';
import type { PluginMachineMaterializationRefV1 } from '@happier-dev/protocol/plugins/availability/materializationRefV1';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
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
    type PluginMachineExecutionOriginCandidateV1,
} from '@/sync/domains/machines/administration/pluginExecutionOrigin';
import { useActivePluginAccountAvailabilityReleaseClassifier } from '@/sync/domains/plugins/availability/projection';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { canPublishCatalogReceipt } from '@/sync/store/settings/wholeCatalogReceiptOrdering';
import { t } from '@/text';
import { SettingsPageHeader } from '@/components/settings/shell/SettingsPageHeader';
import { fireAndForget } from '@/utils/system/fireAndForget';

type AccountStatus = Awaited<ReturnType<PluginWebhookAdministrationHttpClient['readStatus']>>;
type EndpointStatus = AccountStatus['endpoints'][number] & Readonly<{
    /** A local observation of an acknowledged revoke, never a fabricated server timestamp. */
    revocationAcknowledged?: true;
}>;
type AccountStatusObservation = Omit<AccountStatus, 'endpoints'> & Readonly<{ endpoints: readonly EndpointStatus[] }>;
type EndpointAcknowledgement = Readonly<{
    revision: number;
    targetMaterialization?: EndpointStatus['targetMaterialization'];
    credentialRotation?: EndpointStatus['credentialRotation'];
    revocationAcknowledged?: true;
}>;
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
    statusCurrent: boolean;
    refresh: () => Promise<void>;
    onAcknowledged: (endpointId: string, acknowledgement: EndpointAcknowledgement) => void;
}>) {
    const { endpoint } = props;
    const selection = usePluginMachineExecutionOriginSelection({
        pluginId: endpoint.contribution.pluginId,
        classifyRelease: props.classifyRelease,
    });
    const operationKeys = React.useRef(new Map<string, string>());
    const [busyAction, setBusyAction] = React.useState<string | null>(null);
    const previousCredentialVersionId = endpoint.credentialRotation?.previousCredentialVersionId ?? null;

    const stableOperationKey = React.useCallback((operation: string): string => {
        const existing = operationKeys.current.get(operation);
        if (existing) return existing;
        const created = createOperationIdempotencyKey();
        operationKeys.current.set(operation, created);
        return created;
    }, []);

    const movePendingDeliveries = React.useCallback(async (params: Readonly<{
        endpointRevision: number;
        targetMaterialization: PluginMachineMaterializationRefV1;
    }>): Promise<void> => {
        let cursor: string | undefined;
        do {
            const moved = PluginWebhookDeliveryMovePendingResultV1Schema.parse(await props.client.executeAction(
                'plugin.webhook.delivery.movePending',
                {
                    webhookEndpointId: endpoint.webhookEndpointId,
                    endpointRevision: params.endpointRevision,
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
        setBusyAction('revoke');
        const operation = `revoke:${endpoint.revision}`;
        try {
            const result = PluginWebhookEndpointRevokeResultV1Schema.parse(await props.client.executeAction(
                'plugin.webhook.endpoint.revoke',
                {
                    webhookEndpointId: endpoint.webhookEndpointId,
                    expectedRevision: endpoint.revision,
                    idempotencyKey: stableOperationKey(operation),
                },
            ));
            operationKeys.current.delete(operation);
            props.onAcknowledged(result.webhookEndpointId, { revision: result.revision, revocationAcknowledged: true });
            fireAndForget(props.refresh());
        } catch (error) {
            if (error instanceof HappyError && isActionApprovalDeclinedErrorCode(error.code)) return;
            await Modal.alertAsync(t('common.error'), t('settingsPlugins.webhookAdministration.operationFailed'));
        } finally {
            setBusyAction(null);
        }
    }, [endpoint.revision, endpoint.webhookEndpointId, props, stableOperationKey]);

    const retarget = React.useCallback(async () => {
        const fresh = selection.resolveExecutionOrigin();
        if (!fresh || !('materializationRef' in fresh.origin)) {
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
            props.onAcknowledged(result.webhookEndpointId, {
                revision: result.revision,
                targetMaterialization: result.targetMaterialization,
            });
            const movePending = await Modal.confirm(
                t('settingsPlugins.webhookAdministration.movePendingTitle'),
                t('settingsPlugins.webhookAdministration.movePendingBody'),
                { confirmText: t('common.continue'), cancelText: t('common.cancel') },
            );
            if (movePending) {
                await movePendingDeliveries({
                    endpointRevision: result.revision,
                    targetMaterialization: result.targetMaterialization,
                });
            }
            fireAndForget(props.refresh());
        } catch (error) {
            if (error instanceof HappyError && isActionApprovalDeclinedErrorCode(error.code)) return;
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
                targetMaterialization: endpoint.targetMaterialization,
            });
            // A completed move acknowledges the operation, not a fresh queue census.
            props.onAcknowledged(endpoint.webhookEndpointId, { revision: endpoint.revision });
            fireAndForget(props.refresh());
        } catch (error) {
            if (error instanceof HappyError && isActionApprovalDeclinedErrorCode(error.code)) return;
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
            props.onAcknowledged(result.webhookEndpointId, { revision: result.revision });
            if (result.oneTimeGeneratedSecret) {
                await Modal.alertAsync(
                    t('settingsPlugins.webhookAdministration.credentialSecretTitle'),
                    t('settingsPlugins.webhookAdministration.credentialSecretBody', {
                        secret: result.oneTimeGeneratedSecret,
                    }),
                );
            }
            fireAndForget(props.refresh());
        } catch (error) {
            if (error instanceof HappyError && isActionApprovalDeclinedErrorCode(error.code)) return;
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
            props.onAcknowledged(result.webhookEndpointId, { revision: result.revision, credentialRotation: {
                previousCredentialVersionId: result.previousCredentialVersionId,
                previousAcceptUntilMs: result.previousAcceptUntilMs,
            } });
            if (result.oneTimeGeneratedSecret) {
                await Modal.alertAsync(
                    t('settingsPlugins.webhookAdministration.credentialSecretTitle'),
                    t('settingsPlugins.webhookAdministration.credentialSecretBody', {
                        secret: result.oneTimeGeneratedSecret,
                    }),
                );
            }
            fireAndForget(props.refresh());
        } catch (error) {
            if (error instanceof HappyError && isActionApprovalDeclinedErrorCode(error.code)) return;
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
            props.onAcknowledged(endpoint.webhookEndpointId, {
                revision: result.revision,
                credentialRotation: undefined,
            });
            fireAndForget(props.refresh());
        } catch (error) {
            if (error instanceof HappyError && isActionApprovalDeclinedErrorCode(error.code)) return;
            await Modal.alertAsync(t('common.error'), t('settingsPlugins.webhookAdministration.operationFailed'));
        } finally {
            setBusyAction(null);
        }
    }, [endpoint.revision, endpoint.webhookEndpointId, previousCredentialVersionId, props]);

    const selectedTarget = selection.state.kind === 'selected' && 'materializationRef' in selection.state.origin
        ? selection.state.origin.materializationRef
        : null;
    const selectedTargetIsCurrent = selectedTarget !== null
        && arePluginMachineMaterializationRefsEqual(selectedTarget, endpoint.targetMaterialization);
    const selectableOrigins = selection.candidates.filter((candidate): candidate is PluginMachineExecutionOriginCandidateV1 => (
        'materialization' in candidate
        &&
        candidate.validation.kind === 'admitted'
        && candidate.releaseContent === 'matched'
        && candidate.materialization.portableRelease
    ));

    return (
        <ItemGroup
            title={`${endpoint.contribution.pluginId} / ${endpoint.contribution.localId}`}
            description={describeQueue(endpoint)}
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
                disabled={!props.statusCurrent || busyAction !== null || !selection.canExecute || selectedTargetIsCurrent}
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
                    disabled={!props.statusCurrent || busyAction !== null}
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
                    disabled={!props.statusCurrent || busyAction !== null}
                    showChevron={false}
                />
            ) : null}
            {endpoint.routing === 'accountEndpoint' ? (
                <Item
                    testID={`settings.plugins.webhooks.endpoint.${endpoint.webhookEndpointId}.rotateCredential`}
                    title={t('settingsPlugins.webhookAdministration.rotateCredential')}
                    onPress={() => { void rotateCredential(); }}
                    loading={busyAction === 'rotate'}
                    disabled={!props.statusCurrent || busyAction !== null}
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
                    disabled={!props.statusCurrent || busyAction !== null}
                    showChevron={false}
                />
            ) : null}
            <Item
                testID={`settings.plugins.webhooks.endpoint.${endpoint.webhookEndpointId}.revoke`}
                title={t('settingsPlugins.webhookAdministration.revoke')}
                onPress={() => { void revoke(); }}
                loading={busyAction === 'revoke'}
                disabled={!props.statusCurrent || busyAction !== null || endpoint.revokedAt !== undefined || endpoint.revocationAcknowledged === true}
                destructive
                showChevron={false}
            />
        </ItemGroup>
    );
});

const WebhookDeadLetterSection = React.memo(function WebhookDeadLetterSection(props: Readonly<{
    delivery: DeadLetterStatus;
    statusCurrent: boolean;
    client: PluginWebhookAdministrationHttpClient;
    refresh: () => Promise<void>;
    onAcknowledged: (deliveryId: string) => void;
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
            props.onAcknowledged(props.delivery.deliveryId);
            fireAndForget(props.refresh());
        } catch (error) {
            if (error instanceof HappyError && isActionApprovalDeclinedErrorCode(error.code)) return;
            await Modal.alertAsync(t('common.error'), t('settingsPlugins.webhookAdministration.operationFailed'));
        } finally {
            setBusy(null);
        }
    }, [props]);
    const discard = React.useCallback(async () => {
        setBusy('discard');
        try {
            const result = await props.client.discardDelivery({
                deliveryId: props.delivery.deliveryId,
                expectedRevision: props.delivery.revision,
            });
            if (result.kind !== 'discarded') throw new Error(result.kind);
            props.onAcknowledged(props.delivery.deliveryId);
            fireAndForget(props.refresh());
        } catch (error) {
            if (error instanceof HappyError && isActionApprovalDeclinedErrorCode(error.code)) return;
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
                disabled={!props.statusCurrent || busy !== null}
                showChevron={false}
            />
            <Item
                testID={`settings.plugins.webhooks.delivery.${props.delivery.deliveryId}.discard`}
                title={t('common.discard')}
                onPress={() => { void discard(); }}
                loading={busy === 'discard'}
                disabled={!props.statusCurrent || busy !== null}
                destructive
                showChevron={false}
            />
        </ItemGroup>
    );
});

export const PluginWebhookAdministrationScreen = React.memo(function PluginWebhookAdministrationScreen(props: Readonly<{
    client?: PluginWebhookAdministrationHttpClient;
}>) {
    const scope = useActiveServerAccountScope();
    const { executeValue: executeAction } = useMountedActionExecution(scope);
    const client = React.useMemo(
        () => props.client ?? createPluginWebhookAdministrationHttpClient({ executeAction }),
        [executeAction, props.client],
    );
    // The administration API this screen reads is behind the same server
    // feature as public ingress, so an unavailable server has nothing to
    // administer and the read would only surface as a load failure.
    const webhooksAvailable = useFeatureEnabled('plugins.webhooks');
    const classifyRelease = useActivePluginAccountAvailabilityReleaseClassifier();
    const [status, setStatus] = React.useState<AccountStatusObservation | null>(null);
    const [loading, setLoading] = React.useState(true);
    const [error, setError] = React.useState(false);
    const activeRead = React.useRef<object | null>(null);
    const acknowledgeDelivery = React.useCallback((deliveryId: string) => {
        activeRead.current = null;
        setLoading(true);
        setStatus(current => {
            if (current === null) return current;
            const deadLetters = current.deadLetters.filter(delivery => delivery.deliveryId !== deliveryId);
            return deadLetters.length === current.deadLetters.length ? current : { ...current, deadLetters };
        });
    }, []);
    const acknowledgeEndpoint = React.useCallback((endpointId: string, acknowledgement: EndpointAcknowledgement) => {
        activeRead.current = null;
        setLoading(true);
        setStatus(current => current === null ? current : {
            ...current,
            endpoints: current.endpoints.map(endpoint => endpoint.webhookEndpointId !== endpointId
                || !canPublishCatalogReceipt({ current: true, revision: acknowledgement.revision,
                    retainedRevision: endpoint.revision }) ? endpoint : { ...endpoint, ...acknowledgement }),
        });
    }, []);
    const refresh = React.useCallback(async () => {
        const request = {};
        activeRead.current = request;
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
            if (activeRead.current !== request) return;
            setStatus({ ...first, endpoints, nextEndpointCursor: null });
            setError(false);
        } catch {
            if (activeRead.current === request) setError(true);
        } finally {
            if (activeRead.current === request) setLoading(false);
        }
    }, [client]);

    React.useEffect(() => {
        if (!webhooksAvailable) return;
        void refresh();
        return () => { activeRead.current = null; };
    }, [refresh, webhooksAvailable]);

    if (!webhooksAvailable) {
        return (
            <ItemList style={{ paddingTop: 0 }} testID="settings.plugins.webhooks.screen">
                <SettingsPageHeader description={t('settingsPlugins.webhookAdministration.footer')} />
                <ItemGroup>
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
            <SettingsPageHeader
                description={t('settingsPlugins.webhookAdministration.footer')}
                actions={(
                    <SectionActionButton
                        testID="settings.plugins.webhooks.refresh"
                        title={t('common.refresh')}
                        icon="arrows-clockwise"
                        onPress={() => { void refresh(); }}
                        loading={loading}
                    />
                )}
            />
            {error && !loading ? (
                <ItemGroup>
                    <Item
                        testID="settings.plugins.webhooks.loadError"
                        title={t('settingsPlugins.webhookAdministration.loadError')}
                        detail={t('common.retry')}
                        onPress={() => { void refresh(); }}
                        showChevron={false}
                    />
                </ItemGroup>
            ) : null}
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
                    statusCurrent={!loading && !error}
                    client={client}
                    classifyRelease={classifyRelease}
                    refresh={refresh}
                    onAcknowledged={acknowledgeEndpoint}
                />
            ))}
            {status?.deadLetters.length ? status.deadLetters.map((delivery) => (
                <WebhookDeadLetterSection
                    key={delivery.deliveryId}
                    delivery={delivery}
                    statusCurrent={!loading && !error}
                    client={client}
                    refresh={refresh}
                    onAcknowledged={acknowledgeDelivery}
                />
            )) : null}
        </ItemList>
    );
});
