import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { presentApprovalProfile } from '@/components/approvals/approvalProfilePresentation';
import { SESSION_AUTHORING_NONE_OPTION_ID } from '@/components/sessions/authoring/controls/sessionAuthoringFieldControls';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { SelectionListFilterChip } from '@/components/ui/selectionList';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import type { useApprovalProfiles } from '@/hooks/approvals/useApprovalProfiles';
import { t } from '@/text';

export const APPROVAL_PROFILE_INHERIT_OPTION_ID = 'inherit';

type Choice =
    | Readonly<{ mode: 'required'; value: string; onChange: (value: string) => void }>
    | Readonly<{ mode: 'session'; value: string | null; onChange: (value: string | null) => void }>
    | Readonly<{ mode: 'authoring'; value: string | null | undefined; onChange: (value: string | null | undefined) => void }>;

/** The profile owner's typed selection drives both the picker and its missing-reference warning. */
export function ApprovalProfileSelect(props: Choice & Readonly<{
    testID: string;
    source: Pick<ReturnType<typeof useApprovalProfiles>, 'profiles' | 'selection' | 'ready' | 'unavailable'>;
    disabled?: boolean;
    titleMeta?: React.ReactNode;
    presentation?: 'chips' | 'fields';
}>) {
    const [open, setOpen] = React.useState(false);
    const missing = props.source.selection?.resolution.status === 'missing';
    const items = React.useMemo(() => {
        const result: DropdownMenuItem[] = [];
        if (props.mode === 'authoring') result.push({ id: APPROVAL_PROFILE_INHERIT_OPTION_ID,
            title: t('workflows.triggers.guided.profile.inheritSessionProfile') });
        if (props.mode !== 'required') result.push({ id: SESSION_AUTHORING_NONE_OPTION_ID,
            title: t('workflows.triggers.guided.profile.noExplicitSessionProfile') });
        for (const profile of props.source.profiles) {
            const presented = presentApprovalProfile(profile);
            result.push({ id: profile.id, testID: `${props.testID}:${profile.id}`, title: presented.title,
                ...(presented.subtitle ? { subtitle: presented.subtitle } : {}) });
        }
        return result;
    }, [props.mode, props.source.profiles, props.testID]);
    const disabled = props.disabled === true || !props.source.ready;
    const select = (id: string) => {
        if (disabled) return;
        setOpen(false);
        if (id === APPROVAL_PROFILE_INHERIT_OPTION_ID && props.mode === 'authoring') props.onChange(undefined);
        else if (id === SESSION_AUTHORING_NONE_OPTION_ID && props.mode !== 'required') props.onChange(null);
        else props.onChange(id);
    };
    const selectedId = props.value === undefined ? APPROVAL_PROFILE_INHERIT_OPTION_ID
        : props.value === null ? SESSION_AUTHORING_NONE_OPTION_ID : props.value;
    const profileChosen = typeof props.value === 'string';
    const valueLabel = missing && props.source.selection ? presentApprovalProfile(props.source.selection.profile).title
        : items.find(item => item.id === selectedId)?.title ?? t(props.source.unavailable ? 'common.unavailable' : 'common.loading');
    // A chip keeps its own width wherever it is placed; only the field presentation spans its row.
    return <View style={props.presentation === 'chips' ? styles.chipHost : undefined}>
        <DropdownMenu testID={props.testID} open={open}
            onOpenChange={next => { if (!disabled) setOpen(next); }}
            items={items} selectedId={props.value === undefined ? APPROVAL_PROFILE_INHERIT_OPTION_ID
                : props.value === null ? SESSION_AUTHORING_NONE_OPTION_ID : props.value}
            onSelect={select}
            emptyLabel={t(props.source.unavailable ? 'common.unavailable' : 'common.loading')}
            trigger={props.presentation === 'chips' ? ({ toggle }) => <SelectionListFilterChip filter={{
                id: props.testID, testID: `${props.testID}-chip`, label: t('workflows.triggers.guided.profile.title'),
                // Until a profile is chosen the chip names its field, as every filter chip does; the inherit/none
                // sentences belong to the open menu, where they are choices (QA-SHELL-1114 F3).
                valueLabel: profileChosen ? valueLabel : t('workflows.triggers.guided.profile.title'), muted: !profileChosen,
                disabled, open: false, onOpenChange: next => { if (next) toggle(); }, renderPopoverContent: () => null,
            }} /> : undefined}
            itemTrigger={props.presentation === 'chips' ? undefined : { title: t('workflows.triggers.guided.profile.title'),
                subtitle: t('workflows.triggers.guided.profile.description'),
                showSelectedSubtitle: false,
                ...(missing ? { detailFormatter: () => props.source.selection
                    ? presentApprovalProfile(props.source.selection.profile).title : null, field: { invalid: true } } : {}),
                itemProps: { disabled, subtitleLines: 0, accessoryLayout: 'stacked', titleMeta: props.titleMeta } }} />
        {missing ? <SurfaceFreshnessLine testID={`${props.testID}-missing`} tone="warning"
            reason={t('workflows.triggers.guided.profile.missing')} /> : null}
        {props.source.unavailable ? <SurfaceFreshnessLine testID={`${props.testID}-unavailable`}
            reason={t('common.unavailable')} /> : null}
    </View>;
}

const styles = StyleSheet.create({
    chipHost: {
        alignSelf: 'flex-start',
        maxWidth: '100%',
    },
});
