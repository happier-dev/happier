import * as React from 'react';
import type { ViewStyle } from 'react-native';
import type { LaunchProfileV2 } from '@happier-dev/protocol';
import type { AiLaunchProfileSourceV1 } from '@happier-dev/protocol/profiles/read';
import type { ProfileRecordV1, ProfileLegacyCloneSourceV1 } from '@happier-dev/protocol/profiles/profileRecordSchemaV1';

import { EnvironmentVariablesList } from '@/components/profiles/environmentVariables/EnvironmentVariablesList';
import { ItemList } from '@/components/ui/lists/ItemList';
import { Modal } from '@/modal';
import { t } from '@/text';

import { buildSlimProfileSave, isSlimProfileReservedEnvironmentAuthorityReady } from './slimProfileDraft';
import { getAllAgentProviderOwnedEnvironmentKeys } from '@/agents/catalog/catalog';
import { SlimProfilePlacementFields } from './SlimProfilePlacementFields';
import { SlimProfilePromptBehaviorFields } from './SlimProfilePromptBehaviorFields';
import { SlimProfileRoutingFields } from './SlimProfileRoutingFields';
import { useSlimProfileAgentEntries } from './useSlimProfileAgentEntries';
import { ProfileSkillSeedsSection } from './ProfileSkillSeedsSection';
import { useSkillsLibrary } from '@/sync/domains/skills/useSkillsLibrary';
import { ProfileEditActions } from './ProfileEditActions';
import { ProfileNameSection } from './ProfileNameSection';
import { useLegacyProfileSecretRequirements } from './legacy/useLegacyProfileSecretRequirements';

export type SlimProfileEditFormProps = Readonly<{
    profile: LaunchProfileV2 & AiLaunchProfileSourceV1;
    machineId: string | null;
    serverId?: string | null;
    onSave: (profile: LaunchProfileV2, secretBindings: ProfileRecordV1['secretBindings']) => boolean | Promise<boolean>;
    draftSecretBindings?: ProfileRecordV1['secretBindings'];
    legacyCloneSource?: ProfileLegacyCloneSourceV1;
    onCancel: () => void;
    onDirtyChange?: (isDirty: boolean) => void;
    containerStyle?: ViewStyle;
    saveRef?: React.MutableRefObject<(() => boolean | Promise<boolean>) | null>;
    /**
     * The host's page header (entity header with Save). When present the host owns saving and
     * leaving, so the editor renders no action row of its own.
     */
    header?: React.ReactNode;
    /** The name as it is typed, for a host that shows it (a collection's draft row). */
    onNameChange?: (name: string) => void;
}>;

