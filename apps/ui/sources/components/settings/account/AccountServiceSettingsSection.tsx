import * as React from 'react';
import { View } from 'react-native';
import { createServerFetchAtEndpoint } from '@/sync/http/client';
import { AccountServiceContinuation } from '@/components/account/auth/AccountServiceContinuation';
import { AccountServiceHomeAuthenticationAdapter } from '@/components/account/auth/AccountServiceHomeAuthenticationAdapter';
import { describeAccountServiceFailure } from '@/components/account/auth/accountServiceFailurePresentation';
import {
    launchAccountServiceOAuthAuthentication,
    projectAccountServiceMethodStrip,
    describeAccountServiceAuthenticationAction,
} from '@/components/account/auth/accountServiceAuthenticationActions';
import { useAccountServiceEntryOptions } from '@/components/account/auth/useAccountServiceEntryOptions';
import { resolveAccountServiceDisplayName } from '@/components/account/auth/accountServiceDisplayName';
import { AUTHENTICATED_ACCOUNT_ENTRY_ROUTE } from '@/components/navigation/accountEntry/authenticatedAccountEntryRoute';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { buildAuthenticatedAccountEntryHref } from '@/components/navigation/accountEntry/authenticatedAccountEntryRoute';
import { useAccountDirectoryActivePolling } from '@/sync/ops/accountDirectory/useAccountDirectoryActivePolling';

import { accountDirectoryCredentialStorage } from '@/auth/accountDirectory/accountDirectoryCredentialStorage';
import {
    createVerifiedAccountServiceAuthority,
    type AccountDirectoryAuthenticationAction,
    type VerifiedAccountServiceAuthority,
} from '@/auth/accountDirectory/accountDirectoryAuthClient';
import { getAuthProvider } from '@/auth/providers/registry';
import { completeAccountServicePostAuth, confirmAccountServiceHomeRelink, resumeAccountServicePostAuth, type AccountPostAuthFailureCode, type AccountPostAuthInput, type AccountPostAuthResult } from '@/sync/ops/accountDirectory/completeAccountServicePostAuth';
import { TokenStorage, digestAccountDirectoryCredentialToken } from '@/auth/storage/tokenStorage';
import { useServerAuthStatusByServerId } from '@/components/settings/server/hooks/useServerAuthStatusByServerId';
import { Avatar } from '@/components/ui/avatar/Avatar';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ExpandableItem } from '@/components/ui/lists/ExpandableItem';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { StatusPill } from '@/components/ui/status/StatusPill';
import { Icon } from '@/components/ui/icons/Icon';
import { formatRelativeTimeShort } from '@/components/ui/selectionList/formatRelativeTimeShort';
import { useUnistyles } from 'react-native-unistyles';
import { AccountServiceBenefits, AccountServiceInvitationIntro } from './AccountServiceInvitation';
import { AccountServiceChooser } from './AccountServiceChooser';
import { AccountServiceMark } from './AccountServiceMark';
import { AccountRecoveryKeyItem } from './AccountRecoveryKeyItem';
import { AccountServicePasswordForm, type AccountServicePasswordFormView } from '@/components/account/auth/AccountServicePasswordForm';
import { AccountServiceMethodStrip } from './AccountServiceMethodStrip';
import { ACCOUNT_SETTINGS } from './accountSettings';
import { SettingAnchor } from '@/components/settings/shell/SettingRow';
import { resolveHomeDisplayLabel, resolveHomeDisplayName } from '@/components/settings/server/homeDisplayName';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { ItemRowActions } from '@/components/ui/lists/ItemRowActions';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { Modal } from '@/modal';
import {
    type AccountDirectorySession,
    createAccountDirectoryServiceKey,
    createAccountDirectorySession,
} from '@/sync/domains/accountDirectory/accountDirectorySession';
import {
    areServerProfileIdentifiersEquivalent,
    getServerProfilesGeneration,
    listServerProfiles,
    resolveSelectedAccountServiceEndpoint,
    resolveServerProfileScopeId,
    setAccountServiceEndpoint,
    subscribeAccountServiceEndpoint,
    subscribeServerProfiles,
    type AccountServiceEndpointV1,
    type ServerProfile,
} from '@/sync/domains/server/serverProfiles';
import {
    cancelPendingDirectoryHomeEnrollment,
    getPendingDirectoryHomeEnrollment,
    resumePendingDirectoryHomeEnrollment,
    subscribePendingDirectoryHomeEnrollment,
} from '@/sync/ops/accountDirectory/enrollDirectoryHome';
import { canPublishAuthenticatedHomeLink, revokeAuthenticatedHomeLink } from '@/sync/ops/accountDirectory/provisionAuthenticatedHomeLink';
import { refreshAccountHomeDirectory } from '@/sync/ops/accountDirectory/refreshAccountHomeDirectory';
import { t } from '@/text';

/**
 * What this device knows about its sign-in to the selected service. Whether the service can be
 * signed in to at all (checking, unsupported, unreachable, no methods) comes from the one shared
 * discovery read (`useAccountServiceEntryOptions`); this only tracks the stored sign-in.
 */
type AccountServiceCredentialView =
    | Readonly<{ kind: 'loading'; serviceKey: string }>
    | Readonly<{ kind: 'connected'; serviceKey: string }>
    | Readonly<{ kind: 'disconnected'; serviceKey: string }>
    | Readonly<{ kind: 'custody_unavailable'; serviceKey: string }>
    | Readonly<{ kind: 'credential_expired'; serviceKey: string }>;

type AccountServiceConnectionKind =
    | AccountServiceCredentialView['kind']
    /** The selected service answers but cannot find Homes (for example a release that predates Home discovery). */
    | 'unsupported'
    /** The selected service could not be reached or verified. */
    | 'unreachable'
    /** The service can find Homes but advertises no way to sign in right now. */
    | 'methodless';

type DirectorySessionBinding = Readonly<{
    serviceKey: string;
    session: AccountDirectorySession;
    service: VerifiedAccountServiceAuthority;
}>;

type RowActionKind = 'set_preferred' | 'remove' | 'enroll' | 'link' | 'unlink';
/** A failed enrollment keeps its full typed code so the row reads with the one presenter's body. */
type EnrollmentFailureView = Readonly<{ failure: AccountPostAuthFailureCode }>;
type EnrollmentView = 'enrolled' | 'approval_required' | EnrollmentFailureView;
const HOME_ENROLLMENT_FAILED: EnrollmentFailureView = { failure: { source: 'home', code: 'failed' } };
type ServiceAttempt = {
    readonly id: number;
    readonly serviceInvalidationRevision: number;
    serviceKey: string;
};

function accountServiceKey(endpoint: AccountServiceEndpointV1): string {
    return createAccountDirectoryServiceKey({
        endpoint: endpoint.url,
        serverIdentityId: endpoint.serverIdentityId,
    });
}

function isExpiredCredentialError(error: unknown): boolean {
    if (!error || typeof error !== 'object' || !('status' in error)) return false;
    const status = error.status;
    return status === 401 || status === 403;
}


function formatHomeEndpointDetails(home: NonNullable<AccountDirectorySession['snapshot']>['homes'][number]): string {
    return home.connectionDescriptor.endpoints.map((connectionEndpoint) => (
        connectionEndpoint.kind === 'https'
            ? connectionEndpoint.url
            : `Iroh ${connectionEndpoint.endpointId}`
    )).join(' · ');
}

function projectEnrollmentFailure(result: AccountPostAuthResult | null): EnrollmentFailureView | null {
    return result?.kind === 'failure' ? { failure: result.code } : null;
}

/**
 * Production Account Service composition. The endpoint and credential namespace stay outside
 * Home profiles/runtime; refresh is the only path that adopts Directory Homes.
 *
 * One section shape for every state: signed out and every trouble state keep the invitation and
 * its benefits, and only the band under them changes (the ways to sign in, a truthful notice with
 * its next action, or placeholders while checking). Signed in, the invitation becomes who is
 * signed in. Changing the service opens in place.
 */
