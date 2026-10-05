import * as React from 'react';
import { Pressable, View } from 'react-native';
import { SessionInitialTriggerV1Schema, type SessionInitialTriggerV1 } from '@happier-dev/protocol';

import type { AgentInputExtraActionChip } from '@/components/sessions/agentInput/agentInputContracts';
import { AGENT_INPUT_CHIP_ICON_SIZE_PX, AGENT_INPUT_CHIP_ICON_STYLE } from '@/components/sessions/agentInput/definitions/agentInputChipIconMetrics';
import { Icon } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Item } from '@/components/ui/lists/Item';
import { Popover } from '@/components/ui/popover';
import { FloatingOverlay } from '@/components/ui/overlays/FloatingOverlay';
import { TriggerPopover } from '@/components/workflows/triggers/TriggerPopover';
import { TriggerRow } from '@/components/workflows/triggers/TriggerRow';
import { describeTriggerTarget } from '@/components/workflows/triggers/sessionTriggerGroups';
import { formatTriggerSetSummary, formatTriggerSummary } from '@/components/workflows/triggers/formatTriggerSummary';
import { SESSION_TRIGGER_WHEN_KINDS, readTriggerThen, readTriggerWhen } from '@/components/workflows/triggers/sessionTriggerForm';
import { useTriggerThenOptions } from '@/components/workflows/triggers/useTriggerThenOptions';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { t } from '@/text';

type InitialTriggersProps = Readonly<{
    initialTriggers: SessionInitialTriggerV1[];
    onInitialTriggersChange: React.Dispatch<React.SetStateAction<SessionInitialTriggerV1[]>>;
    machineId: string | null;
    serverId: string | null;
}>;

const CHIP_KEY = 'new-session-triggers';

/** Draft-only consumer. Session birth is the sole trigger writer. */
export function createNewSessionTriggersActionChip(props: InitialTriggersProps): AgentInputExtraActionChip {
    const label = props.initialTriggers.length === 0 ? t('workflows.triggers.section.title')
        : formatTriggerSetSummary(props.initialTriggers.map((entry) => entry.trigger));
    return {
        key: CHIP_KEY,
        stabilityKey: JSON.stringify([props.initialTriggers, props.machineId, props.serverId]),
        collapsedAction: ({ openCollapsedPopover, tint }) => ({
            id: CHIP_KEY, label,
            icon: <Icon name="lightning" size={AGENT_INPUT_CHIP_ICON_SIZE_PX} color={tint} />,
            onPress: () => openCollapsedPopover(CHIP_KEY),
        }),
        renderCollapsedPopover: ({ anchorRef, onRequestClose }) => (
            <NewSessionTriggersPopover {...props} anchorRef={anchorRef} onRequestClose={onRequestClose} />
        ),
        render: ({ chipStyle, chipAnchorRef, iconColor, showLabel, textStyle, toggleCollapsedPopover }) => (
            <Pressable ref={chipAnchorRef} testID="new-session-triggers-chip"
                accessibilityRole="button" accessibilityLabel={label}
                onPress={() => toggleCollapsedPopover?.(CHIP_KEY)} style={({ pressed }) => chipStyle(pressed)}>
                <Icon name="lightning" size={AGENT_INPUT_CHIP_ICON_SIZE_PX} color={iconColor} style={AGENT_INPUT_CHIP_ICON_STYLE} />
                {showLabel ? <Text numberOfLines={1} style={textStyle}>{label}</Text> : null}
            </Pressable>
        ),
    };
}

