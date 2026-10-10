import * as React from 'react';
import { useNavigation, useRouter } from '@/components/appShell/workspace/destinationRoute';
import { AppState } from 'react-native';
import type { ManagedIdentityProviderOwnerV1, ManagedIdentityProviderV1 } from '@happier-dev/protocol';

import { CopiedPill } from '@/components/ui/copy/CopiedPill';
import { useTemporaryCopyFeedback } from '@/components/ui/copy/useTemporaryCopyFeedback';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { announceAccessibilityMessage } from '@/components/ui/accessibility/announceAccessibilityMessage';
import { identityAdministrationFailureMessage } from '@/components/settings/identity/identityAdministrationFailure';
import {
    revisionedSettingsDraftTransition,
    type RevisionedSettingsDraftOrigin,
} from '@/components/settings/identity/revisionedSettingsDraft';
import { SettingAnchor, SettingRow } from '@/components/settings/shell/SettingRow';
import { HOME_MANAGED_OIDC_SETTINGS, TEAM_MANAGED_OIDC_SETTINGS } from '@/components/settings/identity/identitySettings';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Modal } from '@/modal';
import { t } from '@/text';
import { setClipboardStringSafe } from '@/utils/ui/clipboard';
import { useUnsavedChangesBeforeRemoveGuard } from '@/utils/navigation/useUnsavedChangesBeforeRemoveGuard';
import { promptUnsavedChangesAlert } from '@/utils/ui/promptUnsavedChangesAlert';
import { useMountedRef } from '@/hooks/ui/useMountedRef';
import { serverAccountScopeKeySuffix } from '@/sync/domains/scope/serverAccountScope';
import type { ActionApprovalRegistration } from '@/components/approvals/actionApprovalContinuation';

import { HomeAdministrationSection } from '../governance/HomeAdministrationSection';
import type { HomeAdministrationContext } from '../governance/homeAdministrationContext';
import { homeAdministrationIdentityProviderPath } from '../governance/homeAdministrationRoutes';
import { useManagedIdentityProviderClient, useManagedIdentityProviders } from './useManagedIdentityProviders';
import { ManagedOidcProviderFields, managedOidcValidationMessage, type ManagedOidcProviderInputRefs } from './ManagedOidcProviderFields';
import {
    EMPTY_MANAGED_OIDC_PROVIDER_DRAFT,
    managedOidcConfigFromDraft,
    managedOidcDraftFromProvider,
    validateManagedIdentityProviderDraft,
    type ManagedOidcProviderDraft,
} from './managedOidcProviderDraft';
export {
    EMPTY_MANAGED_OIDC_PROVIDER_DRAFT,
    managedOidcConfigFromDraft,
    managedOidcDraftFromProvider,
    validateManagedIdentityProviderDraft,
    type ManagedOidcProviderDraft,
} from './managedOidcProviderDraft';

export type ManagedIdentityProviderSaveResult =
    | Readonly<{ kind: 'completed' }>
    | Readonly<{ kind: 'approval_pending' }>
    | Readonly<{ kind: 'failed'; code: string }>;

export type ManagedIdentityProviderSaveCallbacks = Readonly<{
    onApprovalFailed: (code: string) => void;
}>;

export { ManagedOidcProviderFields } from './ManagedOidcProviderFields';

