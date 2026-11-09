import type { EffectiveInputField  as EffectiveActionInputField} from '@happier-dev/protocol/inputs/inputFieldRuntime';
import * as React from 'react';
import { View } from 'react-native';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { ActionInputFields, type ActionFieldOption } from '@/components/sessions/actions/ActionInputFields';
import type { ResolveSessionActionFieldOptions } from '@/components/sessions/actions/sessionActionFieldOptions';
import { ExecutionRunAgentMark } from '@/components/sessions/runs/ExecutionRunAgentMark';
import { Icon } from '@/components/ui/icons/Icon';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

import { ExecutionRunProfilePicker } from './ExecutionRunProfilePicker';
import type { ExecutionRunLauncherBackendChoice } from './resolveExecutionRunLauncherBackendChoices';
import type { ExecutionRunLauncherProfileChoice } from './resolveExecutionRunLauncherProfileChoices';
import { motionTokens } from '@/components/ui/motion/motionTokens';

const alwaysCustomFieldPaths = new Set([
    'backendTargetKeys',
    'engineIds',
    'instructions',
    // "Report to this session" is the composer's own chip, never a generic field.
    'notifyParentOnCompletion',
    'secretReferenceOverlay',
    'teamCredentialModel',
    'teamCredentialSessionBindingConsent',
]);

/** One decision of the start: who runs it, its permissions, its profile, or its remaining fields. */
export type ExecutionRunLauncherOptionsSection = 'backends' | 'permissions' | 'profiles' | 'fields';

const ALL_SECTIONS: readonly ExecutionRunLauncherOptionsSection[] = ['backends', 'permissions', 'profiles', 'fields'];

/** A choice of 2–4 short options is a segmented control; more fall back to the wrapping choices. */
const MAX_SEGMENTED_OPTIONS = 4;

export function resolveExecutionRunLauncherOptionFields(params: Readonly<{
    fields: readonly EffectiveActionInputField[];
    hasSpecializedPermissionOptions: boolean;
}>): readonly EffectiveActionInputField[] {
    return params.fields.filter((field) => {
        if (field.path === 'permissionMode') return !params.hasSpecializedPermissionOptions;
        return !alwaysCustomFieldPaths.has(field.path);
    });
}

const stylesheet = StyleSheet.create((theme) => ({
    root: {
        gap: theme.space.s20,
        // It fills a chip popover, whose panel gives its content no inset of its own.
        padding: theme.space.s12,
    },
    field: {
        gap: theme.space.s8,
    },
    label: {
        color: theme.colors.text.primary,
        ...Typography.variant('label', 'semiBold'),
    },
    labelCount: {
        color: theme.colors.text.secondary,
        ...Typography.variant('body'),
        fontVariant: ['tabular-nums'],
    },
    labelRow: {
        flexDirection: 'row',
        alignItems: 'baseline',
        gap: theme.space.s8,
    },
    tileGroup: {
        gap: theme.space.s8,
    },
    tileGroupLabel: {
        color: theme.colors.text.secondary,
        ...Typography.variant('meta'),
    },
    tiles: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: theme.space.s10,
    },
    tile: {
        flexGrow: 1,
        flexBasis: 200,
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s10,
        paddingVertical: theme.space.s10,
        paddingHorizontal: theme.space.s12,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.base,
    },
    tileSelected: {
        borderColor: theme.colors.text.primary,
    },
    tileTitle: {
        flex: 1,
        minWidth: 0,
        color: theme.colors.text.primary,
        ...Typography.variant('label', 'semiBold'),
    },
    tileTitleDisabled: {
        color: theme.colors.text.secondary,
    },
    check: {
        width: 20,
        height: 20,
        borderRadius: 6,
        borderWidth: 1.5,
        borderColor: theme.colors.border.strong,
        alignItems: 'center',
        justifyContent: 'center',
    },
    checkRound: {
        borderRadius: 10,
    },
    checkOn: {
        borderColor: theme.colors.text.primary,
        backgroundColor: theme.colors.text.primary,
    },
    pair: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: theme.space.s20,
    },
    pairItem: {
        flexGrow: 1,
        flexBasis: 240,
        gap: theme.space.s8,
    },
    segmented: {
        alignSelf: 'flex-start',
    },
    chips: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: theme.space.s10,
    },
    chip: {
        justifyContent: 'center',
        paddingVertical: theme.space.s8,
        paddingHorizontal: theme.space.s12,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.inset,
    },
    chipSelected: {
        borderColor: theme.colors.text.secondary,
    },
    chipText: {
        color: theme.colors.text.secondary,
        ...Typography.variant('meta', 'semiBold'),
    },
    chipTextSelected: {
        color: theme.colors.text.primary,
    },
}));

