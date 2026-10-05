import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { t } from '@/text';

export type PoolMultiSelectCandidate = Readonly<{
    id: string;
    title: string;
    subtitle?: string;
}>;

export type PoolMultiSelectFieldProps = Readonly<{
    candidates: ReadonlyArray<PoolMultiSelectCandidate>;
    selectedIds: ReadonlyArray<string>;
    onCommit: (selectedIds: ReadonlyArray<string>) => void | Promise<void>;
    title: string;
    subtitle: (
        selectedCount: number,
        totalCount: number,
        selectedIds: ReadonlySet<string>,
    ) => string;
    emptySubtitle: string;
    searchPlaceholder: string;
    optionTestIDPrefix: string;
    disabled?: boolean;
    minimumSelected?: number;
    exclusiveId?: string;
    testID?: string;
    /** Always offer search (a members list the person scans by name), not only for long lists. */
    searchable?: boolean;
    menuChrome?: boolean;
    connectAction?: Readonly<{ label: string; onPress: () => void }>;
    /** Controlled open state, for a surface that opens the menu from elsewhere (an empty state). */
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
    /** A different trigger than the field row (a section's "Manage members" button). */
    renderTrigger?: (input: Readonly<{ toggle: () => void; open: boolean; disabled: boolean }>) => React.ReactNode;
}>;

const SEARCHABLE_CANDIDATE_THRESHOLD = 8;

/** Shared draft-and-commit interaction owner for Pool multi-select fields. */
export const PoolMultiSelectField = React.memo(function PoolMultiSelectField(
    props: PoolMultiSelectFieldProps,
) {
    const { theme } = useUnistyles();
    const [localOpen, setLocalOpen] = React.useState(false);
    const open = props.open ?? localOpen;
    const onOpenChange = props.onOpenChange;
    const setOpen = React.useCallback((next: boolean) => {
        setLocalOpen(next);
        onOpenChange?.(next);
    }, [onOpenChange]);
    const [draft, setDraft] = React.useState<ReadonlySet<string> | null>(null);
    const committed = React.useMemo(() => new Set(props.selectedIds), [props.selectedIds]);
    const selected = draft ?? committed;
    const selectedCount = React.useMemo(
        () => props.candidates.reduce(
            (count, candidate) => count + (selected.has(candidate.id) ? 1 : 0),
            0,
        ),
        [props.candidates, selected],
    );

    const commitDraft = React.useCallback((next: ReadonlySet<string>) => {
        const ids = props.candidates
            .map((candidate) => candidate.id)
            .filter((id) => next.has(id));
        const previous = new Set(props.selectedIds);
        if (ids.length === previous.size && ids.every((id) => previous.has(id))) return;
        void props.onCommit(ids);
    }, [props]);

    const handleOpenChange = React.useCallback((nextOpen: boolean) => {
        setOpen(nextOpen);
        if (nextOpen) {
            setDraft(new Set(props.selectedIds));
            return;
        }
        if (draft) commitDraft(draft);
        setDraft(null);
    }, [commitDraft, draft, props.selectedIds, setOpen]);

    const items = React.useMemo(() => props.candidates.map((candidate) => {
        const checked = selected.has(candidate.id);
        return {
            id: candidate.id,
            testID: `${props.optionTestIDPrefix}:${candidate.id}`,
            title: candidate.title,
            subtitle: candidate.subtitle,
            icon: (
                <View style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
                    <Icon
                        name={checked ? 'check-square' : 'square'}
                        size={20}
                        weight={checked ? 'fill' : 'regular'}
                        color={checked ? theme.colors.text.primary : theme.colors.text.secondary}
                    />
                </View>
            ),
        };
    }), [
        props.candidates,
        props.optionTestIDPrefix,
        selected,
        theme.colors.text.primary,
        theme.colors.text.secondary,
    ]);

    const disabled = props.disabled || props.candidates.length === 0;
    // A controlled open request (the empty state's action) seeds the draft the same way a trigger press does.
    React.useEffect(() => {
        if (open && draft === null) setDraft(new Set(props.selectedIds));
    }, [draft, open, props.selectedIds]);
    return (
        <DropdownMenu
            header={props.menuChrome ? <Item title={props.title} subtitle={props.subtitle(selectedCount, props.candidates.length, selected)} mode="info" showChevron={false} showDivider={false} /> : undefined}
            footer={props.menuChrome ? <View style={{ padding: 12, borderTopWidth: 1, borderTopColor: theme.colors.border.default, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                {props.connectAction ? <RoundButton testID={`${props.testID}:connect`} size="small" display="inverted" title={props.connectAction.label} onPress={() => { handleOpenChange(false); props.connectAction?.onPress(); }} /> : <View />}
                <RoundButton testID={`${props.testID}:done`} size="small" display="secondary" title={t('common.done')} onPress={() => handleOpenChange(false)} />
            </View> : undefined}
            open={open}
            onOpenChange={handleOpenChange}
            items={items}
            onSelect={(id) => setDraft((current) => {
                const next = new Set(current ?? props.selectedIds);
                if (props.exclusiveId && id === props.exclusiveId) return new Set([id]);
                if (props.exclusiveId) next.delete(props.exclusiveId);
                if (next.has(id)) {
                    if (next.size <= (props.minimumSelected ?? 0)) return next;
                    next.delete(id);
                } else {
                    next.add(id);
                }
                return next;
            })}
            closeOnSelect={false}
            selectedId={null}
            variant="selectable"
            rowKind="item"
            showCategoryTitles={false}
            // A section button (Manage members) is narrower than its list; a field row is not.
            matchTriggerWidth={!props.renderTrigger}
            {...(props.renderTrigger ? { placement: 'bottom' as const, popoverAnchorAlign: 'end' as const, maxWidthCap: 360 } : {})}
            search={props.searchable === true || props.candidates.length > SEARCHABLE_CANDIDATE_THRESHOLD}
            searchPlaceholder={props.searchPlaceholder}
            trigger={({ toggle, open: isOpen }) => props.renderTrigger ? props.renderTrigger({ toggle, open: isOpen, disabled }) : (
                <Item
                    testID={props.testID}
                    title={props.title}
                    subtitle={props.candidates.length === 0
                        ? props.emptySubtitle
                        : props.subtitle(selectedCount, props.candidates.length, selected)}
                    rightElement={(
                        <Icon
                            name={isOpen ? 'caret-up' : 'caret-down'}
                            size={20}
                            color={theme.colors.text.secondary}
                        />
                    )}
                    onPress={disabled ? undefined : toggle}
                    disabled={disabled}
                    showChevron={false}
                />
            )}
        />
    );
});