export const ManagedOidcProviderEditorContent = React.memo(function ManagedOidcProviderEditorContent(props: Readonly<{
    scope: HomeAdministrationContext['scope'];
    owner: ManagedIdentityProviderOwnerV1;
    provider?: ManagedIdentityProviderV1 | null;
    loading?: boolean;
    refreshing?: boolean;
    refreshFailure?: Readonly<{ code: string; retryable: boolean }> | null;
    mutationsAvailable: boolean;
    onRefreshRequested?: () => void;
    onSaved: (provider: ManagedIdentityProviderV1, callbacks?: ManagedIdentityProviderSaveCallbacks) => Promise<ManagedIdentityProviderSaveResult> | ManagedIdentityProviderSaveResult;
    onApprovalPending?: (registration: ActionApprovalRegistration) => void;
    additionalDirty?: boolean;
    additionalFields?: React.ReactNode;
    testIdPrefix?: string;
    saveTestId?: string;
}>) {
    const navigation = useNavigation();
    const settings = props.owner.kind === 'home' ? HOME_MANAGED_OIDC_SETTINGS : TEAM_MANAGED_OIDC_SETTINGS;
    const client = useManagedIdentityProviderClient(props.scope);
    const mountedRef = useMountedRef();
    const ownerTeamId = props.owner.kind === 'team' ? props.owner.teamId : null;
    const owner = React.useMemo<ManagedIdentityProviderOwnerV1>(
        () => ownerTeamId === null ? { kind: 'home' } : { kind: 'team', teamId: ownerTeamId },
        [ownerTeamId],
    );
    const initialProvider = React.useRef(props.provider ?? null).current;
    const copyFeedback = useTemporaryCopyFeedback();
    const copyCallbackUrl = React.useCallback(async (url: string) => {
        if (!await setClipboardStringSafe(url)) {
            await Modal.alertAsync(t('common.error'), t('items.failedToCopyToClipboard'));
            return;
        }
        copyFeedback.markCopied();
    }, [copyFeedback]);
    const initialDraft = React.useRef(
        initialProvider ? managedOidcDraftFromProvider(initialProvider) : EMPTY_MANAGED_OIDC_PROVIDER_DRAFT,
    ).current;
    const [createdProvider, setCreatedProvider] = React.useState<ManagedIdentityProviderV1 | null>(null);
    const externalProviderIsNewer = Boolean(
        createdProvider
        && props.provider
        && props.provider.id === createdProvider.id
        && props.provider.revision > createdProvider.revision,
    );
    const provider = externalProviderIsNewer ? props.provider ?? null : createdProvider ?? props.provider ?? null;
    const [draft, setDraft] = React.useState<ManagedOidcProviderDraft>(initialDraft);
    const [baseline, setBaseline] = React.useState<ManagedOidcProviderDraft>(initialDraft);
    const [draftOrigin, setDraftOrigin] = React.useState<RevisionedSettingsDraftOrigin | null>(
        initialProvider ? { resourceId: initialProvider.id, revision: initialProvider.revision } : null,
    );
    const [revisionConflict, setRevisionConflict] = React.useState(false);
    const [appliedDraft, setAppliedDraft] = React.useState<ManagedOidcProviderDraft | null>(
        initialProvider ? initialDraft : null,
    );
    const [commitPending, setCommitPending] = React.useState(false);
    const [advanced, setAdvanced] = React.useState(false);
    const [saving, setSaving] = React.useState(false);
    const [testing, setTesting] = React.useState(false);
    const [tested, setTested] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);
    const [validation, setValidation] = React.useState<ReturnType<typeof validateManagedIdentityProviderDraft>>(null);
    // React state disables the rendered controls; this ref closes the smaller
    // same-frame window before that render commits. Save and validation share
    // it because both act on the same provider revision/security revision.
    const operationInFlightRef = React.useRef<symbol | null>(null);

    React.useEffect(() => () => {
        operationInFlightRef.current = null;
    }, []);
    const displayNameInputRef = React.useRef<{ focus(): void } | null>(null);
    const issuerInputRef = React.useRef<{ focus(): void } | null>(null);
    const clientIdInputRef = React.useRef<{ focus(): void } | null>(null);
    const clientSecretInputRef = React.useRef<{ focus(): void } | null>(null);
    const scopesInputRef = React.useRef<{ focus(): void } | null>(null);
    const loginClaimInputRef = React.useRef<{ focus(): void } | null>(null);
    const emailClaimInputRef = React.useRef<{ focus(): void } | null>(null);
    const groupsClaimInputRef = React.useRef<{ focus(): void } | null>(null);
    const inputRefs = React.useMemo<ManagedOidcProviderInputRefs>(() => ({
        displayName: displayNameInputRef,
        issuer: issuerInputRef,
        clientId: clientIdInputRef,
        clientSecret: clientSecretInputRef,
        scopes: scopesInputRef,
        loginClaim: loginClaimInputRef,
        emailClaim: emailClaimInputRef,
        groupsClaim: groupsClaimInputRef,
    }), []);

    React.useEffect(() => {
        const subscription = AppState.addEventListener('change', (nextState) => {
            if (nextState === 'active') return;
            setDraft((current) => current.clientSecret ? { ...current, clientSecret: '' } : current);
            setBaseline((current) => current.clientSecret ? { ...current, clientSecret: '' } : current);
            setAppliedDraft((current) => current?.clientSecret ? { ...current, clientSecret: '' } : current);
        });
        return () => subscription.remove();
    }, []);

    const isEdit = Boolean(provider);
    const providerDirty = JSON.stringify(draft) !== JSON.stringify(baseline);
    // A newly created provider is an incomplete two-phase Team setup until
    // `onSaved` attaches it. Keep that phase retryable after an ordinary
    // failure, while `commitPending` separately fences deferred approval from
    // replaying either mutation.
    const dirty = providerDirty || Boolean(props.additionalDirty) || Boolean(createdProvider) || commitPending;
    React.useEffect(() => {
        if (!props.provider) return;
        if (createdProvider
            && createdProvider.id === props.provider.id
            && props.provider.revision <= createdProvider.revision) return;
        const transition = revisionedSettingsDraftTransition({
            origin: draftOrigin,
            current: { resourceId: props.provider.id, revision: props.provider.revision },
            dirty: providerDirty,
        });
        if (transition === 'keep') return;
        if (transition === 'conflict') {
            setRevisionConflict(true);
            return;
        }
        const next = managedOidcDraftFromProvider(props.provider);
        setDraft(next);
        setBaseline(next);
        setAppliedDraft(next);
        setDraftOrigin({ resourceId: props.provider.id, revision: props.provider.revision });
        setRevisionConflict(false);
    }, [createdProvider, draftOrigin, props.provider, providerDirty]);
    const dirtyRef = React.useRef(dirty);
    dirtyRef.current = dirty;
    const ignoreRef = React.useRef(false);
    const requestDecision = React.useCallback(async () => await promptUnsavedChangesAlert(
        (title, message, buttons) => Modal.alert(title, message, buttons),
        {
            title: t('common.discardChanges'),
            message: t('identityAdministration.subtitle'),
            discardText: t('common.discard'),
            saveText: t('common.save'),
            keepEditingText: t('common.keepEditing'),
        },
    ), []);

    // The outcome appears in a footer below the control that was pressed, so a
    // screen reader still focused on that control would otherwise hear nothing.
    // Announcing through the same helper keeps the two exactly in step.
    const reportError = React.useCallback((message: string) => {
        if (!mountedRef.current) return;
        setError(message);
        announceAccessibilityMessage(message);
    }, [mountedRef]);
    const reportFailure = React.useCallback(
        (code: string) => reportError(identityAdministrationFailureMessage(code)),
        [reportError],
    );
    const reportSaveApprovalFailure = React.useCallback((code: string) => {
        setCommitPending(false);
        reportFailure(code);
    }, [reportFailure]);
    const reportApprovalPending = React.useCallback(
        (registration: ActionApprovalRegistration) => {
            if (!mountedRef.current) return;
            if (props.onApprovalPending) {
                props.onApprovalPending(registration);
                setError(null);
            } else {
                reportError(t('connect.waitingForApproval'));
            }
        },
        [mountedRef, props.onApprovalPending, reportError],
    );

    const update = React.useCallback(<K extends keyof ManagedOidcProviderDraft>(key: K, value: ManagedOidcProviderDraft[K]) => {
        setDraft((current) => ({ ...current, [key]: value }));
        setError(null);
        setValidation((current) => current?.field === key ? null : current);
        setTested(false);
    }, []);

    const reloadConflictedProvider = React.useCallback(() => {
        if (!provider) return;
        const next = managedOidcDraftFromProvider(provider);
        setDraft(next);
        setBaseline(next);
        setAppliedDraft(next);
        setDraftOrigin({ resourceId: provider.id, revision: provider.revision });
        setCreatedProvider((current) => current?.id === provider.id ? provider : null);
        setRevisionConflict(false);
        setError(null);
        setValidation(null);
        setTested(false);
    }, [provider]);

    const applyValidationSuccess = React.useCallback((validated: ManagedIdentityProviderV1) => {
        if (!mountedRef.current) return;
        setCreatedProvider(createdProvider ? validated : null);
        setDraftOrigin({ resourceId: validated.id, revision: validated.revision });
        setTested(true);
    }, [createdProvider, mountedRef]);

    const testConfiguration = React.useCallback(async () => {
        if (!provider || providerDirty || revisionConflict || operationInFlightRef.current !== null) return;
        const operationIdentity = Symbol('validate-managed-identity-provider');
        operationInFlightRef.current = operationIdentity;
        setTesting(true);
        setError(null);
        setTested(false);
        try {
            const input = {
                owner,
                id: provider.id,
                expectedRevision: draftOrigin?.resourceId === provider.id ? draftOrigin.revision : provider.revision,
                expectedSecurityRevision: provider.securityRevision,
            } as const;
            const result = await client.execute('identity.providers.validate', input, {
                onApprovalSucceeded: applyValidationSuccess,
                onApprovalFailed: reportFailure,
            });
            if (result.kind === 'failed') {
                reportFailure(result.failure.code);
                return;
            }
            if (result.kind === 'approval_pending') {
                reportApprovalPending(result.approval);
                return;
            }
            applyValidationSuccess(result.value);
        } catch {
            reportError(t('identityAdministration.error'));
        } finally {
            if (operationInFlightRef.current === operationIdentity) operationInFlightRef.current = null;
            setTesting(false);
        }
    }, [applyValidationSuccess, client, draftOrigin, owner, provider, providerDirty, reportApprovalPending, reportError, reportFailure, revisionConflict]);

    const finishSavedProvider = React.useCallback(async (current: ManagedIdentityProviderV1): Promise<boolean> => {
        if (!mountedRef.current) return false;
        setCreatedProvider(current);
        setAppliedDraft(draft);
        setBaseline(draft);
        setDraftOrigin({ resourceId: current.id, revision: current.revision });
        let result: ManagedIdentityProviderSaveResult;
        try {
            result = await props.onSaved(current, { onApprovalFailed: reportSaveApprovalFailure });
        } catch {
            setCommitPending(false);
            reportError(t('identityAdministration.error'));
            return false;
        }
        if (result.kind === 'approval_pending') {
            setCommitPending(true);
            return false;
        }
        if (result.kind === 'failed') {
            setCommitPending(false);
            reportFailure(result.code);
            return false;
        }
        const next = managedOidcDraftFromProvider(current);
        setDraft(next);
        setBaseline(next);
        setDraftOrigin({ resourceId: current.id, revision: current.revision });
        setRevisionConflict(false);
        setCommitPending(false);
        setCreatedProvider(null);
        ignoreRef.current = true;
        return true;
    }, [draft, mountedRef, props.onSaved, reportError, reportFailure, reportSaveApprovalFailure]);

    const continueAfterProviderUpdate = React.useCallback(async (updated: ManagedIdentityProviderV1): Promise<boolean> => {
        if (!mountedRef.current) return false;
        let current = updated;
        setCreatedProvider(current);
        setDraftOrigin({ resourceId: current.id, revision: current.revision });
        if (draft.clientSecret && draft.clientSecret !== appliedDraft?.clientSecret) {
            // The configuration update has committed even when the separate
            // secret replacement cannot. Keep the committed server projection
            // as the retry baseline so a later Save cannot overwrite rules
            // another owner returned with that update; retain only the entered
            // secret locally for the explicit repair step.
            const committedDraft = managedOidcDraftFromProvider(updated);
            setDraft({ ...committedDraft, clientSecret: draft.clientSecret });
            setBaseline(committedDraft);
            setAppliedDraft(committedDraft);
            const secretInput = {
                owner,
                id: current.id,
                expectedRevision: current.revision,
                clientSecret: draft.clientSecret,
            } as const;
            const secret = await client.execute('identity.providers.secret.replace', secretInput, {
                onApprovalSucceeded: async (savedProvider) => {
                    await finishSavedProvider(savedProvider);
                },
                onApprovalFailed: reportSaveApprovalFailure,
            });
            if (secret.kind === 'failed') {
                if (secret.failure.code === 'identity_provider_revision_conflict') {
                    setRevisionConflict(true);
                    props.onRefreshRequested?.();
                }
                reportFailure(secret.failure.code);
                return false;
            }
            if (secret.kind === 'approval_pending') {
                setCommitPending(true);
                reportApprovalPending(secret.approval);
                return false;
            }
            current = secret.value;
        }
        return await finishSavedProvider(current);
    }, [appliedDraft?.clientSecret, client, draft.clientSecret, finishSavedProvider, mountedRef, owner, props.onRefreshRequested, reportApprovalPending, reportFailure, reportSaveApprovalFailure]);

    const save = React.useCallback(async () => {
        if (operationInFlightRef.current !== null || commitPending) return false;
        const nextValidation = validateManagedIdentityProviderDraft(draft, !provider);
        setValidation(nextValidation);
        if (nextValidation) {
            reportError(managedOidcValidationMessage(nextValidation));
            if (nextValidation.field === 'scopes' || nextValidation.field === 'loginClaim'
                || nextValidation.field === 'emailClaim' || nextValidation.field === 'groupsClaim') setAdvanced(true);
            const focusInvalidField = () => inputRefs[nextValidation.field]?.current?.focus();
            if (typeof globalThis.requestAnimationFrame === 'function') {
                globalThis.requestAnimationFrame(focusInvalidField);
            } else {
                setTimeout(focusInvalidField, 0);
            }
            return false;
        }
        const operationIdentity = Symbol('save-managed-identity-provider');
        operationInFlightRef.current = operationIdentity;
        setSaving(true);
        setError(null);
        try {
            if (!provider) {
                const createInput = {
                    owner,
                    displayName: draft.displayName.trim(),
                    config: managedOidcConfigFromDraft(draft),
                    clientSecret: draft.clientSecret,
                } as const;
                const created = await client.execute('identity.providers.create', createInput, {
                    onApprovalSucceeded: async (savedProvider) => {
                        await finishSavedProvider(savedProvider);
                    },
                    onApprovalFailed: reportSaveApprovalFailure,
                });
                if (created.kind === 'failed') {
                    reportFailure(created.failure.code);
                    return false;
                }
                if (created.kind === 'approval_pending') {
                    setCommitPending(true);
                    reportApprovalPending(created.approval);
                    return false;
                }
                return await finishSavedProvider(created.value);
            } else if (!createdProvider || JSON.stringify(draft) !== JSON.stringify(appliedDraft)) {
                const updateInput = {
                    owner,
                    id: provider.id,
                    expectedRevision: draftOrigin?.resourceId === provider.id ? draftOrigin.revision : provider.revision,
                    displayName: draft.displayName.trim(),
                    config: managedOidcConfigFromDraft(draft, provider),
                } as const;
                const updated = await client.execute('identity.providers.update', updateInput, {
                    onApprovalSucceeded: async (savedProvider) => {
                        await continueAfterProviderUpdate(savedProvider);
                    },
                    onApprovalFailed: reportSaveApprovalFailure,
                });
                if (updated.kind === 'failed') {
                    if (updated.failure.code === 'identity_provider_revision_conflict') {
                        setRevisionConflict(true);
                        props.onRefreshRequested?.();
                    }
                    reportFailure(updated.failure.code);
                    return false;
                }
                if (updated.kind === 'approval_pending') {
                    setCommitPending(true);
                    reportApprovalPending(updated.approval);
                    return false;
                }
                return await continueAfterProviderUpdate(updated.value);
            }
            return await finishSavedProvider(provider);
        } catch {
            if (provider) {
                setCreatedProvider(provider);
                setCommitPending(true);
            }
            reportError(t('identityAdministration.error'));
            return false;
        } finally {
            if (operationInFlightRef.current === operationIdentity) operationInFlightRef.current = null;
            setSaving(false);
        }
    }, [appliedDraft, client, commitPending, continueAfterProviderUpdate, createdProvider, draft, draftOrigin, finishSavedProvider, owner, props.onRefreshRequested, provider, reportApprovalPending, reportError, reportFailure, reportSaveApprovalFailure]);

    useUnsavedChangesBeforeRemoveGuard({
        ignoreRef,
        isDirty: dirty,
        isDirtyRef: dirtyRef,
        requestDecision,
        onSave: save,
        continueOnSave: false,
        onContinue: (action) => { if (action) (navigation as { dispatch?: (value: unknown) => void }).dispatch?.(action); },
        tag: 'ManagedIdentityProviderEditorScreen.beforeRemove',
    });

    if (props.loading) {
        return <ItemGroup><Item title={t('common.loading')} leftElement={<ActivitySpinner />} showChevron={false} /></ItemGroup>;
    }
    const callbackUrl = provider?.callbackUrl ?? null;
    return (
        <>
            {props.refreshFailure ? <AttentionBanner
                testID={`${props.testIdPrefix ?? 'identity-provider'}-refresh-failed`}
                title={t('identityAdministration.refreshFailed')}
                description={props.refreshFailure.retryable ? t('identityAdministration.refreshFailedHint') : identityAdministrationFailureMessage(props.refreshFailure.code)}
                announce="alert"
                action={props.onRefreshRequested ? { label: t('common.retry'), onPress: props.onRefreshRequested, testID: `${props.testIdPrefix ?? 'identity-provider'}-refresh-retry`, loading: props.refreshing, disabled: props.refreshing } : null}
            /> : null}
            <ManagedOidcProviderFields ownerKind={props.owner.kind} draft={draft} isEdit={isEdit} advanced={advanced} editable={props.mutationsAvailable} onAdvancedChange={setAdvanced} onChange={update} inputRefs={inputRefs} validation={validation} testIdPrefix={props.testIdPrefix} />
            {callbackUrl ? (
                <ItemGroup description={t('identityAdministration.callbackUrlHint')}>
                    <SettingRow
                        setting={settings.settings.callbackUrl}
                        testID={`${props.testIdPrefix ?? 'identity-provider'}-callback-url`}
                        subtitle={callbackUrl}
                        rightElement={<CopiedPill visible={copyFeedback.isCopied()} testID={`${props.testIdPrefix ?? 'identity-provider'}-callback-url-copied`} />}
                        onPress={() => void copyCallbackUrl(callbackUrl)}
                        showChevron={false}
                    />
                </ItemGroup>
            ) : null}
            {props.additionalFields}
            {revisionConflict && provider ? <ItemGroup description={t('identityAdministration.settingsChangedElsewhere')}>{draftOrigin?.resourceId !== provider.id || provider.revision > draftOrigin.revision ? <Item testID="identity-provider-reload-conflict" title={t('common.refresh')} onPress={reloadConflictedProvider} showChevron={false} /> : props.onRefreshRequested ? <Item testID="identity-provider-refresh-conflict" title={t('common.retry')} onPress={props.onRefreshRequested} showChevron={false} /> : null}</ItemGroup> : null}
            <ItemGroup description={error ?? undefined}>
                {provider ? <SettingAnchor setting={settings.settings.validate}><Item testID={`${props.testIdPrefix ?? 'identity-provider'}-test`} title={testing ? t('identityAdministration.validating') : t('identityAdministration.validate')} detail={tested ? t('identityAdministration.validated') : undefined} loading={testing} disabled={saving || testing || providerDirty || revisionConflict || !props.mutationsAvailable} onPress={() => void testConfiguration()} showChevron={false} /></SettingAnchor> : null}
                <SettingAnchor setting={settings.settings.save}><Item testID={props.saveTestId ?? `${props.testIdPrefix ?? 'identity-provider'}-save`} title={saving ? t('identityAdministration.saving') : t('identityAdministration.save')} loading={saving} disabled={saving || commitPending || revisionConflict || !dirty || !props.mutationsAvailable} onPress={() => save()} showChevron={false} /></SettingAnchor>
            </ItemGroup>
        </>
    );
});

