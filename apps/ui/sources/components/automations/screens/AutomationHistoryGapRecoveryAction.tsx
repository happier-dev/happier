import * as React from 'react';
import { HappierBanner } from '@happier-dev/plugin-ui/presentation';
import { useUnistyles } from 'react-native-unistyles';

import { readCurrentAppShellPluginUiExecutionOriginCandidates, subscribeCommittedAppShellPluginUiProjection } from '@/components/appShell/plugins/committedPluginUiProjection';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import {
    useActivePluginAccountAvailabilityReader,
    useActivePluginAccountAvailabilityReleaseClassifier,
} from '@/sync/domains/plugins/availability/projection';
import { useDaemonMergedProjectionInputs } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import { loadDaemonMergedProjectionInputs } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import { PLUGIN_EVENT_AUTOMATION_SECTIONS } from '@/sync/domains/plugins/ui/projectionSections';
import { usePluginUiTheme } from '@/components/plugins/surfaces/pluginUiThemeProjection';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { t } from '@/text';
import type { AutomationDefinition } from '@/sync/domains/automations/automationTypes';

import {
    readAutomationHistoryGapRecoveryEligibleEvent,
    readAutomationHistoryGapRecoveryStatus,
    recoverAutomationHistoryGap,
    resolveAutomationHistoryGapRecoveryExecutionOrigin,
} from './automationHistoryGapRecovery';
import { readHistoryGapRecoveryPresentation } from './historyGapRecoveryPresentation';

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
    const watcherPluginId = status?.eventRef.pluginId ?? '';
    const readWatcherFacts = React.useCallback(() => readCurrentAppShellPluginUiExecutionOriginCandidates(watcherPluginId), [watcherPluginId]);
    React.useSyncExternalStore(subscribeCommittedAppShellPluginUiProjection, readWatcherFacts, readWatcherFacts);
    const resolveExecutionOrigin = React.useCallback(() => {
        const facts = readWatcherFacts();
        return resolveAutomationHistoryGapRecoveryExecutionOrigin({
            automation: automationRef.current,
            triggerId: props.triggerId,
            reader: availabilityReader,
            classifyRelease,
            sourceCandidates: facts.sourceCandidates,
            machineRejections: facts.machineRejections,
        });
    }, [availabilityReader, classifyRelease, props.triggerId, readWatcherFacts]);
    const origin = resolveExecutionOrigin();
    const projection = useDaemonMergedProjectionInputs({
        machineId: status?.reporterMaterializationRef.machineId ?? null,
        serverId: accountLifetime?.scope.serverId ?? null,
        enabled: status !== null && accountLifetime !== null,
        staleMs: 0,
        // The reporting watcher supplies native origins too; load its cold facts before execution admission.
        sections: PLUGIN_EVENT_AUTOMATION_SECTIONS,
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
    const presentationTheme = usePluginUiTheme(theme);

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
                        sections: PLUGIN_EVENT_AUTOMATION_SECTIONS,
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
    // One attention banner with its one recovery: resolving reads as resolving, never as unavailable then a flip.
    const presentation = readHistoryGapRecoveryPresentation({ projectionPhase: projection.phase, canRecover, recovering, recoveryFailed });
    const failed = presentation === 'failed';
    return (
        <HappierBanner
            testID={failed ? 'automation-history-gap-recovery-failure' : 'automation-history-gap-recovery'}
            tone="warning"
            theme={presentationTheme}
            title={t(failed ? 'settingsPlugins.eventAutomationComposer.historyGapRecoveryFailureTitle'
                : 'settingsPlugins.eventAutomationComposer.historyGapRecoveryTitle')}
            description={t(failed ? 'settingsPlugins.eventAutomationComposer.historyGapRecoveryFailureBody'
                : presentation === 'unavailable' ? 'settingsPlugins.eventAutomationComposer.historyGapRecoveryUnavailable'
                    : 'settingsPlugins.eventAutomationComposer.historyGapRecoverySubtitle')}
            action={presentation === 'unavailable' ? undefined : (
                <RoundButton
                    size="small"
                    testID={failed ? 'automation-history-gap-recovery-retry' : 'automation-history-gap-recovery-run'}
                    title={t(failed ? 'common.retry' : 'settingsPlugins.eventAutomationComposer.historyGapRecoveryAction')}
                    disabled={!canRecover || recovering}
                    loading={presentation === 'resolving' || recovering}
                    onPress={canRecover && !recovering ? recover : undefined}
                />
            )}
        />
    );
}
