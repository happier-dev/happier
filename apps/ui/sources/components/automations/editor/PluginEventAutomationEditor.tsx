import type { PluginJsonSchemaV2 } from '@happier-dev/protocol/plugins/contributions/publicTypes';
import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { AutomationTriggerDefinitionInput } from '@happier-dev/protocol/automations/automationTriggerDefinition';
import type { PluginUiOpenAutomationEventRequestV1 } from '@happier-dev/protocol/plugins/ui';
import { getPluginMachineExecutionOriginRef } from '@happier-dev/protocol/machines/administration/pluginMachineExecutionOriginV1';

import { useDaemonMergedProjectionInputs } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import { PLUGIN_EVENT_AUTOMATION_SECTIONS } from '@/sync/domains/plugins/ui/projectionSections';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { FloatingOverlay, FloatingOverlaySheetContext } from '@/components/ui/overlays/FloatingOverlay';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';
import { Modal } from '@/modal';
import { captureActiveServerAccountScopeLifetime, type ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { t } from '@/text';
import { useServerScopedMachineLabel } from '@/sync/store/hooks';
import { PluginEventAutomationComposerContent } from './PluginEventAutomationComposerContent';
import { buildPluginEventAutomationTriggerInput } from './pluginEventAutomationDraft';
import type { PluginEventAutomationSetupFailure } from './pluginEventAutomationSetup';
import {
    pluginEventAutomationEditSeedFromCurrentInput,
    pluginEventAutomationEditSeedFromDraftInput,
    type PluginEventAutomationEditSeed,
} from '@/sync/domains/automations/pluginEventAutomationEditSeed';
import {
    usePluginEventAutomationComposer,
    type NewNativeSourceSetup,
    type PluginEventAutomationComposerModel,
} from './usePluginEventAutomationComposer';

type PluginEventDefinitionInput = Extract<
    AutomationTriggerDefinitionInput,
    Readonly<{ kind: 'pluginEvent'; sourceInstanceId: string }>
>;

export type PluginEventAutomationEditorIntent = Readonly<{ observationOnly?: Readonly<{ kind: 'observationOnly' }>; payloadSchema?: PluginJsonSchemaV2 | null }>;
type PluginEventEditorCompletion = (definition: PluginEventDefinitionInput, intent?: PluginEventAutomationEditorIntent) => void;
type NativeSetupPresentation = Readonly<{
    renderUnavailable: (
        retry: () => void,
        machineName: string | null,
        failure: PluginEventAutomationSetupFailure | null,
    ) => React.ReactNode;
    waitingTitle?: (machineName: string | null, phase: 'opening' | 'applying') => string;
}>;

type PluginEventEditorObservationPlacement = Readonly<{
    kind: 'checkpointedPull';
    watcherMaterializationRef: Readonly<{ machineId: string }>;
}> | Readonly<{
    kind: 'socket';
    watcherMaterializationRef: Readonly<{ machineId: string }>;
}> | Readonly<{
    kind: 'durablePush';
    endpointMaterializationRef?: Readonly<{ machineId: string }> | null;
}>;

/**
 * Resolves the machine that owns Event authoring facts. A durable-push edit
 * with no current endpoint target must stay unavailable: the Automation's
 * execution assignment is a different product concept and cannot stand in
 * for endpoint placement.
 */
export function resolvePluginEventEditorProjectionMachineId(params: Readonly<{
    observation: PluginEventEditorObservationPlacement | null;
    authoringMachineId: string | null;
    resolvedEndpointMachineId?: string | null;
    selectedWatcherMachineId?: string | null;
}>): string | null {
    if (
        params.observation?.kind === 'checkpointedPull'
        || params.observation?.kind === 'socket'
    ) {
        return params.selectedWatcherMachineId ?? params.observation.watcherMaterializationRef.machineId;
    }
    if (params.observation?.kind === 'durablePush') {
        return params.observation.endpointMaterializationRef?.machineId ?? params.resolvedEndpointMachineId ?? null;
    }
    return params.selectedWatcherMachineId ?? params.authoringMachineId;
}

export function resolvePluginEventAutomationEditorCompletion(
    model: Pick<PluginEventAutomationComposerModel, 'createDraft' | 'eligibleEvents'>,
): PluginEventDefinitionInput | null {
    const transient = model.createDraft;
    if (!transient) return null;
    const freshWatcher = transient.resolveFreshWatcherOrigin();
    if (!freshWatcher) return null;
    return buildPluginEventAutomationTriggerInput({
        eligibleEvents: model.eligibleEvents,
        draft: transient.draft,
        watcherOrigin: freshWatcher.origin,
    });
}

export async function completePluginEventAutomationEditor(
    model: Pick<PluginEventAutomationComposerModel, 'createDraft' | 'eligibleEvents' | 'invalidateConfiguredSource'>,
    onComplete: PluginEventEditorCompletion,
): Promise<void> {
    const trigger = resolvePluginEventAutomationEditorCompletion(model);
    if (trigger) {
        const observationOnly = model.createDraft?.draft.source.observationOnly;
        onComplete(trigger, { ...(observationOnly ? { observationOnly } : {}), payloadSchema: model.eligibleEvents.find(candidate => candidate.event.identity.pluginId === trigger.eventRef.pluginId
            && candidate.event.identity.localId === trigger.eventRef.localId)?.event.payloadSchema ?? null });
        return;
    }
    model.invalidateConfiguredSource();
    await Modal.alert(
        t('common.error'),
        t('automations.form.trigger.sourceUnavailable'),
    );
}

const styles = StyleSheet.create((theme) => ({
    content: { minWidth: 0, paddingHorizontal: theme.space.s16, paddingBottom: theme.space.s16 },
    footer: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
        gap: theme.space.s8, padding: theme.space.s16 },
}));

