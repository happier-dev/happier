import * as React from 'react';

import { consumeSecretIdParam } from '@/profileRouteParams';
import { useSecretRequirementFlow } from '@/components/sessions/new/hooks/useSecretRequirementFlow';
import type { UseMachineEnvPresenceResult } from '@/hooks/machine/useMachineEnvPresence';
import type { NewSessionDraft } from '@/sync/domains/state/persistence';
import type { AIBackendProfile } from '@/sync/domains/profiles/profileCompatibility';
import type { SavedSecret } from '@/sync/domains/settings/savedSecretTypes';
import { getTempData } from '@/utils/sessions/tempDataStore';
import type {
    SecretBindingsByProfileId,
    SecretChoiceByProfileIdByEnvVarName,
} from '@/utils/secrets/secretRequirementApply';
import { sync } from '@/sync/sync';

type PersistedDraftLike = Readonly<{
    selectedSecretIdByProfileIdByEnvVarName?: unknown;
    sessionOnlySecretValueEncByProfileIdByEnvVarName?: unknown;
}> | null | undefined;

type NavigationParamController = Readonly<{
    setParams?: (params: Record<string, undefined>) => void;
    dispatch?: (action: unknown) => void;
}>;

type SessionOnlySecretValueEncByProfileIdByEnvVarName =
    NewSessionDraft['sessionOnlySecretValueEncByProfileIdByEnvVarName'];