/**
 * The choices a start asks for, one decision per row: who runs it — agent tiles with their marks,
 * several at once where the intent allows — then permissions and profile side by side, then the
 * remaining Action fields. The composer-first start (lab `convo-S1`) shows each decision in its own
 * chip popover by asking for one `sections` subset at a time, so every chip asks the same question
 * the same way.
 */
export const ExecutionRunLauncherOptions = React.memo((props: Readonly<{
    backendChoices: readonly ExecutionRunLauncherBackendChoice[];
    selectedBackendTargetKeys: readonly string[];
    profileChoices: readonly ExecutionRunLauncherProfileChoice[];
    selectedProfileId: string;
    selectedPermissionMode: string;
    permissionModeOptions: readonly Pick<ActionFieldOption, 'value' | 'label'>[];
    fields: readonly EffectiveActionInputField[];
    input: Record<string, unknown>;
    editable: boolean;
    resolveFieldOptions: ResolveSessionActionFieldOptions;
    /** Which decisions to show; all of them when omitted. */
    sections?: readonly ExecutionRunLauncherOptionsSection[];
    /** Narrows the `fields` section to the paths a chip owns (the review scope, or everything else). */
    includeFieldPath?: (path: string) => boolean;
    /** The Machine the choices run on; names where an Agent that is not ready there stands. */
    machineName?: string;
    /** The "Who" row's title for this intent ("Who reviews"); the generic section title otherwise. */
    backendSectionLabel?: string;
    /** Several agents can be chosen (a review); each tile then carries a checkbox and the row a count. */
    multiSelect?: boolean;
    onSelectBackend: (targetKey: string) => void;
    onSelectProfile: (choice: ExecutionRunLauncherProfileChoice) => void;
    onPatch: (patch: Record<string, unknown>) => void;
}>) => {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    // Wrapped chips sit one gap apart; each hit area takes half of it so neighbours never overlap.
    const chipHitReach = React.useMemo(() => {
        const half = theme.space.s10 / 2;
        return { top: half, bottom: half, left: half, right: half };
    }, [theme.space.s10]);
    const sections = props.sections ?? ALL_SECTIONS;
    const includeFieldPath = props.includeFieldPath;
    const optionFields = React.useMemo(() => resolveExecutionRunLauncherOptionFields({
        fields: props.fields,
        hasSpecializedPermissionOptions: props.permissionModeOptions.length > 0,
    }).filter((field) => !includeFieldPath || includeFieldPath(field.path)), [includeFieldPath, props.fields, props.permissionModeOptions.length]);
    const showPermissions = sections.includes('permissions') && props.permissionModeOptions.length > 1;
    const showProfiles = sections.includes('profiles') && props.profileChoices.length > 0;
    const selectedCount = props.backendChoices.filter((choice) => props.selectedBackendTargetKeys.includes(choice.targetKey)).length;
    // Agents the Machine has are offered first; the ones it lacks follow under the picker's own
    // "Not on <machine> yet" heading, so a dimmed tile never has to explain itself.
    const choiceGroups = React.useMemo(() => {
        const machine = props.machineName ?? '';
        return [
            { key: 'ready', label: null, choices: props.backendChoices.filter((choice) => !choice.unavailable) },
            { key: 'notOnMachine', label: t('machineAgents.notOnMachineYet', { machine }), choices: props.backendChoices.filter((choice) => choice.unavailable === 'notOnMachine') },
            { key: 'cantRun', label: t('machineAgents.cantRunOn', { machine }), choices: props.backendChoices.filter((choice) => choice.unavailable === 'cantRun') },
        ].filter((group) => group.choices.length > 0);
    }, [props.backendChoices, props.machineName]);
    const permissionTabs = React.useMemo(
        () => props.permissionModeOptions.map((option) => ({ id: String(option.value), label: option.label })),
        [props.permissionModeOptions],
    );
    const segmentedPermissions = permissionTabs.length > 1 && permissionTabs.length <= MAX_SEGMENTED_OPTIONS;

    return (
        <View style={styles.root}>
            {sections.includes('backends') ? (
                <View style={styles.field}>
                    <View style={styles.labelRow}>
                        <Text accessibilityRole="header" style={styles.label}>
                            {props.backendSectionLabel ?? t('executionRuns.newRun.sections.backends')}
                        </Text>
                        {props.multiSelect && selectedCount > 0 ? (
                            <Text style={styles.labelCount}>{t('runPage.launcher.selectedCount', { count: selectedCount })}</Text>
                        ) : null}
                    </View>
                    {choiceGroups.map((group) => (
                        <View key={group.key} style={styles.tileGroup}>
                            {group.label ? <Text accessibilityRole="header" style={styles.tileGroupLabel}>{group.label}</Text> : null}
                            <View style={styles.tiles}>
                                {group.choices.map((choice) => {
                                    const selected = props.selectedBackendTargetKeys.includes(choice.targetKey);
                                    const disabled = choice.disabled || !props.editable;
                                    return (
                                        <HappierPressable
                                            key={choice.targetKey}
                                            testID={`execution-run-launcher-target:${choice.targetKey}`}
                                            accessibilityRole={props.multiSelect ? 'checkbox' : 'radio'}
                                            accessibilityLabel={t('executionRuns.newRun.a11y.toggleBackend', { backendId: choice.title })}
                                            selected={selected}
                                            checked={selected}
                                            disabled={disabled}
                                            onPress={() => props.onSelectBackend(choice.targetKey)}
                                            style={({ pressed }) => [
                                                styles.tile,
                                                selected ? styles.tileSelected : null,
                                                {
                                                    opacity: choice.disabled ? 0.5 : pressed ? motionTokens.press.opacity : 1,
                                                },
                                            ]}
                                        >
                                            <ExecutionRunAgentMark agentId={choice.agentId} size={30} />
                                            <Text numberOfLines={1} style={[styles.tileTitle, choice.disabled ? styles.tileTitleDisabled : null]}>
                                                {choice.title}
                                            </Text>
                                            <View style={[styles.check, props.multiSelect ? null : styles.checkRound, selected ? styles.checkOn : null]}>
                                                {selected ? <Icon name="check" size={13} color={theme.colors.surface.base} /> : null}
                                            </View>
                                        </HappierPressable>
                                    );
                                })}
                            </View>
                        </View>
                    ))}
                </View>
            ) : null}
            {showPermissions || showProfiles ? (
                <View style={styles.pair}>
                    {showPermissions ? (
                        <View style={styles.pairItem}>
                            <Text accessibilityRole="header" style={styles.label}>{t('executionRuns.newRun.sections.permissions')}</Text>
                            {segmentedPermissions ? (
                                <View style={styles.segmented}>
                                    <SegmentedTabBar
                                        role="radiogroup"
                                        tabs={permissionTabs}
                                        activeTabId={props.selectedPermissionMode}
                                        onSelectTab={(value) => props.onPatch({ permissionMode: value })}
                                        segmentSizing="content"
                                        disabled={!props.editable}
                                        accessibilityLabel={t('executionRuns.newRun.sections.permissions')}
                                        testIDPrefix="execution-run-launcher-permission-mode"
                                    />
                                </View>
                            ) : (
                                <View style={styles.chips}>
                                    {props.permissionModeOptions.map((option) => {
                                        const selected = props.selectedPermissionMode === option.value;
                                        return (
                                            <HappierPressable
                                                key={String(option.value)}
                                                testID={`execution-run-launcher-permission-mode:${String(option.value)}`}
                                                accessibilityRole="button"
                                                accessibilityLabel={t('executionRuns.newRun.a11y.selectPermissionMode', { mode: option.label })}
                                                selected={selected}
                                                hitReach={chipHitReach}
                                                disabled={!props.editable}
                                                onPress={() => props.onPatch({ permissionMode: option.value })}
                                                style={({ pressed }) => [
                                                    styles.chip,
                                                    selected ? styles.chipSelected : null,
                                                    {
                                                        opacity: !props.editable ? 0.45 : pressed ? motionTokens.press.opacity : 1,
                                                    },
                                                ]}
                                            >
                                                <Text style={[styles.chipText, selected ? styles.chipTextSelected : null]}>{option.label}</Text>
                                            </HappierPressable>
                                        );
                                    })}
                                </View>
                            )}
                        </View>
                    ) : null}
                    {showProfiles ? (
                        <View style={styles.pairItem}>
                            <ExecutionRunProfilePicker
                                choices={props.profileChoices}
                                selectedId={props.selectedProfileId}
                                editable={props.editable}
                                sectionLabel={t('executionRuns.newRun.sections.profiles')}
                                resolveAccessibilityLabel={(title) => t('executionRuns.newRun.a11y.selectProfile', { profile: title })}
                                onSelect={props.onSelectProfile}
                            />
                        </View>
                    ) : null}
                </View>
            ) : null}
            {sections.includes('fields') && optionFields.length > 0 ? (
                <ActionInputFields
                    fields={optionFields}
                    input={props.input}
                    editable={props.editable}
                    resolveFieldOptions={props.resolveFieldOptions}
                    onPatch={props.onPatch}
                />
            ) : null}
        </View>
    );
});
