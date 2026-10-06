import { HappierPageSheetGroup } from '@happier-dev/plugin-ui/presentation';
import type { TriggerTargetV1 } from '@happier-dev/protocol';
import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { WorkSection } from '@/components/sessions/work/WorkSection';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { Icon } from '@/components/ui/icons/Icon';
import { CollectionListGroupLabel } from '@/components/ui/lists/collection/CollectionList';
import { formatRelativeTimeShort } from '@/components/ui/selectionList/formatRelativeTimeShort';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { useLocalSearchParams } from '@/components/appShell/workspace/destinationRoute';
import { parseExactTurnAutomationPrefillRoute } from '@/components/automations/sessionLifecycle/exactTurnAutomationPrefill';
import { Modal } from '@/modal';
import { t } from '@/text';
import { useAllMachines } from '@/sync/domains/state/storage';
import { getMachineDisplayName } from '@/utils/sessions/machineUtils';

import { TriggerPopover } from './TriggerPopover';
import { TriggerRow } from './TriggerRow';
import { projectSessionTriggerGroups, type SessionTriggerGroupModel, type SessionTriggerRowModel } from './sessionTriggerGroups';
import {
    SESSION_TRIGGER_WHEN_KINDS,
    readTriggerThen,
    readTriggerWhen,
    type TriggerFormValue,
    type TriggerWhenValue,
} from './sessionTriggerForm';
import { useSessionTriggers } from './useSessionTriggers';
import { useTriggerThenOptions } from './useTriggerThenOptions';
import { useOpenTriggerAsWorkflow } from './useOpenTriggerAsWorkflow';

export type SessionTriggersSectionViewProps = Readonly<{
    groups: readonly SessionTriggerGroupModel[];
    status: 'loading' | 'ready' | 'failed';
    pullRequestLinksUnavailable?: boolean;
    /** Trigger rows whose write is in flight. */
    pendingKeys: ReadonlySet<string>;
    onToggle: (row: SessionTriggerRowModel, next: boolean) => void;
    onOpen: (row: SessionTriggerRowModel, anchor: React.RefObject<View | null>) => void;
    onAdd: (anchor: React.RefObject<View | null>) => void;
    onRetry: () => void;
    /** The header "+", which also anchors a popover the host opens itself (a bound turn). */
    addAnchorRef?: React.RefObject<View | null>;
    /** A retired Automation link reveals this set's first row, as in the Account column. */
    deepLinkAutomationId?: string;
}>;

/**
 * The session's Triggers section in the Work tab (FIN 04 §5.5; 07 S16 and its owner-approved
 * presentation; lab `convo-W9`, phone `convo-P9`): flat, grouped by event under a glyph and a
 * legible label, rows named by what they run, header "Triggers · {n} on · ⓘ · +". Built on I4-W's
 * `WorkSection anatomy="page"` and one `HappierPageSheetGroup` per event, whose group boundary draws
 * the only separators. With none it says so and offers the first trigger (07 S16 empty state).
 */
export const SessionTriggersSectionView = React.memo(function SessionTriggersSectionView(props: SessionTriggersSectionViewProps) {
    const { theme } = useUnistyles();
    const ownAddAnchorRef = React.useRef<View>(null);
    const addAnchorRef = props.addAnchorRef ?? ownAddAnchorRef;
    const onCount = props.groups.reduce((count, group) => count + group.rows.filter((row) => row.enabled).length, 0);
    const empty = props.groups.length === 0;
    const deepLinkedRow = props.deepLinkAutomationId
        ? props.groups.flatMap((group) => group.rows).find((row) => row.automationId === props.deepLinkAutomationId)
        : undefined;
    return (
        <WorkSection
            testID="session-work-triggers"
            anatomy="page"
            title={t('workflows.triggers.section.title')}
            count={empty ? '' : t('workflows.triggers.section.countOn', { count: onCount })}
            info={t('workflows.triggers.section.info')}
            loading={props.status === 'loading' && empty}
            action={(
                <View ref={addAnchorRef} collapsable={false}>
                    <IconButton
                        testID="session-work-triggers-add"
                        iconName="plus"
                        variant="plain"
                        accessibilityLabel={t('workflows.triggers.section.add')}
                        tooltip={t('workflows.triggers.section.add')}
                        onPress={() => props.onAdd(addAnchorRef)}
                    />
                </View>
            )}
        >
            {props.status === 'failed' ? (
                <SurfaceFreshnessLine
                    testID="session-work-triggers-failed"
                    tone="warning"
                    reason={t('workflows.triggers.section.loadFailed')}
                    action={{ label: t('workflows.triggers.popover.tryAgain'), onPress: props.onRetry }}
                />
            ) : null}
            {props.pullRequestLinksUnavailable ? (
                <SurfaceFreshnessLine
                    testID="session-work-trigger-links-unavailable"
                    tone="warning"
                    reason={t('workflows.triggers.pullRequest.loadFailed')}
                    action={{ label: t('workflows.triggers.popover.tryAgain'), onPress: props.onRetry }}
                />
            ) : null}
            {empty && props.status === 'ready' ? (
                <EmptyState
                    testID="session-work-triggers-empty"
                    layout="line"
                    title={t('workflows.triggers.section.emptyTitle')}
                    subtitle={t('workflows.triggers.section.emptyBody')}
                    primaryAction={{ label: t('workflows.triggers.section.add'), onPress: () => props.onAdd(addAnchorRef) }}
                />
            ) : props.groups.map((group) => (
                <HappierPageSheetGroup
                    key={group.id}
                    header={(
                        <CollectionListGroupLabel
                            testID={`session-work-triggers-group:${group.id}`}
                            title={group.title}
                            count={group.rows.length > 1 ? group.rows.length : undefined}
                            mark={<Icon name={group.glyph} size={16} color={theme.colors.text.secondary} />}
                        />
                    )}
                >
                    {group.rows.map((row) => (
                        <AnchoredTriggerRow
                            key={row.key}
                            row={row}
                            pending={props.pendingKeys.has(row.key)}
                            deepLink={row === deepLinkedRow}
                            onToggle={props.onToggle}
                            onOpen={props.onOpen}
                        />
                    ))}
                </HappierPageSheetGroup>
            ))}
        </WorkSection>
    );
});

