import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Item } from '@/components/ui/lists/Item';
import { SelectionListFilterChip } from '@/components/ui/selectionList';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { SessionAuthoringFieldSelectTrigger } from '@/components/sessions/authoring/controls/SessionAuthoringFieldSelectTrigger';
import type { useApprovalProfiles } from '@/hooks/approvals/useApprovalProfiles';
import { t } from '@/text';
import { fireAndForget } from '@/utils/system/fireAndForget';
import type { ApprovalProfileV1 } from '@happier-dev/protocol/actions';

export const APPROVAL_PROFILE_MACHINE_DEFAULT_OPTION_ID = 'machine_default';
export const APPROVAL_PROFILE_ACCOUNT_OPTION_ID = 'account_settings';
export const APPROVAL_PROFILE_INHERIT_OPTION_ID = 'inherit';
export const APPROVAL_PROFILE_NONE_OPTION_ID = 'none';

/**
 * `session`: a Session's own reference; null or absent follows its Machine's default, which falls back to the
 * Account settings. `machine`: a Machine's default for my Sessions there; null uses the Account settings.
 * `default`: a Team, Group or project default; absent inherits the layer above, null deliberately sets no profile.
 */
export type ApprovalProfileChoiceMode = 'session' | 'machine' | 'default';

/** The words of a `default` choice's first two rows; the host owns whose default is inherited. */
export type ApprovalProfileDefaultChoices = Readonly<{
    inherit: Readonly<{ title: string; subtitle?: string; detail: string }>;
    none: Readonly<{ title: string; subtitle?: string }>;
}>;

/** The Machine a new or running Session belongs to and the profile it defaults to; null when no Machine is known yet. */
export type ApprovalProfileMachineDefault = Readonly<{ profile: Pick<ApprovalProfileV1, 'id' | 'name'> | null }> | null;

type Choice =
    | Readonly<{ mode: 'session'; value: string | null | undefined; onChange: (value: string | null) => void }>
    | Readonly<{ mode: 'machine'; value: string | null; onChange: (value: string | null) => void }>
    | Readonly<{ mode: 'default'; value: string | null | undefined; onChange: (value: string | null | undefined) => void;
        defaultChoices: ApprovalProfileDefaultChoices }>;

function machineDefaultTitle(machineDefault: ApprovalProfileMachineDefault): string {
    if (machineDefault === null) return t('workflows.triggers.guided.profile.machineDefault');
    return t('workflows.triggers.guided.profile.machineDefaultNamed', {
        profile: machineDefault.profile?.name ?? t('workflows.triggers.guided.profile.accountSettings'),
    });
}

/** The one approval-profile choice list: the field's menu, the composer chip and the Machine row offer the same rows. */
export function buildApprovalProfileChoices(mode: ApprovalProfileChoiceMode, profiles: readonly Pick<ApprovalProfileV1, 'id' | 'name'>[],
    testID: string, machineDefault: ApprovalProfileMachineDefault = null, defaultChoices?: ApprovalProfileDefaultChoices): DropdownMenuItem[] {
    const result: DropdownMenuItem[] = [];
    if (mode === 'default') {
        if (!defaultChoices) throw new Error('A default approval profile choice needs its inherit and None rows');
        result.push({ id: APPROVAL_PROFILE_INHERIT_OPTION_ID, testID: `${testID}:${APPROVAL_PROFILE_INHERIT_OPTION_ID}`,
            title: defaultChoices.inherit.title, subtitle: defaultChoices.inherit.subtitle });
        result.push({ id: APPROVAL_PROFILE_NONE_OPTION_ID, testID: `${testID}:${APPROVAL_PROFILE_NONE_OPTION_ID}`,
            title: defaultChoices.none.title, subtitle: defaultChoices.none.subtitle });
    } else result.push(mode === 'session'
        ? { id: APPROVAL_PROFILE_MACHINE_DEFAULT_OPTION_ID, testID: `${testID}:${APPROVAL_PROFILE_MACHINE_DEFAULT_OPTION_ID}`,
            title: machineDefaultTitle(machineDefault) }
        : { id: APPROVAL_PROFILE_ACCOUNT_OPTION_ID, testID: `${testID}:${APPROVAL_PROFILE_ACCOUNT_OPTION_ID}`,
            title: t('workflows.triggers.guided.profile.accountSettings') });
    for (const profile of profiles) result.push({ id: profile.id, testID: `${testID}:${profile.id}`, title: profile.name });
    return result;
}

