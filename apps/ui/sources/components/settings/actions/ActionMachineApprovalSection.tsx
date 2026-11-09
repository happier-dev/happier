import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import type { ActionApprovalScopeV1, ActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ITEM_SUBTITLE_TEXT_METRICS } from '@/components/ui/lists/itemDensityMetrics';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { Typography } from '@/constants/Typography';
import { useMachineAdministrationTargetPickerRows } from '@/sync/domains/machines/administration/useTargetSelection';
import { t } from '@/text';

import { ActionApprovalLooseningNotice } from './ActionApprovalLooseningNotice';
import { ActionScopedApprovalRow, type ActionScopedApprovalMode } from './ActionScopedApprovalRow';
import { resolveActionSettingsTargetControlState } from './resolveActionSettingsControlState';
import { useActionPolicyWriter } from './useActionPolicyWriter';

/** Agents are the audience a per-Machine preference is offered for (Plan 40 §6.1). */
const AUDIENCE = 'agent' as const;

/**
 * "On specific machines": the agent preference of one Action on chosen Machines. It is mounted only
 * for Actions whose spec declares Machine approval scope, so only those pages read the Machine
 * inventory. Rows exist for Machines with a stored preference plus those added in this visit; every
 * write is one exact `(Action, Machine, audience)` key through `actions.policy.set`.
 */
