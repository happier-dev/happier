import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import {
    DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1,
    SESSION_PERMISSION_MODES,
    SessionAgentSpawnPolicyV1Schema,
    type SessionAgentSpawnPolicyV1,
} from '@happier-dev/protocol';

import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Switch } from '@/components/ui/forms/Switch';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { t, type TranslationKey } from '@/text';
import { Icon, type IconName } from '@/components/ui/icons/Icon';

const stylesheet = StyleSheet.create(() => ({
    optionIcon: {
        width: 32,
        height: 32,
        alignItems: 'center',
        justifyContent: 'center',
    },
}));

type BooleanPolicyKey = {
    [K in keyof SessionAgentSpawnPolicyV1]: SessionAgentSpawnPolicyV1[K] extends boolean ? K : never;
}[keyof SessionAgentSpawnPolicyV1];

type PolicyToggleDefinition = Readonly<{
    key: BooleanPolicyKey;
    titleKey: TranslationKey;
    subtitleKey: TranslationKey;
    icon: IconName;
}>;

const POLICY_TOGGLE_DEFINITIONS: readonly PolicyToggleDefinition[] = [
    {
        key: 'allowCustomDirectory',
        titleKey: 'settingsActions.spawnPolicy.toggles.allowCustomDirectory.title',
        subtitleKey: 'settingsActions.spawnPolicy.toggles.allowCustomDirectory.subtitle',
        icon: 'folder-open',
    },
    {
        key: 'allowCrossMachine',
        titleKey: 'settingsActions.spawnPolicy.toggles.allowCrossMachine.title',
        subtitleKey: 'settingsActions.spawnPolicy.toggles.allowCrossMachine.subtitle',
        icon: 'desktop',
    },
    {
        key: 'allowBackendTargetOverride',
        titleKey: 'settingsActions.spawnPolicy.toggles.allowBackendTargetOverride.title',
        subtitleKey: 'settingsActions.spawnPolicy.toggles.allowBackendTargetOverride.subtitle',
        icon: 'cpu',
    },
    {
        key: 'allowModelOverride',
        titleKey: 'settingsActions.spawnPolicy.toggles.allowModelOverride.title',
        subtitleKey: 'settingsActions.spawnPolicy.toggles.allowModelOverride.subtitle',
        icon: 'sparkle',
    },
    {
        key: 'allowPermissionModeOverride',
        titleKey: 'settingsActions.spawnPolicy.toggles.allowPermissionModeOverride.title',
        subtitleKey: 'settingsActions.spawnPolicy.toggles.allowPermissionModeOverride.subtitle',
        icon: 'shield-check',
    },
    {
        key: 'allowAgentModeOverride',
        titleKey: 'settingsActions.spawnPolicy.toggles.allowAgentModeOverride.title',
        subtitleKey: 'settingsActions.spawnPolicy.toggles.allowAgentModeOverride.subtitle',
        icon: 'sliders-horizontal',
    },
    {
        key: 'allowConfigOptionOverrides',
        titleKey: 'settingsActions.spawnPolicy.toggles.allowConfigOptionOverrides.title',
        subtitleKey: 'settingsActions.spawnPolicy.toggles.allowConfigOptionOverrides.subtitle',
        icon: 'sliders-horizontal',
    },
    {
        key: 'allowProfileOverride',
        titleKey: 'settingsActions.spawnPolicy.toggles.allowProfileOverride.title',
        subtitleKey: 'settingsActions.spawnPolicy.toggles.allowProfileOverride.subtitle',
        icon: 'user-circle',
    },
    {
        key: 'allowEnvironmentVariables',
        titleKey: 'settingsActions.spawnPolicy.toggles.allowEnvironmentVariables.title',
        subtitleKey: 'settingsActions.spawnPolicy.toggles.allowEnvironmentVariables.subtitle',
        icon: 'key',
    },
    {
        key: 'allowConnectedServicesOverride',
        titleKey: 'settingsActions.spawnPolicy.toggles.allowConnectedServicesOverride.title',
        subtitleKey: 'settingsActions.spawnPolicy.toggles.allowConnectedServicesOverride.subtitle',
        icon: 'link',
    },
    {
        key: 'allowMcpSelectionOverride',
        titleKey: 'settingsActions.spawnPolicy.toggles.allowMcpSelectionOverride.title',
        subtitleKey: 'settingsActions.spawnPolicy.toggles.allowMcpSelectionOverride.subtitle',
        icon: 'cube',
    },
    {
        key: 'allowTranscriptStorageOverride',
        titleKey: 'settingsActions.spawnPolicy.toggles.allowTranscriptStorageOverride.title',
        subtitleKey: 'settingsActions.spawnPolicy.toggles.allowTranscriptStorageOverride.subtitle',
        icon: 'archive',
    },
] as const;

