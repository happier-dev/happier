import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';

export type MultiSelectCandidate = Readonly<{
    id: string;
    title: string;
    subtitle?: string;
}>;

export type MultiSelectFieldProps = Readonly<{
    candidates: ReadonlyArray<MultiSelectCandidate>;
    selectedIds: ReadonlyArray<string>;
    onCommit: (selectedIds: ReadonlyArray<string>) => void | Promise<void>;
    title: string;
    subtitle: (selectedCount: number, totalCount: number) => string;
    emptySubtitle: string;
    searchPlaceholder: string;
    optionTestIDPrefix: string;
    icon: React.ReactNode;
    disabled?: boolean;
    minimumSelected?: number;
    exclusiveId?: string | readonly string[];
    testID?: string;
}>;

const SEARCHABLE_CANDIDATE_THRESHOLD = 8;

export const MultiSelectField = React.memo(function MultiSelectField(props: MultiSelectFieldProps) {
    const { theme } = useUnistyles();
    const [open, setOpen] = React.useState(false);
    const [draft, setDraft] = React.useState<ReadonlySet<string> | null>(null);
    const committed = React.useMemo(() => new Set(props.selectedIds), [props.selectedIds]);
    const selected = draft ?? committed;
    const selectedCount = React.useMemo(
        () => props.candidates.reduce((count, candidate) => count + (selected.has(candidate.id) ? 1 : 0), 0),
        [props.candidates, selected],
    );

    const commitDraft = React.useCallback((next: ReadonlySet<string>) => {
        const ids = props.candidates.map((candidate) => candidate.id).filter((id) => next.has(id));
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
    }, [commitDraft, draft, props.selectedIds]);

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
                        color={checked ? theme.colors.accent.blue : theme.colors.text.secondary}
                    />
                </View>
            ),
        };
    }), [props.candidates, props.optionTestIDPrefix, selected, theme.colors.accent.blue, theme.colors.text.secondary]);

    const disabled = props.disabled || props.candidates.length === 0;
    return (
        <DropdownMenu
            open={open}
            onOpenChange={handleOpenChange}
            items={items}
            onSelect={(id) => setDraft((current) => {
                const next = new Set(current ?? props.selectedIds);
                const exclusiveIds = typeof props.exclusiveId === 'string' ? [props.exclusiveId] : props.exclusiveId ?? [];
                if (exclusiveIds.includes(id)) return new Set([id]);
                for (const exclusiveId of exclusiveIds) next.delete(exclusiveId);
                if (next.has(id)) {
                    if (next.size <= (props.minimumSelected ?? 0)) return next;
                    next.delete(id);
                } else next.add(id);
                return next;
            })}
            closeOnSelect={false}
            selectedId={null}
            variant="selectable"
            rowKind="item"
            showCategoryTitles={false}
            matchTriggerWidth
            search={props.candidates.length > SEARCHABLE_CANDIDATE_THRESHOLD}
            searchPlaceholder={props.searchPlaceholder}
            trigger={({ toggle, open: isOpen }) => (
                <Item
                    testID={props.testID}
                    title={props.title}
                    subtitle={props.candidates.length === 0 ? props.emptySubtitle : props.subtitle(selectedCount, props.candidates.length)}
                    icon={props.icon}
                    rightElement={<Icon name={isOpen ? 'caret-up' : 'caret-down'} size={20} color={theme.colors.text.secondary} />}
                    onPress={disabled ? undefined : toggle}
                    disabled={disabled}
                    showChevron={false}
                />
            )}
        />
    );
});