export const ActionMachineApprovalSection = React.memo(function ActionMachineApprovalSection(props: Readonly<{
    actionId: ActionId;
    settings: ActionsSettingsV1;
    disabled: boolean;
}>) {
    const { theme } = useUnistyles();
    const { actionId, settings } = props;
    const prefix = `settings-actions:action:${actionId}:machines`;
    const writePolicy = useActionPolicyWriter();
    const pickerRows = useMachineAdministrationTargetPickerRows();
    const [added, setAdded] = React.useState<readonly string[]>([]);
    const [addOpen, setAddOpen] = React.useState(false);
    const [removing, setRemoving] = React.useState<string | null>(null);

    const machineNames = React.useMemo(() => {
        const names = new Map<string, string>();
        for (const row of pickerRows) {
            if (!names.has(row.candidate.target.machineId)) names.set(row.candidate.target.machineId, row.candidate.displayName);
        }
        return names;
    }, [pickerRows]);
    const machineIds = React.useMemo(() => {
        const stored = (settings.scopedApprovalPreferences ?? [])
            .filter(row => row.actionId === actionId && row.scope.kind === 'machine')
            .map(row => (row.scope as Extract<ActionApprovalScopeV1, { kind: 'machine' }>).machineId);
        return [...new Set([...stored, ...added])];
    }, [actionId, added, settings.scopedApprovalPreferences]);
    const rows = React.useMemo(() => machineIds.map((machineId) => {
        const scope = { kind: 'machine', machineId } as const;
        const state = resolveActionSettingsTargetControlState({ settings, scope, actionId, targetId: AUDIENCE });
        const value: ActionScopedApprovalMode = state.kind === 'approval' && (state.value === 'ask_first' || state.value === 'allowed')
            ? state.value : 'default';
        // A Machine the inventory no longer lists keeps only an explicit removal.
        const name = machineNames.get(machineId);
        return { machineId, scope, value, name, removed: name === undefined && pickerRows.length > 0,
            // An inherited Allowed is warned about once, by the setting above; a row warns for its own Allowed.
            notice: state.kind === 'approval' && value === 'allowed' ? state.approvalLooseningNotice : undefined };
    }), [actionId, machineIds, machineNames, pickerRows.length, settings]);
    const addItems = React.useMemo(() => pickerRows
        .filter(row => !machineIds.includes(row.candidate.target.machineId))
        .map(row => ({ id: row.candidate.target.machineId, title: row.candidate.displayName,
            testID: `${prefix}:add:${row.candidate.target.machineId}` })), [machineIds, pickerRows, prefix]);

    const handleChange = React.useCallback((scope: ActionApprovalScopeV1, mode: ActionScopedApprovalMode) => {
        void writePolicy({ actionId, audience: AUDIENCE, scope, mode });
    }, [actionId, writePolicy]);
    const handleRemove = React.useCallback((machineId: string) => {
        setRemoving(machineId);
        void writePolicy({ actionId, change: { kind: 'scoped_approval_remove', scope: { kind: 'machine', machineId } } })
            .finally(() => setRemoving(null));
        setAdded(current => current.filter(id => id !== machineId));
    }, [actionId, writePolicy]);
    const handleAdd = React.useCallback((machineId: string) => {
        setAdded(current => (current.includes(machineId) ? current : [...current, machineId]));
        setAddOpen(false);
    }, []);

    const machineIcon = <Icon name="desktop" color={theme.colors.text.secondary} />;
    const othersFollowStyle = React.useMemo(() => ({ ...Typography.default('regular'), color: theme.colors.text.secondary,
        ...ITEM_SUBTITLE_TEXT_METRICS.comfortable }), [theme.colors.text.secondary]);
    return (
        <ItemGroup title={t('settingsActions.scopedMachines.title')} description={t('settingsActions.scopedMachines.description')}>
            {rows.map(row => (row.notice ? (
                <ActionApprovalLooseningNotice
                    key={`${row.machineId}:loosening`}
                    testID={`${prefix}:loosening:${row.machineId}`}
                    notice={row.notice}
                    description={t('settingsActions.scopedMachines.looseningBody', { machine: row.name ?? row.machineId })}
                    disabled={props.disabled}
                />
            ) : null))}
            {rows.map(row => (row.removed ? (
                <Item
                    key={row.machineId}
                    testID={`${prefix}:machine:${row.machineId}`}
                    icon={machineIcon}
                    title={t('settingsActions.scopedMachines.removedMachine')}
                    subtitle={t('settingsActions.scopedMachines.removedMachineBody')}
                    mode="info"
                    showChevron={false}
                    rightElement={(
                        <RoundButton
                            testID={`${prefix}:machine:${row.machineId}:remove`}
                            size="small"
                            display="inverted"
                            title={t('settingsActions.scopedMachines.remove')}
                            loading={removing === row.machineId}
                            disabled={props.disabled}
                            onPress={() => handleRemove(row.machineId)}
                        />
                    )}
                />
            ) : (
                <ActionScopedApprovalRow
                    key={row.machineId}
                    testIDPrefix={`${prefix}:machine:${row.machineId}`}
                    title={row.name ?? row.machineId}
                    icon={machineIcon}
                    value={row.value}
                    disabled={props.disabled}
                    onChange={(mode) => handleChange(row.scope, mode)}
                />
            )))}
            <Item
                testID={`${prefix}:others`}
                title={t('settingsActions.scopedMachines.othersFollow')}
                // A closing note, not a choice: it reads in the rows' secondary line style.
                titleStyle={othersFollowStyle}
                mode="info"
                showChevron={false}
                // On a phone the button moves beneath the note instead of squeezing it.
                accessoryLayout="adaptive"
                rightElement={(
                    <DropdownMenu
                        testID={`${prefix}:add`}
                        open={addOpen}
                        onOpenChange={setAddOpen}
                        items={addItems}
                        onSelect={handleAdd}
                        emptyLabel={t('settingsActions.scopedMachines.noMachinesToAdd')}
                        matchTriggerWidth={false}
                        popoverPhonePresentation="sheet"
                        popoverAccessibilityLabel={t('settingsActions.scopedMachines.addMachine')}
                        trigger={({ toggle }) => (
                            <SectionActionButton
                                testID={`${prefix}:add:trigger`}
                                title={t('settingsActions.scopedMachines.addMachine')}
                                icon="plus"
                                expanded={addOpen}
                                disabled={props.disabled}
                                onPress={toggle}
                            />
                        )}
                    />
                )}
            />
        </ItemGroup>
    );
});
