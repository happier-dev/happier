import * as React from 'react';
import { Platform, Pressable, View, type ViewStyle } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import type { LaunchProfileV2 } from '@happier-dev/protocol';

import { EnvironmentVariablesList } from '@/components/profiles/environmentVariables/EnvironmentVariablesList';
import { MachineSetupTextField } from '@/components/ui/forms/MachineSetupTextField';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import { t } from '@/text';

import { buildSlimProfileSave, isSlimProfileReservedEnvironmentAuthorityReady } from './slimProfileDraft';
import { getAllAgentProviderOwnedEnvironmentKeys } from '@/agents/catalog/catalog';
import { SlimProfilePromptBehaviorFields } from './SlimProfilePromptBehaviorFields';
import { SlimProfileRoutingFields } from './SlimProfileRoutingFields';
import { useSlimProfileAgentEntries } from './useSlimProfileAgentEntries';

export type SlimProfileEditFormProps = Readonly<{
    profile: LaunchProfileV2;
    machineId: string | null;
    serverId?: string | null;
    onSave: (profile: LaunchProfileV2) => boolean;
    onCancel: () => void;
    onDirtyChange?: (isDirty: boolean) => void;
    containerStyle?: ViewStyle;
    saveRef?: React.MutableRefObject<(() => boolean) | null>;
}>;