export function useNewSessionSecretSelectionState(params: Readonly<{
    persistedDraft: PersistedDraftLike;
    selectedProfileId: string | null;
    selectedProfile: AIBackendProfile | null;
    secretBindingsByProfileId: SecretBindingsByProfileId;
    setSecretBindingsByProfileId: (next: SecretBindingsByProfileId) => void;
    secrets: SavedSecret[];
    setSecrets: (next: SavedSecret[]) => void;
    selectedMachineId: string | null;
    machineEnvPresence: UseMachineEnvPresenceResult;
    useProfiles: boolean;
    setSelectedProfileId: (id: string | null) => void;
    router: { push: (options: any) => void };
    navigation: NavigationParamController;
    secretIdParam: string | undefined;
    secretSessionOnlyId: string | undefined;
    secretRequirementResultId: string | undefined;
}>): Readonly<{
    selectedSecretIdByProfileIdByEnvVarName: SecretChoiceByProfileIdByEnvVarName;
    setSelectedSecretIdByProfileIdByEnvVarName: React.Dispatch<React.SetStateAction<SecretChoiceByProfileIdByEnvVarName>>;
    sessionOnlySecretValueByProfileIdByEnvVarName: SecretChoiceByProfileIdByEnvVarName;
    setSessionOnlySecretValueByProfileIdByEnvVarName: React.Dispatch<React.SetStateAction<SecretChoiceByProfileIdByEnvVarName>>;
    getSessionOnlySecretValueEncByProfileIdByEnvVarName: () => SessionOnlySecretValueEncByProfileIdByEnvVarName;
    openSecretRequirementModal: (profile: AIBackendProfile, options: { revertOnCancel: boolean }) => void;
    prepareSecretPromptForProfileSelection: (prevProfileId: string | null) => void;
    suppressNextSecretAutoPromptKeyRef: React.MutableRefObject<string | null>;
    selectedSecretId: string | null;
    setSelectedSecretId: (next: string | null) => void;
    sessionOnlySecretValue: string | null;
    setSessionOnlySecretValue: (next: string | null) => void;
    selectedSavedSecret: SavedSecret | null;
    activeSecretSource: 'sessionOnly' | 'saved' | 'machineEnv';
    secretRequirements: Array<{ name: string; required: boolean }>;
    shouldShowSecretSection: boolean;
}> {
    const [selectedSecretIdByProfileIdByEnvVarName, setSelectedSecretIdByProfileIdByEnvVarName] = React.useState<SecretChoiceByProfileIdByEnvVarName>(() => {
        const raw = params.persistedDraft?.selectedSecretIdByProfileIdByEnvVarName;
        if (!raw || typeof raw !== 'object') return {};
        const out: SecretChoiceByProfileIdByEnvVarName = {};
        for (const [profileId, byEnv] of Object.entries(raw)) {
            if (!byEnv || typeof byEnv !== 'object') continue;
            const inner: Record<string, string | null> = {};
            for (const [envVarName, value] of Object.entries(byEnv as Record<string, unknown>)) {
                if (value === null) inner[envVarName] = null;
                else if (typeof value === 'string') inner[envVarName] = value;
            }
            if (Object.keys(inner).length > 0) out[profileId] = inner;
        }
        return out;
    });

    const [sessionOnlySecretValueByProfileIdByEnvVarName, setSessionOnlySecretValueByProfileIdByEnvVarName] =
        React.useState<SecretChoiceByProfileIdByEnvVarName>(() => {
            const raw = params.persistedDraft?.sessionOnlySecretValueEncByProfileIdByEnvVarName;
            if (!raw || typeof raw !== 'object') return {};
            const out: SecretChoiceByProfileIdByEnvVarName = {};
            for (const [profileId, byEnv] of Object.entries(raw)) {
                if (!byEnv || typeof byEnv !== 'object') continue;
                const inner: Record<string, string | null> = {};
                for (const [envVarName, enc] of Object.entries(byEnv as Record<string, unknown>)) {
                    const decrypted = enc ? sync.decryptSecretValue(enc as never) : null;
                    if (typeof decrypted === 'string' && decrypted.trim().length > 0) {
                        inner[envVarName] = decrypted;
                    }
                }
                if (Object.keys(inner).length > 0) out[profileId] = inner;
            }
            return out;
        });

    const prevProfileIdBeforeSecretPromptRef = React.useRef<string | null>(null);
    const lastSecretPromptKeyRef = React.useRef<string | null>(null);
    const suppressNextSecretAutoPromptKeyRef = React.useRef<string | null>(null);
    const isSecretRequirementModalOpenRef = React.useRef(false);

    const getSessionOnlySecretValueEncByProfileIdByEnvVarName = React.useCallback(() => {
        const out: NonNullable<SessionOnlySecretValueEncByProfileIdByEnvVarName> = {};
        for (const [profileId, byEnv] of Object.entries(sessionOnlySecretValueByProfileIdByEnvVarName)) {
            if (!byEnv || typeof byEnv !== 'object') continue;
            for (const [envVarName, value] of Object.entries(byEnv)) {
                const normalizedValue = typeof value === 'string' ? value.trim() : '';
                if (!normalizedValue) continue;
                const enc = sync.encryptSecretValue(normalizedValue);
                if (!enc) continue;
                if (!out[profileId]) out[profileId] = {};
                out[profileId]![envVarName] = enc;
            }
        }
        return Object.keys(out).length > 0 ? out : null;
    }, [sessionOnlySecretValueByProfileIdByEnvVarName]);

    const prepareSecretPromptForProfileSelection = React.useCallback((prevProfileId: string | null) => {
        prevProfileIdBeforeSecretPromptRef.current = prevProfileId;
        lastSecretPromptKeyRef.current = null;
    }, []);

    const secretRequirements = React.useMemo(() => {
        const requirements = params.selectedProfile?.envVarRequirements ?? [];
        return requirements
            .filter((requirement) => (requirement?.kind ?? 'secret') === 'secret')
            .map((requirement) => ({ name: requirement.name, required: requirement.required === true }))
            .filter((requirement) => typeof requirement.name === 'string' && requirement.name.length > 0) as Array<{ name: string; required: boolean }>;
    }, [params.selectedProfile]);
    const shouldShowSecretSection = secretRequirements.length > 0;

    const { openSecretRequirementModal } = useSecretRequirementFlow({
        router: params.router,
        navigation: params.navigation,
        useProfiles: params.useProfiles,
        selectedProfileId: params.selectedProfileId,
        selectedProfile: params.selectedProfile,
        setSelectedProfileId: params.setSelectedProfileId,
        shouldShowSecretSection,
        selectedMachineId: params.selectedMachineId,
        machineEnvPresence: params.machineEnvPresence,
        secrets: params.secrets,
        setSecrets: params.setSecrets,
        secretBindingsByProfileId: params.secretBindingsByProfileId,
        setSecretBindingsByProfileId: params.setSecretBindingsByProfileId,
        selectedSecretIdByProfileIdByEnvVarName,
        setSelectedSecretIdByProfileIdByEnvVarName,
        sessionOnlySecretValueByProfileIdByEnvVarName,
        setSessionOnlySecretValueByProfileIdByEnvVarName,
        secretRequirementResultId: params.secretRequirementResultId,
        prevProfileIdBeforeSecretPromptRef,
        lastSecretPromptKeyRef,
        suppressNextSecretAutoPromptKeyRef,
        isSecretRequirementModalOpenRef,
    });

    const primarySecretEnvVarName = React.useMemo(() => {
        const required = secretRequirements.find((requirement) => requirement.required)?.name ?? null;
        return required ?? (secretRequirements[0]?.name ?? null);
    }, [secretRequirements]);

    const selectedSecretId = React.useMemo(() => {
        if (!primarySecretEnvVarName) return null;
        if (!params.selectedProfileId) return null;
        const value = (selectedSecretIdByProfileIdByEnvVarName[params.selectedProfileId] ?? {})[primarySecretEnvVarName];
        return typeof value === 'string' ? value : null;
    }, [params.selectedProfileId, primarySecretEnvVarName, selectedSecretIdByProfileIdByEnvVarName]);

    const setSelectedSecretId = React.useCallback((next: string | null) => {
        const profileId = params.selectedProfileId;
        const envVarName = primarySecretEnvVarName;
        if (!envVarName || !profileId) return;
        setSelectedSecretIdByProfileIdByEnvVarName((prev) => ({
            ...prev,
            [profileId]: {
                ...(prev[profileId] ?? {}),
                [envVarName]: next,
            },
        }));
    }, [params.selectedProfileId, primarySecretEnvVarName]);

    const sessionOnlySecretValue = React.useMemo(() => {
        if (!primarySecretEnvVarName) return null;
        if (!params.selectedProfileId) return null;
        const value = (sessionOnlySecretValueByProfileIdByEnvVarName[params.selectedProfileId] ?? {})[primarySecretEnvVarName];
        return typeof value === 'string' ? value : null;
    }, [params.selectedProfileId, primarySecretEnvVarName, sessionOnlySecretValueByProfileIdByEnvVarName]);

    const setSessionOnlySecretValue = React.useCallback((next: string | null) => {
        const profileId = params.selectedProfileId;
        const envVarName = primarySecretEnvVarName;
        if (!envVarName || !profileId) return;
        setSessionOnlySecretValueByProfileIdByEnvVarName((prev) => ({
            ...prev,
            [profileId]: {
                ...(prev[profileId] ?? {}),
                [envVarName]: next,
            },
        }));
    }, [params.selectedProfileId, primarySecretEnvVarName]);

    const selectedSavedSecret = React.useMemo(() => {
        if (!selectedSecretId) return null;
        return params.secrets.find((secret) => secret.id === selectedSecretId) ?? null;
    }, [params.secrets, selectedSecretId]);

    React.useEffect(() => {
        if (!params.selectedProfileId) return;
        if (selectedSecretId !== null) return;
        if (!primarySecretEnvVarName) return;
        const nextDefault = params.secretBindingsByProfileId[params.selectedProfileId]?.[primarySecretEnvVarName] ?? null;
        if (typeof nextDefault === 'string' && nextDefault.length > 0) {
            setSelectedSecretId(nextDefault);
        }
    }, [params.secretBindingsByProfileId, params.selectedProfileId, primarySecretEnvVarName, selectedSecretId, setSelectedSecretId]);

    const activeSecretSource = sessionOnlySecretValue
        ? 'sessionOnly'
        : selectedSecretId
            ? 'saved'
            : 'machineEnv';

    React.useEffect(() => {
        const { nextSelectedSecretId, shouldClearParam } = consumeSecretIdParam({
            secretIdParam: params.secretIdParam,
            selectedSecretId,
        });

        if (nextSelectedSecretId === null) {
            if (selectedSecretId !== null) {
                setSelectedSecretId(null);
            }
        } else if (typeof nextSelectedSecretId === 'string') {
            setSelectedSecretId(nextSelectedSecretId);
        }

        if (shouldClearParam) {
            const setParams = params.navigation.setParams;
            if (typeof setParams === 'function') {
                setParams({ secretId: undefined });
            } else {
                params.navigation.dispatch?.({
                    type: 'SET_PARAMS',
                    payload: { params: { secretId: undefined } },
                });
            }
        }
    }, [params.navigation, params.secretIdParam, selectedSecretId, setSelectedSecretId]);

    React.useEffect(() => {
        if (typeof params.secretSessionOnlyId !== 'string' || params.secretSessionOnlyId.length === 0) {
            return;
        }

        const entry = getTempData<{ secret?: string }>(params.secretSessionOnlyId);
        const value = entry?.secret;
        if (typeof value === 'string' && value.length > 0) {
            setSessionOnlySecretValue(value);
            setSelectedSecretId(null);
        }

        const setParams = params.navigation.setParams;
        if (typeof setParams === 'function') {
            setParams({ secretSessionOnlyId: undefined });
        } else {
            params.navigation.dispatch?.({
                type: 'SET_PARAMS',
                payload: { params: { secretSessionOnlyId: undefined } },
            });
        }
    }, [params.navigation, params.secretSessionOnlyId, setSelectedSecretId, setSessionOnlySecretValue]);

    return {
        selectedSecretIdByProfileIdByEnvVarName,
        setSelectedSecretIdByProfileIdByEnvVarName,
        sessionOnlySecretValueByProfileIdByEnvVarName,
        setSessionOnlySecretValueByProfileIdByEnvVarName,
        getSessionOnlySecretValueEncByProfileIdByEnvVarName,
        openSecretRequirementModal,
        prepareSecretPromptForProfileSelection,
        suppressNextSecretAutoPromptKeyRef,
        selectedSecretId,
        setSelectedSecretId,
        sessionOnlySecretValue,
        setSessionOnlySecretValue,
        selectedSavedSecret,
        activeSecretSource,
        secretRequirements,
        shouldShowSecretSection,
    };
}
