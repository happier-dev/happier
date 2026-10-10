import * as React from 'react';
import { signInConnectionStatusLabel } from '@/components/settings/identity/signInConnectionStatus';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';

import { CopiedPill } from '@/components/ui/copy/CopiedPill';
import { useTemporaryCopyFeedback } from '@/components/ui/copy/useTemporaryCopyFeedback';
import { setClipboardStringSafe } from '@/utils/ui/clipboard';
import { announceAccessibilityMessage } from '@/components/ui/accessibility/announceAccessibilityMessage';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SectionButtonRow } from '@/components/ui/lists/SectionButtonRow';
import { SettingAnchor, SettingRow, SettingSection } from '@/components/settings/shell/SettingRow';
import { HOME_GITHUB_APP_SETTINGS, TEAM_GITHUB_APP_SETTINGS } from '@/components/settings/identity/identitySettings';
import { Modal } from '@/modal';
import { t } from '@/text';
import { serverAccountScopeKeySuffix } from '@/sync/domains/scope/serverAccountScope';
import { openExternalUrl } from '@/utils/url/openExternalUrl';
import type { ActionApprovalRegistration } from '@/components/approvals/actionApprovalContinuation';

import { HomeAdministrationSection } from '../governance/HomeAdministrationSection';
import type { ManagedGitHubAppSurface } from './managedGitHubAppSurface';
import {
    ManagedGitHubAppFailureRecovery,
    managedGitHubAppFailureMessage,
} from './ManagedGitHubAppFailure';
import { homeManagedGitHubAppSurface, managedGitHubAppDisplayName, managedGitHubAppStateLabel } from './ManagedGitHubAppsSection';
import {
    consumePendingGitHubAppVerification,
    recordPendingGitHubAppVerification,
} from './githubAppOAuthReturn';
import { useManagedGitHubApps, useManagedGitHubAppsClient } from './useManagedGitHubApps';
import { Icon } from '@/components/ui/icons/Icon';

/**
 * One GitHub App registration, its verified installations, and the two
 * operations that change them, for whichever owner the enclosing settings tree
 * administers.
 */