export function SlimProfileEditForm(props: SlimProfileEditFormProps) {
    const { theme } = useUnistyles();
    const [name, setName] = React.useState(props.profile.name);
    const [description, setDescription] = React.useState(props.profile.description ?? '');
    const [extraEnvironmentVariables, setExtraEnvironmentVariables] = React.useState(
        [...props.profile.extraEnvironmentVariables],
    );
    const [defaultPermissionModeByTargetKey, setDefaultPermissionModeByTargetKey] = React.useState({
        ...props.profile.defaultPermissionModeByTargetKey,
    });
    const [defaultPersistenceModeByTargetKey, setDefaultPersistenceModeByTargetKey] = React.useState({
        ...props.profile.defaultPersistenceModeByTargetKey,
    });
    const [preferredAgentTargetKey, setPreferredAgentTargetKey] = React.useState(props.profile.preferredAgentTargetKey);
    const [preferredModelSelection, setPreferredModelSelection] = React.useState(props.profile.preferredModelSelection);
    const [codingPromptBehaviorOverrides, setCodingPromptBehaviorOverrides] = React.useState(
        props.profile.codingPromptBehaviorOverrides,
    );
    const initialSnapshot = React.useRef(JSON.stringify({
        name: props.profile.name,
        description: props.profile.description ?? '',
        extraEnvironmentVariables: props.profile.extraEnvironmentVariables,
        defaultPermissionModeByTargetKey: props.profile.defaultPermissionModeByTargetKey,
        defaultPersistenceModeByTargetKey: props.profile.defaultPersistenceModeByTargetKey,
        preferredAgentTargetKey: props.profile.preferredAgentTargetKey,
        preferredModelSelection: props.profile.preferredModelSelection,
        codingPromptBehaviorOverrides: props.profile.codingPromptBehaviorOverrides,
    }));
    const { entries, projection: daemonProjection, serverId } = useSlimProfileAgentEntries(
        props.machineId,
        props.serverId,
    );
    const reservedEnvironmentVariableNames = React.useMemo(
        () => getAllAgentProviderOwnedEnvironmentKeys(
            daemonProjection.inputs?.pluginProjectionV2?.agentsById,
        ),
        [daemonProjection.inputs?.pluginProjectionV2?.agentsById],
    );
    const reservedEnvironmentAuthorityReady = isSlimProfileReservedEnvironmentAuthorityReady({
        projectionPhase: daemonProjection.phase,
        hasV2Projection: daemonProjection.inputs?.pluginProjectionV2 != null,
    });

    React.useEffect(() => {
        props.onDirtyChange?.(JSON.stringify({
            name,
            description,
            extraEnvironmentVariables,
            defaultPermissionModeByTargetKey,
            defaultPersistenceModeByTargetKey,
            preferredAgentTargetKey,
            preferredModelSelection,
            codingPromptBehaviorOverrides,
        }) !== initialSnapshot.current);
    }, [
        codingPromptBehaviorOverrides,
        defaultPermissionModeByTargetKey,
        defaultPersistenceModeByTargetKey,
        description,
        extraEnvironmentVariables,
        name,
        preferredAgentTargetKey,
        preferredModelSelection,
        props.onDirtyChange,
    ]);

    const handleSave = React.useCallback(() => {
        const result = buildSlimProfileSave(
            props.profile,
            {
                name,
                description,
                extraEnvironmentVariables,
                defaultPermissionModeByTargetKey,
                defaultPersistenceModeByTargetKey,
                preferredAgentTargetKey,
                preferredModelSelection,
                codingPromptBehaviorOverrides,
            },
            Date.now,
            reservedEnvironmentVariableNames,
            reservedEnvironmentAuthorityReady,
        );
        if (result.status === 'error') {
            Modal.alert(
                t('common.error'),
                result.field === 'name'
                    ? t('profiles.nameRequired')
                    : result.field === 'extraEnvironmentVariables' && !reservedEnvironmentAuthorityReady
                        ? t('settingsProviders.migration.reservedEnvironmentValidationUnavailable')
                        : result.message,
            );
            return false;
        }
        return props.onSave(result.profile);
    }, [
        codingPromptBehaviorOverrides,
        defaultPermissionModeByTargetKey,
        defaultPersistenceModeByTargetKey,
        description,
        extraEnvironmentVariables,
        name,
        preferredAgentTargetKey,
        preferredModelSelection,
        props,
        reservedEnvironmentAuthorityReady,
        reservedEnvironmentVariableNames,
    ]);

    React.useEffect(() => {
        if (!props.saveRef) return;
        props.saveRef.current = handleSave;
        return () => { props.saveRef!.current = null; };
    }, [handleSave, props.saveRef]);

    return (
        <ItemList style={props.containerStyle} keyboardShouldPersistTaps="handled">
            <ItemGroup title={t('profiles.profileName')}>
                <View style={{ paddingHorizontal: 16, paddingVertical: 12, gap: 16 }}>
                    <MachineSetupTextField
                        testID="profile-slim-name"
                        label={t('common.name')}
                        value={name}
                        placeholder={t('profiles.enterName')}
                        autoCapitalize="words"
                        autoCorrect={false}
                        onChangeText={setName}
                    />
                    <MachineSetupTextField
                        testID="profile-slim-description"
                        label={t('automations.form.labels.descriptionOptional')}
                        value={description}
                        multiline
                        autoCapitalize="sentences"
                        onChangeText={setDescription}
                    />
                </View>
            </ItemGroup>

            <EnvironmentVariablesList
                environmentVariables={extraEnvironmentVariables}
                machineId={props.machineId}
                serverId={serverId}
                profileDocs={null}
                onChange={setExtraEnvironmentVariables}
                sourceRequirementsByName={{}}
                onUpdateSourceRequirement={() => {}}
                getDefaultSecretNameForSourceVar={() => null}
                onPickDefaultSecretForSourceVar={() => {}}
                allowSourceRequirements={false}
            />

            <SlimProfileRoutingFields
                entries={entries}
                machineId={props.machineId}
                serverId={serverId}
                defaultPermissionModeByTargetKey={defaultPermissionModeByTargetKey}
                defaultPersistenceModeByTargetKey={defaultPersistenceModeByTargetKey}
                preferredAgentTargetKey={preferredAgentTargetKey}
                preferredModelSelection={preferredModelSelection}
                onPermissionDefaultsChange={setDefaultPermissionModeByTargetKey}
                onPersistenceDefaultsChange={setDefaultPersistenceModeByTargetKey}
                onPreferredAgentChange={setPreferredAgentTargetKey}
                onPreferredModelChange={setPreferredModelSelection}
            />

            <SlimProfilePromptBehaviorFields
                value={codingPromptBehaviorOverrides}
                onChange={setCodingPromptBehaviorOverrides}
            />

            <View style={{ paddingHorizontal: Platform.select({ ios: 16, default: 12 }), paddingTop: 12 }}>
                <View style={{ flexDirection: 'row', gap: 12 }}>
                    <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={t('common.cancel')}
                        onPress={props.onCancel}
                        style={({ pressed }) => ({
                            flex: 1, backgroundColor: theme.colors.surface.base, borderRadius: 10,
                            paddingVertical: 12, alignItems: 'center', opacity: pressed ? 0.85 : 1,
                        })}
                    >
                        <Text style={{ color: theme.colors.text.primary, ...Typography.default('semiBold') }}>{t('common.cancel')}</Text>
                    </Pressable>
                    <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={t('common.save')}
                        onPress={handleSave}
                        style={({ pressed }) => ({
                            flex: 1, backgroundColor: theme.colors.button.primary.background, borderRadius: 10,
                            paddingVertical: 12, alignItems: 'center', opacity: pressed ? 0.85 : 1,
                        })}
                    >
                        <Text style={{ color: theme.colors.button.primary.tint, ...Typography.default('semiBold') }}>{t('common.save')}</Text>
                    </Pressable>
                </View>
            </View>
        </ItemList>
    );
}
