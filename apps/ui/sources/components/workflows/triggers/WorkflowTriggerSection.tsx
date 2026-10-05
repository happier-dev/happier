import * as React from 'react';
import { View } from 'react-native';
import type { JsonValue, WorkflowTriggerSetV1 } from '@happier-dev/protocol';
import type { WorkflowProjectTargetV1 } from '@happier-dev/protocol/workflows';
import type { WorkflowInputDefinition } from '@happier-dev/protocol/workflows/workflowV1';

import { Icon } from '@/components/ui/icons/Icon';
import { FieldValueItem } from '@/components/ui/forms/FieldValueItem';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { formatWorkflowInputValue, parseWorkflowInputText } from '@/sync/domains/workflows/workflowInputText';
import { getPreferredLanguage, t } from '@/text';
import { formatWithCachedDateTimeFormatter } from '@/utils/datetime/cachedIntlFormatters';
import { Modal } from '@/modal';
import { useAllMachines } from '@/sync/domains/state/storage';
import { getMachineDisplayName } from '@/utils/sessions/machineUtils';

import { formatTriggerSummary } from './formatTriggerSummary';
import { createDefaultThen, readScheduleWhen, type TriggerFormValue, type TriggerWhenValue } from './sessionTriggerForm';
import { TriggerPopover } from './TriggerPopover';
import { TriggerRunsOnRow } from './TriggerRunsOnRow';
import { TriggerRow } from './TriggerRow';
import { describeLegacyTriggerSet } from './sessionTriggerGroups';
import {
    editWorkflowTriggerDraft,
    projectWorkflowTriggerRows,
    type WorkflowTriggerDraft,
    type WorkflowTriggerRowModel,
} from './workflowTriggerDraft';

export type WorkflowTriggerSectionProps = Readonly<{
    testIDPrefix: string;
    /** This Account's trigger set on this workflow, as last read; `null` with none. */
    set: WorkflowTriggerSetV1 | null;
    draft: WorkflowTriggerDraft;
    onChangeDraft: (next: WorkflowTriggerDraft) => void;
    status: 'loading' | 'ready' | 'failed';
    onRetry: () => void;
    /** "{machine} · {folder}" of the set's one machine, stated once (07 S4, L8); `null` without a trigger. */
    runsOn: string | null;
    /** The steps have unsaved changes, so the description adds "Save to include your changes." */
    stepsUnsaved: boolean;
    /** The editor's Where: it seeds the set's Runs on, and a different Runs on says Run now uses it. */
    whereTarget: WorkflowProjectTargetV1 | null;
    whereSummary: string | null;
    /** The workflow's declared inputs, each "Same for all triggers" on the set (03 §5.3). */
    inputs: readonly WorkflowInputDefinition[];
}>;

function rowWhen(row: WorkflowTriggerRowModel): TriggerWhenValue | null {
    return row.schedule === null ? null : readScheduleWhen(row.schedule.schedule);
}

/** "Next run: {time}" for a saved, enabled schedule whose owner has computed its next occurrence. */
function formatNextRun(set: WorkflowTriggerSetV1 | null, row: WorkflowTriggerRowModel | null): string | undefined {
    if (row === null || row.kind !== 'saved' || !row.enabled) return undefined;
    const saved = set?.triggers.find((trigger) => trigger.id === row.triggerId);
    if (saved?.kind !== 'schedule' || saved.nextRunAt === null) return undefined;
    return t('workflows.triggers.row.nextRun', {
        time: formatWithCachedDateTimeFormatter(saved.nextRunAt, getPreferredLanguage(), { dateStyle: 'medium', timeStyle: 'short' }),
    });
}

/**
 * **Runs automatically** (FIN 04 §5.4; 07 S4; lab `editor-T1/T2`): this Account's triggers on this
 * workflow, each its one summary, plus **Add a trigger**; **Manual** with none. Trigger edits are
 * part of the draft: the popover's Done or Add trigger changes the draft only, and the editor's Save
 * writes the definition, then the trigger delta. A trigger here always runs this workflow, so its
 * popover has no Then.
 */
