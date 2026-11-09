import * as React from 'react';
import type { ProfileSecretPickerSelection } from '@/components/profiles/environmentVariables/EnvironmentVariablesList';

import { SecretRequirementModal, type SecretRequirementModalResult } from '@/components/secrets/requirements';
import { Modal } from '@/modal';
import { isLaunchProfileV2, type AiLaunchProfile } from '@happier-dev/protocol/profiles/read';
import { applyProfileSecretBindingSelectionV1 } from '@happier-dev/protocol/profiles/profileOperations';
import { resolveEffectiveProfileSecretBindingsV1, type ProfileRecordV1, type ProfileLegacyCloneSourceV1 } from '@happier-dev/protocol/profiles/profileRecordSchemaV1';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { getStorage } from '@/sync/domains/state/storageStore';
import { areAccountSettingsScopesEqual } from '@/sync/domains/settings/scope/accountSettingsScope';
import { getProfileCatalogSnapshot } from '@/sync/store/settings/profileCatalogSnapshot';
import { t } from '@/text';
import { parseEnvVarTemplate } from '@/utils/profiles/envVarTemplate';
import { useSavedSecretCatalogEntries } from '@/components/secrets/useSavedSecretCatalog';
import { useMountedRef } from '@/hooks/ui/useMountedRef';

type EnvironmentVariable = { name: string; value: string; isSecret?: boolean };
type RequirementState = { required: boolean; useSecretVault: boolean };

