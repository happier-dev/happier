import * as React from 'react';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import type { IdentityConnectionTestDiagnosticsV1 } from '@happier-dev/protocol';

import { IdentityTestDiagnosticsGroup } from '@/components/settings/identity/IdentityTestDiagnosticsGroup';
import { HOME_IDENTITY_PROVIDER_SETTINGS } from '@/components/settings/identity/identitySettings';
import { SettingAnchor, SettingSection } from '@/components/settings/shell/SettingRow';
import { identityAdministrationFailureMessage } from '@/components/settings/identity/identityAdministrationFailure';
import { announceAccessibilityMessage } from '@/components/ui/accessibility/announceAccessibilityMessage';
import { CopiedPill } from '@/components/ui/copy/CopiedPill';
import { useTemporaryCopyFeedback } from '@/components/ui/copy/useTemporaryCopyFeedback';
import {
    resolveTestedSignInConnectionStatus,
    signInConnectionStatusLabel,
} from '@/components/settings/identity/signInConnectionStatus';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Modal } from '@/modal';
import { t } from '@/text';
import { setClipboardStringSafe } from '@/utils/ui/clipboard';
import { openExternalUrl } from '@/utils/url/openExternalUrl';
import { serverAccountScopeKeySuffix } from '@/sync/domains/scope/serverAccountScope';
import {
    createHomeActionApprovalContinuation,
    type ActionApprovalRegistration,
} from '@/components/approvals/actionApprovalContinuation';
import { useMountedRef } from '@/hooks/ui/useMountedRef';

import { HomeAdministrationSection } from '../governance/HomeAdministrationSection';
import type { HomeAdministrationContext } from '../governance/homeAdministrationContext';
import {
    homeAdministrationIdentityProviderEditPath,
    homeAdministrationIdentityProviderPath,
    homeAdministrationSignInProvidersPath,
} from '../governance/homeAdministrationRoutes';
import {
    consumeIdentityProviderTestReturn,
    discardPendingIdentityProviderTest,
    recordPendingIdentityProviderTest,
} from './identityProviderTestReturn';
import { runManagedIdentityProviderRemoval } from './managedIdentityProviderRemoval';
import { useManagedIdentityProviderClient, useManagedIdentityProviders } from './useManagedIdentityProviders';