const PERMISSION_CEILING_OPTIONS = [
    {
        mode: 'default',
        titleKey: 'settingsActions.spawnPolicy.permissionCeiling.options.default.title',
        subtitleKey: 'settingsActions.spawnPolicy.permissionCeiling.options.default.subtitle',
    },
    {
        mode: 'acceptEdits',
        titleKey: 'settingsActions.spawnPolicy.permissionCeiling.options.acceptEdits.title',
        subtitleKey: 'settingsActions.spawnPolicy.permissionCeiling.options.acceptEdits.subtitle',
    },
    {
        mode: 'bypassPermissions',
        titleKey: 'settingsActions.spawnPolicy.permissionCeiling.options.bypassPermissions.title',
        subtitleKey: 'settingsActions.spawnPolicy.permissionCeiling.options.bypassPermissions.subtitle',
    },
    {
        mode: 'plan',
        titleKey: 'settingsActions.spawnPolicy.permissionCeiling.options.plan.title',
        subtitleKey: 'settingsActions.spawnPolicy.permissionCeiling.options.plan.subtitle',
    },
    {
        mode: 'read-only',
        titleKey: 'settingsActions.spawnPolicy.permissionCeiling.options.read-only.title',
        subtitleKey: 'settingsActions.spawnPolicy.permissionCeiling.options.read-only.subtitle',
    },
    {
        mode: 'safe-yolo',
        titleKey: 'settingsActions.spawnPolicy.permissionCeiling.options.safe-yolo.title',
        subtitleKey: 'settingsActions.spawnPolicy.permissionCeiling.options.safe-yolo.subtitle',
    },
    {
        mode: 'yolo',
        titleKey: 'settingsActions.spawnPolicy.permissionCeiling.options.yolo.title',
        subtitleKey: 'settingsActions.spawnPolicy.permissionCeiling.options.yolo.subtitle',
    },
] as const satisfies readonly {
    mode: (typeof SESSION_PERMISSION_MODES)[number];
    titleKey: TranslationKey;
    subtitleKey: TranslationKey;
}[];

export function normalizeSessionAgentSpawnPolicy(raw: unknown): SessionAgentSpawnPolicyV1 {
    const parsed = SessionAgentSpawnPolicyV1Schema.safeParse(raw);
    return parsed.success ? parsed.data : DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1;
}

function buildPermissionCeilingItems(iconColor: string): readonly DropdownMenuItem[] {
    const styles = stylesheet;
    const icon = (name: IconName) => (
        <View style={styles.optionIcon}>
            <Icon name={name} size={20} color={iconColor} />
        </View>
    );

    return [
        {
            id: 'inherit',
            testID: 'settings-actions:session-spawn-policy:permissionCeiling:inherit',
            title: t('settingsActions.spawnPolicy.permissionCeiling.options.inherit.title'),
            subtitle: t('settingsActions.spawnPolicy.permissionCeiling.options.inherit.subtitle'),
            icon: icon('git-branch'),
        },
        ...PERMISSION_CEILING_OPTIONS.map((option) => ({
            id: option.mode,
            testID: `settings-actions:session-spawn-policy:permissionCeiling:${option.mode}`,
            title: t(option.titleKey),
            subtitle: t(option.subtitleKey),
            icon: icon('shield'),
        })),
    ] satisfies readonly DropdownMenuItem[];
}

function parsePermissionCeilingSelection(itemId: string): SessionAgentSpawnPolicyV1['permissionCeiling'] {
    if (itemId === 'inherit') return null;
    return (SESSION_PERMISSION_MODES as readonly string[]).includes(itemId)
        ? itemId as SessionAgentSpawnPolicyV1['permissionCeiling']
        : null;
}

export type SessionAgentSpawnPolicyControlsProps = Readonly<{
    rawPolicy: unknown;
    disabled?: boolean;
    onChange: (policy: SessionAgentSpawnPolicyV1) => void;
}>;

export const SessionAgentSpawnPolicyControls = React.memo(function SessionAgentSpawnPolicyControls(
    props: SessionAgentSpawnPolicyControlsProps,
) {
    const { theme } = useUnistyles();
    const [permissionCeilingOpen, setPermissionCeilingOpen] = React.useState(false);
    const policy = React.useMemo(() => normalizeSessionAgentSpawnPolicy(props.rawPolicy), [props.rawPolicy]);
    const disabled = props.disabled === true;
    const permissionCeilingItems = React.useMemo(
        () => buildPermissionCeilingItems(theme.colors.text.secondary),
        [theme.colors.text.secondary],
    );

    const updatePolicy = React.useCallback((patch: Partial<SessionAgentSpawnPolicyV1>) => {
        props.onChange(SessionAgentSpawnPolicyV1Schema.parse({
            ...policy,
            ...patch,
        }));
    }, [policy, props]);

    return (
        <ItemGroup
            title={t('settingsActions.spawnPolicy.title')}
            footer={t('settingsActions.spawnPolicy.footer')}
        >
            {POLICY_TOGGLE_DEFINITIONS.map((definition) => (
                <Item
                    key={definition.key}
                    testID={`settings-actions:session-spawn-policy:${definition.key}:row`}
                    title={t(definition.titleKey)}
                    subtitle={t(definition.subtitleKey)}
                    icon={<Icon name={definition.icon} size={29} color={theme.colors.text.secondary} />}
                    mode="interactive"
                    disabled={disabled}
                    showChevron={false}
                    rightElement={(
                        <Switch
                            testID={`settings-actions:session-spawn-policy:${definition.key}`}
                            value={policy[definition.key]}
                            disabled={disabled}
                            onValueChange={(next) => updatePolicy({ [definition.key]: next })}
                        />
                    )}
                />
            ))}
            <DropdownMenu
                open={permissionCeilingOpen}
                onOpenChange={(next) => {
                    if (!disabled) setPermissionCeilingOpen(next);
                }}
                variant="selectable"
                search={false}
                selectedId={policy.permissionCeiling ?? 'inherit'}
                showCategoryTitles={false}
                matchTriggerWidth
                connectToTrigger
                rowKind="item"
                items={permissionCeilingItems}
                onSelect={(itemId) => updatePolicy({
                    permissionCeiling: parsePermissionCeilingSelection(itemId),
                })}
                itemTrigger={{
                    title: t('settingsActions.spawnPolicy.permissionCeiling.title'),
                    icon: <Icon name="shield" size={29} color={theme.colors.text.secondary} />,
                    subtitle: t('settingsActions.spawnPolicy.permissionCeiling.subtitle'),
                    itemProps: {
                        testID: 'settings-actions:session-spawn-policy:permissionCeiling',
                        disabled,
                    },
                }}
            />
        </ItemGroup>
    );
});
