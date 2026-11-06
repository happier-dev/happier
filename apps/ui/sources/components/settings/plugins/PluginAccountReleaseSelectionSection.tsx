import * as React from 'react';
import type { PluginProjectionV2 } from '@happier-dev/protocol';
import { isActionApprovalDeclinedErrorCode } from '@happier-dev/protocol/actions/actionExecutionResult';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Modal } from '@/modal';
import type { PluginAccountAvailabilityReader } from '@/sync/domains/plugins/availability/reader';
import { observePluginAccountPackageAssetPublication } from '@/sync/domains/plugins/availability/accountPackageAssetPublication';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { t } from '@/text';
import { HappyError } from '@/utils/errors/errors';
import { useActionApprovalContinuation } from '@/components/approvals/useActionApprovalContinuation';
import { useActiveServerAccountScope } from '@/sync/store/hooks';
import { serverAccountScopeKeySuffix } from '@/sync/domains/scope/serverAccountScope';

import {
    createPluginAccountReleaseSelectionController,
    type PluginAccountReleaseSelectionController,
    type PluginAccountReleaseSelectionControllerResult,
} from './pluginAccountReleaseSelectionController';

type ControllerLifetime = {
    controller: PluginAccountReleaseSelectionController;
    current: boolean;
};

function showResult(result: PluginAccountReleaseSelectionControllerResult): void {
    switch (result.kind) {
        case 'selected':
            // Availability projects the selected release back into this
            // section; that visible state is the success confirmation.
            return;
        case 'conflict':
            Modal.alert(
                t('settingsPlugins.accountReleaseSelection.conflictTitle'),
                t('settingsPlugins.accountReleaseSelection.conflictBody'),
            );
            return;
        case 'rejected':
            Modal.alert(
                t('settingsPlugins.accountReleaseSelection.rejectedTitle'),
                t('settingsPlugins.accountReleaseSelection.rejectedBody'),
            );
            return;
        case 'unavailable':
            Modal.alert(
                t('settingsPlugins.accountReleaseSelection.unavailableTitle'),
                t('settingsPlugins.accountReleaseSelection.unavailableBody'),
            );
            return;
        case 'cancelled':
            return;
    }
}

/**
 * Present-user Account release action. It intentionally has no machine
 * installation/trust authority: the controller asks Availability for the
 * exact release, and only its typed response may trigger preparation.
 */
