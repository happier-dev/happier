import * as React from 'react';
import { useNavigation, useRouter } from '@/components/appShell/workspace/destinationRoute';
import { AppState } from 'react-native';
import type {
    ManagedGitHubAppCreateOutputV1,
    ManagedGitHubAppManifestSetupStartOutputV1,
    ManagedGitHubAppRegistrationV1,
    ManagedGitHubAppUpdateOutputV1,
} from '@happier-dev/protocol';

import { announceAccessibilityMessage } from '@/components/ui/accessibility/announceAccessibilityMessage';
import {
    revisionedSettingsDraftTransition,
    type RevisionedSettingsDraftOrigin,
} from '@/components/settings/identity/revisionedSettingsDraft';
import { CopiedPill } from '@/components/ui/copy/CopiedPill';
import { useTemporaryCopyFeedback } from '@/components/ui/copy/useTemporaryCopyFeedback';
import { setClipboardStringSafe } from '@/utils/ui/clipboard';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { SettingAnchor, SettingRow, SettingSection } from "@/components/settings/shell/SettingRow";
import { HOME_GITHUB_APP_EDITOR_SETTINGS, TEAM_GITHUB_APP_EDITOR_SETTINGS } from "@/components/settings/identity/identitySettings";
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Modal } from '@/modal';
import { t } from '@/text';
import { useUnsavedChangesBeforeRemoveGuard } from '@/utils/navigation/useUnsavedChangesBeforeRemoveGuard';
import { promptUnsavedChangesAlert } from '@/utils/ui/promptUnsavedChangesAlert';
import { openExternalUrl } from '@/utils/url/openExternalUrl';
import { serverAccountScopeKeySuffix } from '@/sync/domains/scope/serverAccountScope';
import type { ActionApprovalRegistration } from '@/components/approvals/actionApprovalContinuation';

import { HomeAdministrationSection } from '../governance/HomeAdministrationSection';
import type { HomeAdministrationContext } from '../governance/homeAdministrationContext';
import { useManagedGitHubApps, useManagedGitHubAppsClient } from './useManagedGitHubApps';
import type { ManagedGitHubAppSurface } from './managedGitHubAppSurface';
import {
    ManagedGitHubAppFailureRecovery,
    managedGitHubAppFailureMessage,
} from './ManagedGitHubAppFailure';
import { homeManagedGitHubAppSurface } from './ManagedGitHubAppsSection';
import {
    consumePendingGitHubAppManifestSetup,
    recordPendingGitHubAppManifestSetup,
    type PendingGitHubAppManifestSetup,
} from './githubAppOAuthReturn';

type Draft = Readonly<{
    githubHost: string;
    githubAppId: string;
    githubClientId: string;
    githubAppSlug: string;
    githubOwnerLogin: string;
    clientSecret: string;
    privateKey: string;
    webhookSecret: string;
}>;

const EMPTY_DRAFT: Draft = Object.freeze({
    githubHost: 'https://github.com', githubAppId: '', githubClientId: '', githubAppSlug: '',
    githubOwnerLogin: '', clientSecret: '', privateKey: '', webhookSecret: '',
});

function draftFromRegistration(registration: ManagedGitHubAppRegistrationV1): Draft {
    return {
        githubHost: registration.githubHost,
        githubAppId: registration.githubAppId,
        githubClientId: registration.githubClientId,
        githubAppSlug: registration.githubAppSlug ?? '',
        githubOwnerLogin: registration.githubOwnerLogin ?? '',
        clientSecret: '', privateKey: '', webhookSecret: '',
    };
}

export function validateManagedGitHubAppDraft(draft: Draft, isCreate: boolean): 'required' | null {
    let hostIsHttps = false;
    try { hostIsHttps = new URL(draft.githubHost.trim()).protocol === 'https:'; } catch { hostIsHttps = false; }
    if (!hostIsHttps || !/^[1-9][0-9]*$/u.test(draft.githubAppId.trim()) || !draft.githubClientId.trim()) return 'required';
    if (isCreate && !draft.privateKey) return 'required';
    return null;
}