const DetailContent = React.memo(function DetailContent(props: Readonly<{
    context: HomeAdministrationContext;
    providerId: string;
}>) {
    const router = useRouter();
    const mountedRef = useMountedRef();
    const client = useManagedIdentityProviderClient(props.context.scope);
    const [pending, setPending] = React.useState<string | null>(null);
    const [error, setError] = React.useState<string | null>(null);
    const [testDiagnostics, setTestDiagnostics] = React.useState<IdentityConnectionTestDiagnosticsV1 | null>(null);
    // The outcome is rendered in a group below the pressed control, so it is
    // announced through the canonical live region as well as shown.
    const reportFailure = React.useCallback((code: string) => {
        if (!mountedRef.current) return;
        setError(code);
        announceAccessibilityMessage(identityAdministrationFailureMessage(code));
    }, [mountedRef]);
    const reportApprovalPending = React.useCallback((registration: ActionApprovalRegistration) => {
        if (!mountedRef.current) return;
        props.context.requestApproval?.(registration);
        setError(null);
    }, [mountedRef, props.context.requestApproval]);
    const { state, refresh } = useManagedIdentityProviders(
        props.context.scope,
        { kind: 'home' },
        reportApprovalPending,
    );
    // The shared OAuth route has already consumed the one-time server handle.
    // Its process-local handoff is claimed only by this exact Home, Account,
    // and provider. Deferred execution is bound here to the same mounted
    // diagnostics callback used by an immediate result.
    const readTestReturnRef = React.useRef(false);
    React.useEffect(() => {
        if (readTestReturnRef.current) return;
        const returned = consumeIdentityProviderTestReturn({
            serverId: props.context.scope.serverId,
            accountId: props.context.scope.accountId,
            providerId: props.providerId,
        });
        if (!returned) return;
        readTestReturnRef.current = true;
        const applyResult = (value: Readonly<{ diagnostics?: IdentityConnectionTestDiagnosticsV1 }>) => {
            if (!mountedRef.current) return;
            setTestDiagnostics(value.diagnostics ?? null);
            setError(null);
            refresh();
        };
        if (returned.kind === 'completed') {
            applyResult(returned.diagnostics ? { diagnostics: returned.diagnostics } : {});
        } else if (returned.kind === 'failed') {
            reportFailure(returned.code);
        } else {
            reportApprovalPending(createHomeActionApprovalContinuation({
                artifactId: returned.artifactId,
                actionId: returned.actionId,
                scope: returned.scope,
                onSucceeded: applyResult,
                onFailed: reportFailure,
            }));
        }
    }, [mountedRef, props.context.scope.accountId, props.context.scope.serverId, props.providerId, refresh]);
    const copyFeedback = useTemporaryCopyFeedback();
    const copyCallbackUrl = React.useCallback(async (url: string) => {
        if (!await setClipboardStringSafe(url)) {
            await Modal.alertAsync(t('common.error'), t('items.failedToCopyToClipboard'));
            return;
        }
        copyFeedback.markCopied();
    }, [copyFeedback]);

    if (state.kind === 'loading') {
        return <ItemGroup><SurfaceStateCard testID="identity-provider-loading" kind="loading" size="line" title={t('common.loading')} /></ItemGroup>;
    }
    if (state.kind === 'unavailable') {
        return (
            <ItemGroup>
                <SurfaceStateCard
                    testID="identity-provider-unavailable"
                    kind="error"
                    size="line"
                    title={identityAdministrationFailureMessage(state.failure.code)}
                    action={state.failure.retryable ? { testID: 'identity-provider-retry', label: t('common.retry'), onPress: refresh } : undefined}
                />
            </ItemGroup>
        );
    }
    const provider = state.items.find((item) => item.id === props.providerId);
    if (!provider) {
        return <ItemGroup><SurfaceStateCard testID="identity-provider-missing" kind="error" size="line" title={t('identityAdministration.error')} /></ItemGroup>;
    }

    const runLifecycle = async (actionId: 'identity.providers.enable' | 'identity.providers.disable') => {
        setPending(actionId);
        setError(null);
        try {
            const refreshCurrentProvider = () => {
                if (mountedRef.current) refresh();
            };
            const result = await client.execute(actionId, {
                owner: { kind: 'home' },
                id: provider.id,
                expectedRevision: provider.revision,
                expectedSecurityRevision: provider.securityRevision,
            }, {
                onApprovalSucceeded: refreshCurrentProvider,
                onApprovalFailed: reportFailure,
            });
            if (result.kind === 'failed') reportFailure(result.failure.code);
            else if (result.kind === 'approval_pending') reportApprovalPending(result.approval);
            else refreshCurrentProvider();
        } finally {
            setPending(null);
        }
    };

    const beginProviderTest = async (value: Readonly<{ attemptId: string; authorizeUrl: string }>) => {
        if (!mountedRef.current) return;
        const returnTo = homeAdministrationIdentityProviderPath(props.context.scope.serverId, provider.id);
        recordPendingIdentityProviderTest({
            kind: 'home',
            serverId: props.context.scope.serverId,
            accountId: props.context.scope.accountId,
            providerId: provider.id,
            attemptId: value.attemptId,
            returnTo,
        });
        if (!await openExternalUrl(value.authorizeUrl)) {
            discardPendingIdentityProviderTest(provider.id);
            reportFailure('identity_provider_test_open_failed');
        }
    };

    const test = async () => {
        setPending('test');
        setError(null);
        setTestDiagnostics(null);
        try {
            const result = await client.execute('identity.providers.test.start', {
                owner: { kind: 'home' },
                id: provider.id,
                expectedRevision: provider.revision,
                expectedSecurityRevision: provider.securityRevision,
            }, {
                onApprovalSucceeded: beginProviderTest,
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
            await beginProviderTest(result.value);
        } finally {
            setPending(null);
        }
    };

    const remove = async () => {
        setPending('remove');
        setError(null);
        try {
            const completeRemoval = () => {
                if (!mountedRef.current) return;
                router.replace(homeAdministrationSignInProvidersPath(props.context.scope.serverId));
            };
            const outcome = await runManagedIdentityProviderRemoval({
                providerId: provider.id,
                readPreflight: async (options) => await client.execute(
                    'identity.providers.remove.preview',
                    {
                        owner: { kind: 'home' },
                        id: provider.id,
                        expectedRevision: provider.revision,
                    },
                    options,
                ),
                onApprovalPending: reportApprovalPending,
                confirm: async () => await Modal.confirm(
                    t('identityAdministration.removeTitle', { name: provider.displayName }),
                    t('identityAdministration.removeBody', { name: provider.displayName }),
                    { cancelText: t('common.cancel'), confirmText: t('identityAdministration.remove'), destructive: true },
                ),
                remove: async (expectedRevision) => {
                    const result = await client.execute('identity.providers.remove', {
                        owner: { kind: 'home' },
                        id: provider.id,
                        expectedRevision,
                    }, {
                        onApprovalSucceeded: completeRemoval,
                        onApprovalFailed: reportFailure,
                    });
                    return result;
                },
            });
            if (outcome.kind === 'blocked') {
                await Modal.alertAsync(
                    t('identityAdministration.remove'),
                    t('identityAdministration.removeBlocked', {
                        accounts: outcome.blockers.identityCount,
                        connections: outcome.blockers.connectionCount,
                    }),
                );
            } else if (outcome.kind === 'failed') {
                reportFailure(outcome.code);
            } else if (outcome.kind === 'approval_pending') {
                reportApprovalPending(outcome.approval);
            } else if (outcome.kind === 'removed') {
                completeRemoval();
            }
        } finally {
            setPending(null);
        }
    };

    const callbackUrl = provider.callbackUrl ?? null;
    const projectionCurrent = !state.refreshing && !state.stale;
    const busy = pending !== null || !props.context.mutationsAvailable || !projectionCurrent;
    return (
        <>
            {state.stale ? (
                <ItemGroup>
                    <SurfaceStateCard
                        testID="identity-provider-stale"
                        kind="error"
                        size="line"
                        title={t('homeGovernance.offlineNotice')}
                        action={{ testID: 'identity-provider-retry', label: t('common.retry'), onPress: refresh }}
                    />
                </ItemGroup>
            ) : null}
            <SettingSection
                section={HOME_IDENTITY_PROVIDER_SETTINGS.sectionRefs.configuration}
                answersFor={[HOME_IDENTITY_PROVIDER_SETTINGS.sectionRefs.consumers]}
            ><ItemGroup title={provider.displayName}>
                <Item title={t('identityAdministration.configuration')} detail={signInConnectionStatusLabel(provider.enabled ? 'active' : 'disabled')} showChevron={false} />
                {callbackUrl ? (
                    <SettingAnchor setting={HOME_IDENTITY_PROVIDER_SETTINGS.settings.callbackUrl}><Item
                        testID="identity-provider-callback-url"
                        title={t('identityAdministration.callbackUrl')}
                        subtitle={callbackUrl}
                        rightElement={<CopiedPill visible={copyFeedback.isCopied()} testID="identity-provider-callback-url-copied" />}
                        accessibilityHint={t('identityAdministration.callbackUrlHint')}
                        onPress={() => void copyCallbackUrl(callbackUrl)}
                        showChevron={false}
                    /></SettingAnchor>
                ) : null}
                {provider.kind === 'oidc' ? (
                    <>
                        <SettingAnchor setting={HOME_IDENTITY_PROVIDER_SETTINGS.settings.issuer}><Item title={t('identityAdministration.issuer')} detail={provider.config.issuer} showChevron={false} /></SettingAnchor>
                        <SettingAnchor setting={HOME_IDENTITY_PROVIDER_SETTINGS.settings.clientId}><Item title={t('identityAdministration.clientId')} detail={provider.config.clientId} showChevron={false} /></SettingAnchor>
                        <SettingAnchor setting={HOME_IDENTITY_PROVIDER_SETTINGS.settings.clientSecret}><Item
                            title={t('identityAdministration.clientSecret')}
                            detail={provider.secret.health === 'unreadable'
                                ? t('identityAdministration.secretNeedsAttention')
                                : provider.secret.configured
                                    ? t('identityAdministration.secretSet')
                                    : t('identityAdministration.secretNotSet')}
                            showChevron={false}
                        /></SettingAnchor>
                        {provider.secret.health === 'unreadable' ? (
                            <SettingAnchor setting={HOME_IDENTITY_PROVIDER_SETTINGS.settings.secretRepair}><Item
                                testID="identity-provider-secret-repair"
                                title={t('identityAdministration.secretNeedsAttention')}
                                detail={t('identityAdministration.secretRepair')}
                                disabled={busy}
                                onPress={() => router.push(homeAdministrationIdentityProviderEditPath(props.context.scope.serverId, provider.id))}
                            /></SettingAnchor>
                        ) : null}
                    </>
                ) : (
                    <Item
                        title={t('identityAdministration.githubFacetSignIn')}
                        detail={t('identityAdministration.githubFacetSignInSubtitle')}
                        showChevron={false}
                    />
                )}
                {provider.kind === 'oidc' ? (
                    <Item title={t('identityAdministration.test')} detail={signInConnectionStatusLabel(resolveTestedSignInConnectionStatus({ enabled: true, testable: true, lastSuccessfulTest: provider.lastSuccessfulTest }))} showChevron={false} />
                ) : null}
            </ItemGroup></SettingSection>
            {provider.teamConsumers.length > 0 ? (
                <SettingAnchor setting={HOME_IDENTITY_PROVIDER_SETTINGS.settings.teamConsumers}><ItemGroup
                    title={t('identityAdministration.teamConsumers')}
                    description={t('identityAdministration.teamConsumersSubtitle')}
                >
                    {provider.teamConsumers.map((consumer) => (
                        <Item
                            key={consumer.binding.id}
                            testID={`identity-provider-team-consumer:${consumer.binding.id}`}
                            title={consumer.team.name}
                            subtitle={t('identityAdministration.githubFacetSignIn')}
                            detail={signInConnectionStatusLabel(consumer.binding.enabled ? 'active' : 'disabled')}
                            showChevron={false}
                        />
                    ))}
                </ItemGroup></SettingAnchor>
            ) : null}
            {provider.kind === 'oidc' && testDiagnostics ? <IdentityTestDiagnosticsGroup diagnostics={testDiagnostics} /> : null}
            {error ? <ItemGroup><Item testID="identity-provider-failure" title={identityAdministrationFailureMessage(error)} showChevron={false} /></ItemGroup> : null}
            <SettingSection section={HOME_IDENTITY_PROVIDER_SETTINGS.sectionRefs.actions}><ItemGroup title={t('identityAdministration.actions')}>
                {provider.kind === 'oidc' ? (
                    <SettingAnchor setting={HOME_IDENTITY_PROVIDER_SETTINGS.settings.test}><Item testID="identity-provider-test" title={pending === 'test' ? t('identityAdministration.testing') : t('identityAdministration.test')} loading={pending === 'test'} disabled={busy} onPress={() => void test()} showChevron={false} /></SettingAnchor>
                ) : null}
                {provider.kind === 'oidc' ? (
                    <SettingAnchor setting={HOME_IDENTITY_PROVIDER_SETTINGS.settings.edit}><Item testID="identity-provider-edit" title={t('identityAdministration.edit')} disabled={busy} onPress={() => router.push(homeAdministrationIdentityProviderEditPath(props.context.scope.serverId, provider.id))} showChevron={false} /></SettingAnchor>
                ) : null}
                {provider.enabled ? (
                    <SettingAnchor setting={HOME_IDENTITY_PROVIDER_SETTINGS.settings.disable}><Item testID="identity-provider-disable" title={t('identityAdministration.disable')} disabled={busy} onPress={() => void (async () => {
                        if (!await Modal.confirm(t('identityAdministration.disableTitle', { name: provider.displayName }), t('identityAdministration.disableBody', { name: provider.displayName }), { cancelText: t('common.cancel'), confirmText: t('identityAdministration.disable') })) return;
                        await runLifecycle('identity.providers.disable');
                    })()} showChevron={false} /></SettingAnchor>
                ) : (
                    <SettingAnchor setting={HOME_IDENTITY_PROVIDER_SETTINGS.settings.enable}><Item testID="identity-provider-enable" title={t('identityAdministration.enable')} disabled={busy} onPress={() => void runLifecycle('identity.providers.enable')} showChevron={false} /></SettingAnchor>
                )}
                <SettingAnchor setting={HOME_IDENTITY_PROVIDER_SETTINGS.settings.remove}><Item testID="identity-provider-remove" title={t('identityAdministration.remove')} destructive disabled={busy} onPress={() => void remove()} showChevron={false} /></SettingAnchor>
            </ItemGroup></SettingSection>
        </>
    );
});

export const ManagedIdentityProviderDetailScreen = React.memo(function ManagedIdentityProviderDetailScreen(props: Readonly<{
    serverId: string;
    providerId: string;
}>) {
    return (
        <HomeAdministrationSection serverId={props.serverId} title={t('identityAdministration.title')} description={t('homeGovernance.pages.identityProvider')}>
            {(context) => context.projection.capabilities.manageAuthentication
                ? <DetailContent key={`${serverAccountScopeKeySuffix(context.scope)}:${props.providerId}`} context={context} providerId={props.providerId} />
                : <SettingSection section={HOME_IDENTITY_PROVIDER_SETTINGS.sectionRefs.configuration} answersFor={[HOME_IDENTITY_PROVIDER_SETTINGS.sectionRefs.consumers, HOME_IDENTITY_PROVIDER_SETTINGS.sectionRefs.actions]}><ItemGroup><Item title={t('homeGovernance.forbiddenTitle')} showChevron={false} /></ItemGroup></SettingSection>}
        </HomeAdministrationSection>
    );
});
