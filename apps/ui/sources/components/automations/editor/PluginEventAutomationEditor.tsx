import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { AutomationTriggerDefinitionInput } from '@happier-dev/protocol';
import type { PluginUiOpenAutomationEventRequestV1 } from '@happier-dev/protocol/plugins/ui';

import { useDaemonMergedProjectionInputs } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { FloatingOverlay, FloatingOverlaySheetContext } from '@/components/ui/overlays/FloatingOverlay';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';
import { Modal } from '@/modal';
import { captureActiveServerAccountScopeLifetime, type ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { t } from '@/text';
import { PluginEventAutomationComposerContent } from './PluginEventAutomationComposerContent';
import { buildPluginEventAutomationTriggerInput } from './pluginEventAutomationDraft';
import {
    pluginEventAutomationEditSeedFromCurrentInput,
    pluginEventAutomationEditSeedFromDraftInput,
    type PluginEventAutomationEditSeed,
} from '@/sync/domains/automations/pluginEventAutomationEditSeed';
import {
    usePluginEventAutomationComposer,
    type PluginEventAutomationComposerModel,
} from './usePluginEventAutomationComposer';

type PluginEventDefinitionInput = Extract<
    AutomationTriggerDefinitionInput,
    Readonly<{ kind: 'pluginEvent'; sourceInstanceId: string }>
>;

export type PluginEventAutomationEditorIntent = Readonly<{ observationOnly: Readonly<{ kind: 'observationOnly' }> }>;
type PluginEventEditorCompletion = (definition: PluginEventDefinitionInput, intent?: PluginEventAutomationEditorIntent) => void;

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
}>): string | null {
    if (
        params.observation?.kind === 'checkpointedPull'
        || params.observation?.kind === 'socket'
    ) {
        return params.observation.watcherMaterializationRef.machineId;
    }
    if (params.observation?.kind === 'durablePush') {
        return params.observation.endpointMaterializationRef?.machineId ?? params.resolvedEndpointMachineId ?? null;
    }
    return params.authoringMachineId;
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
        if (observationOnly) onComplete(trigger, { observationOnly });
        else onComplete(trigger);
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
            {insideSheet ? <View style={styles.content}><PluginEventAutomationComposerContent model={props.model} /></View>
                : <ListPresentationProvider value="page"><ItemGroup surface="none" title={t('workflows.triggers.popover.configureEvent')}>
                    <ListPresentationProvider value="grouped">
                        <View style={styles.content}><PluginEventAutomationComposerContent model={props.model} /></View>
                    </ListPresentationProvider>
                </ItemGroup></ListPresentationProvider>}
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
    /** Intent from retained activity; source setup still comes from the current catalog's real Action. */
    initialEventRef?: Readonly<{ pluginId: string; localId: string }> | null;
    initialSetupSeed?: PluginUiOpenAutomationEventRequestV1;
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
    const machineId = resolvePluginEventEditorProjectionMachineId({
        observation: currentObservation,
        authoringMachineId: props.authoringMachineId,
        resolvedEndpointMachineId: endpointPlacement !== null && endpointPlacement.seed === currentSeed
            && endpointPlacement.lifetime === accountLifetime && accountLifetime?.isCurrent()
            ? endpointPlacement.machineId : null,
    });
    const projection = useDaemonMergedProjectionInputs({
        machineId,
        serverId: props.serverId,
        enabled: Boolean(machineId),
    });
    const model = usePluginEventAutomationComposer({
        machineId,
        serverId: props.serverId,
        projectionPhase: projection.phase,
        projectionInputs: projection.inputs,
        initialEditSeed: currentSeed,
        initialEventRef: props.initialEventRef,
        initialSetupSeed: props.initialSetupSeed,
    });
    React.useEffect(() => {
        // Reuse the composer's existing endpoint read; execution placement is never a fallback.
        setEndpointPlacement(model.seededObservationMachineId && accountLifetime?.isCurrent()
            ? { seed: currentSeed, lifetime: accountLifetime, machineId: model.seededObservationMachineId } : null);
    }, [accountLifetime, currentSeed, model.seededObservationMachineId]);
    return (
        <InlinePluginEventEditor
            model={model}
            onComplete={props.onComplete}
            onCancel={props.onCancel}
            maxHeight={props.maxHeight}
        />
    );
}