/**
 * Registering or editing one GitHub App, for whichever owner the enclosing
 * settings tree administers.
 *
 * Both setup routes live here on purpose: manifest-assisted registration is the
 * short path on github.com, and the manual fields are the only way to adopt an
 * enterprise-owned App or a GitHub Enterprise Server host. Splitting them would
 * give one concept two forms to keep in step.
 */
export const ManagedGitHubAppEditorContent = React.memo(function ManagedGitHubAppEditorContent(props: Readonly<{
    surface: ManagedGitHubAppSurface;
    manifestReturn: PendingGitHubAppManifestSetup;
    registrationId?: string;
}>) {
    const router = useRouter();
    const navigation = useNavigation();
    const { owner, scope } = props.surface;
    const settings = owner.kind === "home" ? HOME_GITHUB_APP_EDITOR_SETTINGS : TEAM_GITHUB_APP_EDITOR_SETTINGS;
    const client = useManagedGitHubAppsClient(scope);
    const apps = useManagedGitHubApps(scope, owner);
    const refreshApps = apps.refresh;
    const registration = props.registrationId && apps.state.kind === 'ready'
        ? apps.state.registrations.find((item) => item.id === props.registrationId) ?? null
        : null;
    const [draft, setDraft] = React.useState<Draft>(EMPTY_DRAFT);
    const [baseline, setBaseline] = React.useState<Draft>(EMPTY_DRAFT);
    const [draftOrigin, setDraftOrigin] = React.useState<RevisionedSettingsDraftOrigin | null>(null);
    const [revisionConflict, setRevisionConflict] = React.useState(false);
    const [saving, setSaving] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);
    const [approvalNotice, setApprovalNotice] = React.useState<string | null>(null);
    const [manifestAppName, setManifestAppName] = React.useState('');
    const [manifestOrganization, setManifestOrganization] = React.useState('');
    const [manifestForOrganization, setManifestForOrganization] = React.useState(false);
    const draftDirty = JSON.stringify(draft) !== JSON.stringify(baseline);
    const manifestDirty = manifestAppName.length > 0 || manifestOrganization.length > 0 || manifestForOrganization;
    const dirty = draftDirty || manifestDirty;
    // The two setup paths mutate the same registration owner. State supplies
    // presentation, while this ref prevents a second dispatch in the same
    // event frame before `saving` has rendered.
    const operationInFlightRef = React.useRef<symbol | null>(null);
    const dirtyRef = React.useRef(dirty);
    dirtyRef.current = dirty;
    const ignoreRef = React.useRef(false);
    React.useEffect(() => () => {
        operationInFlightRef.current = null;
    }, []);
    const reportApprovalPending = React.useCallback((approval: ActionApprovalRegistration) => {
        props.surface.onApprovalPending?.(approval);
        const message = t('connect.waitingForApproval');
        setError(null);
        setApprovalNotice(message);
        announceAccessibilityMessage(message);
    }, [props.surface.onApprovalPending]);
    const reportApprovalFailure = React.useCallback((code: string) => {
        setApprovalNotice(null);
        setError(code);
    }, []);
    const finishSave = React.useCallback((result: ManagedGitHubAppCreateOutputV1 | ManagedGitHubAppUpdateOutputV1) => {
        ignoreRef.current = true;
        router.replace(props.surface.routes.detail(result.registration.id));
    }, [props.surface.routes, router]);
    const adoptRegistration = React.useCallback(() => {
        if (!registration) return;
        const next = draftFromRegistration(registration);
        setDraft(next);
        setBaseline(next);
        setDraftOrigin({ resourceId: registration.id, revision: registration.revision });
        setRevisionConflict(false);
        setError(null);
    }, [registration]);
    React.useEffect(() => {
        if (!registration) return;
        const transition = revisionedSettingsDraftTransition({
            origin: draftOrigin,
            current: { resourceId: registration.id, revision: registration.revision },
            dirty: draftDirty,
        });
        if (transition === 'keep') return;
        if (transition === 'conflict') {
            setRevisionConflict(true);
            return;
        }
        adoptRegistration();
    }, [adoptRegistration, draftDirty, draftOrigin, registration]);
    React.useEffect(() => {
        const subscription = AppState.addEventListener('change', (nextState) => {
            if (nextState === 'active') return;
            setDraft((current) => current.clientSecret || current.privateKey || current.webhookSecret
                ? { ...current, clientSecret: '', privateKey: '', webhookSecret: '' }
                : current);
        });
        return () => subscription.remove();
    }, []);
    const update = React.useCallback(<K extends keyof Draft>(key: K, value: Draft[K]) => {
        setDraft((current) => ({ ...current, [key]: value }));
        setError(null);
        setApprovalNotice(null);
    }, []);
    const save = React.useCallback(async (): Promise<boolean> => {
        if (operationInFlightRef.current !== null || revisionConflict || !props.surface.mutationsAvailable) return false;
        if (validateManagedGitHubAppDraft(draft, !props.registrationId)) {
            setError(t('identityAdministration.githubRequired'));
            return false;
        }
        const operationIdentity = Symbol('save-managed-github-app');
        operationInFlightRef.current = operationIdentity;
        setSaving(true);
        setError(null);
        setApprovalNotice(null);
        try {
            if (!registration) {
                const result = await client.execute('identity.githubApps.create', {
                    owner,
                    githubHost: draft.githubHost.trim(),
                    githubAppId: draft.githubAppId.trim(),
                    githubClientId: draft.githubClientId.trim(),
                    githubAppSlug: draft.githubAppSlug.trim() || null,
                    githubOwnerLogin: draft.githubOwnerLogin.trim() || null,
                    secrets: {
                        privateKey: draft.privateKey,
                        ...(draft.clientSecret ? { clientSecret: draft.clientSecret } : {}),
                        ...(draft.webhookSecret ? { webhookSecret: draft.webhookSecret } : {}),
                    },
                }, {
                    onApprovalSucceeded: finishSave,
                    onApprovalFailed: reportApprovalFailure,
                });
                if (result.kind === 'failed') { setError(result.failure.code); return false; }
                if (result.kind === 'approval_pending') { reportApprovalPending(result.approval); return false; }
                finishSave(result.value);
                return true;
            }
            const secrets = {
                ...(draft.clientSecret ? { clientSecret: draft.clientSecret } : {}),
                ...(draft.privateKey ? { privateKey: draft.privateKey } : {}),
                ...(draft.webhookSecret ? { webhookSecret: draft.webhookSecret } : {}),
            };
            const result = await client.execute('identity.githubApps.update', {
                owner, registrationId: registration.id,
                expectedRevision: draftOrigin?.resourceId === registration.id
                    ? draftOrigin.revision
                    : registration.revision,
                patch: {
                    githubClientId: draft.githubClientId.trim(),
                    githubAppSlug: draft.githubAppSlug.trim() || null,
                    githubOwnerLogin: draft.githubOwnerLogin.trim() || null,
                    ...(Object.keys(secrets).length > 0 ? { secrets } : {}),
                },
            }, {
                onApprovalSucceeded: finishSave,
                onApprovalFailed: reportApprovalFailure,
            });
            if (result.kind === 'failed') {
                setError(result.failure.code);
                if (result.failure.code === 'github_app_revision_conflict') {
                    setRevisionConflict(true);
                    void refreshApps();
                }
                return false;
            }
            if (result.kind === 'approval_pending') { reportApprovalPending(result.approval); return false; }
            finishSave(result.value);
            return true;
        } catch {
            setError(t('identityAdministration.error'));
            return false;
        } finally {
            if (operationInFlightRef.current === operationIdentity) operationInFlightRef.current = null;
            setSaving(false);
        }
    }, [client, draft, draftOrigin, finishSave, owner, props.registrationId, props.surface.mutationsAvailable, refreshApps, registration, reportApprovalFailure, reportApprovalPending, revisionConflict]);

    const finishManifestSetup = React.useCallback(async (result: ManagedGitHubAppManifestSetupStartOutputV1): Promise<boolean> => {
        recordPendingGitHubAppManifestSetup(props.manifestReturn);
        if (!await openExternalUrl(result.authorizeUrl)) {
            consumePendingGitHubAppManifestSetup();
            setError('github_manifest_setup_open_failed');
            return false;
        }
        setManifestAppName('');
        setManifestOrganization('');
        setManifestForOrganization(false);
        return true;
    }, [props.manifestReturn]);

    const startManifestSetup = React.useCallback(async (): Promise<boolean> => {
        if (operationInFlightRef.current !== null || !props.surface.mutationsAvailable) return false;
        if (!manifestAppName.trim() || (manifestForOrganization && !manifestOrganization.trim())) {
            setError(t('identityAdministration.required')); return false;
        }
        const operationIdentity = Symbol('start-managed-github-app-manifest');
        operationInFlightRef.current = operationIdentity;
        setSaving(true); setError(null);
        setApprovalNotice(null);
        try {
            const result = await client.execute('identity.githubApps.manifestSetup.start', {
                owner, appName: manifestAppName.trim(),
                githubOwner: manifestForOrganization
                    ? { kind: 'organization', login: manifestOrganization.trim() }
                    : { kind: 'account' },
            }, {
                onApprovalSucceeded: async (value) => { await finishManifestSetup(value); },
                onApprovalFailed: reportApprovalFailure,
            });
            if (result.kind === 'failed') { setError(result.failure.code); return false; }
            if (result.kind === 'approval_pending') { reportApprovalPending(result.approval); return false; }
            return await finishManifestSetup(result.value);
        } catch {
            setError(t('identityAdministration.error'));
            return false;
        } finally {
            if (operationInFlightRef.current === operationIdentity) operationInFlightRef.current = null;
            setSaving(false);
        }
    }, [client, finishManifestSetup, manifestAppName, manifestForOrganization, manifestOrganization, owner, props.surface.mutationsAvailable, reportApprovalFailure, reportApprovalPending]);

    const copyFeedback = useTemporaryCopyFeedback();
    const copyCallbackUrl = React.useCallback(async (url: string) => {
        if (!await setClipboardStringSafe(url)) {
            await Modal.alertAsync(t('common.error'), t('items.failedToCopyToClipboard'));
            return;
        }
        copyFeedback.markCopied();
    }, [copyFeedback]);

    const saveBeforeLeave = React.useCallback(
        async () => manifestDirty && !draftDirty ? await startManifestSetup() : await save(),
        [draftDirty, manifestDirty, save, startManifestSetup],
    );

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
    useUnsavedChangesBeforeRemoveGuard({
        ignoreRef,
        isDirty: dirty,
        isDirtyRef: dirtyRef,
        requestDecision,
        onSave: saveBeforeLeave,
        continueOnSave: false,
        onContinue: (action) => { if (action) (navigation as { dispatch?: (value: unknown) => void }).dispatch?.(action); },
        tag: 'ManagedGitHubAppEditorScreen.beforeRemove',
    });

    if (props.registrationId && apps.state.kind === 'loading') return <ItemGroup><Item title={t('common.loading')} leftElement={<ActivitySpinner />} showChevron={false} /></ItemGroup>;
    if (props.registrationId && !registration) return <ItemGroup><Item title={t('identityAdministration.error')} showChevron={false} /></ItemGroup>;
    const edit = Boolean(registration);
    // Manual setup is the only path that needs this: the manifest flow writes its
    // own `redirect_url`. The Home derives the value and never persists it, so it
    // is absent when the Home has no public server URL to derive one from.
    const callbackUrl = registration?.callbackUrl ?? null;
    return (
        <>
            {!edit ? <SettingSection section={settings.sectionRefs.setup}><ItemGroup title={t('identityAdministration.githubManifestSetup')} description={t('identityAdministration.githubManifestSetupSubtitle')}>
                <SettingRow setting={settings.settings.manifestAppName} accessoryLayout="adaptive" showChevron={false} rightElement={<FieldTextInput testID="github-manifest-app-name" accessibilityLabel={t('identityAdministration.githubAppName')} value={manifestAppName} editable={props.surface.mutationsAvailable} onChangeText={setManifestAppName} />} />
                <SettingRow setting={settings.settings.manifestForOrganization} testID="github-manifest-organization-toggle" selected={manifestForOrganization} disabled={!props.surface.mutationsAvailable} onPress={() => setManifestForOrganization((value) => !value)} showChevron={false} />
                {manifestForOrganization ? <SettingRow setting={settings.settings.manifestOrganization} accessoryLayout="adaptive" showChevron={false} rightElement={<FieldTextInput testID="github-manifest-organization" accessibilityLabel={t('identityAdministration.githubOrganizationLogin')} value={manifestOrganization} editable={props.surface.mutationsAvailable} autoCapitalize="none" onChangeText={setManifestOrganization} />} /> : null}
                <SettingAnchor setting={settings.settings.manifestSetup}><Item testID="github-manifest-start" title={saving ? t('identityAdministration.githubOpeningSetup') : t('identityAdministration.githubManifestSetup')} loading={saving} disabled={saving || !props.surface.mutationsAvailable} onPress={() => void startManifestSetup()} showChevron={false} /></SettingAnchor>
            </ItemGroup></SettingSection> : null}
            <SettingSection section={settings.sectionRefs.configuration}><SettingAnchor setting={settings.settings.manualSetup}><ItemGroup title={edit ? t('identityAdministration.configuration') : t('identityAdministration.githubManualSetup')}>
                <SettingRow setting={settings.settings.githubHost} accessoryLayout="adaptive" showChevron={false} rightElement={<FieldTextInput testID="github-app-host" accessibilityLabel={t('identityAdministration.githubHost')} value={draft.githubHost} editable={!edit && props.surface.mutationsAvailable} autoCapitalize="none" onChangeText={(value) => update('githubHost', value)} />} />
                <SettingRow setting={settings.settings.githubAppId} accessoryLayout="adaptive" showChevron={false} rightElement={<FieldTextInput testID="github-app-id" accessibilityLabel={t('identityAdministration.githubAppId')} value={draft.githubAppId} editable={!edit && props.surface.mutationsAvailable} keyboardType="number-pad" onChangeText={(value) => update('githubAppId', value)} />} />
                <SettingRow setting={settings.settings.githubClientId} accessoryLayout="adaptive" showChevron={false} rightElement={<FieldTextInput testID="github-app-client-id" accessibilityLabel={t('identityAdministration.githubClientId')} value={draft.githubClientId} editable={props.surface.mutationsAvailable} autoCapitalize="none" onChangeText={(value) => update('githubClientId', value)} />} />
                <SettingRow setting={settings.settings.githubAppSlug} accessoryLayout="adaptive" showChevron={false} rightElement={<FieldTextInput testID="github-app-slug" accessibilityLabel={t('identityAdministration.githubAppSlug')} value={draft.githubAppSlug} editable={props.surface.mutationsAvailable} autoCapitalize="none" onChangeText={(value) => update('githubAppSlug', value)} />} />
                <SettingRow setting={settings.settings.githubOwnerLogin} accessoryLayout="adaptive" showChevron={false} rightElement={<FieldTextInput testID="github-app-owner" accessibilityLabel={t('identityAdministration.githubOwnerLogin')} value={draft.githubOwnerLogin} editable={props.surface.mutationsAvailable} autoCapitalize="none" onChangeText={(value) => update('githubOwnerLogin', value)} />} />
            </ItemGroup></SettingAnchor></SettingSection>
            {callbackUrl ? (
                <ItemGroup description={t('identityAdministration.callbackUrlHint')}>
                    <SettingRow
                        setting={settings.settings.callbackUrl}
                        testID="github-app-callback-url"
                        subtitle={callbackUrl}
                        rightElement={<CopiedPill visible={copyFeedback.isCopied()} testID="github-app-callback-url-copied" />}
                        onPress={() => void copyCallbackUrl(callbackUrl)}
                        showChevron={false}
                    />
                </ItemGroup>
            ) : null}
            <ItemGroup title={t('identityAdministration.advanced')} description={edit ? t('identityAdministration.githubSecretsRetain') : undefined}>
                <SettingRow setting={settings.settings.clientSecret} accessoryLayout="adaptive" showChevron={false} rightElement={<FieldTextInput testID="github-app-client-secret" accessibilityLabel={t('identityAdministration.clientSecret')} value={draft.clientSecret} editable={props.surface.mutationsAvailable} secureTextEntry autoCapitalize="none" onChangeText={(value) => update('clientSecret', value)} />} />
                <SettingRow setting={settings.settings.privateKey} accessoryLayout="stacked" showChevron={false} rightElement={<FieldTextInput testID="github-app-private-key" accessibilityLabel={t('identityAdministration.githubPrivateKey')} value={draft.privateKey} editable={props.surface.mutationsAvailable} secureTextEntry multiline autoCapitalize="none" onChangeText={(value) => update('privateKey', value)} />} />
                <SettingRow setting={settings.settings.webhookSecret} accessoryLayout="adaptive" showChevron={false} rightElement={<FieldTextInput testID="github-app-webhook-secret" accessibilityLabel={t('identityAdministration.githubWebhookSecret')} value={draft.webhookSecret} editable={props.surface.mutationsAvailable} secureTextEntry autoCapitalize="none" onChangeText={(value) => update('webhookSecret', value)} />} />
            </ItemGroup>
            {revisionConflict && registration ? <ItemGroup description={t('identityAdministration.settingsChangedElsewhere')}>{draftOrigin?.resourceId !== registration.id || registration.revision > draftOrigin.revision
                ? <Item testID="github-app-reload-conflict" title={t('common.refresh')} disabled={saving || !props.surface.mutationsAvailable} onPress={adoptRegistration} showChevron={false} />
                : <Item testID="github-app-refresh-conflict" title={t('common.retry')} disabled={saving} onPress={refreshApps} showChevron={false} />}</ItemGroup> : null}
            <ItemGroup description={approvalNotice ?? (error ? managedGitHubAppFailureMessage(error) : undefined)}>
                <SettingAnchor setting={settings.settings.save}><Item testID="github-app-save" title={saving ? t('identityAdministration.saving') : t('identityAdministration.save')} loading={saving} disabled={saving || revisionConflict || !dirty || !props.surface.mutationsAvailable} onPress={() => void save()} showChevron={false} /></SettingAnchor>
                {error ? <ManagedGitHubAppFailureRecovery code={error} surface={props.surface} /> : null}
            </ItemGroup>
        </>
    );
});

export const ManagedGitHubAppEditorScreen = React.memo(function ManagedGitHubAppEditorScreen(props: Readonly<{ serverId: string; registrationId?: string }>) {
    return <HomeAdministrationSection serverId={props.serverId} title={t(props.registrationId ? 'identityAdministration.githubAppEditTitle' : 'identityAdministration.githubAppCreateTitle')} description={t('homeGovernance.pages.githubAppEditor')}>{(context) => context.projection.capabilities.manageAuthentication ? <ManagedGitHubAppEditorContent key={`${serverAccountScopeKeySuffix(context.scope)}:${props.registrationId ?? 'create'}`} surface={homeManagedGitHubAppSurface(context)} manifestReturn={{ kind: 'home', serverId: context.scope.serverId }} {...(props.registrationId ? { registrationId: props.registrationId } : {})} /> : <ItemGroup><Item title={t('homeGovernance.forbiddenTitle')} showChevron={false} /></ItemGroup>}</HomeAdministrationSection>;
});