export function useLegacyProfileSecretRequirements(params: Readonly<{
    profile: AiLaunchProfile;
    profileName: string;
    environmentVariables: readonly EnvironmentVariable[];
    preserveSourceDefinition?: boolean;
    draftSecretBindings?: ProfileRecordV1['secretBindings'];
    legacyCloneSource?: ProfileLegacyCloneSourceV1;
}>) {
    const { profile, profileName, environmentVariables } = params;
    const scope = useAccountSettingsScope();
    const mountedRef = useMountedRef();
    // Capture the admitted row once; canonical Save owns revision admission rather
    // than repainting or replacing this private draft on a catalog refresh.
    const capture = React.useRef<Readonly<{
        scope: typeof scope;
        bindings: ProfileRecordV1['secretBindings'] | null;
    }> | null>(null);
    if (!capture.current) {
        const snapshot = getProfileCatalogSnapshot(scope);
        // A refresh keeps the complete admitted row used to render this editor.
        // Capture its matching private bindings without rebasing them on refresh.
        const row = snapshot?.dataComplete && snapshot.source === 'destination'
            ? snapshot.data?.find(candidate => candidate.record.id === profile.id) : undefined;
        const bindings = profile.profileRecordRevision !== undefined
            ? row?.revision === profile.profileRecordRevision ? row.record.secretBindings : null
            : params.legacyCloneSource
                ? params.draftSecretBindings ?? null
                : isLaunchProfileV2(params.profile) && !profile.artifactId && !row
                    ? params.draftSecretBindings ?? {} : null;
        capture.current = { scope, bindings };
    }
    const savedSecretEntries = useSavedSecretCatalogEntries();
    const [profileSecretBindings, setProfileSecretBindings] = React.useState<ProfileRecordV1['secretBindings']>(
        () => ({ ...capture.current?.bindings }),
    );
    const readSaveRefusal = React.useCallback((): 'profile_editor_revision_unavailable' | null => {
        const captured = capture.current;
        if (!captured?.bindings || !areAccountSettingsScopesEqual(captured.scope, getStorage().getState().settingsScope)) return 'profile_editor_revision_unavailable';
        return null;
    }, []);
    const readPrivateSecretBindingsForSave = React.useCallback((): ProfileRecordV1['secretBindings'] | null => (
        readSaveRefusal() === null ? profileSecretBindings : null
    ), [profileSecretBindings, readSaveRefusal]);
    const notifySaveUnavailable = React.useCallback(() => {
        const capturedScope = capture.current?.scope;
        if (!mountedRef.current || !capturedScope
            || !areAccountSettingsScopesEqual(capturedScope, getStorage().getState().settingsScope)) return;
        const refusal = readSaveRefusal();
        if (refusal) Modal.alert(t('common.error'), refusal);
    }, [mountedRef, readSaveRefusal]);
    const effectiveBindings = React.useMemo(() => resolveEffectiveProfileSecretBindingsV1(
        profile.secretBindings ?? {}, profileSecretBindings,
    ), [profile.secretBindings, profileSecretBindings]);
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

    const previousUsedNames = React.useRef(usedRequirementVarNames);
    React.useEffect(() => {
        const removed = [...previousUsedNames.current].filter(name => !usedRequirementVarNames.has(name));
        previousUsedNames.current = usedRequirementVarNames;
        if (params.preserveSourceDefinition || removed.length === 0) return;
        setSourceRequirementsByName((previous) => {
            const next = { ...previous };
            for (const name of removed) delete next[name];
            return next;
        });
        setProfileSecretBindings(existing => removed.reduce((bindings, name) => (
            applyProfileSecretBindingSelectionV1(bindings, name, { kind: 'none' })
        ), existing));
    }, [params.preserveSourceDefinition, usedRequirementVarNames]);

    const derivedEnvVarRequirements = React.useMemo<NonNullable<AiLaunchProfile['envVarRequirements']>>(() => (
        Object.entries(sourceRequirementsByName)
            .map(([name, state]) => ({
                name,
                kind: state.useSecretVault ? 'secret' as const : 'config' as const,
                required: state.required,
            }))
    ), [sourceRequirementsByName]);

    const getDefaultSecretNameForSourceVar = React.useCallback((sourceVarName: string, selectedSecretId?: string | null): string | null => {
        const secretId = selectedSecretId !== undefined ? selectedSecretId : effectiveBindings[sourceVarName] ?? null;
        return secretId
            ? savedSecretEntries.find((entry) => entry.ref === secretId)?.name ?? null
            : null;
    }, [effectiveBindings, savedSecretEntries]);

    const openDefaultSecretModalForSourceVar = React.useCallback((sourceVarName: string, selection?: ProfileSecretPickerSelection) => {
        const normalized = sourceVarName.trim().toUpperCase();
        if (!normalized) return;
        const defaultSecretId = selection?.secretId !== undefined ? selection.secretId : effectiveBindings[normalized] ?? null;
        const setDefaultSecretId = (secretId: string | null) => {
            if (selection) {
                selection.onSelect(secretId);
                return;
            }
            setProfileSecretBindings(existing => applyProfileSecretBindingSelectionV1(existing, normalized,
                secretId ? { kind: 'reference', reference: secretId } : { kind: 'none' }));
        };
        const handleResolve = (result: SecretRequirementModalResult) => {
            if (result.action === 'selectSaved') setDefaultSecretId(result.secretId);
        };
        Modal.show({
            component: SecretRequirementModal,
            props: {
                profile: { id: profile.id, name: profileName },
                secretEnvVarName: normalized,
                machineId: null,
                accountScope: capture.current?.scope ?? null,
                defaultSecretId,
                selectedSavedSecretId: defaultSecretId,
                onSetDefaultSecretId: setDefaultSecretId,
                variant: 'defaultForProfile',
                titleOverride: t('secrets.defineDefaultForProfileTitle'),
                allowManage: true,
                allowSessionOnly: false,
                onResolve: handleResolve,
            },
            onRequestClose: () => handleResolve({ action: 'cancel' }),
            closeOnBackdrop: true,
        });
    }, [effectiveBindings, profile.id, profileName]);

    const updateSourceRequirement = React.useCallback((sourceVarName: string, next: RequirementState | null, secretId?: string | null) => {
        const normalized = sourceVarName.trim().toUpperCase();
        if (!normalized) return;
        setSourceRequirementsByName((previous) => {
            const updated = { ...previous };
            if (next) updated[normalized] = { required: Boolean(next.required), useSecretVault: Boolean(next.useSecretVault) };
            else delete updated[normalized];
            return updated;
        });
        if (!next?.useSecretVault || secretId !== undefined) {
            setProfileSecretBindings(existing => applyProfileSecretBindingSelectionV1(existing, normalized,
                next?.useSecretVault && secretId ? { kind: 'reference', reference: secretId } : { kind: 'none' }));
        }
    }, []);

    return {
        sourceRequirementsByName,
        derivedEnvVarRequirements,
        profileSecretBindings,
        readPrivateSecretBindingsForSave,
        notifySaveUnavailable,
        getDefaultSecretNameForSourceVar,
        openDefaultSecretModalForSourceVar,
        updateSourceRequirement,
    };
}