export function InlinePluginEventEditor(props: Readonly<{
    model: PluginEventAutomationComposerModel;
    onComplete: PluginEventEditorCompletion;
    onCancel: () => void;
    maxHeight?: number;
}>) {
    const insideSheet = React.useContext(FloatingOverlaySheetContext);
    const complete = React.useCallback(async () => {
        await completePluginEventAutomationEditor(props.model, props.onComplete);
    }, [props]);
    return (
        <FloatingOverlay surfaceChrome="theme" maxHeight={props.maxHeight ?? 640}
            footer={<View style={styles.footer}>
                <RoundButton testID="automation-plugin-event-cancel" size="small" display="inverted"
                    title={t('common.cancel')} onPress={props.onCancel} />
                <RoundButton
                    testID="automation-plugin-event-done"
                    title={t('common.done')}
                    size="small"
                    onPress={props.model.createDraft ? () => { void complete(); } : undefined}
                    disabled={!props.model.createDraft}
                />
            </View>}>
            {/* One tree in the popover and its phone sheet: crossing the breakpoint keeps the open pickers and their
                search. The sheet's header already names the step, so its section repeats no title (as a pushed page's). */}
            <ListPresentationProvider value="page"><ItemGroup surface="none" title={insideSheet ? undefined : t('workflows.triggers.popover.configureEvent')}>
                <ListPresentationProvider value="grouped" floating={insideSheet}>
                    <View style={styles.content}><PluginEventAutomationComposerContent model={props.model} /></View>
                </ListPresentationProvider>
            </ItemGroup></ListPresentationProvider>
        </FloatingOverlay>
    );
}

/**
 * The one row-scoped Event editor used by every plural Automation surface.
 * Its model is mounted for the exact active row, so changing another row can
 * never replace this row's transient source setup or currentness witnesses.
 */
