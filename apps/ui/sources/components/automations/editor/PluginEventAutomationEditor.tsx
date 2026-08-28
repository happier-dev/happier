import * as React from 'react';
import type { AutomationTriggerDefinitionInput } from '@happier-dev/protocol';

import { useDaemonMergedProjectionInputs } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Modal } from '@/modal';
import { t } from '@/text';
import { AutomationPluralEditorScreen } from './AutomationPluralEditorScreen';
import { PluginEventAutomationComposerContent } from './PluginEventAutomationComposerContent';
import { buildPluginEventAutomationTriggerInput } from './pluginEventAutomationDraft';
import {
    pluginEventAutomationEditSeedFromCurrentInput,
    pluginEventAutomationEditSeedFromDraftInput,
    type PluginEventAutomationEditSeed,
} from './pluginEventAutomationEditSeed';
import {
    usePluginEventAutomationComposer,
    type PluginEventAutomationComposerModel,
} from './usePluginEventAutomationComposer';

type PluginEventDefinitionInput = Extract<
    AutomationTriggerDefinitionInput,
    Readonly<{ kind: 'pluginEvent' }>
>;

type PluginEventEditorCompletion = Parameters<
    NonNullable<React.ComponentProps<typeof AutomationPluralEditorScreen>['renderPluginEventEditor']>
>[0]['onComplete'];

type PluginEventEditorObservationPlacement = Readonly<{
    kind: 'checkpointedPull';
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
}>): string | null {
    if (params.observation?.kind === 'checkpointedPull') {
        return params.observation.watcherMaterializationRef.machineId;
    }
    if (params.observation?.kind === 'durablePush') {
        return params.observation.endpointMaterializationRef?.machineId ?? null;
    }
    return params.authoringMachineId;
}

export function resolvePluginEventAutomationEditorCompletion(
    model: PluginEventAutomationComposerModel,
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
    model: PluginEventAutomationComposerModel,
    onComplete: PluginEventEditorCompletion,
): Promise<void> {
    const trigger = resolvePluginEventAutomationEditorCompletion(model);
    if (trigger) {
        onComplete(trigger);
        return;
    }
    model.invalidateConfiguredSource();
    await Modal.alert(
        t('common.error'),
        t('automations.form.trigger.sourceUnavailable'),
    );
}

function InlinePluginEventEditor(props: Readonly<{
    model: PluginEventAutomationComposerModel;
    onComplete: PluginEventEditorCompletion;
    onCancel: () => void;
}>) {
    const complete = React.useCallback(async () => {
        await completePluginEventAutomationEditor(props.model, props.onComplete);
    }, [props]);
    return (
        <>
            <PluginEventAutomationComposerContent model={props.model} />
            <ItemGroup>
                <Item
                    testID="automation-plugin-event-done"
                    title={t('common.done')}
                    onPress={props.model.createDraft ? () => { void complete(); } : undefined}
                    disabled={!props.model.createDraft}
                    showChevron={false}
                />
                <Item title={t('common.cancel')} onPress={props.onCancel} showChevron={false} />
            </ItemGroup>
        </>
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
    authoringMachineId: string | null;
    serverId: string | null;
    onComplete: PluginEventEditorCompletion;
    onCancel: () => void;
}>) {
    const currentSeed = React.useMemo(() => {
        if (!props.value || !('sourceInstanceId' in props.value)) return props.seed;
        return props.seed
            ? pluginEventAutomationEditSeedFromCurrentInput(props.seed, props.value)
            : pluginEventAutomationEditSeedFromDraftInput({
                automationId: props.automationId,
                triggerId: props.clientId,
                value: props.value,
            });
    }, [props.automationId, props.clientId, props.seed, props.value]);
    const currentObservation = props.value?.observationTransport ?? currentSeed?.observation ?? null;
    const machineId = resolvePluginEventEditorProjectionMachineId({
        observation: currentObservation,
        authoringMachineId: props.authoringMachineId,
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
    });
    return (
        <InlinePluginEventEditor
            model={model}
            onComplete={props.onComplete}
            onCancel={props.onCancel}
        />
    );
}
