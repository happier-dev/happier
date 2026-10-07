import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import {
    SessionAgentStartAllowListsV1Schema,
    type SessionAgentStartAllowListsV1,
} from '@happier-dev/protocol/account/settings/sessionAgentStartAllowListsV1';

import { getResolvedBackendCatalogEntries } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { getEnabledAgentIds } from '@/agents/catalog/enabled';
import { AgentCatalogIdentityIcon } from '@/agents/presentation/AgentCatalogIdentityIcon';
import { useRoleCatalog } from '@/components/roles/catalog/useRoleCatalog';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { renderDropdownItemTriggerRightElement } from '@/components/ui/forms/dropdown/renderDropdownItemTriggerRightElement';
import { resolveFieldBoxColors } from '@/components/ui/forms/fieldBox';
import { SettingRow } from '@/components/settings/shell/SettingRow';
import { withItemGroupDividers } from '@/components/ui/lists/ItemGroup';
import { useSetting } from '@/sync/domains/state/storage';
import { t } from '@/text';

import { ACTIONS_CREATE_SESSION_SETTINGS } from './actionsSettings';

type ListKey = 'allowedRoleIds' | 'allowedAgentTargetKeys';
type Choice = Readonly<{ id: string; title: string; icon?: React.ReactNode }>;
type MenuProps = Readonly<{
    anchorRef: React.RefObject<View | null>;
    selected: readonly string[] | null;
    onChange: (selected: string[] | null) => void;
    onClose: () => void;
    testID: string;
}>;

/** Both fields save one Account setting; neither adds keys to released policy V1. */
export function SessionAgentStartAllowListsControls(props: Readonly<{
    rawAllowLists: unknown;
    disabled?: boolean;
    showDivider?: boolean;
    onChange: (allowLists: SessionAgentStartAllowListsV1) => void;
}>) {
    const lists = SessionAgentStartAllowListsV1Schema.parse(props.rawAllowLists ?? {});
    return <>{withItemGroupDividers((['allowedRoleIds', 'allowedAgentTargetKeys'] as const).map((key) => (
        <AllowListField key={key} listKey={key} selected={lists[key]} disabled={props.disabled}
            onChange={(selected) => props.onChange(SessionAgentStartAllowListsV1Schema.parse({ ...lists, [key]: selected }))} />
    )), { first: false, last: props.showDivider === false })}</>;
}

function AllowListField(props: Readonly<{
    listKey: ListKey;
    selected: readonly string[] | null;
    disabled?: boolean;
    showDivider?: boolean;
    onChange: (selected: string[] | null) => void;
}>) {
    const { theme } = useUnistyles();
    const anchorRef = React.useRef<View>(null);
    const [open, setOpen] = React.useState(false);
    const roles = props.listKey === 'allowedRoleIds';
    const testID = `settings-actions:session-start-allow-lists:${roles ? 'roles' : 'agents'}`;
    const detail = props.selected === null ? t('common.all') : props.selected.length === 0
        ? t('settingsActions.spawnPolicy.allowLists.none')
        : t('settingsActions.spawnPolicy.allowLists.selected', { count: props.selected.length });
    const menuProps: MenuProps = { anchorRef, selected: props.selected, onChange: props.onChange, onClose: () => setOpen(false), testID: `${testID}:menu` };
    return (
        <View ref={anchorRef} collapsable={false}>
            <SettingRow setting={ACTIONS_CREATE_SESSION_SETTINGS.settings[props.listKey]} testID={testID}
                showDivider={props.showDivider}
                disabled={props.disabled} showChevron={false} accessoryLayout="adaptive"
                accessibilityExpanded={open}
                onPress={() => { if (!props.disabled) setOpen(true); }}
                rightElement={renderDropdownItemTriggerRightElement({
                    detail, open, detailColor: theme.colors.text.primary, chevronColor: theme.colors.text.secondary,
                    field: resolveFieldBoxColors(theme),
                })} />
            {open ? roles ? <RoleAllowListMenu {...menuProps} /> : <AgentAllowListMenu {...menuProps} /> : null}
        </View>
    );
}

function RoleAllowListMenu(props: MenuProps) {
    const catalog = useRoleCatalog();
    return <AllowListMenu {...props} choices={catalog.entries.map((entry) => ({ id: entry.roleId, title: entry.role.name }))}
        emptyLabel={catalog.status === 'loading' ? t('common.loading') : catalog.status === 'failed' ? t('roles.settings.loadFailed') : null}
        onRetry={catalog.status === 'failed' ? catalog.refresh : undefined} />;
}

function AgentAllowListMenu(props: MenuProps) {
    const acpCatalogSettingsV1 = useSetting('acpCatalogSettingsV1');
    const backendEnabledByTargetKey = useSetting('backendEnabledByTargetKey');
    const entries = getResolvedBackendCatalogEntries({ enabledAgentIds: getEnabledAgentIds({ backendEnabledByTargetKey }), acpCatalogSettingsV1, backendEnabledByTargetKey });
    return <AllowListMenu {...props} choices={entries.map((entry) => ({ id: entry.backendTargetKey, title: entry.title,
        icon: <AgentCatalogIdentityIcon entry={entry.agentCatalogEntry} machineId={null} serverId={null} current={false} />,
    }))} />;
}

function AllowListMenu(props: MenuProps & Readonly<{ choices: readonly Choice[]; emptyLabel?: string | null; onRetry?: () => void }>) {
    const items: DropdownMenuItem[] = [
        { id: 'all', title: t('common.all'), checked: props.selected === null },
        { id: 'none', title: t('settingsActions.spawnPolicy.allowLists.none'), checked: props.selected?.length === 0 },
        ...props.choices.map((choice) => ({ ...choice, id: `choice:${choice.id}`, checked: props.selected === null || props.selected.includes(choice.id) })),
        ...(props.selected ?? []).filter((id) => !props.choices.some((choice) => choice.id === id))
            .map((id) => ({ id: `choice:${id}`, title: t('common.unavailable'), checked: true })),
        ...(props.emptyLabel ? [{ id: 'status', title: props.emptyLabel, disabled: true }] : []),
        ...(props.onRetry ? [{ id: 'retry', title: t('common.retry') }] : []),
    ];
    return <DropdownMenu open testID={props.testID} popoverAnchorRef={props.anchorRef} items={items}
        closeOnSelect={false} search showCategoryTitles={false} onOpenChange={(next) => { if (!next) props.onClose(); }}
        onSelect={(id) => {
            if (id === 'retry') { props.onRetry?.(); return; }
            if (id === 'status') return;
            if (id === 'all' || id === 'none') { props.onChange(id === 'all' ? null : []); return; }
            if (!id.startsWith('choice:')) return;
            const choiceId = id.slice('choice:'.length);
            const selected = props.selected ?? props.choices.map((choice) => choice.id);
            props.onChange(selected.includes(choiceId) ? selected.filter((value) => value !== choiceId) : [...selected, choiceId]);
        }} />;
}
