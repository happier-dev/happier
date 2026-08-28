import * as React from 'react';
import type { TextInput } from 'react-native';
import { useNavigation, useRouter } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';
import {
    areProviderContributionKeysEqualV1,
    createProviderErrorV1,
    createProviderSavedSecretRecordFingerprintV1,
    parseProviderIpAddress,
    parseProviderManualModelInput,
    type ProviderEndpointOverrideV1,
    type ProviderErrorV1,
} from '@happier-dev/protocol';
import type { DaemonProviderContributionAuthoringPreviewV1 } from '@happier-dev/protocol/rpc';

import type { DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { SavedSecretPickerModal } from '@/components/ui/forms/valueRefs/SavedSecretPickerModal';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { Modal } from '@/modal';
import { randomUUID } from '@/platform/randomUUID';
import {
    buildCustomProviderTemplate,
    createCustomProviderDraft,
    type CustomProviderDraft,
    type CustomProviderPreset,
    updateCustomProviderDraftPreset,
} from '@/providers/authoring/state';
import {
    useRetireProviderStateOnAccountChange,
} from '@/providers/hooks/accountLifetimeRetirement';
import { useProviderSettingsTarget } from '@/providers/hooks/targetMachine';
import { useProviderConnectionMutation } from '@/providers/hooks/useProviderConnectionMutation';
import { useProviderConnections } from '@/providers/hooks/useProviderConnections';
import {
    describeProviderConnections,
    probeProviderDraft,
    providerErrorFromRpcFailure,
} from '@/providers/rpc/client';
import { useAllMachines, useSetting } from '@/sync/domains/state/storage';
import { t } from '@/text';
import { ProviderFeatureAvailabilityNotice, useProviderFeatureAvailability } from './ProviderFeatureAvailability';
import { useActiveUnsavedChangesGuard } from '@/utils/navigation/useActiveUnsavedChangesGuard';
import { useUnsavedChangesBeforeRemoveGuard } from '@/utils/navigation/useUnsavedChangesBeforeRemoveGuard';
import { promptUnsavedChangesAlert } from '@/utils/ui/promptUnsavedChangesAlert';
import { BuiltInProviderAuthoringView } from './authoring/BuiltInProviderAuthoringView';
import { CustomProviderAuthoringView } from './authoring/CustomProviderAuthoringView';

const PRESETS: readonly CustomProviderPreset[] = ['openai-responses', 'openai-chat', 'anthropic'];

function localEndpointHint(draft: CustomProviderDraft): string | null {
    const candidates = draft.advanced
        ? draft.endpoints.filter((endpoint) => endpoint.enabled).map((endpoint) => endpoint.baseUrl)
        : [draft.baseUrl];
    for (const candidate of candidates) {
        try {
            const url = new URL(candidate);
            const hostname = url.hostname.replace(/^\[|\]$/gu, '').toLowerCase();
            const locality = parseProviderIpAddress(hostname)?.locality;
            if (hostname === 'localhost' || hostname.endsWith('.localhost') || locality === 'loopback' || locality === 'private') {
                return candidate.trim();
            }
        } catch {
            // An incomplete form value does not have a locality hint yet.
        }
    }
    return null;
}

function draftProbeObservationFacts(draft: CustomProviderDraft): Readonly<Record<string, unknown>> {
    const manualModelsText = draft.manualModelsText;
    if (draft.advanced) {
        return {
            advanced: true,
            manualModelsText,
            endpoints: draft.endpoints.filter((endpoint) => endpoint.enabled).map((endpoint) => ({
                protocol: endpoint.protocol,
                baseUrl: endpoint.baseUrl,
                publicHeadersText: endpoint.publicHeadersText,
                probePathsText: endpoint.probePathsText,
                probeParser: endpoint.probeParser,
                requiresApiKey: endpoint.requiresApiKey,
                ...(endpoint.requiresApiKey ? {
                    credentialStyle: endpoint.credentialStyle,
                    credentialHeader: endpoint.credentialHeader,
                } : {}),
            })),
        };
    }
    return {
        advanced: false,
        manualModelsText,
        protocol: draft.protocol,
        baseUrl: draft.baseUrl,
        catalog: draft.catalog,
        ...(draft.catalog === 'probe' ? { modelsPath: draft.modelsPath } : {}),
        requiresApiKey: draft.requiresApiKey,
        ...(draft.requiresApiKey ? {
            credentialStyle: draft.credentialStyle,
            credentialHeader: draft.credentialHeader,
        } : {}),
    };
}

export const ProviderConnectionAuthoringScreen = React.memo(function ProviderConnectionAuthoringScreen(
    props: Readonly<{ contributionKey?: string; candidateId?: string; displayName?: string }>,
) {
    const router = useRouter();
    const navigation = useNavigation();
    const { theme } = useUnistyles();
    const { enabled, presentation: availabilityPresentation } = useProviderFeatureAvailability();
    const machines = useAllMachines();
    const savedSecrets = useSetting('secrets');
    const providerTarget = useProviderSettingsTarget();
    const {
        machineId,
        resolveCurrentTarget,
        selectedTargetServerMatchesActiveAccount,
        serverId,
    } = providerTarget;
    const query = useProviderConnections({ enabled, machineId, serverId });
    const mutation = useProviderConnectionMutation({
        resolveTarget: resolveCurrentTarget,
        refresh: query.refresh,
    });
    const connectionId = React.useRef(`pc_${randomUUID()}`).current;
    const [draft, setDraft] = React.useState<CustomProviderDraft>(() => createCustomProviderDraft('openai-responses'));
    const [secretId, setSecretId] = React.useState<string | null>(null);
    const effectiveSecretId = selectedTargetServerMatchesActiveAccount ? secretId : null;
    // A SavedSecret reference belongs to the Account Settings that hold it, so
    // the selection is retired with the Account that made it. The rest of the
    // draft describes a machine-local Provider connection and stays.
    const discardAccountScopedSecretSelection = React.useCallback(() => {
        setSecretId(null);
    }, []);
    useRetireProviderStateOnAccountChange(discardAccountScopedSecretSelection);
    React.useEffect(() => {
        if (!selectedTargetServerMatchesActiveAccount) setSecretId(null);
    }, [selectedTargetServerMatchesActiveAccount]);
    const [presetOpen, setPresetOpen] = React.useState(false);
    const [credentialOpen, setCredentialOpen] = React.useState(false);
    const [probeState, setProbeState] = React.useState<'idle' | 'probing' | 'success' | 'notSupported'>('idle');
    const [probeError, setProbeError] = React.useState<ProviderErrorV1 | null>(null);
    const [localError, setLocalError] = React.useState<string | null>(null);
    const [manualModelsError, setManualModelsError] = React.useState<string | null>(null);
    const [selectedCandidateId, setSelectedCandidateId] = React.useState<string | null>(props.candidateId ?? null);
    const [contributionEndpointValues, setContributionEndpointValues] = React.useState<Readonly<Record<string, string>>>({});
    const [contributionDisplayName, setContributionDisplayName] = React.useState<string | null>(props.displayName ?? null);
    const [authoringPreview, setAuthoringPreview] = React.useState<DaemonProviderContributionAuthoringPreviewV1 | null>(null);
    const [authoringPreviewLoading, setAuthoringPreviewLoading] = React.useState(false);
    const [authoringPreviewError, setAuthoringPreviewError] = React.useState<ProviderErrorV1 | null>(null);
    const [authoringPreviewRefreshNonce, setAuthoringPreviewRefreshNonce] = React.useState(0);
    const [enableAfterSaving, setEnableAfterSaving] = React.useState(true);
    const [invalidField, setInvalidField] = React.useState<'name' | 'baseUrl' | null>(null);
    const nameFieldRef = React.useRef<TextInput>(null);
    const baseUrlFieldRef = React.useRef<TextInput>(null);
    const manualModelsFieldRef = React.useRef<TextInput>(null);
    const ignoreUnsavedGuardRef = React.useRef(false);
    const isDirtyRef = React.useRef(false);
    const probeGenerationRef = React.useRef(0);
    const authoringPreviewGenerationRef = React.useRef(0);
    const candidateMachineRef = React.useRef(machineId);
    const requestedContributionKey = props.contributionKey;
    const contribution = requestedContributionKey
        ? query.data?.available.find((item) =>
            areProviderContributionKeysEqualV1(item.contributionKey, requestedContributionKey))
        : undefined;
    const contributionEndpointTemplates = contribution?.endpointTemplates ?? [];
    const contributionEndpointOverrides = React.useMemo<ProviderEndpointOverrideV1[]>(() =>
        contributionEndpointTemplates.flatMap((endpoint) => {
            const baseUrl = contributionEndpointValues[endpoint.id]?.trim() ?? '';
            return baseUrl ? [{ endpointTemplateId: endpoint.id, baseUrl }] : [];
        }), [contributionEndpointTemplates, contributionEndpointValues]);
    const contributionEndpointsComplete = contributionEndpointOverrides.length === 0
        || contributionEndpointOverrides.length === contributionEndpointTemplates.length;
    const contributionEndpointOverridesKey = JSON.stringify(contributionEndpointOverrides);
    const draftRequiresApiKey = draft.advanced
        ? draft.endpoints.some((endpoint) => endpoint.enabled && endpoint.requiresApiKey)
        : draft.requiresApiKey;
    const draftHasProbe = draft.advanced
        ? draft.endpoints.some((endpoint) => endpoint.enabled && endpoint.probePathsText.trim().length > 0)
        : draft.catalog === 'probe';
    const selectedSecretObservation = React.useMemo(() => {
        if (!draftRequiresApiKey || effectiveSecretId === null) return null;
        const secret = savedSecrets.find((candidate) => candidate.id === effectiveSecretId);
        if (!secret) return { status: 'missing' as const };
        const persistedEnvelope = secret.encryptedValue.encryptedValue;
        return {
            status: 'present' as const,
            hasPendingValue: typeof secret.encryptedValue.value === 'string',
            recordFingerprint: persistedEnvelope
                ? createProviderSavedSecretRecordFingerprintV1({
                    secretId: effectiveSecretId,
                    persistedEncryptedEnvelope: persistedEnvelope,
                })
                : null,
        };
    }, [draftRequiresApiKey, effectiveSecretId, savedSecrets]);
    // Unsaved work is the draft itself. The target machine is a persisted
    // Machine Administration preference that survives navigation and is
    // restored on return, and it can be initialized automatically from a sole
    // verified candidate after the first render — including it here would mark
    // a pristine form dirty and prompt for changes the user never made.
    const authoringStateKey = JSON.stringify({
        draft, secretId: effectiveSecretId, enableAfterSaving,
        selectedCandidateId, contributionDisplayName,
        contributionEndpointValues,
    });
    const probeObservationKey = JSON.stringify({
        machineId,
        draft: draftProbeObservationFacts(draft),
        savedSecretId: draftRequiresApiKey ? effectiveSecretId : null,
        selectedSecretObservation,
    });
    const initialAuthoringStateKeyRef = React.useRef(authoringStateKey);
    isDirtyRef.current = authoringStateKey !== initialAuthoringStateKeyRef.current;

    React.useEffect(() => {
        probeGenerationRef.current += 1;
        setProbeState('idle');
        setProbeError(null);
    }, [probeObservationKey]);

    React.useEffect(() => {
        if (candidateMachineRef.current === machineId) return;
        candidateMachineRef.current = machineId;
        setSelectedCandidateId(null);
        setContributionDisplayName(null);
    }, [machineId]);

    React.useEffect(() => {
        const generation = authoringPreviewGenerationRef.current + 1;
        authoringPreviewGenerationRef.current = generation;
        if (!enabled || !props.contributionKey || !machineId) {
            setAuthoringPreview(null);
            setAuthoringPreviewError(null);
            setAuthoringPreviewLoading(false);
            return;
        }
        setAuthoringPreview(null);
        setAuthoringPreviewError(null);
        if (!contributionEndpointsComplete) {
            setAuthoringPreviewLoading(false);
            return;
        }
        setAuthoringPreviewLoading(true);
        void describeProviderConnections({
            machineId,
            serverId,
            authoringPreview: {
                connectionId,
                contributionKey: props.contributionKey,
                displayName: contributionDisplayName,
                selectedCandidateId,
                endpointOverrides: contributionEndpointOverrides,
            },
        }).then((result) => {
            if (authoringPreviewGenerationRef.current !== generation) return;
            setAuthoringPreviewLoading(false);
            if (result.status === 'error') {
                setAuthoringPreviewError(result.error);
                return;
            }
            if (!result.authoringPreview) {
                setAuthoringPreviewError(createProviderErrorV1('provider_endpoint_unavailable', {
                    connectionId, machineId,
                }));
                return;
            }
            setAuthoringPreview(result.authoringPreview);
        }).catch((caught) => {
            if (authoringPreviewGenerationRef.current !== generation) return;
            setAuthoringPreviewLoading(false);
            setAuthoringPreviewError(providerErrorFromRpcFailure(caught, { connectionId, machineId }));
        });
    }, [authoringPreviewRefreshNonce, connectionId, contributionDisplayName, contributionEndpointOverridesKey, contributionEndpointsComplete, enabled, machineId, props.contributionKey, selectedCandidateId, serverId]);
    const retryAuthoringPreview = React.useCallback(async (): Promise<void> => {
        setAuthoringPreviewRefreshNonce((current) => current + 1);
    }, []);

    const pickSecret = React.useCallback(() => {
        if (!selectedTargetServerMatchesActiveAccount) return;
        Modal.show({
            component: SavedSecretPickerModal,
            props: { selectedId: secretId, onSelectId: setSecretId },
            chrome: { kind: 'card', title: t('settingsProviders.detail.pickSecretTitle'), dimensions: { size: 'lg' } },
            closeOnBackdrop: true,
        });
    }, [secretId, selectedTargetServerMatchesActiveAccount]);

    const reviewConnectionDraft = React.useCallback(() => {
        mutation.clearError();
        setLocalError(null);
        setProbeError(null);
        baseUrlFieldRef.current?.focus();
    }, [mutation.clearError]);

    const save = React.useCallback(async (): Promise<boolean> => {
        if (!machineId) return false;
        setLocalError(null);
        setManualModelsError(null);
        setInvalidField(null);
        const previewCredential = authoringPreview?.credential ?? contribution?.credential ?? null;
        if (props.contributionKey && previewCredential?.required && !effectiveSecretId) {
            setLocalError('provider_secret_missing');
            pickSecret();
            return false;
        }
        if (!props.contributionKey) {
            if (!draft.name.trim()) {
                setInvalidField('name');
                setLocalError('provider_connection_invalid');
                nameFieldRef.current?.focus();
                return false;
            }
            if (!draft.advanced && !draft.baseUrl.trim()) {
                setInvalidField('baseUrl');
                setLocalError('provider_connection_invalid');
                baseUrlFieldRef.current?.focus();
                return false;
            }
            if (draftRequiresApiKey && !effectiveSecretId) {
                setLocalError('provider_secret_missing');
                pickSecret();
                return false;
            }
        }
        const manualModels = parseProviderManualModelInput(draft.manualModelsText);
        if (!props.contributionKey && manualModels.rejected.length > 0) {
            setManualModelsError(t('settingsProviders.models.invalidModelIds', {
                ids: manualModels.rejected.map((entry) => entry.value).join(', '),
            }));
            manualModelsFieldRef.current?.focus();
            return false;
        }
        try {
            const request = props.contributionKey ? (() => {
                if (authoringPreview?.status !== 'resolved') return null;
                return {
                    action: 'createContribution' as const,
                    machineId, connectionId, contributionKey: props.contributionKey,
                    displayName: contributionDisplayName, savedSecretId: effectiveSecretId, enable: enableAfterSaving,
                    authoringReview: {
                        candidateId: authoringPreview.candidateId,
                        fingerprint: authoringPreview.fingerprint,
                        revision: authoringPreview.revision,
                        endpointOverrides: contributionEndpointOverrides,
                    },
                };
            })() : {
                action: 'createCustom' as const,
                machineId, connectionId, template: buildCustomProviderTemplate(draft),
                manualModels: manualModels.accepted.map((id) => ({ id })),
                savedSecretId: draftRequiresApiKey ? effectiveSecretId : null, enable: enableAfterSaving,
            };
            if (!request) return false;
            const result = await mutation.run(request, 'save');
            if (result?.status === 'success' && 'connection' in result) {
                isDirtyRef.current = false;
                ignoreUnsavedGuardRef.current = true;
                router.replace(`/(app)/settings/providers/${result.connection.connectionId}` as never);
                return true;
            }
        } catch {
            setLocalError('provider_connection_invalid');
        }
        return false;
    }, [authoringPreview, connectionId, contribution?.credential, contributionDisplayName, contributionEndpointOverrides, draft, draftRequiresApiKey, effectiveSecretId, enableAfterSaving, machineId, mutation, pickSecret, props.contributionKey, router]);

    const chooseAuthoringCandidate = React.useCallback(async (candidateId: string) => {
        const candidate = query.data?.discoveryCandidates.find((entry) => entry.candidateId === candidateId);
        let displayName = contributionDisplayName;
        if (candidate?.connection.status === 'requires_named_connection' && !displayName) {
            displayName = await Modal.prompt(
                t('settingsProviders.local.addConnectionTitle'),
                t('settingsProviders.local.addConnectionDescription'),
                {
                    defaultValue: t('settingsProviders.local.defaultConnectionName', {
                        provider: candidate.providerName,
                    }),
                    confirmText: t('common.create'),
                },
            );
            if (!displayName?.trim()) return;
            displayName = displayName.trim();
        }
        setContributionDisplayName(displayName);
        setSelectedCandidateId(candidateId);
    }, [contributionDisplayName, query.data?.discoveryCandidates]);

    const testDraft = React.useCallback(async () => {
        // Re-resolve immediately before the probe so a draft is never tested
        // against a machine the selection has since moved away from.
        const target = resolveCurrentTarget();
        if (!machineId || props.contributionKey || !target || target.machineId !== machineId) return;
        const generation = probeGenerationRef.current;
        setProbeState('probing');
        setProbeError(null);
        setLocalError(null);
        let template: ReturnType<typeof buildCustomProviderTemplate>;
        try {
            template = buildCustomProviderTemplate(draft);
        } catch {
            setProbeState('idle');
            setProbeError(createProviderErrorV1('provider_connection_invalid', {
                connectionId,
                machineId,
            }));
            return;
        }
        try {
            const result = await probeProviderDraft({
                machineId: target.machineId,
                serverId: target.serverId,
                draftConnectionId: connectionId,
                template,
                savedSecretId: draftRequiresApiKey ? effectiveSecretId : null,
                actionNonce: `probe_${randomUUID()}`,
            });
            if (probeGenerationRef.current !== generation) return;
            if (result.status === 'error') {
                setProbeState('idle');
                setProbeError(result.error);
            } else {
                setProbeState(result.status === 'success' ? 'success' : 'notSupported');
            }
        } catch (caught) {
            if (probeGenerationRef.current !== generation) return;
            setProbeState('idle');
            setProbeError(providerErrorFromRpcFailure(caught, {
                connectionId,
                machineId,
            }));
        }
    }, [connectionId, draft, draftRequiresApiKey, effectiveSecretId, machineId, props.contributionKey, resolveCurrentTarget]);

    const requestUnsavedChangesDecision = React.useCallback(() => promptUnsavedChangesAlert(
        (title, message, buttons) => Modal.alert(title, message, buttons),
        {
            title: t('common.discardChanges'),
            message: t('settingsProviders.authoring.unsavedDescription'),
            discardText: t('common.discard'),
            saveText: t('common.save'),
            keepEditingText: t('common.keepEditing'),
        },
    ), []);
    const continueNavigation = React.useCallback((action: unknown) => {
        if (action) (navigation as { dispatch?: (value: unknown) => void } | null)?.dispatch?.(action);
    }, [navigation]);

    useUnsavedChangesBeforeRemoveGuard({
        ignoreRef: ignoreUnsavedGuardRef,
        isDirty: isDirtyRef.current,
        isDirtyRef,
        requestDecision: requestUnsavedChangesDecision,
        onSave: save,
        continueOnSave: false,
        onContinue: continueNavigation,
        tag: 'ProviderConnectionAuthoringScreen.beforeRemove',
    });
    useActiveUnsavedChangesGuard({
        navigation,
        guard: React.useMemo(() => ({
            isDirtyRef,
            ignoreRef: ignoreUnsavedGuardRef,
            requestDecision: requestUnsavedChangesDecision,
            onSave: save,
            continueOnSave: false,
            tag: 'ProviderConnectionAuthoringScreen.shellGuard',
        }), [requestUnsavedChangesDecision, save]),
    });

    const presets = React.useMemo<readonly DropdownMenuItem[]>(() => PRESETS.map((id) => ({
        id,
        title: t(`settingsProviders.authoring.protocol.${id}.title`),
        subtitle: t(`settingsProviders.authoring.protocol.${id}.description`),
    })), []);
    const credentialStyles = React.useMemo<readonly DropdownMenuItem[]>(() => [
        { id: 'bearer', title: t('settingsProviders.authoring.credentialStyle.bearer') },
        { id: 'x-api-key', title: t('settingsProviders.authoring.credentialStyle.xApiKey') },
        { id: 'api-key', title: t('settingsProviders.authoring.credentialStyle.apiKey') },
        { id: 'custom-header', title: t('settingsProviders.authoring.credentialStyle.customHeader') },
        { id: 'custom-header-bearer', title: t('settingsProviders.authoring.credentialStyle.customHeaderBearer') },
    ], []);

    if (availabilityPresentation) {
        return <ItemList><ItemGroup><ProviderFeatureAvailabilityNotice presentation={availabilityPresentation} /></ItemGroup></ItemList>;
    }
    if (!machineId) {
        return <ItemList><ItemGroup><Item mode="info" title={t('settingsProviders.noMachine')} subtitle={t('settingsProviders.noMachineDescription')} /></ItemGroup></ItemList>;
    }

    const displayError = mutation.error ?? authoringPreviewError ?? localError;
    const displayErrorRetry = mutation.error
        ? mutation.retry
        : authoringPreviewError
            ? retryAuthoringPreview
            : undefined;
    const localEndpoint = localEndpointHint(draft);
    const targetMachine = machines.find((machine) => machine.id === machineId);
    const currentMachineName = targetMachine?.metadata?.displayName || targetMachine?.metadata?.host || machineId;

    if (props.contributionKey) {
        const previewCredential = authoringPreview?.credential ?? contribution?.credential ?? null;
        return (
            <BuiltInProviderAuthoringView
                targetSelection={providerTarget.selection}
                machineId={machineId}
                currentMachineName={currentMachineName}
                providerName={contribution?.name ?? null}
                provenance={contribution?.provenance ?? null}
                websiteUrl={contribution?.websiteUrl}
                keyUrl={contribution?.credential?.keyUrl}
                previewCredential={previewCredential}
                endpointTemplates={contributionEndpointTemplates}
                endpointValues={contributionEndpointValues}
                secretSelected={effectiveSecretId !== null}
                savedSecretSelectionEnabled={selectedTargetServerMatchesActiveAccount}
                preview={authoringPreview}
                previewLoading={authoringPreviewLoading}
                enableAfterSaving={enableAfterSaving}
                savePending={mutation.isPending('save')}
                error={displayError}
                errorRetry={displayErrorRetry}
                secondaryTextColor={theme.colors.text.secondary}
                warningColor={theme.colors.state.warning.foreground}
                onPickSecret={pickSecret}
                onChooseCandidate={(candidateId) => { void chooseAuthoringCandidate(candidateId); }}
                onEndpointChange={(endpointTemplateId, baseUrl) => {
                    setSelectedCandidateId(null);
                    setContributionEndpointValues((current) => ({
                        ...current,
                        [endpointTemplateId]: baseUrl,
                    }));
                }}
                onEnableAfterSavingChange={setEnableAfterSaving}
                onSave={() => { void save(); }}
            />
        );
    }

    return (
        <CustomProviderAuthoringView
            model={{
                targetSelection: providerTarget.selection,
                machineId,
                currentMachineName,
                draft,
                presets,
                presetOpen,
                credentialStyles,
                credentialOpen,
                invalidField,
                localEndpoint,
                enableAfterSaving,
                draftRequiresApiKey,
                secretSelected: effectiveSecretId !== null,
                savedSecretSelectionEnabled: selectedTargetServerMatchesActiveAccount,
                manualModelsError,
                draftHasProbe,
                probeState,
                savePending: mutation.isPending('save'),
                error: displayError,
                errorRetry: displayErrorRetry,
                probeError,
                secondaryTextColor: theme.colors.text.secondary,
                nameFieldRef,
                baseUrlFieldRef,
                manualModelsFieldRef,
            }}
            actions={{
                onPresetOpenChange: setPresetOpen,
                onCredentialOpenChange: setCredentialOpen,
                onPresetSelect: (preset) => {
                    if (PRESETS.includes(preset as CustomProviderPreset)) {
                        setDraft((current) => updateCustomProviderDraftPreset(current, preset as CustomProviderPreset));
                    }
                },
                onCredentialStyleSelect: (credentialStyle) => {
                    if (credentialStyle === 'bearer' || credentialStyle === 'x-api-key'
                        || credentialStyle === 'api-key' || credentialStyle === 'custom-header'
                        || credentialStyle === 'custom-header-bearer') {
                        setDraft((current) => ({ ...current, credentialStyle }));
                    }
                },
                onDraftChange: setDraft,
                onNameChange: (name) => {
                    setInvalidField((current) => current === 'name' ? null : current);
                    setDraft((current) => ({ ...current, name }));
                },
                onBaseUrlChange: (baseUrl) => {
                    setInvalidField((current) => current === 'baseUrl' ? null : current);
                    setDraft((current) => ({ ...current, baseUrl }));
                },
                onManualModelsChange: (manualModelsText) => {
                    setManualModelsError(null);
                    setDraft((current) => ({ ...current, manualModelsText }));
                },
                onEnableAfterSavingChange: setEnableAfterSaving,
                onPickSecret: pickSecret,
                onReviewConnection: reviewConnectionDraft,
                onTest: () => { void testDraft(); },
                onSave: () => { void save(); },
            }}
        />
    );
});
