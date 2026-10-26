import React from 'react';
import { View, Platform } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { EnvironmentVariableCard, type EnvironmentVariableCardProps } from './EnvironmentVariableCard';
import type { ProfileDocumentation } from '@/sync/domains/profiles/profileUtils';
import { InlineAddExpander } from '@/components/ui/forms/InlineAddExpander';
import { Modal } from '@/modal';
import { t } from '@/text';
import { useEnvironmentVariables } from '@/hooks/server/useEnvironmentVariables';
import { parseEnvVarTemplate } from '@/utils/profiles/envVarTemplate';
import { shadowLevelStyle } from '@/shadowElevation';
import { Text, TextInput } from '@/components/ui/text/Text';
import { Icon } from '@/components/ui/icons/Icon';


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
    machineName,
    profileDocs,
    onChange,
    sourceRequirementsByName,
    onUpdateSourceRequirement,
    getDefaultSecretNameForSourceVar,
    onPickDefaultSecretForSourceVar,
    onAddVariable,
}: EnvironmentVariablesListProps) {
    const { theme } = useUnistyles();
    const styles = stylesheet;

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
        { extraEnv, sensitiveKeys },
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
        } satisfies EnvironmentVariableCardProps;
    };

    return (
        <View style={styles.container}>
            <View style={styles.titleContainer}>
                <Text style={styles.titleText}>
                    {t('profiles.environmentVariables.title')}
                </Text>
            </View>

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

            <View style={styles.addContainer}>
                <InlineAddExpander
                    isOpen={isAddExpanded}
                    onOpenChange={(open) => { if (open) setIsAddExpanded(true); else resetAddDraft(); }}
                    triggerTestID="profile-environment-add"
                    title={t('profiles.environmentVariables.addVariable')}
                    icon={<Icon name="plus-circle" size={29} color={theme.colors.button.secondary.tint} />}
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
            </View>
        </View>
    );
}


const stylesheet = StyleSheet.create((theme) => ({
    container: {
        marginBottom: 16,
    },
    titleContainer: {
        paddingTop: Platform.select({ ios: 35, default: 16 }),
        paddingBottom: Platform.select({ ios: 6, default: 8 }),
        paddingHorizontal: Platform.select({ ios: 32, default: 24 }),
    },
    titleText: {
        ...Typography.default('regular'),
        color: theme.colors.text.secondary,
        fontSize: Platform.select({ ios: 13, default: 14 }),
        lineHeight: Platform.select({ ios: 18, default: 20 }),
        letterSpacing: Platform.select({ ios: -0.08, default: 0.1 }),
        textTransform: 'uppercase',
        fontWeight: '500',
    },
    envVarListContainer: {
        // Intentionally unused: each EnvironmentVariableCard is an ItemGroup
        // and provides its own consistent horizontal margins.
    },
    addContainer: {
        backgroundColor: theme.colors.surface.base,
        marginHorizontal: Platform.select({ ios: 16, default: 12 }),
        borderRadius: Platform.select({ ios: 10, default: 16 }),
        overflow: 'hidden',
        ...shadowLevelStyle(theme.colors.shadowLevels[1]),
    },
}));