/** The choice row a stored value selects: no profile follows the Machine (a Session) or the Account (a Machine). */
export function approvalProfileChoiceId(mode: ApprovalProfileChoiceMode, value: string | null | undefined): string {
    if (typeof value === 'string') return value;
    if (mode === 'default') return value === null ? APPROVAL_PROFILE_NONE_OPTION_ID : APPROVAL_PROFILE_INHERIT_OPTION_ID;
    return mode === 'session' ? APPROVAL_PROFILE_MACHINE_DEFAULT_OPTION_ID : APPROVAL_PROFILE_ACCOUNT_OPTION_ID;
}

/** The stored value a chosen row means: a profile id, or null for "no profile of its own". */
export function approvalProfileChoiceValue(id: string): string | null {
    return id === APPROVAL_PROFILE_MACHINE_DEFAULT_OPTION_ID || id === APPROVAL_PROFILE_ACCOUNT_OPTION_ID
        || id === APPROVAL_PROFILE_NONE_OPTION_ID ? null : id;
}

/** The chosen row's words, for a sentence that names the current choice ("Changed elsewhere to …"). */
export function approvalProfileChoiceTitle(mode: ApprovalProfileChoiceMode, value: string | null | undefined,
    profiles: readonly Pick<ApprovalProfileV1, 'id' | 'name'>[], machineDefault: ApprovalProfileMachineDefault = null,
    defaultChoices?: ApprovalProfileDefaultChoices): string {
    const id = approvalProfileChoiceId(mode, value);
    if (id === APPROVAL_PROFILE_INHERIT_OPTION_ID && defaultChoices) return defaultChoices.inherit.detail;
    return buildApprovalProfileChoices(mode, profiles, '', machineDefault, defaultChoices).find(choice => choice.id === id)?.title
        ?? t('workflows.triggers.guided.profile.deletedName');
}

/**
 * A chip names what applies: the chosen profile or the Machine's own profile. While a new Session follows a
 * Machine with no profile it names its field, as every chip in the row does (QA-SHELL-1114 F3).
 */
export function approvalProfileChipLabel(params: Readonly<{
    value: string | null | undefined;
    profiles: readonly Pick<ApprovalProfileV1, 'id' | 'name'>[];
    machineDefault: ApprovalProfileMachineDefault;
    ready: boolean;
}>): Readonly<{ label: string; chosen: boolean }> {
    const fieldName = t('workflows.triggers.guided.profile.title');
    if (typeof params.value !== 'string') {
        const profile = params.machineDefault?.profile;
        return profile ? { label: t('workflows.triggers.guided.profile.machineDefaultChip', { profile: profile.name }), chosen: true }
            : { label: fieldName, chosen: false };
    }
    const profile = params.profiles.find(row => row.id === params.value);
    return { label: profile?.name ?? (params.ready ? t('workflows.triggers.guided.profile.deletedName') : t('common.loading')), chosen: true };
}

