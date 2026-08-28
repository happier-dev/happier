import * as React from 'react';
import { HappierBanner } from '@happier-dev/plugin-ui/presentation';
import { arePluginMachineMaterializationRefsEqual } from '@happier-dev/protocol';
import { useUnistyles } from 'react-native-unistyles';

import { composePluginMachineExecutionOriginV1 } from '@/sync/domains/machines/administration/pluginExecutionOrigin';
import { resolveFreshPluginMachineExecutionOrigin, type FreshPluginMachineExecutionOriginV1 } from '@/sync/domains/machines/administration/usePluginExecutionOriginSelection';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import {
    useActivePluginAccountAvailabilityReader,
    useActivePluginAccountAvailabilityReleaseClassifier,
} from '@/sync/domains/plugins/availability/projection';
import { useDaemonMergedProjectionInputs } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import { loadDaemonMergedProjectionInputs } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import { projectPluginUiTheme } from '@/components/plugins/surfaces/pluginUiThemeProjection';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Item } from '@/components/ui/lists/Item';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import type { AutomationDefinition } from '@/sync/domains/automations/automationTypes';

import {
    readAutomationHistoryGapRecoveryEligibleEvent,
    readAutomationHistoryGapRecoveryStatus,
    recoverAutomationHistoryGap,
} from './automationHistoryGapRecovery';

function resolveHistoryGapRecoveryExecutionOrigin(params: Readonly<{
    automation: AutomationDefinition | null;
    triggerId: string;
    reader: ReturnType<typeof useActivePluginAccountAvailabilityReader>;
    classifyRelease: ReturnType<typeof useActivePluginAccountAvailabilityReleaseClassifier>;
}>): FreshPluginMachineExecutionOriginV1 | null {
    const status = readAutomationHistoryGapRecoveryStatus(params.automation, params.triggerId);
    const automation = params.automation;
    const trigger = automation?.triggers.find((candidate) => candidate.id === params.triggerId);
    if (!status || !automation || trigger?.kind !== 'pluginEvent' || !params.reader) return null;
    const admission = params.reader.readMaterializations();
    if (admission.kind !== 'available') return null;
    const matches = admission.materializations.filter((materialization) => (
        materialization.pluginId === trigger.eventRef.pluginId
        && arePluginMachineMaterializationRefsEqual(materialization, status.reporterMaterializationRef)
    ));
    if (matches.length !== 1) return null;
    return resolveFreshPluginMachineExecutionOrigin({
        pluginId: trigger.eventRef.pluginId,
        origin: composePluginMachineExecutionOriginV1(matches[0]!),
        reader: params.reader,
        classifyRelease: params.classifyRelease,
    });
}

/**
 * A detail-only recovery entry point. It borrows the existing cold Event
 * catalog and generic Action controller; it never reads source config or
 * checkpoint data, and it does not create another Automation status store.
 */