const HomeManagedOidcProviderEditorAdapter = React.memo(function HomeManagedOidcProviderEditorAdapter(props: Readonly<{
    context: HomeAdministrationContext;
    providerId?: string;
}>) {
    const router = useRouter();
    const providers = useManagedIdentityProviders(props.context.scope, { kind: 'home' }, props.context.requestApproval);
    const onSaved = React.useCallback((saved: ManagedIdentityProviderV1) => {
        router.replace(homeAdministrationIdentityProviderPath(props.context.scope.serverId, saved.id));
        return { kind: 'completed' } as const;
    }, [props.context.scope.serverId, router]);
    const provider = props.providerId && providers.state.kind === 'ready'
        ? providers.state.items.find((item) => item.id === props.providerId && item.kind === 'oidc') ?? null
        : null;
    if (props.providerId && providers.state.kind === 'unavailable') {
        return <ItemGroup description={providers.state.failure.retryable ? t('teams.unavailable.offline') : t('identityAdministration.error')}><Item title={t('identityAdministration.error')} detail={providers.state.failure.retryable ? t('common.retry') : undefined} onPress={providers.state.failure.retryable ? providers.refresh : undefined} showChevron={false} /></ItemGroup>;
    }
    if (props.providerId && providers.state.kind === 'ready' && !provider) {
        return <ItemGroup><Item title={t('identityAdministration.error')} showChevron={false} /></ItemGroup>;
    }
    return <ManagedOidcProviderEditorContent
        scope={props.context.scope}
        owner={{ kind: 'home' }}
        provider={provider}
        loading={Boolean(props.providerId) && providers.state.kind === 'loading'}
        refreshing={providers.state.kind === 'ready' && providers.state.refreshing}
        refreshFailure={providers.state.kind === 'ready' ? providers.state.failure : null}
        mutationsAvailable={props.context.mutationsAvailable}
        onApprovalPending={props.context.requestApproval}
        onRefreshRequested={providers.refresh}
        onSaved={onSaved}
    />;
});

export const ManagedIdentityProviderEditorScreen = React.memo(function ManagedIdentityProviderEditorScreen(props: Readonly<{
    serverId: string;
    providerId?: string;
}>) {
    return (
        <HomeAdministrationSection serverId={props.serverId} title={t(props.providerId ? 'identityAdministration.editTitle' : 'identityAdministration.createTitle')} description={t('homeGovernance.pages.identityProviderEditor')}>
            {(context) => context.projection.capabilities.manageAuthentication
                ? <HomeManagedOidcProviderEditorAdapter
                    key={`${serverAccountScopeKeySuffix(context.scope)}:${props.providerId ?? 'create'}`}
                    context={context}
                    providerId={props.providerId}
                />
                : <ItemGroup><Item title={t('homeGovernance.forbiddenTitle')} showChevron={false} /></ItemGroup>}
        </HomeAdministrationSection>
    );
});