/** A row that anchors its own popover beside it. */
const AnchoredTriggerRow = React.memo(function AnchoredTriggerRow(props: Readonly<{
    row: SessionTriggerRowModel;
    pending: boolean;
    deepLink: boolean;
    onToggle: SessionTriggersSectionViewProps['onToggle'];
    onOpen: SessionTriggersSectionViewProps['onOpen'];
}>) {
    const anchorRef = React.useRef<View>(null);
    const { row } = props;
    const openRef = React.useRef(props.onOpen);
    openRef.current = props.onOpen;
    React.useEffect(() => { if (props.deepLink) openRef.current(row, anchorRef); }, [props.deepLink]);
    return (
        <View ref={anchorRef} collapsable={false}>
            <TriggerRow
                testID={`session-work-trigger:${row.key}`}
                title={row.title}
                outcome={row.outcome}
                qualifier={row.qualifier}
                multiline={row.legacy}
                enabled={row.enabled}
                toggleDisabled={props.pending || row.sourceUnavailable || row.legacy}
                onToggle={(next) => props.onToggle(row, next)}
                onPress={() => props.onOpen(row, anchorRef)}
            />
        </View>
    );
});

/** The kinds a session's popover lists but cannot add here, each with its reason (07 S16). */
const SESSION_UNAVAILABLE_KINDS = {
    sessionStarts: 'workflows.triggers.kindDescription.sessionStarts',
} as const;

type OpenPopover = Readonly<{ anchor: React.RefObject<View | null>; row: SessionTriggerRowModel | null }>;

/**
 * The section as the Work tab mounts it in ORC's `triggersSection` slot: the session's triggers
 * through `session.trigger.*` (the one writer the Work tab and agents share), the switch and the
 * popover each one immediate call with its own result.
 */