/** Detailed catalog reads are mounted only after the visible chip or overflow opens it. */
function NewSessionTriggersPopover(props: InitialTriggersProps & Readonly<{
    anchorRef: React.RefObject<View | null>;
    onRequestClose: () => void;
}>): React.ReactElement {
    const activeScope = useActiveServerAccountScope();
    const libraryEnabled = props.serverId === null || (activeScope !== null
        && areServerProfileIdentifiersEquivalent(activeScope.serverId, props.serverId));
    const options = useTriggerThenOptions({ libraryEnabled });
    const libraryNotice = libraryEnabled ? null : <Item testID="new-session-triggers-library-unavailable"
        mode="info" title={t('workflows.triggers.then.workflow')} showChevron={false} subtitleLines={0}
        subtitle={t('workflows.triggers.creation.savedWorkflowsUnavailable')} />;
    const [editing, setEditing] = React.useState<number | 'new' | null>(() => props.initialTriggers.length ? null : 'new');
    const original = typeof editing === 'number' ? props.initialTriggers[editing] : undefined;
    const when = original ? readTriggerWhen(original.trigger) : null;
    if (editing !== null) {
        return <TriggerPopover testID="new-session-trigger-popover" anchorRef={props.anchorRef}
            onRequestClose={props.onRequestClose} creatingSession sessionId={null}
            whenKinds={['sessionStarts', ...SESSION_TRIGGER_WHEN_KINDS.filter((kind) => kind !== 'sessionStarts')]}
            unavailableKinds={{ prComment: t('workflows.triggers.kindDescription.pullRequestUnavailable'),
                ciFailed: t('workflows.triggers.kindDescription.pullRequestUnavailable') }}
            initialWhen={{ kind: 'sessionStarts' }}
            initial={original && when ? { when, enabled: original.trigger.enabled,
                then: readTriggerThen(original.target, undefined, original.inputs ?? {}) } : null}
            workflowOptions={options.workflowOptions} machineId={props.machineId} serverId={props.serverId}
            libraryWorkflowsAvailable={libraryEnabled} afterRows={libraryNotice}
            onSubmit={async (value, write) => {
                if (!write.trigger || !write.target) return;
                // The compact editor does not author lifecycle policies or run-context overrides.
                const trigger = original?.trigger.kind === 'sessionLifecycle' && write.trigger.kind === 'sessionLifecycle'
                    && when?.kind === value.when.kind
                    ? { ...write.trigger, events: original.trigger.events, policy: original.trigger.policy } : write.trigger;
                const entry = SessionInitialTriggerV1Schema.parse({ ...original, trigger, target: write.target, inputs: write.inputs });
                props.onInitialTriggersChange((current) => editing === 'new' ? [...current, entry]
                    : current.map((value, index) => index === editing ? entry : value));
            }}
            {...(original ? {
                onToggleEnabled: async (enabled: boolean) => props.onInitialTriggersChange((current) => current.map((entry, index) =>
                    index === editing ? { ...entry, trigger: { ...entry.trigger, enabled } } : entry)),
                onDelete: async () => props.onInitialTriggersChange((current) => current.filter((_, index) => index !== editing)),
            } : {})} />;
    }
    return <Popover open anchorRef={props.anchorRef} placement="auto" maxWidthCap={420} maxHeightCap={640}
        autoFocusOnOpen onRequestClose={props.onRequestClose} portal={{ web: true, native: true, matchAnchorWidth: false }}>
        {({ maxHeight }) => <FloatingOverlay maxHeight={maxHeight} scrollEnabled>
            <ItemGroup title={t('workflows.triggers.section.title')} action={<RoundButton testID="new-session-triggers-add"
                size="small" title={t('workflows.triggers.section.add')} onPress={() => setEditing('new')} />}>
                {libraryNotice}
                {props.initialTriggers.map((entry, index) => <TriggerRow key={index} testID={`new-session-trigger-draft:${index}`}
                    title={describeTriggerTarget(entry.target, options.resolveWorkflowTitle)} qualifier={formatTriggerSummary(entry.trigger)}
                    enabled={entry.trigger.enabled}
                    {...(readTriggerWhen(entry.trigger) ? { onPress: () => setEditing(index) } : {})}
                    onToggle={(enabled) => props.onInitialTriggersChange((current) => current.map((value, itemIndex) =>
                        itemIndex === index ? { ...value, trigger: { ...value.trigger, enabled } } : value))} />)}
            </ItemGroup>
        </FloatingOverlay>}
    </Popover>;
}
