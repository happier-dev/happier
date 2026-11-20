import type { EffectiveInputField  as EffectiveActionInputField} from '@happier-dev/protocol/inputs/inputFieldRuntime';
import * as React from 'react';
import { View } from 'react-native';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { ActionInputFields, type ActionFieldOption } from '@/components/sessions/actions/ActionInputFields';
import type { ResolveSessionActionFieldOptions } from '@/components/sessions/actions/sessionActionFieldOptions';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

import { ExecutionRunProfilePicker } from './ExecutionRunProfilePicker';
import type { ExecutionRunLauncherProfileChoice } from './resolveExecutionRunLauncherProfileChoices';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { normalizeInputHintsText } from '@happier-dev/protocol/inputs/inputFields';
import { resolveEffectiveInputFields } from '@happier-dev/protocol/inputs/inputFieldRuntime';
import { parseQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { useProjectedPluginLocalizedTextResolver } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { buildSessionActionFieldOptionsResolver } from '@/components/sessions/actions/sessionActionFieldOptions';
import type { ExecutionRunProfileCapability } from '@/sync/domains/executionRuns/extractExecutionRunsBackendsFromMachineCapabilities';

const resolveProfileFieldOptions = buildSessionActionFieldOptionsResolver({});

/** Profile declarations name their public controls; the validation schema can also contain private options. */
export function ExecutionRunProfileOptionFields(props: Readonly<{
    profile: ExecutionRunProfileCapability;
    options: Record<string, unknown>;
    editable: boolean;
    onPatch: (patch: Record<string, unknown>) => void;
}>) {
    const localize = useProjectedPluginLocalizedTextResolver();
    const hints = React.useMemo(() => {
        const identity = parseQualifiedPluginContributionKey(props.profile.id);
        return identity && props.profile.optionsInputHints
            ? normalizeInputHintsText(props.profile.optionsInputHints, value => localize(identity.pluginId, value))
            : undefined;
    }, [localize, props.profile.id, props.profile.optionsInputHints]);
    const fields = React.useMemo(() => resolveEffectiveInputFields({ inputHints: hints }, props.options), [hints, props.options]);
    return <ActionInputFields fields={fields} input={props.options} editable={props.editable}
        resolveFieldOptions={resolveProfileFieldOptions} onPatch={props.onPatch} />;
}

const alwaysCustomFieldPaths = new Set([
    'backendTargetKeys',
    'reviewers',
    'instructions',
    // "Report to this session" is the composer's own chip, never a generic field.
    'notifyParentOnCompletion',
    'secretReferenceOverlay',
    'teamCredentialModel',
    'teamCredentialSessionBindingConsent',
]);

/**
 * One decision of the start: its permissions, its profile, or its remaining fields. Who runs it is the
 * contextual start composer's Who list, never a section here.
 */
export type ExecutionRunLauncherOptionsSection = 'permissions' | 'profiles' | 'fields';

const ALL_SECTIONS: readonly ExecutionRunLauncherOptionsSection[] = ['permissions', 'profiles', 'fields'];

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
    label: {
        color: theme.colors.text.primary,
        ...Typography.variant('label', 'semiBold'),
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
 * The choices a start asks for, one decision per row: permissions and profile side by side, then the
 * remaining Action fields. The composer-first start (lab `convo-S1`) shows each decision in its own
 * chip popover by asking for one `sections` subset at a time, so every chip asks the same question
 * the same way.
 */
export const ExecutionRunLauncherOptions = React.memo((props: Readonly<{
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
    const permissionTabs = React.useMemo(
        () => props.permissionModeOptions.map((option) => ({ id: String(option.value), label: option.label })),
        [props.permissionModeOptions],
    );
    const segmentedPermissions = permissionTabs.length > 1 && permissionTabs.length <= MAX_SEGMENTED_OPTIONS;

    return (
        <View style={styles.root}>
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