/** The profile owner's typed read drives both the picker and its missing-reference warning. */
export function ApprovalProfileSelect(props: Choice & Readonly<{
    testID: string;
    source: Pick<ReturnType<typeof useApprovalProfiles>, 'profiles' | 'ready' | 'unavailable'>
        & Partial<Pick<ReturnType<typeof useApprovalProfiles>, 'profileRows' | 'requestCatalog' | 'displayProfiles' | 'selectedDescriptor'>>;
    machineDefault?: ApprovalProfileMachineDefault;
    disabled?: boolean;
    titleMeta?: React.ReactNode;
    description?: string;
    /**
     * `fields` (default) a labelled field; `chips` the composer chip; `row` a value row among glyph-led rows
     * (Session Info's Setup: glyph, label, current choice, chevron), collapsed until pressed; `selects` the
     * bordered field select of the Session controls' `selects` presentation, naming the choice alone.
     */
    presentation?: 'chips' | 'fields' | 'row' | 'selects';
    /** The row presentation's glyph, in its section's glyph column. */
    icon?: React.ReactNode;
    /** The fields presentation's control placement: `stacked` under the words (default), or `adaptive` beside them. */
    layout?: 'stacked' | 'adaptive';
}>) {
    const [open, setOpen] = React.useState(false);
    const machineDefault = props.machineDefault ?? null;
    const displayProfiles = props.source.displayProfiles ?? props.source.profiles;
    const defaultChoices = props.mode === 'default' ? props.defaultChoices : undefined;
    const items = React.useMemo(() => buildApprovalProfileChoices(props.mode, displayProfiles, props.testID, machineDefault, defaultChoices),
        [props.mode, displayProfiles, props.testID, machineDefault, defaultChoices]);
    const displayReady = props.source.ready || props.source.selectedDescriptor !== undefined;
    const missing = displayReady && typeof props.value === 'string'
        && !displayProfiles.some(profile => profile.id === props.value);
    const disabled = props.disabled === true || (!props.source.ready && !props.source.requestCatalog);
    const selectedId = approvalProfileChoiceId(props.mode, props.value);
    const select = (id: string) => {
        if (disabled || !props.source.ready) return;
        setOpen(false);
        if (props.mode === 'default') props.onChange(id === APPROVAL_PROFILE_INHERIT_OPTION_ID ? undefined : approvalProfileChoiceValue(id));
        else props.onChange(approvalProfileChoiceValue(id));
    };
    const selectAnchorRef = React.useRef<React.ComponentRef<typeof View> | null>(null);
    const chip = props.presentation === 'chips' || props.presentation === 'selects' ? approvalProfileChipLabel({ value: props.value,
        profiles: displayProfiles, machineDefault, ready: displayReady }) : null;
    const row = props.presentation === 'row';
    // A chip keeps its own width wherever it is placed; only the field presentation spans its row.
    return <View style={chip ? styles.chipHost : undefined}>
        <DropdownMenu testID={props.testID} open={open}
            onOpenChange={next => {
                if (disabled) return;
                setOpen(next);
                if (next && props.source.requestCatalog) fireAndForget(props.source.requestCatalog(), { tag: 'ApprovalProfileSelect.catalog' });
            }}
            items={items} selectedId={selectedId}
            onSelect={select}
            emptyLabel={t(props.source.unavailable ? 'common.unavailable' : 'common.loading')}
            trigger={chip && props.presentation === 'selects' ? ({ toggle }) => <SessionAuthoringFieldSelectTrigger
                anchorRef={selectAnchorRef} title={t('workflows.triggers.guided.profile.title')} label={chip.label}
                open={open} disabled={disabled} onPress={toggle} testID={`${props.testID}-select`} />
            : chip ? ({ toggle }) => <SelectionListFilterChip filter={{
                id: props.testID, testID: `${props.testID}-chip`, label: t('workflows.triggers.guided.profile.title'),
                valueLabel: chip.label, muted: !chip.chosen,
                disabled, open: false, onOpenChange: next => { if (next) toggle(); }, renderPopoverContent: () => null,
            }} /> : row ? ({ toggle }) => <Item testID={`${props.testID}-row`}
                title={t('workflows.triggers.guided.profile.title')} icon={props.icon} density="compact"
                // The short choice ("Machine default", a profile's name) keeps the value beside its label; the menu names
                // the Machine's own profile.
                detail={displayReady
                    ? approvalProfileChoiceTitle(props.mode, props.value, displayProfiles, null, defaultChoices)
                    : t(props.source.unavailable ? 'common.unavailable' : 'common.loading')}
                disabled={disabled} onPress={toggle} /> : undefined}
            itemTrigger={chip || row ? undefined : { title: t('workflows.triggers.guided.profile.title'),
                subtitle: props.description ?? t('workflows.triggers.guided.profile.description'),
                showSelectedSubtitle: false,
                ...(missing ? { detailFormatter: () => t('workflows.triggers.guided.profile.deletedName'), field: { invalid: true } }
                    // An inherited default shows what applies, not the row's "Use …" wording.
                    : defaultChoices ? { detailFormatter: (item: DropdownMenuItem | null) => item?.id === APPROVAL_PROFILE_INHERIT_OPTION_ID
                        ? defaultChoices.inherit.detail : item?.title ?? null } : {}),
                itemProps: { disabled, subtitleLines: 0, accessoryLayout: props.layout ?? 'stacked', titleMeta: props.titleMeta } }} />
        {missing ? <SurfaceFreshnessLine testID={`${props.testID}-missing`} tone="warning"
            reason={t('workflows.triggers.guided.profile.missing')} /> : null}
        {props.source.unavailable ? <SurfaceFreshnessLine testID={`${props.testID}-unavailable`}
            reason={t('common.unavailable')} /> : null}
    </View>;
}

const styles = StyleSheet.create({
    chipHost: {
        alignSelf: 'flex-start',
        // The chip keeps its own width even when the missing-profile line beneath it is wider.
        alignItems: 'flex-start',
        maxWidth: '100%',
    },
});
