import * as React from 'react';

import { SecretRequirementModal, type SecretRequirementModalResult } from '@/components/secrets/requirements';
import { useSavedSecretsMutable } from '@/components/secrets/useSavedSecretsMutable';
import { Modal } from '@/modal';
import { useSetting } from '@/sync/domains/state/storage';
import { type AIBackendProfile } from '@/sync/domains/profiles/profileCompatibility';
import { type SavedSecret } from '@/sync/domains/settings/savedSecretTypes';
import { t } from '@/text';
import { parseEnvVarTemplate } from '@/utils/profiles/envVarTemplate';

type EnvironmentVariable = { name: string; value: string; isSecret?: boolean };
type RequirementState = { required: boolean; useSecretVault: boolean };

export function useLegacyProfileSecretRequirements(params: Readonly<{
    profile: AIBackendProfile;
    profileName: string;
    environmentVariables: readonly EnvironmentVariable[];
}>) {
    const { profile, profileName, environmentVariables } = params;
    const [secrets, setSecrets] = useSavedSecretsMutable();
    const bindingsByProfileId = useSetting('currentSecretBindingsByProfileId');
    const [profileSecretBindings, setProfileSecretBindings] = React.useState<Record<string, string>>(() => ({
        ...(bindingsByProfileId[profile.id] ?? {}),
    }));
    const [sourceRequirementsByName, setSourceRequirementsByName] = React.useState<Record<string, RequirementState>>(() => {
        const requirements: Record<string, RequirementState> = {};
        for (const requirement of profile.envVarRequirements ?? []) {
            const name = requirement.name.trim().toUpperCase();
            if (!name) continue;
            requirements[name] = {
                required: Boolean(requirement.required),
                useSecretVault: requirement.kind === 'secret',
            };
        }
        return requirements;
    });

    const usedRequirementVarNames = React.useMemo(() => new Set(environmentVariables.flatMap((variable) => {
        const template = parseEnvVarTemplate(variable.value);
        const name = (template?.sourceVar ?? variable.name).trim().toUpperCase();
        return name ? [name] : [];
    })), [environmentVariables]);

    React.useEffect(() => {
        setSourceRequirementsByName((previous) => {
            const next = Object.fromEntries(Object.entries(previous).filter(([name]) => usedRequirementVarNames.has(name)));
            return Object.keys(next).length === Object.keys(previous).length ? previous : next;
        });
    }, [usedRequirementVarNames]);

    React.useEffect(() => {
        setProfileSecretBindings((existing) => {
            const next = Object.fromEntries(Object.entries(existing).filter(([name, secretId]) => (
                typeof secretId === 'string'
                && usedRequirementVarNames.has(name)
                && sourceRequirementsByName[name]?.useSecretVault === true
            )));
            return Object.keys(next).length === Object.keys(existing).length ? existing : next;
        });
    }, [sourceRequirementsByName, usedRequirementVarNames]);

    const derivedEnvVarRequirements = React.useMemo<NonNullable<AIBackendProfile['envVarRequirements']>>(() => (
        Object.entries(sourceRequirementsByName)
            .filter(([name]) => usedRequirementVarNames.has(name))
            .map(([name, state]) => ({
                name,
                kind: state.useSecretVault ? 'secret' as const : 'config' as const,
                required: state.required,
            }))
            .sort((left, right) => left.name.localeCompare(right.name))
    ), [sourceRequirementsByName, usedRequirementVarNames]);

    const getDefaultSecretNameForSourceVar = React.useCallback((sourceVarName: string): string | null => {
        const secretId = profileSecretBindings[sourceVarName] ?? null;
        return secretId ? secrets.find((secret: SavedSecret) => secret.id === secretId)?.name ?? null : null;
    }, [profileSecretBindings, secrets]);

    const openDefaultSecretModalForSourceVar = React.useCallback((sourceVarName: string) => {
        const normalized = sourceVarName.trim().toUpperCase();
        if (!normalized) return;
        const defaultSecretId = profileSecretBindings[normalized] ?? null;
        const setDefaultSecretId = (secretId: string | null) => {
            setProfileSecretBindings((existing) => {
                const next = { ...existing };
                if (secretId) next[normalized] = secretId;
                else delete next[normalized];
                return next;
            });
        };
        const handleResolve = (result: SecretRequirementModalResult) => {
            if (result.action === 'selectSaved') setDefaultSecretId(result.secretId);
        };
        Modal.show({
            component: SecretRequirementModal,
            props: {
                profile: { ...profile, name: profileName, envVarRequirements: derivedEnvVarRequirements },
                secretEnvVarName: normalized,
                machineId: null,
                secrets,
                defaultSecretId,
                selectedSavedSecretId: defaultSecretId,
                onSetDefaultSecretId: setDefaultSecretId,
                variant: 'defaultForProfile',
                titleOverride: t('secrets.defineDefaultForProfileTitle'),
                onChangeSecrets: setSecrets,
                allowSessionOnly: false,
                onResolve: handleResolve,
            },
            onRequestClose: () => handleResolve({ action: 'cancel' }),
            closeOnBackdrop: true,
        });
    }, [derivedEnvVarRequirements, profile, profileName, profileSecretBindings, secrets, setSecrets]);

    const updateSourceRequirement = React.useCallback((sourceVarName: string, next: RequirementState | null) => {
        const normalized = sourceVarName.trim().toUpperCase();
        if (!normalized) return;
        setSourceRequirementsByName((previous) => {
            const updated = { ...previous };
            if (next) updated[normalized] = { required: Boolean(next.required), useSecretVault: Boolean(next.useSecretVault) };
            else delete updated[normalized];
            return updated;
        });
        if (!next?.useSecretVault) {
            setProfileSecretBindings((existing) => {
                if (!(normalized in existing)) return existing;
                const updated = { ...existing };
                delete updated[normalized];
                return updated;
            });
        }
    }, []);

    return {
        sourceRequirementsByName,
        derivedEnvVarRequirements,
        profileSecretBindings,
        getDefaultSecretNameForSourceVar,
        openDefaultSecretModalForSourceVar,
        updateSourceRequirement,
    };
}