export function SlimProfileEditForm(props: SlimProfileEditFormProps) {
    // The fields and their admitted revision share one baseline. A refreshed row
    // cannot authorize overwriting another editor's change with this draft.
    const initialProfile = React.useRef(props.profile).current;
    const [name, setName] = React.useState(props.profile.name);
    const { onNameChange } = props;
    React.useEffect(() => {
        onNameChange?.(name);
    }, [name, onNameChange]);
    const [description, setDescription] = React.useState(props.profile.description ?? '');
    const [extraEnvironmentVariables, setExtraEnvironmentVariables] = React.useState(
        [...props.profile.extraEnvironmentVariables],
    );
    const requirements = useLegacyProfileSecretRequirements({
        profile: props.profile, profileName: name, environmentVariables: extraEnvironmentVariables,
        draftSecretBindings: props.draftSecretBindings, legacyCloneSource: props.legacyCloneSource,
    });
    const initialRequirements = React.useRef(JSON.stringify({
        envVarRequirements: requirements.derivedEnvVarRequirements,
        secretBindings: requirements.profileSecretBindings,
    }));
    const [defaultPermissionModeByTargetKey, setDefaultPermissionModeByTargetKey] = React.useState({
        ...props.profile.defaultPermissionModeByTargetKey,
    });
    const [defaultPersistenceModeByTargetKey, setDefaultPersistenceModeByTargetKey] = React.useState({
        ...props.profile.defaultPersistenceModeByTargetKey,
    });
    const [preferredAgentTargetKey, setPreferredAgentTargetKey] = React.useState(props.profile.preferredAgentTargetKey);
    const [preferredModelSelection, setPreferredModelSelection] = React.useState(props.profile.preferredModelSelection);
    const [placement, setPlacement] = React.useState(props.profile.placement);
    const [checkout, setCheckout] = React.useState(props.profile.checkout);
    const [codingPromptBehaviorOverrides, setCodingPromptBehaviorOverrides] = React.useState(
        props.profile.codingPromptBehaviorOverrides,
    );
    const [skillSeeds, setSkillSeeds] = React.useState<readonly string[]>(props.profile.skillSeeds ?? []);
    const skillsLibrary = useSkillsLibrary();
    const initialSnapshot = React.useRef(JSON.stringify({
        name: props.profile.name,
        description: props.profile.description ?? '',
        extraEnvironmentVariables: props.profile.extraEnvironmentVariables,
        defaultPermissionModeByTargetKey: props.profile.defaultPermissionModeByTargetKey,
        defaultPersistenceModeByTargetKey: props.profile.defaultPersistenceModeByTargetKey,
        preferredAgentTargetKey: props.profile.preferredAgentTargetKey,
        preferredModelSelection: props.profile.preferredModelSelection,
        placement: props.profile.placement,
        checkout: props.profile.checkout,
        codingPromptBehaviorOverrides: props.profile.codingPromptBehaviorOverrides,
        skillSeeds: props.profile.skillSeeds ?? [],
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
            placement,
            checkout,
            codingPromptBehaviorOverrides,
            skillSeeds,
        }) !== initialSnapshot.current || JSON.stringify({
            envVarRequirements: requirements.derivedEnvVarRequirements,
            secretBindings: requirements.profileSecretBindings,
        }) !== initialRequirements.current);
    }, [
        checkout,
        codingPromptBehaviorOverrides,
        defaultPermissionModeByTargetKey,
        defaultPersistenceModeByTargetKey,
        description,
        extraEnvironmentVariables,
        name,
        placement,
        preferredAgentTargetKey,
        preferredModelSelection,
        props.onDirtyChange,
        requirements.derivedEnvVarRequirements,
        requirements.profileSecretBindings,
        skillSeeds,
    ]);

    const handleSave = React.useCallback(() => {
        const secretBindings = requirements.readPrivateSecretBindingsForSave();
        if (secretBindings === null) {
            requirements.notifySaveUnavailable();
            return false;
        }
        const result = buildSlimProfileSave(
            initialProfile,
            {
                name,
                description,
                extraEnvironmentVariables,
                envVarRequirements: requirements.derivedEnvVarRequirements,
                defaultPermissionModeByTargetKey,
                defaultPersistenceModeByTargetKey,
                preferredAgentTargetKey,
                preferredModelSelection,
                placement,
                checkout,
                codingPromptBehaviorOverrides,
                skillSeeds,
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
        return props.onSave(result.profile, secretBindings);
    }, [
        checkout,
        codingPromptBehaviorOverrides,
        defaultPermissionModeByTargetKey,
        defaultPersistenceModeByTargetKey,
        description,
        extraEnvironmentVariables,
        name,
        placement,
        preferredAgentTargetKey,
        preferredModelSelection,
        props,
        initialProfile,
        reservedEnvironmentAuthorityReady,
        reservedEnvironmentVariableNames,
        skillSeeds,
        requirements.derivedEnvVarRequirements,
        requirements.readPrivateSecretBindingsForSave,
        requirements.notifySaveUnavailable,
    ]);

    React.useEffect(() => {
        if (!props.saveRef) return;
        props.saveRef.current = handleSave;
        return () => { props.saveRef!.current = null; };
    }, [handleSave, props.saveRef]);

    return (
        <ItemList style={props.containerStyle} keyboardShouldPersistTaps="handled">
            {props.header}
            <ProfileNameSection
                testIDPrefix="profile-slim"
                name={name}
                onChangeName={setName}
                description={{ value: description, onChange: setDescription }}
            />

            <EnvironmentVariablesList
                environmentVariables={extraEnvironmentVariables}
                machineId={props.machineId}
                serverId={serverId}
                profileDocs={null}
                onChange={setExtraEnvironmentVariables}
                sourceRequirementsByName={requirements.sourceRequirementsByName}
                onUpdateSourceRequirement={requirements.updateSourceRequirement}
                getDefaultSecretNameForSourceVar={requirements.getDefaultSecretNameForSourceVar}
                onPickDefaultSecretForSourceVar={requirements.openDefaultSecretModalForSourceVar}
                allowSourceRequirements
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
            >
                <SlimProfilePlacementFields
                    machineId={props.machineId}
                    serverId={serverId}
                    placement={placement}
                    checkout={checkout}
                    onPlacementChange={setPlacement}
                    onCheckoutChange={setCheckout}
                />
            </SlimProfileRoutingFields>

            <SlimProfilePromptBehaviorFields
                value={codingPromptBehaviorOverrides}
                onChange={setCodingPromptBehaviorOverrides}
            />

            <ProfileSkillSeedsSection seeds={skillSeeds} library={skillsLibrary} onChange={setSkillSeeds} />

            {props.header ? null : (
                <ProfileEditActions saveAs={false} onSave={handleSave} onCancel={props.onCancel} />
            )}
        </ItemList>
    );
}
