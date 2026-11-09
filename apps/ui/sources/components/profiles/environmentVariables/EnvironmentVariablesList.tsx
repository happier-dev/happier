import React from 'react';
import { View } from 'react-native';
import { EnvironmentVariableCard, type EnvironmentVariableCardProps } from './EnvironmentVariableCard';
import type { ProfileDocumentation } from '@/sync/domains/profiles/profileUtils';
import { InlineAddExpander } from '@/components/ui/forms/InlineAddExpander';
import { Modal } from '@/modal';
import { t } from '@/text';
import { useEnvironmentVariables } from '@/hooks/server/useEnvironmentVariables';
import { parseEnvVarTemplate } from '@/utils/profiles/envVarTemplate';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Item } from '@/components/ui/lists/Item';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import type { TextInput } from '@/components/ui/text/Text';


type EnvironmentVariable = EnvironmentVariableCardProps['variable'];
type SourceRequirement = NonNullable<EnvironmentVariableCardProps['sourceRequirement']>;

export type ProfileSecretPickerSelection = Readonly<{
    secretId?: string | null;
    onSelect: (secretId: string | null) => void;
}>;

export type EnvironmentVariableAddition = Readonly<{
    variable: EnvironmentVariable;
    requirement: (SourceRequirement & { name: string; secretId?: string | null }) | null;
}>;

export interface EnvironmentVariablesListProps {
    environmentVariables: Array<{ name: string; value: string; isSecret?: boolean }>;
    machineId: string | null;
    /** Optional exact server context for the machine environment preview. */
    serverId?: string | null;
    machineName?: string | null;
    profileDocs?: ProfileDocumentation | null;
    onChange: (newVariables: Array<{ name: string; value: string; isSecret?: boolean }>) => void;
    sourceRequirementsByName: Record<string, { required: boolean; useSecretVault: boolean } | undefined>;
    onUpdateSourceRequirement: (
        sourceVarName: string,
        next: { required: boolean; useSecretVault: boolean } | null
    ) => void;
    getDefaultSecretNameForSourceVar: (sourceVarName: string, secretId?: string | null) => string | null;
    onPickDefaultSecretForSourceVar: (sourceVarName: string, selection?: ProfileSecretPickerSelection) => void;
    onAddVariable: (addition: EnvironmentVariableAddition) => void;
    allowSourceRequirements?: boolean;
}

const SECRET_NAME_REGEX = /TOKEN|KEY|SECRET|AUTH|PASS|PASSWORD|COOKIE/i;
const ENV_VAR_TEMPLATE_REF_REGEX = /\$\{([A-Z_][A-Z0-9_]*)(?::[-=][^}]*)?\}/g;

/**
 * Complete environment variables section with title, add button, and editable cards
 * Matches profile list pattern from index.tsx:1159-1308
 */