export function PluginEventAutomationEditor(props: Readonly<{
    automationId: string;
    clientId: string;
    value: PluginEventDefinitionInput | null;
    seed: PluginEventAutomationEditSeed | null;
    onEditSeedApplied?: Parameters<typeof usePluginEventAutomationComposer>[0]['onEditSeedApplied'];
    /** Intent from retained activity; source setup still comes from the current catalog's real Action. */
    initialEventRef?: Readonly<{ pluginId: string; localId: string }> | null;
    initialSetupSeed?: PluginUiOpenAutomationEventRequestV1;
    /** Open the native setup form for a saved source as soon as its exact editor restores it. */
    savedSourceSetup?: NonNullable<Parameters<typeof usePluginEventAutomationComposer>[0]['savedSourceSetup']> & NativeSetupPresentation;
    /** Open the seeded native form directly and settle an observation without a workflow target. */
    newSourceSetup?: NewNativeSourceSetup & NativeSetupPresentation;
    observationOnly?: PluginEventAutomationEditorIntent['observationOnly'];
    authoringMachineId: string | null;
    serverId: string | null;
    onComplete: PluginEventEditorCompletion;
    onCancel: () => void;
    maxHeight?: number;
}>) {
    const currentSeed = React.useMemo(() => {
        if (!props.value || !('sourceInstanceId' in props.value)) return props.seed;
        const seed = props.seed
            ? pluginEventAutomationEditSeedFromCurrentInput(props.seed, props.value)
            : pluginEventAutomationEditSeedFromDraftInput({
                automationId: props.automationId,
                triggerId: props.clientId,
                value: props.value,
            });
        return props.observationOnly ? { ...seed, source: { ...seed.source, observationOnly: props.observationOnly } } : seed;
    }, [props.automationId, props.clientId, props.observationOnly, props.seed, props.value]);
    const accountLifetime = captureActiveServerAccountScopeLifetime();
    const [endpointPlacement, setEndpointPlacement] = React.useState<Readonly<{
        seed: PluginEventAutomationEditSeed | null;
        lifetime: ActiveServerAccountScopeLifetime;
        machineId: string;
    }> | null>(null);
    const currentObservation = props.value?.observationTransport ?? currentSeed?.observation ?? null;
    const [catalogRefresh, setCatalogRefresh] = React.useState(0);
    const setup = props.savedSourceSetup ?? props.newSourceSetup;
    const chooseWatcher = props.savedSourceSetup?.chooseWatcher === true;
    const newSetup = props.newSourceSetup !== undefined && props.savedSourceSetup === undefined;
    const authoringMachineId = props.newSourceSetup?.seed.monitoringMachineId ?? props.authoringMachineId;
    const placement = endpointPlacement !== null && endpointPlacement.seed === currentSeed && endpointPlacement.lifetime === accountLifetime
        && accountLifetime?.isCurrent() ? endpointPlacement.machineId : null;
    const machineId = chooseWatcher && !placement ? null : resolvePluginEventEditorProjectionMachineId({
        observation: currentObservation,
        authoringMachineId,
        resolvedEndpointMachineId: placement,
        selectedWatcherMachineId: currentObservation === null || chooseWatcher ? placement : null,
    });
    const setupMachineName = useServerScopedMachineLabel(props.serverId, setup ? machineId : null);
    const projection = useDaemonMergedProjectionInputs({
        machineId,
        serverId: props.serverId,
        enabled: Boolean(machineId),
        sections: PLUGIN_EVENT_AUTOMATION_SECTIONS,
        refreshKey: catalogRefresh,
    });
    const model = usePluginEventAutomationComposer({
        machineId,
        serverId: props.serverId,
        projectionPhase: projection.phase,
        projectionInputs: projection.inputs,
        initialEditSeed: currentSeed,
        onEditSeedApplied: props.onEditSeedApplied,
        initialEventRef: props.initialEventRef,
        initialSetupSeed: props.initialSetupSeed,
        savedSourceSetup: props.savedSourceSetup,
        newSourceSetup: newSetup ? props.newSourceSetup : undefined,
        defaultWatcherMachineId: authoringMachineId,
    });
    React.useEffect(() => {
        // A new Event reads the authoring Machine's catalog and follows the selected watcher's Machine
        // (the composer pre-selects one there). Saved endpoint placement still belongs to the existing endpoint reader.
        const selectedMachineId = currentObservation === null || (chooseWatcher && currentObservation.kind !== 'durablePush')
            ? model.selectedWatcherOrigin ? getPluginMachineExecutionOriginRef(model.selectedWatcherOrigin).machineId : null
            : model.seededObservationMachineId;
        setEndpointPlacement(selectedMachineId && accountLifetime?.isCurrent()
            ? { seed: currentSeed, lifetime: accountLifetime, machineId: selectedMachineId } : null);
    }, [accountLifetime, currentSeed, currentObservation, model.seededObservationMachineId, model.selectedWatcherOrigin, chooseWatcher]);
    const nativeSetupStarted = React.useRef(false);
    const readyToOpen = newSetup
        ? model.sourceStatus === 'idle' && model.selectedEvent !== null && model.selectedWatcherOrigin !== null
        : model.sourceStatus === 'configured';
    React.useEffect(() => {
        if (!setup || chooseWatcher || nativeSetupStarted.current || !readyToOpen) return;
        nativeSetupStarted.current = true;
        model.configureSource();
    }, [chooseWatcher, model.configureSource, readyToOpen, setup]);
    if (setup) {
        const retrySetup = () => {
            if (model.eventCatalogStatus === 'ready' && model.selectedEvent
                && (!newSetup || model.selectedWatcherOrigin)) model.configureSource();
            else {
                nativeSetupStarted.current = false;
                setCatalogRefresh(current => current + 1);
            }
        };
        const applying = model.sourceStatus === 'applying';
        if (chooseWatcher && model.sourceStatus !== 'settingUp' && !applying) {
            return <View style={styles.content}>
                <PluginEventAutomationComposerContent model={model} watcherOnly />
                {model.selectedWatcherOrigin && (model.sourceStatus === 'unavailable' || model.eventCatalogStatus === 'unavailable')
                    ? setup.renderUnavailable(retrySetup, setupMachineName, model.sourceFailure)
                    : model.selectedWatcherOrigin && model.eventCatalogStatus === 'loading'
                        ? <SurfaceStateCard size="line" kind="loading" title={t('common.loading')} /> : null}
                <View style={styles.footer}>
                    {/* Continue is the step's one primary; Cancel stays quiet (PAGE-ACCEPT-176 R10-D3). */}
                    <RoundButton title={t('common.cancel')} size="small" display="inverted" onPress={props.onCancel} />
                    <RoundButton title={t('common.continue')} size="small"
                        disabled={!model.selectedWatcherOrigin || model.sourceStatus !== 'configured'}
                        onPress={model.configureSource} />
                </View>
            </View>;
        }
        const waiting = model.eventCatalogStatus === 'loading' || model.sourceStatus === 'settingUp' || applying
            || (newSetup ? readyToOpen && !nativeSetupStarted.current
                : !chooseWatcher && model.eventCatalogStatus === 'ready' && model.sourceStatus === 'idle');
        if (waiting) return <SurfaceStateCard size="line" kind="loading"
            title={setup.waitingTitle?.(setupMachineName, applying ? 'applying' : 'opening') ?? t('common.loading')} />;
        if (model.sourceStatus === 'configured') return null;
        return setup.renderUnavailable(retrySetup, setupMachineName, model.sourceFailure);
    }
    return (
        <InlinePluginEventEditor
            model={model}
            onComplete={props.onComplete}
            onCancel={props.onCancel}
            maxHeight={props.maxHeight}
        />
    );
}