export function WorkflowTriggerSection(props: WorkflowTriggerSectionProps): React.ReactElement {
    const machines = useAllMachines();
    const rows = React.useMemo(() => projectWorkflowTriggerRows(props.set, props.draft), [props.draft, props.set]);
    const [open, setOpen] = React.useState<Readonly<{ row: WorkflowTriggerRowModel | null; anchor: React.RefObject<View | null> }> | null>(null);
    const addAnchorRef = React.useRef<View>(null);
    const description = [
        props.runsOn !== null && rows.length > 0
            ? t('workflows.triggers.editor.runsByOn', { where: props.runsOn })
            : t('workflows.triggers.editor.runsBy'),
        props.stepsUnsaved ? t('workflows.triggers.editor.saveToInclude') : t('workflows.triggers.editor.savedWorkflow'),
    ].join(' ');

    const initial = React.useMemo((): TriggerFormValue | null => {
        const row = open?.row;
        if (!row) return null;
        const when = rowWhen(row);
        return when === null ? null : { when, then: createDefaultThen('runWorkflow'), enabled: row.enabled };
    }, [open]);

    const change = props.onChangeDraft;
    const row = open?.row ?? null;
    // One Runs on per trigger set: a pending change, the set's, or the editor's Where for a new set.
    const runsOn = props.draft.context?.project ?? props.set?.project ?? props.whereTarget;
    const runsOnDiffers = runsOn !== null && props.whereTarget !== null
        && (runsOn.machineId !== props.whereTarget.machineId || runsOn.directory !== props.whereTarget.directory);
    const constantInputs: Readonly<Record<string, JsonValue>> = props.draft.context?.inputs ?? props.set?.context?.inputs ?? {};
    const legacy = props.set ? describeLegacyTriggerSet(props.set,
        (id) => getMachineDisplayName(machines.find((machine) => machine.id === id) ?? { id, absence: 'unlisted' })) : null;
    const readState = props.status === 'ready' ? null : rows.length > 0 || legacy ? (
        <SurfaceFreshnessLine testID={`${props.testIDPrefix}-triggers-read`} busy={props.status === 'loading'}
            tone={props.status === 'failed' ? 'warning' : 'neutral'}
            reason={props.status === 'failed' ? t('workflows.triggers.section.loadFailed') : t('common.loading')}
            {...(props.status === 'failed' ? { action: { label: t('workflows.triggers.popover.tryAgain'), onPress: props.onRetry } } : {})} />
    ) : (
        <SurfaceStateCard testID={`${props.testIDPrefix}-triggers-read`} size="line"
            kind={props.status === 'failed' ? 'error' : 'loading'}
            title={props.status === 'failed' ? t('workflows.triggers.section.loadFailed') : t('common.loading')}
            {...(props.status === 'failed' ? { action: { testID: `${props.testIDPrefix}-triggers-read-retry`, label: t('workflows.triggers.popover.tryAgain'), onPress: props.onRetry } } : {})} />
    );
    if (legacy && props.set) {
        const set = props.set;
        const retained = set.triggers.filter((trigger) => !props.draft.removes.includes(trigger.id));
        return (
            <ItemGroup title={t('workflows.triggers.editor.title')} description={t('workflows.triggers.editor.editInWorkflows')}>
                {readState}
                {retained.length === 0 ? (
                    <Item title={legacy.title} titleLines={0} subtitle={legacy.qualifier} subtitleLines={0} mode="info" />
                ) : retained.map((trigger) => (
                    <TriggerRow
                        key={trigger.id}
                        testID={`${props.testIDPrefix}-trigger:${trigger.id}`}
                        title={legacy.title} qualifier={legacy.qualifier} multiline
                        enabled={set.enabled && trigger.enabled} toggleDisabled onToggle={() => {}}
                        onPress={() => {
                            void Modal.confirm(t('workflows.triggers.editor.editInWorkflows'), undefined, {
                                confirmText: t('workflows.triggers.popover.deleteTrigger'), destructive: true,
                            }).then((confirmed) => {
                                if (confirmed) change(editWorkflowTriggerDraft(props.draft, { kind: 'remove', triggerId: trigger.id }));
                            });
                        }}
                    />
                ))}
            </ItemGroup>
        );
    }
    return (
        <ItemGroup title={t('workflows.triggers.editor.title')} description={description}>
            {readState}
            {rows.length === 0 && props.status === 'ready' ? (
                <Item testID={`${props.testIDPrefix}-triggers-manual`} title={t('workflows.triggers.summary.manual')} mode="info" />
            ) : rows.map((item) => (
                <WorkflowTriggerRowView
                    key={item.key}
                    testID={`${props.testIDPrefix}-trigger:${item.key}`}
                    row={item}
                    onOpen={(anchor) => setOpen({ row: item, anchor })}
                />
            ))}
            <View ref={addAnchorRef} collapsable={false}>
                <Item
                    testID={`${props.testIDPrefix}-triggers-add`}
                    title={t('workflows.triggers.section.add')}
                    icon={<Icon name="plus" />}
                    showChevron={false}
                    onPress={() => setOpen({ row: null, anchor: addAnchorRef })}
                />
            </View>
            {open !== null && (row === null || initial !== null) ? (
                <TriggerPopover
                    testID={`${props.testIDPrefix}-trigger-popover`}
                    anchorRef={open.anchor}
                    onRequestClose={() => setOpen(null)}
                    {...(formatNextRun(props.set, row) === undefined ? {} : { subtitle: formatNextRun(props.set, row) })}
                    whenKinds={['schedule']}
                    sessionId={null}
                    showThen={false}
                    initial={initial}
                    workflowOptions={[]}
                    machineId={runsOn?.machineId ?? null}
                    setRows={(
                        <TriggerRunsOnRow
                            testID={`${props.testIDPrefix}-trigger-runs-on`}
                            target={runsOn}
                            onChange={(project) => change(editWorkflowTriggerDraft(props.draft, { kind: 'setContext', context: { project } }))}
                            description={runsOnDiffers && props.whereSummary !== null
                                ? `${t('workflows.triggers.editor.runsOnDescription')} ${t('workflows.triggers.editor.runsOnDiffers', { where: props.whereSummary })}`
                                : t('workflows.triggers.editor.runsOnDescription')}
                        />
                    )}
                    afterRows={(
                        <>
                            {props.inputs.map((input) => (
                                <FieldValueItem
                                    key={input.name}
                                    testID={`${props.testIDPrefix}-trigger-input-${input.name}`}
                                    title={input.name}
                                    subtitle={t('workflows.triggers.editor.sameForAllTriggers')}
                                    value={formatWorkflowInputValue(constantInputs[input.name] ?? input.default)}
                                    allowEmpty={!input.required}
                                    onCommit={(text) => {
                                        const value = parseWorkflowInputText(input, text);
                                        const { [input.name]: _previous, ...rest } = constantInputs;
                                        change(editWorkflowTriggerDraft(props.draft, {
                                            kind: 'setContext',
                                            context: { inputs: value === undefined ? rest : { ...rest, [input.name]: value } },
                                        }));
                                    }}
                                />
                            ))}
                            {/* The set's roles are your roles (07 S4); the per-set overrides push S11's
                                Roles rows once that editor lands here. */}
                            <Item
                                testID={`${props.testIDPrefix}-trigger-roles`}
                                title={t('workflows.triggers.editor.roles')}
                                subtitle={t('workflows.triggers.editor.sameForAllTriggers')}
                                detail={t('workflows.start.rolesYour')}
                                mode="info"
                            />
                        </>
                    )}
                    onSubmit={async (value, write) => {
                        if (write.trigger === null) return;
                        if (row === null) {
                            change(editWorkflowTriggerDraft(props.draft, { kind: 'add', clientId: createClientId(), trigger: write.trigger }));
                        } else if (row.kind === 'new') {
                            change(editWorkflowTriggerDraft(props.draft, { kind: 'add', clientId: row.clientId, trigger: write.trigger }));
                        } else {
                            const { enabled: _enabled, ...definition } = write.trigger;
                            change(editWorkflowTriggerDraft(props.draft, { kind: 'update', triggerId: row.triggerId, trigger: definition, enabled: value.enabled }));
                        }
                    }}
                    {...(row === null ? {} : {
                        onToggleEnabled: async (next: boolean) => {
                            if (row.kind === 'saved') {
                                change(editWorkflowTriggerDraft(props.draft, { kind: 'update', triggerId: row.triggerId, enabled: next }));
                            } else if (row.schedule !== null) {
                                change(editWorkflowTriggerDraft(props.draft, { kind: 'add', clientId: row.clientId, trigger: { ...row.schedule, enabled: next } }));
                            }
                        },
                        onDelete: async () => {
                            change(row.kind === 'new'
                                ? editWorkflowTriggerDraft(props.draft, { kind: 'discardAdd', clientId: row.clientId })
                                : editWorkflowTriggerDraft(props.draft, { kind: 'remove', triggerId: row.triggerId }));
                        },
                    })}
                />
            ) : null}
        </ItemGroup>
    );
}

let clientSequence = 0;
function createClientId(): string {
    clientSequence += 1;
    return `trigger-draft-${Date.now().toString(36)}-${clientSequence}`;
}

const WorkflowTriggerRowView = React.memo(function WorkflowTriggerRowView(props: Readonly<{
    testID: string;
    row: WorkflowTriggerRowModel;
    onOpen: (anchor: React.RefObject<View | null>) => void;
}>) {
    const anchorRef = React.useRef<View>(null);
    const { row } = props;
    const subtitle = row.kind === 'new'
        ? t('workflows.triggers.editor.newRow')
        : row.enabled ? undefined : t('workflows.triggers.row.off');
    // A plugin event's configuration is private to its setup flow; here it is listed, not re-configured.
    const editable = row.schedule !== null;
    return (
        <View ref={anchorRef} collapsable={false}>
            <Item
                testID={props.testID}
                title={formatTriggerSummary(row.trigger)}
                {...(subtitle === undefined ? {} : { subtitle })}
                icon={<Icon name={row.trigger.kind === 'schedule' ? 'clock' : 'lightning'} />}
                showChevron={editable}
                {...(editable ? { onPress: () => props.onOpen(anchorRef) } : { mode: 'info' as const })}
            />
        </View>
    );
});