export function PluginAccountReleaseSelectionSection(props: Readonly<{
    pluginId: string;
    /**
     * The machine-observed release this Account can select, or `null` when no
     * machine currently holds the plugin. Account hosting outlives every
     * installation, so its lifecycle stays reachable without one.
     */
    version: string | null;
    reader: PluginAccountAvailabilityReader | null;
    /** The live raw daemon projection, if this Account action can use it. */
    projection: PluginProjectionV2 | null;
    daemon: Readonly<{
        serverId: string | null;
        serverIdentityId: string | null;
        machineId: string | null;
    }>;
    testID: string;
}>): React.ReactElement | null {
    const [pending, setPending] = React.useState(false);
    const [hasUiArtifactSlots, setHasUiArtifactSlots] = React.useState(false);
    const [hostedStatus, setHostedStatus] = React.useState<ReturnType<PluginAccountReleaseSelectionController['readHostedArtifactStatus']>>('unavailable');
    const controllerLifetimeRef = React.useRef<ControllerLifetime | null>(null);
    const accountScope = useActiveServerAccountScope();
    const { requestApproval } = useActionApprovalContinuation({
        scopeKey: accountScope ? serverAccountScopeKeySuffix(accountScope) : '',
        serverId: accountScope?.serverId ?? '',
        onExecuted: () => {},
    });

    React.useEffect(() => {
        const lifetime: ControllerLifetime = {
            controller: createPluginAccountReleaseSelectionController({
                onBlockingApprovalPending: ({ artifactId, scope, signal }) => requestApproval({
                    artifactId, scope, signal, refreshAfterExecution: false,
                    // The blocking executor retains the result and the original
                    // controller lifetime; presentation must not replay it.
                    onExecuted: async () => 'ignored',
                }),
            }),
            current: true,
        };
        controllerLifetimeRef.current = lifetime;
        setPending(false);
        return () => {
            lifetime.current = false;
            if (controllerLifetimeRef.current === lifetime) controllerLifetimeRef.current = null;
            lifetime.controller.retire();
        };
    }, [props.pluginId, props.reader, requestApproval]);

    React.useEffect(() => {
        const update = () => {
            const lifetime = controllerLifetimeRef.current;
            if (!lifetime?.current) return;
            setHostedStatus(lifetime.controller.readHostedArtifactStatus({
                pluginId: props.pluginId,
                reader: props.reader,
            }));
            const administration = props.reader?.readCurrentHostedArtifactAdministration({ pluginId: props.pluginId });
            setHasUiArtifactSlots(administration?.kind === 'available' && administration.release.uiSlots.length > 0);
        };
        update();
        return props.reader?.subscribe(update);
    }, [props.pluginId, props.reader]);

    React.useEffect(() => {
        const reader = props.reader;
        const projection = props.projection;
        const { machineId, serverId, serverIdentityId } = props.daemon;
        if (!reader || !projection || !machineId || !serverIdentityId) return;
        const accountLifetime = captureActiveServerAccountScopeLifetime();
        if (!accountLifetime?.isCurrent()) return;
        let current = true;
        const dispose = observePluginAccountPackageAssetPublication({
            pluginId: props.pluginId,
            reader,
            accountLifetime,
            projection,
            daemon: { machineId, serverId, serverIdentityId },
            isCurrent: () => current,
        });
        return () => {
            current = false;
            dispose();
        };
    }, [props.pluginId, props.reader, props.projection, props.daemon.machineId, props.daemon.serverId, props.daemon.serverIdentityId]);

    const runHostedAction = React.useCallback((action: (
        controller: PluginAccountReleaseSelectionController,
    ) => Promise<Readonly<{ kind: 'updated' | 'conflict' | 'unavailable' | 'cancelled' }>>) => {
        const lifetime = controllerLifetimeRef.current;
        if (!lifetime || pending || lifetime.controller.isPending()) return;
        setPending(true);
        void action(lifetime.controller).then((result) => {
            if (!lifetime.current || controllerLifetimeRef.current !== lifetime) return;
            if (result.kind === 'conflict') {
                Modal.alert(
                    t('settingsPlugins.accountReleaseSelection.conflictTitle'),
                    t('settingsPlugins.accountReleaseSelection.conflictBody'),
                );
            } else if (result.kind === 'unavailable') {
                Modal.alert(
                    t('settingsPlugins.accountReleaseSelection.unavailableTitle'),
                    t('settingsPlugins.accountReleaseSelection.unavailableBody'),
                );
            }
        }).catch((error: unknown) => {
            if (error instanceof HappyError && isActionApprovalDeclinedErrorCode(error.code)) return;
            if (lifetime.current && controllerLifetimeRef.current === lifetime) {
                Modal.alert(t('common.error'), t('common.requestFailed'));
            }
        }).finally(() => {
            if (lifetime.current && controllerLifetimeRef.current === lifetime) setPending(false);
        });
    }, [pending]);

    const version = props.version;
    const selectRelease = React.useCallback(() => {
        const lifetime = controllerLifetimeRef.current;
        if (!lifetime || version === null || pending || lifetime.controller.isPending()) return;
        setPending(true);
        void (async () => {
            try {
                const result = await lifetime.controller.select({
                    pluginId: props.pluginId,
                    version,
                    reader: props.reader,
                    projection: props.projection,
                    daemon: props.daemon,
                    isCurrent: () => lifetime.current && controllerLifetimeRef.current === lifetime,
                });
                if (lifetime.current && controllerLifetimeRef.current === lifetime) {
                    showResult(result);
                }
            } catch (error) {
                if (error instanceof HappyError && isActionApprovalDeclinedErrorCode(error.code)) return;
                if (lifetime.current && controllerLifetimeRef.current === lifetime) {
                    showResult(Object.freeze({ kind: 'unavailable' as const, code: 'target_release_unavailable' as const }));
                }
            } finally {
                if (lifetime.current && controllerLifetimeRef.current === lifetime) setPending(false);
            }
        })();
    }, [pending, props.daemon, props.pluginId, props.projection, props.reader, version]);

    if (version === null && hostedStatus === 'unavailable') return null;

    return (
        <ItemGroup
            title={t('settingsPlugins.accountReleaseSelection.groupTitle')}
            description={version === null
                ? t('settingsPlugins.accountReleaseSelection.hostedGroupFooter')
                : t('settingsPlugins.accountReleaseSelection.groupFooter')}
        >
            {version !== null ? (
                <Item
                    testID={props.testID}
                    title={t('settingsPlugins.accountReleaseSelection.entryTitle')}
                    subtitle={t('settingsPlugins.accountReleaseSelection.entrySubtitle', { version })}
                    onPress={selectRelease}
                    disabled={pending}
                    loading={pending}
                    showChevron={false}
                />
            ) : null}
            {hostedStatus !== 'unavailable' ? (
                <Item
                    testID={`${props.testID}.hosting`}
                    title={hostedStatus === 'notOptedIn' || hostedStatus === 'disabledHosted'
                        ? t('settingsPlugins.accountReleaseSelection.hostedEnableTitle')
                        : t('settingsPlugins.accountReleaseSelection.hostedDisableTitle')}
                    subtitle={hostedStatus === 'unsupported' || hostedStatus === 'unsupportedHosted'
                        ? t('common.unavailable')
                        : hostedStatus === 'hosted'
                        ? t('settingsPlugins.accountReleaseSelection.hostedStatusReady')
                        : hostedStatus === 'publicationPending'
                            ? t('settingsPlugins.accountReleaseSelection.hostedStatusPending')
                            : t('settingsPlugins.accountReleaseSelection.hostedStatusDisabled')}
                    onPress={() => runHostedAction(async (controller) => {
                        const enabled = hostedStatus === 'notOptedIn' || hostedStatus === 'disabledHosted';
                        return await controller.setHostedArtifactsEnabled({
                            pluginId: props.pluginId,
                            reader: props.reader,
                            enabled,
                        });
                    })}
                    disabled={pending || hostedStatus === 'unsupported' || hostedStatus === 'unsupportedHosted'}
                    loading={pending}
                    showChevron={false}
                />
            ) : null}
            {hostedStatus === 'hosted' || hostedStatus === 'publicationPending' || hostedStatus === 'disabledHosted' || hostedStatus === 'unsupportedHosted' ? (
                <Item
                    testID={`${props.testID}.removeHosted`}
                    title={t('settingsPlugins.accountReleaseSelection.hostedRemoveTitle')}
                    subtitle={t('settingsPlugins.accountReleaseSelection.hostedRemoveBody')}
                    destructive
                    onPress={() => runHostedAction((controller) => controller.disableAndRemoveHostedArtifacts({
                        pluginId: props.pluginId,
                        reader: props.reader,
                    }))}
                    disabled={pending}
                    showChevron={false}
                />
            ) : null}
            {hostedStatus !== 'unavailable' && hasUiArtifactSlots ? (
                <Item
                    testID={`${props.testID}.clearCache`}
                    title={t('settingsPlugins.accountReleaseSelection.hostedClearCacheTitle')}
                    subtitle={t('settingsPlugins.accountReleaseSelection.hostedClearCacheBody')}
                    onPress={() => runHostedAction((controller) => controller.clearHostedArtifactCache({
                        pluginId: props.pluginId,
                        reader: props.reader,
                    }))}
                    disabled={pending}
                    showChevron={false}
                />
            ) : null}
        </ItemGroup>
    );
}