export function AutomationHistoryGapRecoveryAction(props: Readonly<{
    automation: AutomationDefinition;
    triggerId: string;
    isCurrentRoute: () => boolean;
    rereadAutomationStatus: () => Promise<void>;
}>) {
    const { theme } = useUnistyles();
    const accountLifetime = captureActiveServerAccountScopeLifetime();
    const availabilityReader = useActivePluginAccountAvailabilityReader();
    const classifyRelease = useActivePluginAccountAvailabilityReleaseClassifier();
    const automationRef = React.useRef(props.automation);
    automationRef.current = props.automation;
    const status = readAutomationHistoryGapRecoveryStatus(props.automation, props.triggerId);
    const resolveExecutionOrigin = React.useCallback(() => resolveHistoryGapRecoveryExecutionOrigin({
        automation: automationRef.current,
        triggerId: props.triggerId,
        reader: availabilityReader,
        classifyRelease,
    }), [availabilityReader, classifyRelease, props.triggerId]);
    const origin = resolveExecutionOrigin();
    const projection = useDaemonMergedProjectionInputs({
        machineId: origin?.machineTarget.target.machineId ?? null,
        serverId: origin?.machineTarget.serverId ?? null,
        enabled: status !== null && origin !== null,
        staleMs: 0,
    });
    const eligibleEvent = React.useMemo(() => (
        projection.phase === 'ready'
            ? readAutomationHistoryGapRecoveryEligibleEvent({
                inputs: projection.inputs,
                automation: props.automation,
                triggerId: props.triggerId,
            })
            : null
    ), [projection.inputs, projection.phase, props.automation, props.triggerId]);
    const operationRef = React.useRef<AbortController | null>(null);
    const [recovering, setRecovering] = React.useState(false);
    const [recoveryFailed, setRecoveryFailed] = React.useState(false);
    React.useEffect(() => () => operationRef.current?.abort(), []);
    const presentationTheme = React.useMemo(() => projectPluginUiTheme(theme), [theme]);

    const canRecover = status !== null
        && origin !== null
        && projection.phase === 'ready'
        && eligibleEvent !== null
        && accountLifetime !== null
        && accountLifetime.isCurrent();
    const recover = React.useCallback(() => {
        if (!eligibleEvent || !accountLifetime || !canRecover || operationRef.current) return;
        const operation = new AbortController();
        operationRef.current = operation;
        setRecovering(true);
        void (async () => {
            try {
                const outcome = await recoverAutomationHistoryGap({
                    eligibleEvent,
                    triggerId: props.triggerId,
                    accountLifetime,
                    signal: operation.signal,
                    resolveCurrentAutomation: () => automationRef.current,
                    resolveExecutionOrigin,
                    loadCurrentProjection: async (target) => await loadDaemonMergedProjectionInputs({
                        machineId: target.machineId,
                        serverId: target.serverId,
                        staleMs: 0,
                    }),
                });
                if (
                    outcome.kind === 'unavailable'
                    && !operation.signal.aborted
                    && accountLifetime.isCurrent()
                    && props.isCurrentRoute()
                ) {
                    // Only a canonical status transition out of history-gap recovery
                    // clears this presentation. A successful-looking Action result
                    // cannot clear source attention.
                    setRecoveryFailed(true);
                }
            } finally {
                if (operationRef.current === operation) operationRef.current = null;
                if (!operation.signal.aborted && accountLifetime.isCurrent() && props.isCurrentRoute()) {
                    try {
                        await props.rereadAutomationStatus();
                    } catch {
                        // The status/store owner remains authoritative; retain the existing attention state on a failed reread.
                    }
                }
                if (accountLifetime.isCurrent() && props.isCurrentRoute()) {
                    setRecovering(false);
                }
                operation.abort();
            }
        })();
    }, [accountLifetime, canRecover, eligibleEvent, props, resolveExecutionOrigin]);

    if (!status) return null;
    const canStartRecovery = canRecover && !recovering && !recoveryFailed;
    return (
        <>
            {recoveryFailed ? (
                <HappierBanner
                    testID="automation-history-gap-recovery-failure"
                    tone="warning"
                    theme={presentationTheme}
                    title={t('settingsPlugins.eventAutomationComposer.historyGapRecoveryFailureTitle')}
                    description={t('settingsPlugins.eventAutomationComposer.historyGapRecoveryFailureBody')}
                    renderContent={({ color }) => (
                        <>
                            <Text selectable style={{ ...Typography.rowTitle(), color }}>
                                {t('settingsPlugins.eventAutomationComposer.historyGapRecoveryFailureTitle')}
                            </Text>
                            <Text selectable style={{ ...Typography.rowMeta(), color: theme.colors.text.secondary }}>
                                {t('settingsPlugins.eventAutomationComposer.historyGapRecoveryFailureBody')}
                            </Text>
                            <RoundButton
                                size="small"
                                testID="automation-history-gap-recovery-retry"
                                title={t('common.retry')}
                                accessibilityLabel={t('common.retry')}
                                disabled={!canRecover || recovering}
                                loading={recovering}
                                onPress={canRecover && !recovering ? recover : undefined}
                            />
                        </>
                    )}
                />
            ) : null}
            <Item
                title={t('settingsPlugins.eventAutomationComposer.historyGapRecoveryTitle')}
                subtitle={canRecover
                    ? t('settingsPlugins.eventAutomationComposer.historyGapRecoverySubtitle')
                    : t('settingsPlugins.eventAutomationComposer.historyGapRecoveryUnavailable')}
                subtitleLines={0}
                {...(canStartRecovery ? { onPress: recover } : {})}
                mode={canStartRecovery ? undefined : 'info'}
                loading={recovering}
                showChevron={false}
            />
        </>
    );
}