export function EnvironmentVariablesList({
    environmentVariables,
    machineId,
    serverId,
    machineName,
    profileDocs,
    onChange,
    sourceRequirementsByName,
    onUpdateSourceRequirement,
    getDefaultSecretNameForSourceVar,
    onPickDefaultSecretForSourceVar,
    onAddVariable,
    allowSourceRequirements = true,
}: EnvironmentVariablesListProps) {

    const [isAddExpanded, setIsAddExpanded] = React.useState(false);
    const [newVariable, setNewVariable] = React.useState<EnvironmentVariable>({ name: '', value: '' });
    const [newRequirement, setNewRequirement] = React.useState<SourceRequirement | null | undefined>();
    const [newSecretId, setNewSecretId] = React.useState<string | null | undefined>();
    const nameInputRef = React.useRef<React.ElementRef<typeof TextInput> | null>(null);
    const newRequirementName = (parseEnvVarTemplate(newVariable.value)?.sourceVar ?? newVariable.name).trim().toUpperCase();
    const draftRequirement = newRequirement === undefined
        ? sourceRequirementsByName[newRequirementName] ?? null
        : newRequirement;
    const previewVariables = React.useMemo(() => (
        isAddExpanded && /^[A-Z_][A-Z0-9_]*$/.test(newVariable.name)
            && !environmentVariables.some(variable => variable.name === newVariable.name)
            ? [...environmentVariables, newVariable]
            : environmentVariables
    ), [environmentVariables, isAddExpanded, newVariable]);

    const extractVarRefsFromValue = React.useCallback((value: string): string[] => {
        const refs: string[] = [];
        if (!value) return refs;
        let match: RegExpExecArray | null;
        // Reset regex state defensively (global regex).
        ENV_VAR_TEMPLATE_REF_REGEX.lastIndex = 0;
        while ((match = ENV_VAR_TEMPLATE_REF_REGEX.exec(value)) !== null) {
            const name = match[1];
            if (name) refs.push(name);
        }
        return refs;
    }, []);

    const documentedSecretNames = React.useMemo(() => {
        if (!profileDocs) return new Set<string>();

        return new Set(
            profileDocs.environmentVariables
                .filter((envVar) => envVar.isSecret)
                .map((envVar) => envVar.name),
        );
    }, [profileDocs]);

    const { keysToQuery, extraEnv, sensitiveKeys } = React.useMemo(() => {
        const keys = new Set<string>();
        const env: Record<string, string> = {};
        const sensitive = new Set<string>();

        const isSecretName = (name: string) =>
            documentedSecretNames.has(name) || SECRET_NAME_REGEX.test(name);

        previewVariables.forEach((envVar) => {
            keys.add(envVar.name);
            env[envVar.name] = envVar.value;

            const valueRefs = extractVarRefsFromValue(envVar.value);
            valueRefs.forEach((ref) => keys.add(ref));

            const isSensitive = envVar.isSecret === true || isSecretName(envVar.name) || valueRefs.some(isSecretName);
            if (isSensitive) {
                sensitive.add(envVar.name);
                valueRefs.forEach((ref) => { sensitive.add(ref); });
            } else {
                if (SECRET_NAME_REGEX.test(envVar.name)) sensitive.add(envVar.name);
                valueRefs.forEach((ref) => {
                    if (SECRET_NAME_REGEX.test(ref)) sensitive.add(ref);
                });
            }
        });

        return {
            keysToQuery: Array.from(keys),
            extraEnv: env,
            sensitiveKeys: Array.from(sensitive),
        };
    }, [documentedSecretNames, previewVariables, extractVarRefsFromValue]);

    const { meta: machineEnv, isLoading: isMachineEnvLoading, policy: machineEnvPolicy } = useEnvironmentVariables(
        machineId,
        keysToQuery,
        { extraEnv, sensitiveKeys, serverId },
    );

    const resetAddDraft = React.useCallback(() => {
        setNewVariable({ name: '', value: '' });
        setNewRequirement(undefined);
        setNewSecretId(undefined);
        setIsAddExpanded(false);
    }, []);

    // Helper to get expected value and description from documentation
    const getDocumentation = React.useCallback((varName: string) => {
        if (!profileDocs) return { expectedValue: undefined, description: undefined, isSecret: false };

        const doc = profileDocs.environmentVariables.find(ev => ev.name === varName);
        return {
            expectedValue: doc?.expectedValue,
            description: doc?.description,
            isSecret: doc?.isSecret || false
        };
    }, [profileDocs]);

    const handleUpdateVariable = React.useCallback((index: number, newValue: string) => {
        const updated = [...environmentVariables];
        updated[index] = { ...updated[index], value: newValue };
        onChange(updated);
    }, [environmentVariables, onChange]);

    const handleUpdateSecretOverride = React.useCallback((index: number, isSecret: boolean | undefined) => {
        const updated = [...environmentVariables];
        updated[index] = { ...updated[index], isSecret };
        onChange(updated);
    }, [environmentVariables, onChange]);

    const handleDeleteVariable = React.useCallback((index: number) => {
        onChange(environmentVariables.filter((_, i) => i !== index));
    }, [environmentVariables, onChange]);

    const handleDuplicateVariable = React.useCallback((index: number) => {
        const envVar = environmentVariables[index];
        const baseName = envVar.name.replace(/_COPY\d*$/, '');

        // Find next available copy number
        let copyNum = 1;
        while (environmentVariables.some(v => v.name === `${baseName}_COPY${copyNum}`)) {
            copyNum++;
        }

        const duplicated = {
            name: `${baseName}_COPY${copyNum}`,
            value: envVar.value,
            isSecret: envVar.isSecret,
        };
        onChange([...environmentVariables, duplicated]);
    }, [environmentVariables, onChange]);

    const handleAddVariable = React.useCallback(() => {
        const normalizedName = newVariable.name.trim().toUpperCase();
        if (!normalizedName) {
            Modal.alert(t('common.error'), t('profiles.environmentVariables.validation.nameRequired'));
            return;
        }

        // Validate variable name format
        if (!/^[A-Z_][A-Z0-9_]*$/.test(normalizedName)) {
            Modal.alert(
                t('common.error'),
                t('profiles.environmentVariables.validation.invalidNameFormat'),
            );
            return;
        }

        // Check for duplicates
        if (environmentVariables.some(v => v.name === normalizedName)) {
            Modal.alert(t('common.error'), t('profiles.environmentVariables.validation.duplicateName'));
            return;
        }

        onAddVariable({
            variable: { ...newVariable, name: normalizedName, value: newVariable.value.trim() },
            requirement: draftRequirement ? {
                ...draftRequirement,
                name: newRequirementName,
                ...(newSecretId !== undefined ? { secretId: newSecretId } : {}),
            } : null,
        });

        resetAddDraft();
    }, [draftRequirement, environmentVariables, newRequirementName, newSecretId, newVariable, onAddVariable, resetAddDraft]);

    // Creation and existing rows share sensitivity, documentation and preview decisions.
    const getCardProps = (envVar: EnvironmentVariable, index: number) => {
        const refs = extractVarRefsFromValue(envVar.value);
        const primaryRef = refs[0] ?? null;
        const primaryDocs = getDocumentation(envVar.name);
        const refDocs = primaryRef ? getDocumentation(primaryRef) : undefined;
        const autoSecret =
            primaryDocs.isSecret ||
            refDocs?.isSecret ||
            SECRET_NAME_REGEX.test(envVar.name) ||
            refs.some((ref) => SECRET_NAME_REGEX.test(ref));
        const forcedSecret = Boolean(machineEnv?.[envVar.name]?.isForcedSensitive);
        const effectiveIsSecret = forcedSecret
            ? true
            : envVar.isSecret !== undefined
                ? envVar.isSecret
                : autoSecret;
        const expectedValue = primaryDocs.expectedValue ?? refDocs?.expectedValue;
        const description = primaryDocs.description ?? refDocs?.description;
        const template = parseEnvVarTemplate(envVar.value);
        const sourceVarName = template?.sourceVar ?? null;
        const requirementVarName = (sourceVarName ?? envVar.name).trim().toUpperCase();

        return {
            variable: envVar, index, machineId, machineName: machineName ?? null,
            machineEnv, machineEnvPolicy, isMachineEnvLoading,
            expectedValue, description, isSecret: effectiveIsSecret,
            secretOverride: envVar.isSecret, autoSecret, isForcedSensitive: forcedSecret,
            sourceRequirement: sourceRequirementsByName[requirementVarName] ?? null,
            onUpdateSourceRequirement,
            defaultSecretNameForSourceVar: getDefaultSecretNameForSourceVar(requirementVarName),
            onPickDefaultSecretForSourceVar,
            onUpdateSecretOverride: handleUpdateSecretOverride,
            onUpdate: handleUpdateVariable, onDelete: handleDeleteVariable, onDuplicate: handleDuplicateVariable,
            showSourceRequirements: allowSourceRequirements,
        } satisfies EnvironmentVariableCardProps;
    };

    // Published Profiles carry requirements without environment-value rows.
    // Keep their private default picker reachable without manufacturing a value
    // that would later be saved into the shared definition.
    const representedRequirements = new Set(environmentVariables.map(variable =>
        (parseEnvVarTemplate(variable.value)?.sourceVar ?? variable.name).trim().toUpperCase()));
    const secretOnlyRequirements = allowSourceRequirements ? Object.entries(sourceRequirementsByName)
        .filter(([name, requirement]) => requirement?.useSecretVault && !representedRequirements.has(name)) : [];

    // Variables render as their own cards; until there is one, the section is one sheet whose only
    // row adds the first (like every other "add" in a settings sheet), not an action above nothing.
    const hasCards = environmentVariables.length > 0 || secretOnlyRequirements.length > 0;

    return (
        <View>
            <ItemGroup
                title={t('profiles.environmentVariables.title')}
                description={t('profilesPage.environmentDescription')}
                surface={hasCards ? 'none' : undefined}
                actionLayout="adaptive"
                action={hasCards ? <SectionActionButton
                    testID="profile-environment-add"
                    title={t('profiles.environmentVariables.addVariable')}
                    icon="plus"
                    expanded={isAddExpanded}
                    onPress={() => { if (isAddExpanded) resetAddDraft(); else setIsAddExpanded(true); }}
                /> : undefined}
            >
                {secretOnlyRequirements.map(([name]) => (
                    <Item
                        key={`requirement:${name}`}
                        testID={`profile-requirement-secret-${name}`}
                        title={name}
                        subtitle={t('profiles.environmentVariables.card.defaultSecretLabel')}
                        detail={getDefaultSecretNameForSourceVar(name) ?? t('secrets.noneTitle')}
                        onPress={() => onPickDefaultSecretForSourceVar(name)}
                    />
                ))}
            {environmentVariables.length > 0 && (
                <View>
                    {environmentVariables.map((envVar, index) => {

                        return (
                            <EnvironmentVariableCard
                                key={envVar.name}
                                {...getCardProps(envVar, index)}
                            />
                        );
                    })}
                </View>
            )}

                <InlineAddExpander
                    isOpen={isAddExpanded}
                    onOpenChange={(open) => { if (open) setIsAddExpanded(true); else resetAddDraft(); }}
                    title={t('profiles.environmentVariables.addVariable')}
                    trigger={hasCards ? null : undefined}
                    // With no variables yet, the add row is the section's action: the plus glyph in the
                    // leading column, as every other "add" row (Add launch profile, Add model).
                    triggerTestID="profile-environment-add"
                    saveTestID="profile-environment-add-save"
                    cancelTestID="profile-environment-add-cancel"
                    onCancel={resetAddDraft}
                    onSave={handleAddVariable}
                    saveDisabled={!newVariable.name.trim()}
                    cancelLabel={t('common.cancel')}
                    saveLabel={t('common.save')}
                    autoFocusRef={nameInputRef}
                >
                    <EnvironmentVariableCard
                        {...getCardProps(newVariable, 0)}
                        onNameChange={(name) => setNewVariable(current => ({ ...current, name: name.toUpperCase() }))}
                        nameInputRef={nameInputRef}
                        testIDPrefix="profile-environment-add"
                        sourceRequirement={draftRequirement}
                        onUpdateSourceRequirement={(_name, requirement) => {
                            setNewRequirement(requirement);
                            if (!requirement?.useSecretVault) setNewSecretId(null);
                        }}
                        defaultSecretNameForSourceVar={getDefaultSecretNameForSourceVar(newRequirementName, newSecretId)}
                        onPickDefaultSecretForSourceVar={(name) => onPickDefaultSecretForSourceVar(name, {
                            secretId: newSecretId,
                            onSelect: setNewSecretId,
                        })}
                        onUpdate={(_index, value) => setNewVariable(current => ({ ...current, value }))}
                        onUpdateSecretOverride={(_index, isSecret) => setNewVariable(current => ({ ...current, isSecret }))}
                        onDelete={undefined}
                        onDuplicate={undefined}
                    />
                </InlineAddExpander>
            </ItemGroup>
        </View>
    );
}