export function AccountServiceSettingsSection(): React.ReactElement {
    const router = useRouter();
    const { theme } = useUnistyles();
    const activeServer = useActiveServerSnapshot();
    const continuationAbortRef = React.useRef<AbortController | null>(null);
    React.useEffect(() => () => continuationAbortRef.current?.abort(), []);
    const [continuationResults, setContinuationResults] = React.useState<Readonly<Record<string, { input: AccountPostAuthInput; result: AccountPostAuthResult }>>>({});
    const [homeAuthentication, setHomeAuthentication] = React.useState<Readonly<{
        input: AccountPostAuthInput; previous: AccountPostAuthResult; homeServerIdentityId: string;
    }> | null>(null);
    const endpoint = React.useSyncExternalStore(
        (listener) => subscribeAccountServiceEndpoint(() => listener()),
        resolveSelectedAccountServiceEndpoint,
        resolveSelectedAccountServiceEndpoint,
    );
    // The one discovery read for the selected service: whether it can be signed in to, and how.
    const entry = useAccountServiceEntryOptions();
    const discovery = entry.status === 'ready' ? entry.discovery : null;
    const profileGeneration = React.useSyncExternalStore(
        (listener) => subscribeServerProfiles(() => listener()),
        getServerProfilesGeneration,
        getServerProfilesGeneration,
    );
    const profiles = React.useMemo(() => listServerProfiles(), [profileGeneration]);
    const authStatusByProfileId = useServerAuthStatusByServerId(profiles);
    const serviceKey = accountServiceKey(endpoint);
    const [busy, setBusy] = React.useState(false);
    const [pendingMethod, setPendingMethod] = React.useState<string | null>(null);
    const [credentialView, setCredentialView] = React.useState<AccountServiceCredentialView>({
        kind: 'loading',
        serviceKey,
    });
    const [credentialReadGeneration, setCredentialReadGeneration] = React.useState(0);
    const [directorySessionBinding, setDirectorySessionBinding] = React.useState<DirectorySessionBinding | null>(null);
    const [pendingRowActions, setPendingRowActions] = React.useState<Readonly<Record<string, RowActionKind>>>({});
    const [enrollmentFailures, setEnrollmentFailures] = React.useState<Readonly<Partial<Record<string, EnrollmentFailureView>>>>({});
    const [advancedExpanded, setAdvancedExpanded] = React.useState(false);
    const [changingService, setChangingService] = React.useState(false);
    // A new E2EE account on this service whose recovery key was not confirmed saved (its own reminder,
    // scoped to the service identity, never to a Home on the same server).
    const [recoveryKeyReminder, setRecoveryKeyReminder] = React.useState<string | null>(null);
    // The service account's recovery-key row, opened from the account menu or the reminder (per service).
    const [recoveryKeyOpen, setRecoveryKeyOpen] = React.useState<string | null>(null);
    // Email and password open in place of the method strip, for this service only.
    const [passwordForm, setPasswordForm] = React.useState<Readonly<{
        serviceKey: string;
        view: AccountServicePasswordFormView;
    }> | null>(null);
    const pendingEnrollment = React.useSyncExternalStore(
        subscribePendingDirectoryHomeEnrollment,
        getPendingDirectoryHomeEnrollment,
        getPendingDirectoryHomeEnrollment,
    );
    const activeAttemptRef = React.useRef<ServiceAttempt | null>(null);
    const attemptSequenceRef = React.useRef(0);
    const serviceInvalidationRevisionRef = React.useRef(0);
    const previousServiceKeyRef = React.useRef<string | null>(null);
    const automaticallyHydratedServiceKeyRef = React.useRef<string | null>(null);
    const serviceKeyRef = React.useRef(serviceKey);
    serviceKeyRef.current = serviceKey;

    const visibleCredential: AccountServiceCredentialView = credentialView.serviceKey === serviceKey
        ? credentialView
        : { kind: 'loading', serviceKey };
    // Discovery decides whether the service is usable; the stored sign-in decides the rest.
    // A stored sign-in shows as soon as it is read; discovery decides the rest. A signed-in
    // device keeps its identity while the service is slow or unreachable (the Homes below say
    // they could not be refreshed), and only a signed-out one sees the service's trouble.
    const signedInView = visibleCredential.kind === 'connected'
        || visibleCredential.kind === 'credential_expired'
        || visibleCredential.kind === 'custody_unavailable';
    const connectionKind: AccountServiceConnectionKind = entry.status === 'unsupported'
        ? 'unsupported'
        : signedInView
            ? visibleCredential.kind
            : entry.status === 'loading'
                ? 'loading'
                : entry.status !== 'ready' || !discovery
                    ? 'unreachable'
                    : visibleCredential.kind === 'disconnected' && discovery.authenticationActions.length === 0
                        ? 'methodless'
                        : visibleCredential.kind;
    const directorySession = directorySessionBinding?.serviceKey === serviceKey
        ? directorySessionBinding.session
        : null;
    const verifiedAccountServiceName = directorySessionBinding?.serviceKey === serviceKey
        ? directorySessionBinding.service.snapshot.features.accountServicePresentation?.displayName?.trim() || undefined
        : undefined;
    const verifiedAccountServiceIdentity = directorySessionBinding?.serviceKey === serviceKey
        ? directorySessionBinding.service.serverIdentityId
        : null;
    const subscribeDirectorySession = React.useCallback((listener: () => void) => (
        directorySession?.subscribe(() => listener()) ?? (() => {})
    ), [directorySession]);
    const getDirectorySnapshot = React.useCallback(() => directorySession?.snapshot ?? null, [directorySession]);
    const directorySnapshot = React.useSyncExternalStore(
        subscribeDirectorySession,
        getDirectorySnapshot,
        getDirectorySnapshot,
    );
    const connected = connectionKind === 'connected';
    const directoryRefreshing = directorySnapshot?.status === 'loading';

    const beginAttempt = React.useCallback((targetServiceKey: string): Readonly<{
        attempt: ServiceAttempt;
        shouldCancel: () => boolean;
        shouldInvalidateContinuation: () => boolean;
    }> => {
        const attempt: ServiceAttempt = {
            id: ++attemptSequenceRef.current,
            serviceInvalidationRevision: serviceInvalidationRevisionRef.current,
            serviceKey: targetServiceKey,
        };
        activeAttemptRef.current = attempt;
        return {
            attempt,
            shouldCancel: () => activeAttemptRef.current !== attempt || serviceKeyRef.current !== attempt.serviceKey,
            shouldInvalidateContinuation: () => (
                serviceInvalidationRevisionRef.current !== attempt.serviceInvalidationRevision
                || serviceKeyRef.current !== attempt.serviceKey
            ),
        };
    }, []);

    const invalidateAttempts = React.useCallback(() => {
        continuationAbortRef.current?.abort();
        activeAttemptRef.current = null;
        attemptSequenceRef.current += 1;
        serviceInvalidationRevisionRef.current += 1;
        return cancelPendingDirectoryHomeEnrollment();
    }, []);

    React.useEffect(() => {
        const previousServiceKey = previousServiceKeyRef.current;
        previousServiceKeyRef.current = serviceKey;
        if (previousServiceKey !== null && previousServiceKey !== serviceKey) {
            void invalidateAttempts();
            setChangingService(false);
        }
        setDirectorySessionBinding((current) => current?.serviceKey === serviceKey ? current : null);
        setPasswordForm((current) => current?.serviceKey === serviceKey ? current : null);
        setRecoveryKeyOpen((current) => current === serviceKey ? current : null);
        setPendingRowActions({});
        setEnrollmentFailures({});
    }, [invalidateAttempts, serviceKey]);

    // Reads the stored sign-in for the service's identity: the one this device already recorded,
    // or, for a service chosen before its identity was known, the one discovery observes (which
    // is then recorded).
    const recordedIdentity = endpoint.serverIdentityId?.trim() || null;
    const serviceIdentity = recordedIdentity ?? discovery?.serverIdentityId ?? null;
    React.useEffect(() => {
        if (!serviceIdentity) return;
        let cancelled = false;
        const requestedServiceKey = serviceKey;
        setCredentialView((current) => (
            current.kind === 'credential_expired' && current.serviceKey === requestedServiceKey
                ? current
                : { kind: 'loading', serviceKey: requestedServiceKey }
        ));
        void (async () => {
            try {
                const credentials = await accountDirectoryCredentialStorage.get({
                    endpoint: endpoint.url,
                    serverIdentityId: serviceIdentity,
                });
                if (cancelled) return;
                if (!recordedIdentity) {
                    await setAccountServiceEndpoint({ ...endpoint, serverIdentityId: serviceIdentity });
                    return;
                }
                setCredentialView((current) => (
                    current.kind === 'credential_expired' && current.serviceKey === requestedServiceKey
                        ? current
                        : { kind: credentials ? 'connected' : 'disconnected', serviceKey: requestedServiceKey }
                ));
            } catch {
                if (!cancelled) setCredentialView({ kind: 'custody_unavailable', serviceKey: requestedServiceKey });
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [credentialReadGeneration, endpoint, recordedIdentity, serviceIdentity, serviceKey]);

    React.useEffect(() => {
        if (!connected || !serviceIdentity) {
            setRecoveryKeyReminder(null);
            return;
        }
        let cancelled = false;
        void TokenStorage.getRecoveryKeyReminderPending({ kind: 'account_service', serverIdentityId: serviceIdentity })
            .then((pending) => { if (!cancelled) setRecoveryKeyReminder(pending ? serviceKey : null); });
        return () => { cancelled = true; };
    }, [connected, serviceIdentity, serviceKey]);

    React.useEffect(() => {
        if (pendingEnrollment && pendingEnrollment.serviceKey !== serviceKey) {
            void invalidateAttempts();
        }
    }, [invalidateAttempts, pendingEnrollment, serviceKey]);

    const refreshDirectory = React.useCallback(async () => {
        if (!connected || !discovery || directoryRefreshing) return;
        const { shouldCancel } = beginAttempt(serviceKey);
        const session = directorySessionBinding?.serviceKey === serviceKey
            ? directorySessionBinding.session
            : createAccountDirectorySession({
                endpoint: endpoint.url,
                serverIdentityId: discovery.serverIdentityId,
            }, { capability: discovery.capability });
        if (session !== directorySessionBinding?.session) {
            setDirectorySessionBinding({ serviceKey, session, service: createVerifiedAccountServiceAuthority(discovery) });
        }
        // Who is signed in is read beside the Homes; it never holds up or fails their refresh.
        void session.refreshAccount();
        try {
            const refreshed = await refreshAccountHomeDirectory(session, { shouldCancel });
            if (!shouldCancel() && isExpiredCredentialError(refreshed.error)) {
                setCredentialView({ kind: 'credential_expired', serviceKey });
            }
        } catch {
            if (!shouldCancel()) await Modal.alertAsync(t('common.error'), t('errors.operationFailed'));
        } finally {
            setPendingRowActions((current) => {
                const next = { ...current };
                for (const [homeServerIdentityId, action] of Object.entries(next)) {
                    if (action === 'enroll') delete next[homeServerIdentityId];
                }
                return next;
            });
        }
    }, [beginAttempt, connected, directoryRefreshing, directorySessionBinding, discovery, endpoint.url, serviceKey]);

    React.useEffect(() => {
        // The Homes are read once per service, as soon as the service is known to be usable.
        if (!connected || !discovery || directoryRefreshing) return;
        if (automaticallyHydratedServiceKeyRef.current === serviceKey) return;
        automaticallyHydratedServiceKeyRef.current = serviceKey;
        void refreshDirectory();
    }, [connected, directoryRefreshing, discovery, refreshDirectory, serviceKey]);

    const startAccountJourney = React.useCallback(async (source?: string | AccountPostAuthInput) => {
        if (busy) return;
        setBusy(true);
        try {
            if (typeof source === 'object') {
                router.push(buildAuthenticatedAccountEntryHref({
                    service: source.service,
                    intent: source.intent,
                    returnTo: '/settings/account',
                }));
                return;
            }
            if (!discovery) throw new Error('Account Service unavailable');
            router.push(buildAuthenticatedAccountEntryHref({
                service: { endpointUrl: discovery.endpointUrl, serverIdentityId: discovery.serverIdentityId },
                intent: source
                    ? { kind: 'link', homeServerIdentityId: source }
                    : { kind: 'refresh' },
                returnTo: '/settings/account',
            }));
        } catch {
            await Modal.alertAsync(t('common.error'), t('errors.operationFailed'));
        } finally {
            setBusy(false);
        }
    }, [busy, discovery, router]);

    // The service's name, never its address: in sentences a generic phrase stands in, and the
    // section title falls back to what the section is.
    const namedService = resolveAccountServiceDisplayName({
        url: endpoint.url,
        serverIdentityId: endpoint.serverIdentityId ?? discovery?.serverIdentityId,
        savedName: endpoint.displayName,
        advertisedName: discovery?.accountServiceDisplayName,
        profiles,
        activeServerId: activeServer.serverId,
    });
    const serviceName = namedService ?? t('welcome.yourSignInService');
    const sectionTitle = namedService ?? t('settingsAccount.accountServiceChooserTitle');

    /**
     * One way in: OAuth leaves for the provider directly; email and password open inline, in place
     * of the strip; a key continues on the account-entry route.
     */
    const startSignIn = React.useCallback(async (method: AccountDirectoryAuthenticationAction) => {
        if (!discovery || pendingMethod) return;
        const { execution } = method;
        if (execution.kind === 'email_password') {
            setPasswordForm({ serviceKey, view: execution.action === 'provision' ? 'create' : 'sign_in' });
            return;
        }
        if (execution.kind !== 'oauth') {
            await startAccountJourney();
            return;
        }
        const slug = describeAccountServiceAuthenticationAction(method, serviceName).slug;
        setPendingMethod(slug);
        try {
            const outcome = await launchAccountServiceOAuthAuthentication({
                authority: createVerifiedAccountServiceAuthority(discovery),
                execution,
                intent: { kind: 'refresh' },
                returnTo: AUTHENTICATED_ACCOUNT_ENTRY_ROUTE,
                accountEntryReturnTo: '/settings/account',
                transport: entry.transport,
                isCurrent: () => serviceKeyRef.current === serviceKey,
            });
            if (outcome === 'failed') {
                await Modal.alertAsync(t('welcome.signInServiceUnavailableTitle'), t('errors.operationFailed'));
            }
        } finally {
            setPendingMethod(null);
        }
    }, [discovery, entry.transport, pendingMethod, serviceKey, serviceName, startAccountJourney]);

    const disconnect = React.useCallback(async () => {
        if (busy) return;
        setBusy(true);
        const cancellation = invalidateAttempts();
        try {
            await cancellation;
            const removed = directorySession
                ? await directorySession.logout()
                : endpoint.serverIdentityId?.trim()
                    ? await accountDirectoryCredentialStorage.logout({
                        endpoint: endpoint.url,
                        serverIdentityId: endpoint.serverIdentityId,
                    })
                    : false;
            if (!removed) {
                await Modal.alertAsync(t('common.error'), t('errors.operationFailed'));
                return;
            }
            setCredentialView({ kind: 'disconnected', serviceKey });
            setDirectorySessionBinding(null);
            setPendingRowActions({});
            setEnrollmentFailures({});
        } finally {
            setBusy(false);
        }
    }, [busy, directorySession, endpoint.serverIdentityId, endpoint.url, invalidateAttempts, serviceKey]);

    const setPreferredHome = React.useCallback(async (homeServerIdentityId: string) => {
        if (!directorySession || pendingRowActions[homeServerIdentityId]) return;
        const { shouldCancel, shouldInvalidateContinuation } = beginAttempt(serviceKey);
        setPendingRowActions((current) => ({ ...current, [homeServerIdentityId]: 'set_preferred' }));
        try {
            await directorySession.setPreferredHome(homeServerIdentityId);
            if (shouldCancel()) return;
            const snapshot = await directorySession.refresh();
            if (shouldCancel()) return;
        } catch {
            if (!shouldCancel()) await Modal.alertAsync(t('common.error'), t('errors.operationFailed'));
        } finally {
            setPendingRowActions((current) => {
                const next = { ...current };
                delete next[homeServerIdentityId];
                return next;
            });
        }
    }, [beginAttempt, directorySession, pendingRowActions, serviceKey]);

    const removeHome = React.useCallback(async (homeServerIdentityId: string, label: string) => {
        if (!directorySession || pendingRowActions[homeServerIdentityId]) return;
        const confirmed = await Modal.confirm(
            t('settingsAccount.accountServiceRemoveHomeConfirmTitle', { label, accountService: verifiedAccountServiceName }),
            t('settingsAccount.accountServiceRemoveHomeConfirmBody', { label, accountService: verifiedAccountServiceName }),
            {
                confirmText: t('common.remove'),
                cancelText: t('common.cancel'),
                destructive: true,
            },
        );
        if (!confirmed) return;
        const { shouldCancel } = beginAttempt(serviceKey);
        setPendingRowActions((current) => ({ ...current, [homeServerIdentityId]: 'remove' }));
        try {
            await directorySession.deleteHome(homeServerIdentityId);
            if (shouldCancel()) return;
            await directorySession.refresh();
            if (shouldCancel()) return;
        } catch {
            if (!shouldCancel()) await Modal.alertAsync(t('common.error'), t('errors.operationFailed'));
        } finally {
            setPendingRowActions((current) => {
                const next = { ...current };
                delete next[homeServerIdentityId];
                return next;
            });
        }
    }, [beginAttempt, directorySession, pendingRowActions, serviceKey, verifiedAccountServiceName]);

    const unlinkHome = React.useCallback(async (homeServerIdentityId: string, label: string) => {
        if (!verifiedAccountServiceIdentity || pendingRowActions[homeServerIdentityId]) return;
        const confirmed = await Modal.confirm(
            t('settingsAccount.accountServiceUnlinkHomeConfirmTitle', { label, accountService: verifiedAccountServiceName }),
            t('settingsAccount.accountServiceUnlinkHomeConfirmBody', { label, accountService: verifiedAccountServiceName }),
            {
                confirmText: t('settingsAccount.accountServiceUnlinkHomeConfirmAction'),
                cancelText: t('common.cancel'),
                destructive: true,
            },
        );
        if (!confirmed) return;
        const shouldCancel = () => serviceKeyRef.current !== serviceKey;
        setPendingRowActions((current) => ({ ...current, [homeServerIdentityId]: 'unlink' }));
        try {
            const result = await revokeAuthenticatedHomeLink({
                homeServerIdentityId,
                issuerServerIdentityId: verifiedAccountServiceIdentity,
                shouldCancel,
            });
            if (result.kind !== 'unlinked' && !shouldCancel()) {
                await Modal.alertAsync(t('common.error'), t('errors.operationFailed'));
            }
        } finally {
            setPendingRowActions((current) => {
                const next = { ...current };
                delete next[homeServerIdentityId];
                return next;
            });
        }
    }, [pendingRowActions, serviceKey, verifiedAccountServiceIdentity, verifiedAccountServiceName]);

    const continueHome = React.useCallback(async (homeServerIdentityId: string, kind: 'link' | 'enroll') => {
        if (!directorySessionBinding || pendingRowActions[homeServerIdentityId]) return;
        if (pendingEnrollment?.serviceKey === serviceKey && pendingEnrollment.homeServerIdentityId === homeServerIdentityId) {
            const result = await resumePendingDirectoryHomeEnrollment();
            if (result) setContinuationResults((current) => ({ ...current, [homeServerIdentityId]: { input: pendingEnrollment.input, result } }));
            return;
        }
        // The continuation is bound to the exact Account credential it was started
        // under, so a credential replaced mid-flow cannot adopt it. Without a stored
        // credential there is nothing to continue: the section says so instead.
        const storedCredentials = await TokenStorage.accountDirectoryAuthCredentials
            .get({ endpoint: directorySessionBinding.service.endpointUrl,
                serverIdentityId: directorySessionBinding.service.serverIdentityId })
            .catch(() => null);
        if (!storedCredentials) {
            setCredentialView({ kind: 'credential_expired', serviceKey });
            return;
        }
        const credentialTokenDigest = await digestAccountDirectoryCredentialToken(storedCredentials.token);
        continuationAbortRef.current?.abort();
        const controller = new AbortController();
        continuationAbortRef.current = controller;
        const input = { service: directorySessionBinding.service, session: directorySessionBinding.session,
            credentialTokenDigest, intent: { kind, homeServerIdentityId }, signal: controller.signal } as const;
        setPendingRowActions((current) => ({ ...current, [homeServerIdentityId]: kind }));
        try {
            const previous = continuationResults[homeServerIdentityId]?.result;
            let result = pendingEnrollment?.homeServerIdentityId === homeServerIdentityId
                ? await resumePendingDirectoryHomeEnrollment()
                : previous?.kind === 'failure' && previous.recovery === 'retry_stage'
                    ? await resumeAccountServicePostAuth(input, previous)
                    : await completeAccountServicePostAuth(input);
            if (result?.kind === 'failure' && result.recovery === 'relink_home') {
                const confirmed = await Modal.confirm(t('settingsAccount.accountServiceRelinkConfirmTitle', { accountService: verifiedAccountServiceName }),
                    t('settingsAccount.accountServiceRelinkConfirmBody', { accountService: verifiedAccountServiceName }),
                    { confirmText: t('common.continue'), cancelText: t('common.cancel') });
                if (confirmed && !controller.signal.aborted) result = await confirmAccountServiceHomeRelink(input);
            }
            if (!result || controller.signal.aborted) return;
            setContinuationResults((current) => ({ ...current, [homeServerIdentityId]: { input, result } }));
            if (result.kind === 'failure' && result.recovery === 'reauthenticate_account') {
                setCredentialView({ kind: 'credential_expired', serviceKey });
            }
            setEnrollmentFailures((current) => {
                const next = { ...current };
                const failure = projectEnrollmentFailure(result);
                if (failure) next[homeServerIdentityId] = failure;
                else delete next[homeServerIdentityId];
                return next;
            });
        } finally {
            setPendingRowActions((current) => {
                const next = { ...current };
                delete next[homeServerIdentityId];
                return next;
            });
        }
    }, [continuationResults, directorySessionBinding, pendingEnrollment, pendingRowActions, serviceKey, verifiedAccountServiceName]);

    const enrollHome = React.useCallback((homeServerIdentityId: string) => continueHome(homeServerIdentityId, 'enroll'), [continueHome]);
    const linkHome = React.useCallback(async (profile: ServerProfile) => {
        const identity = profile.serverIdentityId;
        if (!identity) return;
        if (!connected) await startAccountJourney(identity);
        else await continueHome(identity, 'link');
    }, [connected, continueHome, startAccountJourney]);

    useAccountDirectoryActivePolling(async () => {
        if (!pendingEnrollment || pendingEnrollment.serviceKey !== serviceKey) return 'completed';
        const result = await resumePendingDirectoryHomeEnrollment();
        if (result && result.kind !== 'approval_required') {
            setContinuationResults((current) => ({ ...current, [pendingEnrollment.homeServerIdentityId]: { input: pendingEnrollment.input, result } }));
        }
        return result?.kind === 'failure' && result.recovery === 'retry_stage' ? 'backoff' : 'completed';
    }, pendingEnrollment?.serviceKey === serviceKey);

    const linkableProfiles = profiles.filter((profile) => {
        const identity = profile.serverIdentityId?.trim() ?? '';
        return Boolean(identity) && authStatusByProfileId[resolveServerProfileScopeId(profile)] === 'signedIn';
    });
    const linkableProfileByIdentity = new Map(linkableProfiles.map((profile) => [
        profile.serverIdentityId!.trim(),
        profile,
    ]));
    const directoryHomeIdentityIds = new Set(
        directorySnapshot?.homes.map((home) => home.homeServerIdentityId) ?? [],
    );
    const localHomesMissingFromDirectory = linkableProfiles.filter((profile) => (
        !directoryHomeIdentityIds.has(profile.serverIdentityId!.trim())
    ));

    // Linking a local Home goes through this service; it is offered only where it can succeed.
    const serviceUsable = connected || connectionKind === 'disconnected' || connectionKind === 'credential_expired';
    const homeDirectoryCapability = discovery ? discovery.capability.homeDirectory : null;
    const homeEnrollmentCapability = discovery ? discovery.capability.homeEnrollment : null;
    const diagnosticDetail = entry.status === 'loading' || directorySnapshot?.status === 'loading'
        ? t('settingsAccount.accountServiceDiagnosticChecking')
        : entry.status === 'unsupported' || directorySnapshot?.status === 'unsupported'
            ? t('settingsAccount.accountServiceDiagnosticUnsupported')
            : entry.status !== 'ready' || directorySnapshot?.status === 'error' || directorySnapshot?.status === 'stale'
                ? t('settingsAccount.accountServiceDiagnosticUnavailable')
                : t('settingsAccount.accountServiceDiagnosticReady');
    // The expired sign-in is said once, on the service's own row; the Homes below keep their last
    // known state without repeating it.
    // When every Home here says it cannot be linked, an empty state inviting a link would
    // contradict those rows; they are the whole message. It stays while a Home can be linked.
    const onlyUnlinkableLocalHomes = serviceUsable
        && localHomesMissingFromDirectory.length > 0
        && localHomesMissingFromDirectory.every((profile) => !canPublishAuthenticatedHomeLink(profile.serverIdentityId!.trim()));
    // Signed in while the service itself cannot be reached: the Homes cannot be read yet.
    const directoryUnreachable = connected && !discovery && entry.status !== 'loading';
    const directoryNotice = (directorySnapshot?.status === 'loading' && directorySnapshot.homes.length === 0)
        || (connected && !directorySnapshot && entry.status === 'loading')
        ? (
            <Item
                testID="settings-account-service-directory-loading"
                mode="info"
                title={t('settingsAccount.accountServiceDiscoveringHomes')}
                loading
                showChevron={false}
            />
        )
        : directorySnapshot?.status === 'unsupported'
            ? (
                <Item
                    testID="settings-account-service-directory-unsupported"
                    mode="info"
                    title={t('settingsAccount.accountServiceDiscoveryUnsupported')}
                    subtitle={t('settingsAccount.accountServiceDiscoveryUnsupportedDescription')}
                    subtitleLines={0}
                        showChevron={false}
                />
            )
            : directoryUnreachable || directorySnapshot?.status === 'error' || directorySnapshot?.status === 'stale'
                ? (
                    <Item
                        testID="settings-account-service-directory-unavailable"
                        mode="info"
                        icon={<Icon name="info" size={20} color={theme.colors.state.warning.foreground} />}
                        title={t('settingsAccount.accountServiceDiscoveryUnavailable')}
                        subtitle={t('settingsAccount.accountServiceDiscoveryUnavailableDescription')}
                        subtitleLines={0}
                        showChevron={false}
                        accessoryLayout="adaptive"
                        rightElementOutsidePressable
                        rightElement={connected ? (
                            <RoundButton
                                testID="settings-account-service-directory-retry"
                                size="small"
                                display="secondary"
                                title={t('common.retry')}
                                onPress={discovery ? () => { void refreshDirectory(); } : entry.retry}
                            />
                        ) : undefined}
                    />
                )
                : directorySnapshot?.status === 'ready' && directorySnapshot.homes.length === 0 && !onlyUnlinkableLocalHomes
                    ? (
                        <Item
                            testID="settings-account-service-directory-empty"
                            mode="info"
                            icon={<Icon name="house" size={20} color={theme.colors.text.secondary} />}
                            title={t('settingsAccount.accountServiceHomesEmpty')}
                            subtitle={t('settingsAccount.accountServiceHomesEmptyDescription', { accountService: verifiedAccountServiceName })}
                            subtitleLines={0}
                        showChevron={false}
                        />
                    )
                    : null;

    // A Home is named by its name; an unnamed Home is "This Home" when it is the one in focus, and
    // otherwise by its address, the only thing that tells two unnamed Homes apart.
    const localHomeTitle = (profile: ServerProfile) => resolveHomeDisplayName(profile)
        ?? (areServerProfileIdentifiersEquivalent(resolveServerProfileScopeId(profile), activeServer.serverId)
            ? t('settingsAccount.thisHomeTitle')
            : resolveHomeDisplayLabel(profile, profile.id));
    const serviceMark = <AccountServiceMark url={endpoint.url} size={22} />;
    const toggleChangingService = () => setChangingService((current) => !current);
    // A notice that carries "Change service" itself hides the header's, so there is one way in.
    const noticeCarriesChange = connectionKind === 'unsupported' || connectionKind === 'unreachable' || connectionKind === 'methodless';
    const signInMethods = discovery?.authenticationActions ?? null;
    const primaryMethod = signInMethods ? projectAccountServiceMethodStrip(signInMethods).primary : null;
    const primaryMethodPresentation = primaryMethod ? describeAccountServiceAuthenticationAction(primaryMethod, serviceName) : null;
    const changeServiceButton = (testID: string, display: 'secondary' | 'inverted') => (
        <RoundButton
            testID={testID}
            size="small"
            display={display}
            title={t('settingsAccount.accountServiceChangeService')}
            leading={display === 'inverted' ? <Icon name="arrows-left-right" size={14} color={theme.colors.text.secondary} /> : undefined}
            textStyle={display === 'inverted' ? { color: theme.colors.text.secondary } : undefined}
            trailing={changingService ? <Icon name="caret-up" size={14} color={theme.colors.text.secondary} /> : undefined}
            expanded={changingService}
            onPress={toggleChangingService}
            disabled={busy}
        />
    );
    const noticeRow = (testID: string, title: string, body: string, actions: React.ReactNode) => (
        <Item
            testID={testID}
            mode="info"
            icon={<Icon name="info" size={20} color={theme.colors.state.warning.foreground} />}
            title={title}
            titleLines={0}
            subtitle={body}
            subtitleLines={0}
            accessibilityLiveRegion="polite"
            showChevron={false}
            accessoryLayout="adaptive"
            rightElementOutsidePressable
            rightElement={<View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>{actions}</View>}
        />
    );
    const retryButton = (
        <RoundButton
            testID="settings-account-service-retry"
            size="small"
            display="secondary"
            title={t('common.retry')}
            leading={<Icon name="arrows-clockwise" size={14} color={theme.colors.text.primary} />}
            onPress={entry.retry}
        />
    );
    // The service's email sign-in carries whether it can mail a reset link.
    const emailLogin = signInMethods?.find(({ execution }) => (
        execution.kind === 'email_password' && execution.action === 'login'
    ))?.execution;
    const passwordFormElement = passwordForm?.serviceKey === serviceKey && discovery
        && (connectionKind === 'disconnected' || connectionKind === 'credential_expired') ? (
            <SectionContentRow testID="settings-account-service-password">
                <AccountServicePasswordForm
                    service={createVerifiedAccountServiceAuthority(discovery)}
                    serviceName={serviceName}
                    transport={entry.transport}
                    login={emailLogin?.kind === 'email_password' ? emailLogin : null}
                    initialView={passwordForm.view}
                    onCancel={() => setPasswordForm(null)}
                    onSignedIn={(outcome) => {
                        if (serviceKeyRef.current !== serviceKey) return;
                        // Custody was committed by the sign-in owner; the section adopts its session
                        // (with an E2EE Account's unlocked key) and reads the Homes with it.
                        setDirectorySessionBinding({ serviceKey, session: outcome.session, service: outcome.service });
                        automaticallyHydratedServiceKeyRef.current = null;
                        setCredentialView({ kind: 'connected', serviceKey });
                        setPasswordForm(null);
                    }}
                />
            </SectionContentRow>
        ) : null;
    // The band under the invitation: how to sign in, or what is wrong and what to do next.
    const invitationFooter = connectionKind === 'unsupported'
        ? noticeRow('settings-account-service-notice',
            t('settingsAccount.accountServiceUnsupportedTitle', { accountService: serviceName }),
            t('settingsAccount.accountServiceUnsupportedBody'),
            changeServiceButton('settings-account-service-notice-change', 'secondary'))
        : connectionKind === 'unreachable'
            ? noticeRow('settings-account-service-notice',
                t('settingsAccount.accountServiceUnreachableTitle', { accountService: serviceName }),
                t('settingsAccount.accountServiceUnreachableBody'),
                <>{retryButton}{changeServiceButton('settings-account-service-notice-change', 'inverted')}</>)
            : connectionKind === 'methodless'
                ? noticeRow('settings-account-service-notice',
                    t('welcome.signInServiceMethodlessTitle'),
                    t('welcome.signInServiceMethodlessBody'),
                    <>{retryButton}{changeServiceButton('settings-account-service-notice-change', 'inverted')}</>)
                : passwordFormElement ?? (
                    <SectionContentRow testID="settings-account-service-methods">
                        <AccountServiceMethodStrip
                            actions={connectionKind === 'disconnected' ? signInMethods : null}
                            serviceName={serviceName}
                            pendingSlug={pendingMethod ?? (busy ? '' : null)}
                            onSelect={(method) => { void startSignIn(method); }}
                        />
                    </SectionContentRow>
                );
    const refreshedAt = directorySnapshot?.refreshedAtMs
        ? t('settingsAccount.accountServiceRefreshedAt', { time: formatRelativeTimeShort(directorySnapshot.refreshedAtMs, Date.now()) })
        : null;
    const account = directorySnapshot?.account ?? null;
    const linkedMethod = account?.linkedAuthenticationMethods[0] ?? null;
    const signedInWith = linkedMethod ? t('settingsAccount.accountServiceSignedInWith', {
        provider: getAuthProvider(linkedMethod.providerId)?.displayName ?? linkedMethod.providerId,
    }) : null;
    // Named by the account's name; without one, by how it signed in ("Signed in with GitHub"),
    // never by the service's address. The row's mark is the account's picture, else the service's.
    const identityTitle = account?.displayName ?? signedInWith ?? t('settingsAccount.accountServiceSignedIn');
    const identitySummary = [
        account?.displayName ? signedInWith : null,
        linkedMethod?.login ? `@${linkedMethod.login}` : null,
        refreshedAt,
    ].filter(Boolean).join(' · ');
    const identityPicture = account?.avatar ?? null;

    const primaryRows = connected ? (
        <Item
            testID="settings-account-service-identity"
            icon={account && identityPicture
                ? <Avatar id={account.accountId} size={36} imageUrl={identityPicture} />
                : serviceMark}
            iconBoxSize={identityPicture ? 36 : undefined}
            title={identityTitle}
            titleLines={2}
            subtitle={identitySummary || undefined}
            subtitleLines={0}
            accessibilityLabel={identitySummary ? `${identityTitle}, ${identitySummary}` : identityTitle}
            mode="info"
            showChevron={false}
            rightElementOutsidePressable
            rightElement={(
                <ItemRowActions
                    title={sectionTitle}
                    compactThreshold={Number.MAX_SAFE_INTEGER}
                    compactActionIds={['settings-account-service-refresh']}
                    overflowTriggerTestID="settings-account-service-account-menu"
                    actions={[{
                        id: 'settings-account-service-refresh',
                        inlineTestID: 'settings-account-service-refresh',
                        title: t('common.refresh'),
                        icon: directoryRefreshing ? <ActivitySpinner size="small" /> : 'arrows-clockwise' as const,
                        disabled: directoryRefreshing,
                        onPress: () => { void refreshDirectory(); },
                    }, {
                        id: 'settings-account-service-change',
                        inlineTestID: 'settings-account-service-change',
                        title: t('settingsAccount.accountServiceChangeService'),
                        icon: 'arrows-left-right' as const,
                        disabled: busy,
                        onPress: toggleChangingService,
                    }, ...(account?.recoveryKey === 'password_unlock' || account?.recoveryKey === 'key_only' ? [{
                        id: 'settings-account-service-view-recovery-key',
                        inlineTestID: 'settings-account-service-view-recovery-key',
                        title: t('settingsAccount.showRecoveryKey'),
                        icon: 'key' as const,
                        onPress: () => setRecoveryKeyOpen(serviceKey),
                    }] : []), {
                        id: 'settings-account-service-disconnect',
                        inlineTestID: 'settings-account-service-disconnect',
                        title: t('settingsAccount.accountServiceSignOut', { accountService: serviceName }),
                        icon: 'sign-out' as const,
                        disabled: busy,
                        destructive: true,
                        onPress: () => { void disconnect(); },
                    }]}
                />
            )}
        />
    ) : connectionKind === 'credential_expired' ? (
        <Item
            testID="settings-account-service-expired"
            icon={serviceMark}
            title={t('settingsAccount.accountServiceReconnectRequired', { accountService: serviceName })}
            subtitle={t('settingsAccount.accountServiceReconnectDescription')}
            subtitleLines={0}
            mode="info"
            showChevron={false}
            accessoryLayout="adaptive"
            rightElementOutsidePressable
            rightElement={primaryMethod && primaryMethodPresentation ? (
                <RoundButton
                    testID="settings-account-service-login"
                    size="small"
                    display="secondary"
                    title={primaryMethodPresentation.title}
                    leading={<Icon name={primaryMethodPresentation.iconName} size={14} color={theme.colors.text.primary} />}
                    loading={pendingMethod !== null || busy}
                    disabled={pendingMethod !== null || busy}
                    onPress={() => { void startSignIn(primaryMethod); }}
                />
            ) : undefined}
        />
    ) : connectionKind === 'custody_unavailable' ? (
        <Item
            testID="settings-account-service-custody"
            icon={serviceMark}
            title={t('settingsAccount.accountServiceCustodyTitle', { accountService: serviceName })}
            subtitle={t('settingsAccount.accountServiceCustodyBody')}
            subtitleLines={0}
            mode="info"
            showChevron={false}
            accessoryLayout="adaptive"
            rightElementOutsidePressable
            rightElement={(
                <RoundButton
                    testID="settings-account-service-custody-retry"
                    size="small"
                    display="secondary"
                    title={t('common.retry')}
                    onPress={() => setCredentialReadGeneration((current) => current + 1)}
                />
            )}
        />
    ) : null;

    // A link, enrollment or sign-in that stopped part-way keeps its result on the row of the Home
    // it was for, with the step that recovers it; directory rows and this device's own Homes alike.
    const renderRetainedContinuation = (homeServerIdentityId: string, onBack: () => void): React.ReactElement | null => {
        const retained = continuationResults[homeServerIdentityId];
        const continuation = retained?.input.session.serviceKey === serviceKey ? retained : undefined;
        if (continuation?.result.kind !== 'home_material_required' && continuation?.result.kind !== 'failure') return null;
        return <View key={homeServerIdentityId} testID={`settings-account-service-material-${homeServerIdentityId}`}>
            {homeAuthentication?.input === continuation.input ? <AccountServiceHomeAuthenticationAdapter
                {...homeAuthentication} returnTo={AUTHENTICATED_ACCOUNT_ENTRY_ROUTE} accountEntryReturnTo="/settings/account"
                onBack={() => setHomeAuthentication(null)}
                onResult={(result) => {
                    setContinuationResults((current) => ({ ...current,
                        [homeServerIdentityId]: { input: homeAuthentication.input, result } }));
                    setHomeAuthentication(null);
                    setEnrollmentFailures((current) => {
                        const next = { ...current };
                        const failure = projectEnrollmentFailure(result);
                        if (failure) next[homeServerIdentityId] = failure;
                        else delete next[homeServerIdentityId];
                        return next;
                    });
                }} /> : <AccountServiceContinuation input={continuation.input} result={continuation.result}
                onReauthenticate={startAccountJourney}
                onOpenHomeAuthentication={(input, targetHomeServerIdentityId, previous) => setHomeAuthentication({ input, homeServerIdentityId: targetHomeServerIdentityId, previous })}
                onResult={(result, input) => setContinuationResults((current) => ({ ...current,
                    [homeServerIdentityId]: { input: input ?? continuation.input, result } }))}
                onBack={onBack} />}
        </View>;
    };
    const dismissContinuation = (homeServerIdentityId: string) => setContinuationResults((current) => {
        const next = { ...current };
        delete next[homeServerIdentityId];
        return next;
    });

    return (
        <>
            <ItemGroup
                title={sectionTitle}
                description={t('settingsAccount.accountServiceDescription')}
                action={noticeCarriesChange ? undefined : changeServiceButton('settings-account-service-change-service', 'inverted')}
            >
                <SettingAnchor setting={ACCOUNT_SETTINGS.settings.accountService}>
                    {primaryRows ?? (
                        <SectionContentRow testID="settings-account-service-invitation">
                            <AccountServiceInvitationIntro serviceMark={serviceMark} />
                        </SectionContentRow>
                    )}
                </SettingAnchor>
                {primaryRows && connectionKind === 'credential_expired' ? passwordFormElement : null}
                {connected && recoveryKeyReminder === serviceKey && serviceIdentity ? (
                    <Item
                        testID="settings-account-service-recovery-key"
                        mode="info"
                        icon={<Icon name="key" size={20} color={theme.colors.state.warning.foreground} />}
                        title={t('settingsAccount.accountServiceRecoveryKeyTitle', { accountService: serviceName })}
                        subtitle={t('settingsAccount.accountServiceRecoveryKeyBody')}
                        subtitleLines={0}
                        showChevron={false}
                        accessoryLayout="adaptive"
                        rightElementOutsidePressable
                        rightElement={(
                            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                            {account?.recoveryKey === 'password_unlock' ? (
                                <RoundButton
                                    testID="settings-account-service-recovery-key-view"
                                    size="small"
                                    display="secondary"
                                    title={t('settingsAccount.showRecoveryKey')}
                                    onPress={() => setRecoveryKeyOpen(serviceKey)}
                                />
                            ) : null}
                            <RoundButton
                                testID="settings-account-service-recovery-key-dismiss"
                                size="small"
                                display="secondary"
                                title={t('settingsAccount.accountServiceRecoveryKeySaved')}
                                onPress={async () => {
                                    await TokenStorage.setRecoveryKeyReminderDismissed(true, {
                                        kind: 'account_service',
                                        serverIdentityId: serviceIdentity,
                                    });
                                    setRecoveryKeyReminder(null);
                                }}
                            />
                            </View>
                        )}
                    />
                ) : null}
                {connected && recoveryKeyOpen === serviceKey && serviceIdentity && discovery && account?.recoveryKey === 'password_unlock' ? (
                    <AccountRecoveryKeyItem
                        recoveryEmail={null}
                        testIDPrefix="settings-account-service-recovery-key-row"
                        scopeKey={`${serviceKey}|${account.accountId}`}
                        source={{
                            kind: 'account_service',
                            request: createServerFetchAtEndpoint({
                                endpointUrl: discovery.endpointUrl,
                                serverId: discovery.serverIdentityId,
                                credentials: null,
                                ...(entry.transport?.runtimeOrigin ? { runtimeOrigin: entry.transport.runtimeOrigin } : {}),
                                ...(entry.transport?.homeCarrier ? { homeCarrier: entry.transport.homeCarrier } : {}),
                            }),
                            reminderTarget: { kind: 'account_service', serverIdentityId: serviceIdentity },
                        }}
                    />
                ) : connected && recoveryKeyOpen === serviceKey && account?.recoveryKey === 'key_only' ? (
                    <Item
                        testID="settings-account-service-recovery-key-row-unavailable"
                        mode="info"
                        icon={<Icon name="key" size={18} color={theme.colors.text.secondary} />}
                        title={t('settingsAccount.secretKey')}
                        subtitle={t('settingsAccount.accountServiceRecoveryKeyKeyOnly', { accountService: serviceName })}
                        subtitleLines={0}
                        showChevron={false}
                    />
                ) : null}
                {primaryRows ? null : (
                    <SectionContentRow testID="settings-account-service-benefits">
                        <AccountServiceBenefits />
                    </SectionContentRow>
                )}
                {primaryRows ? null : invitationFooter}
                <ChangeServiceDisclosure expanded={changingService} onExpandedChange={setChangingService}>
                    {changingService ? (
                        <AccountServiceChooser
                            currentEndpoint={endpoint}
                            profiles={profiles}
                            homeTitle={localHomeTitle}
                            activeServerId={activeServer.serverId}
                            signedIn={connected || connectionKind === 'credential_expired'}
                            showHeading={!noticeCarriesChange}
                            onClose={() => setChangingService(false)}
                        />
                    ) : null}
                </ChangeServiceDisclosure>
                <ExpandableItem
                    testID="settings-account-service-advanced"
                    expanded={advancedExpanded}
                    onExpandedChange={setAdvancedExpanded}
                    header={({ headerProps }) => (
                        <Item
                            {...headerProps}
                            title={t('settingsSession.handoff.advanced.title')}
                            detail={t('settingsAccount.accountServiceAdvancedSummary')}
                        />
                    )}
                >
                    <Item
                        testID="settings-account-service-technical-identity"
                        title={t('settingsAccount.accountServiceIdentity')}
                        detail={endpoint.serverIdentityId ?? t('common.unavailable')}
                        mode="info"
                        showChevron={false}
                    />
                    <Item
                        testID="settings-account-service-technical-home-directory"
                        title={t('settingsAccount.accountServiceHomeDirectoryCapability')}
                        detail={homeDirectoryCapability === null
                            ? t('common.unavailable')
                            : t(homeDirectoryCapability ? 'common.yes' : 'common.no')}
                        mode="info"
                        showChevron={false}
                    />
                    <Item
                        testID="settings-account-service-technical-home-enrollment"
                        title={t('settingsAccount.accountServiceHomeEnrollmentCapability')}
                        detail={homeEnrollmentCapability === null
                            ? t('common.unavailable')
                            : t(homeEnrollmentCapability ? 'common.yes' : 'common.no')}
                        mode="info"
                        showChevron={false}
                    />
                    <Item
                        testID="settings-account-service-technical-diagnostics"
                        title={t('settingsAccount.accountServiceDiagnostics')}
                        detail={diagnosticDetail}
                        mode="info"
                        showChevron={false}
                    />
                    {directorySnapshot?.refreshedAtMs ? (
                        <Item
                            testID="settings-account-service-technical-last-refresh"
                            title={t('common.refresh')}
                            detail={new Date(directorySnapshot.refreshedAtMs).toLocaleString()}
                            mode="info"
                            showChevron={false}
                        />
                    ) : null}
                    {directorySnapshot?.preferredHomeServerIdentityId ? (
                        <Item
                            testID="settings-account-service-technical-preferred"
                            title={t('settingsAccount.accountServicePreferredHome')}
                            detail={directorySnapshot.homes.find((home) => (
                                home.homeServerIdentityId === directorySnapshot.preferredHomeServerIdentityId
                            ))?.label ?? directorySnapshot.preferredHomeServerIdentityId}
                            mode="info"
                            showChevron={false}
                        />
                    ) : null}
                    {directorySnapshot?.homes.map((home) => {
                        const endpointDetails = formatHomeEndpointDetails(home);
                        const technicalDetails = endpointDetails === home.canonicalServerUrl
                            ? home.canonicalServerUrl
                            : `${home.canonicalServerUrl} · ${endpointDetails}`;
                        return (
                            <Item
                                key={`technical-${home.homeServerIdentityId}`}
                                testID={`settings-account-service-technical-home-${home.homeServerIdentityId}`}
                                title={home.label}
                                subtitle={technicalDetails}
                                subtitleLines={2}
                                subtitleEllipsizeMode="middle"
                                mode="info"
                                showChevron={false}
                            />
                        );
                    })}
                </ExpandableItem>
            </ItemGroup>
            {(directoryNotice || directorySnapshot || (serviceUsable && localHomesMissingFromDirectory.length > 0)) ? (
                <ItemGroup
                    title={t('settingsAccount.accountServiceLinkedHomes')}
                    description={t('settingsAccount.accountServiceDiscoveryDescription')}
                    action={connected ? (
                        <RoundButton
                            testID="settings-account-service-homes-refresh"
                            size="small"
                            display="inverted"
                            title={t('common.refresh')}
                            leading={directoryRefreshing
                                ? <ActivitySpinner size="small" />
                                : <Icon name="arrows-clockwise" size={14} color={theme.colors.text.secondary} />}
                            disabled={directoryRefreshing}
                            onPress={() => { void refreshDirectory(); }}
                        />
                    ) : undefined}
                >
                    {directoryNotice}
                    {directorySnapshot?.homes.map((home) => {
                        const preferred = directorySnapshot.preferredHomeServerIdentityId === home.homeServerIdentityId;
                        const testID = `settings-account-service-home-${home.homeServerIdentityId}`;
                        const pendingAction = pendingRowActions[home.homeServerIdentityId];
                        const profile = linkableProfileByIdentity.get(home.homeServerIdentityId)
                            ?? profiles.find((candidate) => candidate.id === home.homeServerIdentityId);
                        const retainedView = renderRetainedContinuation(home.homeServerIdentityId, () => router.back());
                        if (retainedView) return retainedView;
                        const durablyEnrolled = profile
                            ? authStatusByProfileId[resolveServerProfileScopeId(profile)] === 'signedIn'
                            : false;
                        const reconciliation = directorySnapshot.reconciliation;
                        const adoptionFailed = (
                            reconciliation?.kind === 'completed'
                            || reconciliation?.kind === 'cancelled'
                        ) && reconciliation.failures.some((failure) => (
                            failure.homeServerIdentityId === home.homeServerIdentityId
                        ));
                        const pendingForHome = pendingEnrollment?.homeServerIdentityId === home.homeServerIdentityId
                            ? pendingEnrollment
                            : null;
                        const enrollmentView: EnrollmentView | null = durablyEnrolled
                            ? 'enrolled'
                            : enrollmentFailures[home.homeServerIdentityId]
                                ?? (pendingForHome
                                    ? pendingForHome.kind === 'approval_required' ? 'approval_required' : HOME_ENROLLMENT_FAILED
                                    : adoptionFailed ? HOME_ENROLLMENT_FAILED : null);
                        const setPreferredTitle = t('settingsAccount.accountServiceSetPreferredHome');
                        const removeTitle = t('settingsAccount.accountServiceRemoveHome', { accountService: verifiedAccountServiceName });
                        const enrollmentNeedsRetry = pendingForHome?.kind === 'transport_unavailable';
                        const enrollmentCanRestart = Boolean(pendingForHome)
                            || enrollmentNeedsRetry
                            || (typeof enrollmentView === 'object' && enrollmentView !== null
                                && enrollmentView.failure.source === 'home' && enrollmentView.failure.code === 'expired');
                        const enrollTitle = pendingForHome
                            ? t('common.retry')
                            : enrollmentNeedsRetry
                            ? t('settingsAccount.accountServiceRetryHomeConnection')
                            : t('settingsAccount.accountServiceConnectHome');
                        const homeSignedIn = Boolean(profile && authStatusByProfileId[resolveServerProfileScopeId(profile)] === 'signedIn');
                        const actions = [
                            ...(profile && homeSignedIn ? [{
                                id: `${testID}-link`,
                                inlineTestID: `${testID}-link`,
                                title: t('settingsAccount.accountServiceLinkThisHome'),
                                icon: pendingAction === 'link'
                                    ? <ActivitySpinner size="small" />
                                    : 'link' as const,
                                disabled: Boolean(pendingAction) || busy,
                                onPress: () => { void linkHome(profile); },
                            }, {
                                id: `${testID}-unlink`,
                                inlineTestID: `${testID}-unlink`,
                                title: t('settingsAccount.accountServiceUnlinkHome', { accountService: verifiedAccountServiceName }),
                                icon: pendingAction === 'unlink'
                                    ? <ActivitySpinner size="small" />
                                    : 'link-break' as const,
                                disabled: Boolean(pendingAction) || busy,
                                destructive: true,
                                onPress: () => { void unlinkHome(home.homeServerIdentityId, home.label); },
                            }] : []),
                            ...(!preferred ? [{
                                id: `${testID}-set-preferred`,
                                inlineTestID: `${testID}-set-preferred`,
                                title: setPreferredTitle,
                                icon: pendingAction === 'set_preferred'
                                    ? <ActivitySpinner size="small" />
                                    : 'star' as const,
                                disabled: Boolean(pendingAction),
                                onPress: () => { void setPreferredHome(home.homeServerIdentityId); },
                            }] : []),
                            ...(!durablyEnrolled || enrollmentCanRestart ? [{
                                id: `${testID}-enroll`,
                                inlineTestID: `${testID}-enroll`,
                                title: enrollTitle,
                                icon: pendingAction === 'enroll'
                                    ? <ActivitySpinner size="small" />
                                    : 'link' as const,
                                disabled: Boolean(pendingAction),
                                onPress: () => { void enrollHome(home.homeServerIdentityId); },
                            }] : []),
                            {
                                id: `${testID}-remove`,
                                inlineTestID: `${testID}-remove`,
                                title: removeTitle,
                                icon: pendingAction === 'remove'
                                    ? <ActivitySpinner size="small" />
                                    : 'trash' as const,
                                disabled: Boolean(pendingAction),
                                destructive: true,
                                onPress: () => { void removeHome(home.homeServerIdentityId, home.label); },
                            },
                        ];
                        const commonActionId = !durablyEnrolled || enrollmentCanRestart
                            ? `${testID}-enroll`
                            : !preferred
                                ? `${testID}-set-preferred`
                                : homeSignedIn
                                    ? `${testID}-link`
                                    : null;
                        const preferredLabel = t('settingsAccount.accountServicePreferredHome');
                        // Every enrollment failure reads in the same words here as it
                        // does on the OAuth return and the continuation card: the
                        // failure presenter is the one owner of that vocabulary, so a
                        // fourth copy of these bodies cannot drift away from it.
                        const enrollmentLabel = enrollmentView === 'enrolled'
                            ? t('settingsAccount.accountServiceHomeConnected')
                            : enrollmentView === 'approval_required'
                                ? t('settingsAccount.accountServiceHomeApprovalRequired')
                                : enrollmentView
                                    ? describeAccountServiceFailure(enrollmentView.failure).body
                                    : null;
                        const statusLabel = [preferred ? preferredLabel : null, enrollmentLabel].filter(Boolean).join(' · ');
                        // A short settled state reads as a pill; a failure explanation is a sentence and
                        // stays in the row's text so it is never clipped.
                        const statusPill = enrollmentView === 'enrolled'
                            ? { variant: 'success' as const, label: t('settingsAccount.accountServiceHomeConnected') }
                            : enrollmentView === 'approval_required'
                                ? { variant: 'warning' as const, label: t('settingsAccount.accountServiceHomeApprovalRequired') }
                                : null;
                        const failureLabel = statusPill ? null : enrollmentLabel;
                        return (
                            <Item
                                key={home.homeServerIdentityId}
                                testID={testID}
                                icon={<Icon name="house" size={20} color={theme.colors.text.secondary} />}
                                title={home.label}
                                subtitle={[preferred ? preferredLabel : null, failureLabel].filter(Boolean).join(' · ') || undefined}
                                subtitleTestID={preferred ? `${testID}-preferred` : undefined}
                                accessibilityLabel={statusLabel ? `${home.label}, ${statusLabel}` : home.label}
                                mode="info"
                                rightElement={(
                                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                                        {statusPill ? (
                                            <StatusPill
                                                testID={`${testID}-status`}
                                                variant={statusPill.variant}
                                                label={statusPill.label}
                                                labelVariant="phrase"
                                            />
                                        ) : null}
                                        <ItemRowActions
                                            title={home.label}
                                            actions={actions}
                                            compactThreshold={Number.MAX_SAFE_INTEGER}
                                            compactActionIds={commonActionId ? [commonActionId] : []}
                                        />
                                    </View>
                                )}
                                rightElementOutsidePressable
                                showChevron={false}
                            />
                        );
                    })}
                    {(serviceUsable ? localHomesMissingFromDirectory : []).map((profile) => {
                        const homeServerIdentityId = profile.serverIdentityId!.trim();
                        const testID = `settings-account-service-local-home-${homeServerIdentityId}`;
                        const retainedView = renderRetainedContinuation(homeServerIdentityId, () => dismissContinuation(homeServerIdentityId));
                        if (retainedView) return retainedView;
                        // Linking publishes the Home's address; a Home that has none other devices can
                        // reach says so instead of offering a link that cannot succeed.
                        const linkable = canPublishAuthenticatedHomeLink(homeServerIdentityId);
                        const linking = pendingRowActions[homeServerIdentityId] === 'link';
                        return (
                            <Item
                                key={profile.id}
                                testID={testID}
                                icon={<Icon name="link" size={20} color={theme.colors.text.secondary} />}
                                title={localHomeTitle(profile)}
                                subtitle={linkable
                                    ? t('settingsAccount.accountServiceLinkLocalHomeDescription')
                                    : t('settingsAccount.accountServiceLinkUnreachableHome')}
                                subtitleTestID={linkable ? undefined : `${testID}-unreachable`}
                                subtitleLines={0}
                                mode="info"
                                rightElement={linkable ? (
                                    <RoundButton
                                        testID={`${testID}-link`}
                                        size="small"
                                        display="secondary"
                                        title={t('settingsAccount.accountServiceLink')}
                                        accessibilityLabel={t('settingsAccount.accountServiceLinkThisHome')}
                                        loading={linking}
                                        disabled={Boolean(pendingRowActions[homeServerIdentityId]) || busy}
                                        onPress={() => { void linkHome(profile); }}
                                    />
                                ) : undefined}
                                rightElementOutsidePressable
                                showChevron={false}
                            />
                        );
                    })}
                </ItemGroup>
            ) : null}
        </>
    );
}

/**
 * The inline service chooser. It has no header row of its own (the section action or a notice
 * opens it), so while closed it draws no row divider either.
 */
function ChangeServiceDisclosure(props: Readonly<{
    expanded: boolean;
    onExpandedChange: (expanded: boolean) => void;
    children: React.ReactNode;
    showDivider?: boolean;
}>) {
    return (
        <ExpandableItem
            testID="settings-account-service-change-disclosure"
            expanded={props.expanded}
            onExpandedChange={props.onExpandedChange}
            header={null}
            showDivider={props.expanded && props.showDivider !== false}
        >
            {props.children}
        </ExpandableItem>
    );
}