export const ManagedGitHubAppDetailContent = React.memo(function ManagedGitHubAppDetailContent(props: Readonly<{
    surface: ManagedGitHubAppSurface;
    registrationId: string;
}>) {
    const router = useRouter();
    const { owner, scope } = props.surface;
    const settings = owner.kind === 'home' ? HOME_GITHUB_APP_SETTINGS : TEAM_GITHUB_APP_SETTINGS;
    const client = useManagedGitHubAppsClient(scope);
    const { state, refresh } = useManagedGitHubApps(scope, owner);
    const [installationId, setInstallationId] = React.useState('');
    const [organizationId, setOrganizationId] = React.useState('');
    const [pending, setPending] = React.useState<string | null>(null);
    const [error, setError] = React.useState<string | null>(null);
    const [notice, setNotice] = React.useState<string | null>(null);
    const copyFeedback = useTemporaryCopyFeedback();
    const copyCallbackUrl = React.useCallback(async (url: string) => {
        if (!await setClipboardStringSafe(url)) {
            await Modal.alertAsync(t('common.error'), t('items.failedToCopyToClipboard'));
            return;
        }
        copyFeedback.markCopied();
    }, [copyFeedback]);
    const reportApprovalFailure = (code: string) => {
        setNotice(null);
        setError(code);
    };
    const reportApprovalPending = (approval: ActionApprovalRegistration) => {
        props.surface.onApprovalPending?.(approval);
        const message = t('connect.waitingForApproval');
        setNotice(message);
        announceAccessibilityMessage(message);
    };
    if (state.kind === 'loading') return <ItemGroup><Item title={t('common.loading')} leftElement={<ActivitySpinner />} showChevron={false} /></ItemGroup>;
    if (state.kind === 'unavailable') {
        const message = managedGitHubAppFailureMessage(state.failure.code);
        return <ItemGroup description={message}><Item title={message} detail={state.failure.retryable ? t('common.retry') : undefined} onPress={state.failure.retryable ? refresh : undefined} showChevron={false} /></ItemGroup>;
    }
    const registration = state.registrations.find((item) => item.id === props.registrationId);
    if (!registration) return <ItemGroup><Item title={t('identityAdministration.error')} showChevron={false} /></ItemGroup>;
    const installations = state.installations.filter((item) => item.registrationId === registration.id);
    const verify = async () => {
        if (!props.surface.mutationsAvailable || pending !== null) return;
        const githubInstallationId = installationId.trim();
        const githubOrganizationId = organizationId.trim();
        if (!/^[1-9][0-9]*$/u.test(githubInstallationId) || !/^[1-9][0-9]*$/u.test(githubOrganizationId)) {
            setError(t('identityAdministration.githubRequired')); return;
        }
        setPending('verify'); setError(null); setNotice(null);
        try {
            const existing = installations.find((item) => item.githubInstallationId === githubInstallationId);
            const finishVerification = async (value: Readonly<{ authorizeUrl: string }>) => {
                setNotice(null);
                const returnTo = props.surface.routes.detail(registration.id);
                recordPendingGitHubAppVerification({ registrationId: registration.id, returnTo });
                if (!await openExternalUrl(value.authorizeUrl)) {
                    consumePendingGitHubAppVerification(registration.id);
                    setError('github_verification_open_failed');
                }
            };
            const result = await client.execute('identity.githubApps.verifyInstallation', {
                owner, registrationId: registration.id,
                expectedRegistrationRevision: registration.revision,
                expectedInstallationRevision: existing?.revision ?? 0,
                githubInstallationId, githubOrganizationId,
            }, {
                onApprovalSucceeded: finishVerification,
                onApprovalFailed: reportApprovalFailure,
            });
            if (result.kind === 'failed') { setError(result.failure.code); return; }
            if (result.kind === 'approval_pending') { reportApprovalPending(result.approval); return; }
            await finishVerification(result.value);
        } finally { setPending(null); }
    };
    const remove = async (installation: (typeof installations)[number]) => {
        if (!props.surface.mutationsAvailable || pending !== null) return;
        if (!await Modal.confirm(
            t('identityAdministration.githubRemoveInstallationTitle', { name: installation.githubOrganizationLogin }),
            t('identityAdministration.githubRemoveInstallationBody', { name: installation.githubOrganizationLogin }),
            { cancelText: t('common.cancel'), confirmText: t('identityAdministration.githubRemoveInstallation'), destructive: true },
        )) return;
        setPending(installation.id); setError(null); setNotice(null);
        try {
            const result = await client.execute('identity.githubApps.remove', {
                owner, installationId: installation.id, expectedRevision: installation.revision,
            }, {
                onApprovalSucceeded: () => { setNotice(null); refresh(); },
                onApprovalFailed: reportApprovalFailure,
            });
            if (result.kind === 'failed') {
                if (result.failure.code === 'github_installation_in_use') {
                    await Modal.alertAsync(t('identityAdministration.githubRemoveInstallation'), t('identityAdministration.githubInstallationInUse'));
                } else setError(result.failure.code);
                return;
            }
            if (result.kind === 'approval_pending') {
                reportApprovalPending(result.approval);
                return;
            }
            refresh();
        } finally { setPending(null); }
    };
    const busy = pending !== null || !props.surface.mutationsAvailable;
    const directoryRoute = props.surface.routes.directory;
    const teamConsumers = installations.flatMap((installation) => installation.teamConsumers);
    // Both projections are computed by the Home. The UI only names the returned
    // permission/event rows and their status; it never recomputes consumer access.
    const projectRequirementRows = (field: 'requirements' | 'prospectiveRequirements') => installations.flatMap((installation) => {
        const requirements = installation[field];
        if (!requirements) return [];
        const missingPermissions = new Map(requirements.missingPermissions.map((row) => [row.permission, row.required]));
        const missingEvents = new Set(requirements.missingEvents);
        return [
            ...Object.entries(requirements.permissions).map(([permission, level]) => ({
                key: `${installation.id}:permission:${permission}`,
                title: permission,
                subtitle: t('identityAdministration.githubRequiredPermission', { level }),
                missing: missingPermissions.has(permission),
            })),
            ...requirements.events.map((event) => ({
                key: `${installation.id}:event:${event}`,
                title: event,
                subtitle: t('identityAdministration.githubRequiredEvent'),
                missing: missingEvents.has(event),
            })),
        ];
    });
    const requirementRows = projectRequirementRows('requirements');
    const setupRequirementRows = projectRequirementRows('prospectiveRequirements');
    // Older Homes did not distinguish enabled consumers from setup candidates.
    // Keep their existing label rather than describing that projection as current.
    const hasCurrentAccessProjection = installations.length > 0 && installations.every((installation) => (
        installation.requirements !== undefined && installation.prospectiveRequirements !== undefined
    ));
    const hasAccessSection = requirementRows.length > 0 || hasCurrentAccessProjection || setupRequirementRows.length > 0;
    // The Home derives this from its public server URL and never persists it; it
    // is absent only when the Home has no public URL to derive one from, and the
    // manifest flow sets its own `redirect_url`, so only manual setup needs it.
    const callbackUrl = registration.callbackUrl ?? null;
    return (
        <>
            {state.stale ? <ItemGroup description={t('homeGovernance.offlineNotice')}><Item title={t('common.retry')} onPress={refresh} showChevron={false} /></ItemGroup> : null}
            <SettingSection section={settings.sectionRefs.configuration}>
                <ItemGroup title={managedGitHubAppDisplayName(registration)}>
                    <SettingRow setting={settings.settings.githubHost} detail={new URL(registration.githubHost).hostname} showChevron={false} />
                    {callbackUrl ? (
                        <SettingRow
                            setting={settings.settings.callbackUrl}
                            testID="github-app-callback-url"
                            subtitle={callbackUrl}
                            rightElement={<CopiedPill visible={copyFeedback.isCopied()} testID="github-app-callback-url-copied" />}
                            accessibilityHint={t('identityAdministration.callbackUrlHint')}
                            onPress={() => void copyCallbackUrl(callbackUrl)}
                            showChevron={false}
                        />
                    ) : null}
                    <SettingRow setting={settings.settings.githubAppSlug} detail={registration.githubAppSlug ?? '—'} showChevron={false} />
                    <SettingRow setting={settings.settings.githubOwnerLogin} detail={registration.githubOwnerLogin ?? '—'} showChevron={false} />
                    <SettingRow setting={settings.settings.githubPrivateKey} detail={registration.secretHealth.privateKeyConfigured ? t('identityAdministration.secretSet') : t('identityAdministration.secretNotSet')} showChevron={false} />
                    <SettingRow setting={settings.settings.clientSecret} detail={registration.secretHealth.clientSecretConfigured ? t('identityAdministration.secretSet') : t('identityAdministration.secretNotSet')} showChevron={false} />
                </ItemGroup>
            </SettingSection>
            <SettingSection section={settings.sectionRefs.installations} answersFor={hasAccessSection ? undefined : [settings.sectionRefs.access]}>
                <SettingAnchor setting={settings.settings.githubInstallations}>
                    <ItemGroup title={t('identityAdministration.githubInstallations')}>
                        {installations.length === 0 ? <Item title={t('identityAdministration.githubInstallationsEmpty')} showChevron={false} /> : installations.map((item) => (
                            <Item
                                key={item.id}
                                testID={`github-app-installation:${item.id}`}
                                title={item.githubOrganizationLogin}
                                subtitle={item.repositorySelection === 'all' ? t('identityAdministration.githubAllRepositories') : t('identityAdministration.githubSelectedRepositories')}
                                detail={managedGitHubAppStateLabel(item.state)}
                                mode="info"
                                accessoryLayout="adaptive"
                                rightElement={(
                                    <RoundButton
                                        testID={`github-app-installation-remove:${item.id}`}
                                        title={t('identityAdministration.githubRemoveInstallation')}
                                        accessibilityLabel={t('identityAdministration.githubRemoveInstallationFor', { name: item.githubOrganizationLogin })}
                                        size="normal"
                                        display="destructive"
                                        titleNumberOfLines="complete"
                                        disabled={busy}
                                        loading={pending === item.id}
                                        action={() => remove(item)}
                                    />
                                )}
                            />
                        ))}
                    </ItemGroup>
                </SettingAnchor>
                {teamConsumers.length > 0 ? (
                    <SettingAnchor setting={settings.settings.teamConsumers}>
                        <ItemGroup
                            title={t('identityAdministration.teamConsumers')}
                            description={t('identityAdministration.teamConsumersSubtitle')}
                        >
                            {teamConsumers.map((consumer) => (
                                <Item
                                    key={`${consumer.binding.kind}:${consumer.binding.id}`}
                                    testID={`github-app-team-consumer:${consumer.binding.kind}:${consumer.binding.id}`}
                                    title={consumer.team.name}
                                    subtitle={consumer.binding.kind === 'identity_connection'
                                        ? t('identityAdministration.githubFacetSignIn')
                                        : t('identityAdministration.githubFacetDirectory')}
                                    detail={consumer.binding.kind === 'identity_connection'
                                        ? signInConnectionStatusLabel(consumer.binding.enabled ? 'active' : 'disabled')
                                        : consumer.binding.state === 'active'
                                            ? t('teams.authentication.directory.state.active')
                                            : consumer.binding.state === 'initializing'
                                                ? t('teams.authentication.directory.state.syncing')
                                                : consumer.binding.state === 'paused'
                                                    ? t('teams.authentication.directory.state.paused')
                                                    : t('teams.authentication.directory.state.needsAttention')}
                                    showChevron={false}
                                />
                            ))}
                        </ItemGroup>
                    </SettingAnchor>
                ) : null}
            </SettingSection>
            {hasAccessSection ? (
                <SettingSection section={settings.sectionRefs.access}>
                    {requirementRows.length > 0 || hasCurrentAccessProjection ? (
                        <SettingAnchor setting={settings.settings.currentAccess}>
                            <ItemGroup
                                title={hasCurrentAccessProjection ? t('identityAdministration.githubCurrentAccess') : t('identityAdministration.githubRequiredAccess')}
                                description={hasCurrentAccessProjection
                                    ? t('identityAdministration.githubCurrentAccessSubtitle')
                                    : requirementRows.some((row) => row.missing)
                                    ? t('identityAdministration.githubRequiredAccessSubtitle')
                                    : t('identityAdministration.githubRequiredAccessSatisfied')}
                            >
                                {requirementRows.length === 0 ? <Item title={t('identityAdministration.githubCurrentAccessEmpty')} mode="info" /> : null}
                                {requirementRows.map((row) => (
                                    <Item
                                        key={row.key}
                                        testID={`github-app-requirement:${row.key}`}
                                        title={row.title}
                                        subtitle={row.subtitle}
                                        detail={row.missing
                                            ? t('identityAdministration.githubRequirementMissing')
                                            : t('identityAdministration.githubRequirementGranted')}
                                        showChevron={false}
                                    />
                                ))}
                            </ItemGroup>
                        </SettingAnchor>
                    ) : null}
                    {setupRequirementRows.length > 0 ? (
                        <SettingAnchor setting={settings.settings.setupAccess}>
                            <ItemGroup title={t('identityAdministration.githubSetupAccess')} description={t('identityAdministration.githubSetupAccessSubtitle')}>
                                {setupRequirementRows.map((row) => (
                                    <Item
                                        key={row.key}
                                        testID={`github-app-setup-requirement:${row.key}`}
                                        title={row.title}
                                        subtitle={row.subtitle}
                                        detail={row.missing
                                            ? t('identityAdministration.githubRequirementMissing')
                                            : t('identityAdministration.githubRequirementGranted')}
                                        mode="info"
                                    />
                                ))}
                            </ItemGroup>
                        </SettingAnchor>
                    ) : null}
                </SettingSection>
            ) : null}
            {installations.length > 0 ? (
                <ItemGroup
                    title={t('identityAdministration.githubConsumers')}
                    description={t('identityAdministration.githubConsumersSubtitle')}
                >
                    <SettingRow
                        setting={settings.settings.signIn}
                        testID="github-app-sign-in"
                        icon={<Icon name="sign-in" />}
                        subtitle={t('identityAdministration.githubFacetSignInSubtitle')}
                        detail={t('identityAdministration.githubFacetConfigure')}
                        onPress={() => router.push(props.surface.routes.signIn)}
                    />
                    {directoryRoute ? (
                        <SettingRow
                            setting={settings.settings.directory}
                            testID="github-app-directory"
                            icon={<Icon name="users" />}
                            subtitle={t('identityAdministration.githubFacetDirectorySubtitle')}
                            detail={t('identityAdministration.githubFacetConfigure')}
                            onPress={() => router.push(directoryRoute)}
                        />
                    ) : null}
                </ItemGroup>
            ) : null}
            <SettingSection section={settings.sectionRefs.verification}>
                <ItemGroup title={t('identityAdministration.githubVerifyInstallation')}>
                    <SettingRow setting={settings.settings.githubInstallationId} accessoryLayout="adaptive" showChevron={false} rightElement={<FieldTextInput testID="github-installation-id" accessibilityLabel={t('identityAdministration.githubInstallationId')} value={installationId} editable={props.surface.mutationsAvailable} keyboardType="number-pad" onChangeText={setInstallationId} />} />
                    <SettingRow setting={settings.settings.githubOrganizationId} accessoryLayout="adaptive" showChevron={false} rightElement={<FieldTextInput testID="github-organization-id" accessibilityLabel={t('identityAdministration.githubOrganizationId')} value={organizationId} editable={props.surface.mutationsAvailable} keyboardType="number-pad" onChangeText={setOrganizationId} />} />
                </ItemGroup>
                <ItemGroup surface="none">
                    <SectionButtonRow>
                        <SettingAnchor setting={settings.settings.verify}>
                            <RoundButton
                                testID="github-installation-verify"
                                title={pending === 'verify' ? t('identityAdministration.githubOpeningVerification') : t('identityAdministration.githubVerifyInstallation')}
                                accessibilityLabel={t('identityAdministration.githubVerifyInstallation')}
                                size="normal"
                                display="secondary"
                                titleNumberOfLines="complete"
                                loading={pending === 'verify'}
                                disabled={busy}
                                action={verify}
                            />
                        </SettingAnchor>
                    </SectionButtonRow>
                </ItemGroup>
            </SettingSection>
            {notice ? <ItemGroup><Item testID="github-app-notice" title={notice} showChevron={false} /></ItemGroup> : null}
            {error ? (
                <ItemGroup description={managedGitHubAppFailureMessage(error)}>
                    <Item title={t('identityAdministration.error')} showChevron={false} />
                    <ManagedGitHubAppFailureRecovery code={error} surface={props.surface} />
                </ItemGroup>
            ) : null}
            <SettingSection section={settings.sectionRefs.actions}>
                <ItemGroup title={t('identityAdministration.actions')}><SettingRow setting={settings.settings.edit} testID="github-app-edit" disabled={busy} onPress={() => router.push(props.surface.routes.edit(registration.id))} /></ItemGroup>
            </SettingSection>
        </>
    );
});

export const ManagedGitHubAppDetailScreen = React.memo(function ManagedGitHubAppDetailScreen(props: Readonly<{ serverId: string; registrationId: string }>) {
    return <HomeAdministrationSection serverId={props.serverId} title={t('identityAdministration.githubApps')} description={t('homeGovernance.pages.githubApp')}>{(context) => context.projection.capabilities.manageAuthentication ? <ManagedGitHubAppDetailContent key={`${serverAccountScopeKeySuffix(context.scope)}:${props.registrationId}`} surface={homeManagedGitHubAppSurface(context)} registrationId={props.registrationId} /> : <ItemGroup><Item title={t('homeGovernance.forbiddenTitle')} showChevron={false} /></ItemGroup>}</HomeAdministrationSection>;
});