export const SessionTriggersSection = React.memo(function SessionTriggersSection(props: Readonly<{ sessionId: string }>) {
    const read = useSessionTriggers(props.sessionId);
    const openTriggerAsWorkflow = useOpenTriggerAsWorkflow();
    const thenOptions = useTriggerThenOptions();
    const machines = useAllMachines();
    const groups = React.useMemo(() => projectSessionTriggerGroups({
        sets: read.sets,
        lastRunAtByAutomationId: read.lastRunAtByAutomationId,
        resolveWorkflowTitle: thenOptions.resolveWorkflowTitle,
        resolveMachineTitle: (id) => getMachineDisplayName(machines.find((machine) => machine.id === id) ?? { id, absence: 'unlisted' }),
        formatAge: (at) => formatRelativeTimeShort(at, Date.now()),
    }), [read.lastRunAtByAutomationId, read.sets, thenOptions.resolveWorkflowTitle, machines]);

    const [pendingKeys, setPendingKeys] = React.useState<ReadonlySet<string>>(() => new Set());
    const toggle = React.useCallback((row: SessionTriggerRowModel, next: boolean) => {
        if (row.legacy || pendingKeys.has(row.key)) return;
        setPendingKeys((current) => new Set(current).add(row.key));
        void read.update({ triggerId: row.triggerId, expectedRevision: row.revision, patch: { enabled: next } })
            .catch(() => read.retry())
            .finally(() => setPendingKeys((current) => {
                const nextKeys = new Set(current);
                nextKeys.delete(row.key);
                return nextKeys;
            }));
    }, [pendingKeys, read]);

    const [popover, setPopover] = React.useState<OpenPopover | null>(null);
    const initial = React.useMemo((): TriggerFormValue | null => {
        const row = popover?.row;
        if (!row) return null;
        const set = read.sets.find((candidate) => candidate.automationId === row.automationId);
        const trigger = set?.triggers.find((candidate) => candidate.id === row.triggerId);
        const when = trigger ? readTriggerWhen(trigger) : null;
        if (!set?.target || !when) return null;
        return { when, then: readTriggerThen(set.target, set.context?.executionTarget, set.context?.inputs), enabled: row.enabled };
    }, [popover, read.sets]);

    const close = React.useCallback(() => setPopover(null), []);
    const row = popover?.row ?? null;

    // "When this turn finishes…" (04 §5.5): the deep link carries the exact turn; the section opens
    // its popover once with When a turn ends bound to that turn (the existing exact-turn owner parses it).
    const addAnchorRef = React.useRef<View>(null);
    const params = useLocalSearchParams();
    const exactTurn = parseExactTurnAutomationPrefillRoute(params);
    const boundTurnId = exactTurn.kind === 'valid' && exactTurn.prefill.sourceSessionId === props.sessionId
        ? exactTurn.prefill.sourceTurnId
        : null;
    const consumedTurnRef = React.useRef<string | null>(null);
    const [boundWhen, setBoundWhen] = React.useState<TriggerWhenValue | undefined>(undefined);
    React.useEffect(() => {
        if (boundTurnId === null || consumedTurnRef.current === boundTurnId || read.status !== 'ready') return;
        consumedTurnRef.current = boundTurnId;
        setBoundWhen({ kind: 'turnEnds', sourceTurnId: boundTurnId });
        setPopover({ anchor: addAnchorRef, row: null });
    }, [boundTurnId, read.status]);
    return (
        <>
            <SessionTriggersSectionView
                groups={groups}
                status={read.status}
                pullRequestLinksUnavailable={!Array.isArray(read.pullRequestLinks) && read.pullRequestLinks.status === 'unavailable'}
                pendingKeys={pendingKeys}
                onToggle={toggle}
                onOpen={(openedRow, anchor) => {
                    if (openedRow.legacy) {
                        void Modal.confirm(t('workflows.triggers.editor.editInWorkflows'), undefined, {
                            confirmText: t('workflows.triggers.popover.deleteTrigger'), destructive: true,
                        }).then((confirmed) => (confirmed ? read.remove(openedRow.triggerId) : null)).catch((error: unknown) => {
                            read.retry();
                            void Modal.alert(t('common.error'), error instanceof Error ? error.message : t('workflows.triggers.section.saveFailed'));
                        });
                        return;
                    }
                    // A trigger whose workflow is gone offers only Delete trigger (07 S16).
                    if (openedRow.sourceUnavailable) {
                        void Modal.confirm(t('workflows.triggers.row.workflowDeleted'), undefined, {
                            confirmText: t('workflows.triggers.popover.deleteTrigger'),
                            destructive: true,
                        }).then((confirmed) => (confirmed ? read.remove(openedRow.triggerId) : null)).catch(() => read.retry());
                        return;
                    }
                    setPopover({ anchor, row: openedRow });
                }}
                onAdd={(anchor) => { setBoundWhen(undefined); setPopover({ anchor, row: null }); }}
                onRetry={read.retry}
                addAnchorRef={addAnchorRef}
                {...(typeof params.trigger === 'string' ? { deepLinkAutomationId: params.trigger } : {})}
            />
            {popover !== null && (row === null || initial !== null) ? (
                <TriggerPopover
                    testID="session-work-trigger-popover"
                    anchorRef={popover.anchor}
                    onRequestClose={close}
                    whenKinds={SESSION_TRIGGER_WHEN_KINDS}
                    unavailableKinds={Object.fromEntries(Object.entries(SESSION_UNAVAILABLE_KINDS).map(([kind, key]) => [kind, t(key)]))}
                    sessionId={props.sessionId}
                    {...(Array.isArray(read.pullRequestLinks) ? { pullRequestLinks: read.pullRequestLinks } : {})}
                    initial={initial}
                    {...(row === null && boundWhen !== undefined ? { initialWhen: boundWhen } : {})}
                    workflowOptions={thenOptions.workflowOptions}
                    onSubmit={async (value, write) => {
                        if (write.target === null || write.trigger === null) return;
                        if (row === null) {
                            await read.add({ target: write.target, trigger: write.trigger, inputs: write.inputs });
                            return;
                        }
                        const { enabled: _enabled, ...definition } = write.trigger;
                        await read.update({
                            triggerId: row.triggerId,
                            expectedRevision: row.revision,
                            patch: { target: write.target, trigger: definition, enabled: value.enabled, inputs: write.inputs },
                        });
                    }}
                    machineId={read.machineId}
                    {...(row === null ? {} : {
                        onSaveAsWorkflow: (target: TriggerTargetV1) => openTriggerAsWorkflow(target, {
                            scope: 'session', sessionId: props.sessionId, triggerId: row.triggerId, expectedRevision: row.revision,
                        }),
                        onToggleEnabled: async (next: boolean) => {
                            await read.update({ triggerId: row.triggerId, expectedRevision: row.revision, patch: { enabled: next } });
                        },
                        onDelete: async () => { await read.remove(row.triggerId); },
                    })}
                />
            ) : null}
        </>
    );
});
