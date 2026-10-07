import * as React from 'react';
import { usePathname, useRouter } from '@/components/appShell/workspace/destinationRoute';
import { buildAuthenticatedAccountEntryHref } from '@/components/navigation/accountEntry/authenticatedAccountEntryRoute';
import { createHomeLoginRequesterFingerprintV1 } from '@happier-dev/protocol/auth/accountDirectory';
import { Platform, StyleSheet, View } from 'react-native';

import {
    decideHomeDeviceApproval,
    listHomeDeviceApprovals,
    type HomeDeviceApprovalDecision,
    type HomeDeviceApprovalListItem,
    type HomeDeviceApprovalTarget,
} from '@/auth/approval/homeDeviceApprovalClient';
import { resolveHomeEnrollmentTransport } from '@/auth/enrollment/homeEnrollmentTransport';
import {
    formatEnrollmentExpiry,
    formatHomeEnrollmentTargetLabel,
} from '@/auth/pairing/pairingPresentation';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { PoliteAccessibilityStatus } from '@/components/ui/accessibility/PoliteAccessibilityStatus';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemLoadStateRows } from '@/components/ui/lists/ItemLoadStateRows';
import { Text } from '@/components/ui/text/Text';
import {
    buildHomeConnectionDescriptorForProfile,
    resolveServerProfileScopeId,
    type ServerProfile,
} from '@/sync/domains/server/serverProfiles';
import {
    cancelPendingDirectoryHomeEnrollment,
    getPendingDirectoryHomeEnrollment,
    resumePendingDirectoryHomeEnrollment,
    subscribePendingDirectoryHomeEnrollment,
} from '@/sync/ops/accountDirectory/enrollDirectoryHome';
import type { AccountPostAuthInput, AccountPostAuthResult } from '@/sync/ops/accountDirectory/completeAccountServicePostAuth';
import { AccountServiceContinuation } from '@/components/account/auth/AccountServiceContinuation';
import { describeAccountPostAuthResultReason } from '@/components/account/auth/accountServiceFailurePresentation';
import { AccountServiceHomeAuthenticationAdapter } from '@/components/account/auth/AccountServiceHomeAuthenticationAdapter';
import { AUTHENTICATED_ACCOUNT_ENTRY_ROUTE } from '@/components/navigation/accountEntry/authenticatedAccountEntryRoute';
import { t } from '@/text';
import { resolveHomeDisplayLabel } from '@/components/settings/server/homeDisplayName';
import {
    useAccountDirectoryActivePolling,
    type AccountDirectoryActivePollingOutcome,
} from '@/sync/ops/accountDirectory/useAccountDirectoryActivePolling';

type PendingApproval = Readonly<{
    home: ServerProfile;
    approval: HomeDeviceApprovalListItem;
}>;

type LoadState =
    | Readonly<{ kind: 'loading'; items: readonly PendingApproval[] }>
    | Readonly<{ kind: 'ready'; items: readonly PendingApproval[] }>
    | Readonly<{
        kind: 'error';
        items: readonly PendingApproval[];
        reason: string | null;
        /** The Homes that did not answer, when that is the whole failure (not an error they returned). */
        unreachableServerIds: readonly string[];
    }>;

type StatusAnnouncement = Readonly<{
    revision: number;
    text: string;
}>;

type ApprovalLoadMode = 'interactive' | 'poll';

function homeLabel(home: ServerProfile): string {
    return resolveHomeDisplayLabel(home, home.id);
}

/** Why the list could not load, naming the Homes that failed: unreachable ones, else erroring ones. */
function describeApprovalLoadFailure(
    failures: ReadonlyArray<Readonly<{ home: ServerProfile; result: Awaited<ReturnType<typeof listHomeDeviceApprovals>> }>>,
): string | null {
    const unreachable = failures.filter(({ result }) => !result.ok && result.status === 0).map(({ home }) => homeLabel(home));
    if (unreachable.length > 0) return t('homeDeviceApproval.loadErrorUnreachable', { homes: unreachable.join(', ') });
    const failing = failures.map(({ home }) => homeLabel(home));
    return failing.length > 0 ? t('homeDeviceApproval.loadErrorFailed', { homes: failing.join(', ') }) : null;
}

function approvalSnapshotKey(items: readonly PendingApproval[]): string {
    return items
        .map(({ home, approval }) => `${home.id}:${approval.approvalId}`)
        .sort()
        .join('|');
}

/**
 * Reads a resumed enrollment result with the continuation card's own reason, so
 * the announcement and the card this section renders never disagree.
 */
function pendingEnrollmentResultAnnouncement(
    homeName: string,
    result: AccountPostAuthResult | null | void,
): string {
    const prefix = `${homeName}. `;
    if (!result || result.kind === 'stopped') return `${prefix}${t('homeDeviceApproval.stopWaiting')}`;
    // This section's continuation offers direct Home sign-in (onOpenHomeAuthentication).
    return `${prefix}${describeAccountPostAuthResultReason(result, { signInToHome: true, homeName })}`;
}

const styles = StyleSheet.create({
    requesterFingerprint: {
        fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
    },
    requesterDetails: {
        paddingHorizontal: 16,
        paddingVertical: 8,
        gap: 4,
    },
});

async function withHomeApprovalTarget<T>(
    home: ServerProfile,
    unavailable: T,
    operation: (target: HomeDeviceApprovalTarget) => Promise<T>,
    /** The result for a Home this device cannot ask at all (no descriptor, or signed out); defaults to `unavailable`. */
    notSignedIn: T = unavailable,
): Promise<T> {
    const descriptor = buildHomeConnectionDescriptorForProfile(home);
    if (!descriptor) return notSignedIn;
    const credentials = await TokenStorage.getCredentialsForServerUrl(
        descriptor.canonicalServerUrl,
        { serverId: descriptor.homeServerIdentityId },
    ).catch(() => null);
    if (!credentials?.token) return notSignedIn;
    const resolution = await resolveHomeEnrollmentTransport(descriptor, {
        verification: { kind: 'authenticated', token: credentials.token },
    });
    if (!resolution.ok) return unavailable;
    const { transport } = resolution;
    try {
        return await operation({ transport, credentials });
    } finally {
        try {
            await transport.close();
        } catch {
            // The operation result is authoritative; transport teardown is best-effort.
        }
    }
}

export function HomeDeviceApprovalSection({ homes }: Readonly<{ homes: readonly ServerProfile[] }>) {
    const router = useRouter();
    const invokingPath = usePathname();
    const [state, setState] = React.useState<LoadState>({ kind: 'loading', items: [] });
    const [busyKeys, setBusyKeys] = React.useState<readonly string[]>([]);
    const [decisionErrorKeys, setDecisionErrorKeys] = React.useState<readonly string[]>([]);
    const [expandedRequestKeys, setExpandedRequestKeys] = React.useState<readonly string[]>([]);
    const [continuation, setContinuation] = React.useState<Readonly<{ input: AccountPostAuthInput; result: AccountPostAuthResult }> | null>(null);
    const [homeAuthentication, setHomeAuthentication] = React.useState<Readonly<{
        input: AccountPostAuthInput; previous: AccountPostAuthResult; homeServerIdentityId: string;
    }> | null>(null);
    const [announcement, setAnnouncement] = React.useState<StatusAnnouncement>({
        revision: 0,
        text: t('common.loading'),
    });
    const mountedRef = React.useRef(false);
    const approvalItemsRef = React.useRef<readonly PendingApproval[]>([]);
    const approvalSnapshotKeyRef = React.useRef<string | null>(null);
    const approvalRefreshPromiseRef = React.useRef<Promise<AccountDirectoryActivePollingOutcome> | null>(null);
    const pendingEnrollment = React.useSyncExternalStore(
        subscribePendingDirectoryHomeEnrollment,
        getPendingDirectoryHomeEnrollment,
        getPendingDirectoryHomeEnrollment,
    );
    const publishAnnouncement = React.useCallback((text: string) => {
        if (!mountedRef.current) return;
        setAnnouncement((current) => ({ revision: current.revision + 1, text }));
    }, []);

    const load = React.useCallback((mode: ApprovalLoadMode = 'interactive'): Promise<AccountDirectoryActivePollingOutcome> => {
        const inFlight = approvalRefreshPromiseRef.current;
        if (inFlight) return inFlight;

        const operation = (async () => {
            if (mode === 'interactive' && mountedRef.current) {
                setState((current) => ({ kind: 'loading', items: current.items }));
            }
            try {
                const results = await Promise.all(homes.map(async (home) => ({
                    home,
                    result: await withHomeApprovalTarget(
                        home,
                        { ok: false, reason: 'request_failed', status: 0 } as const,
                        listHomeDeviceApprovals,
                        // A signed-out Home has no approvals this device can see; that is not a failure to retry.
                        { ok: false, reason: 'unauthorized', status: 401 } as const,
                    ),
                })));
                if (!mountedRef.current) return 'completed';

                const failures = results.filter(({ result }) => !result.ok && result.reason !== 'unauthorized');
                const failed = failures.length > 0;
                if (failed && mode === 'poll') return 'backoff';

                const items = results.flatMap(({ home, result }) => result.ok
                    ? result.items.map((approval) => ({ home, approval }))
                    : []);
                const nextSnapshotKey = approvalSnapshotKey(items);
                const changed = nextSnapshotKey !== approvalSnapshotKeyRef.current;
                if (mode === 'poll' && !changed) return 'completed';

                approvalItemsRef.current = items;
                approvalSnapshotKeyRef.current = failed ? null : nextSnapshotKey;
                setState(failed
                    ? {
                        kind: 'error',
                        items,
                        reason: describeApprovalLoadFailure(failures),
                        unreachableServerIds: failures.every(({ result }) => !result.ok && result.status === 0)
                            ? failures.map(({ home }) => resolveServerProfileScopeId(home))
                            : [],
                    }
                    : { kind: 'ready', items });
                publishAnnouncement(
                    failed
                        ? t('homeDeviceApproval.loadError')
                        : items.length === 0
                            ? t('inbox.emptyDescription')
                            : `${t('homeDeviceApproval.title')}: ${items.map(({ home }) => homeLabel(home)).join(', ')}`,
                );
                return failed ? 'backoff' : 'completed';
            } catch {
                if (mountedRef.current && mode === 'interactive') {
                    approvalSnapshotKeyRef.current = null;
                    setState((current) => ({ kind: 'error', items: current.items, reason: null, unreachableServerIds: [] }));
                    publishAnnouncement(t('homeDeviceApproval.loadError'));
                }
                return 'backoff';
            }
        })();
        approvalRefreshPromiseRef.current = operation;
        void operation.finally(() => {
            if (approvalRefreshPromiseRef.current === operation) {
                approvalRefreshPromiseRef.current = null;
            }
        });
        return operation;
    }, [homes, publishAnnouncement]);

    React.useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
        };
    }, []);

    React.useEffect(() => {
        void load();
    }, [load]);

    const decide = React.useCallback(async (item: PendingApproval, decision: HomeDeviceApprovalDecision) => {
        const key = `${item.home.id}:${item.approval.approvalId}`;
        setBusyKeys((current) => current.includes(key) ? current : [...current, key]);
        setDecisionErrorKeys((current) => current.filter((candidate) => candidate !== key));
        const unavailable = { ok: false, reason: 'request_failed', status: 0 } as const;
        let result: Awaited<ReturnType<typeof decideHomeDeviceApproval>>;
        try {
            result = await withHomeApprovalTarget(
                item.home,
                unavailable,
                (target) => decideHomeDeviceApproval(target, item.approval.approvalId, decision),
            );
        } catch {
            result = unavailable;
        } finally {
            setBusyKeys((current) => current.filter((candidate) => candidate !== key));
        }
        if (!result.ok) {
            if (result.reason === 'already_decided') {
                setDecisionErrorKeys((current) => current.filter((candidate) => candidate !== key));
                await load();
                return;
            }
            setDecisionErrorKeys((current) => current.includes(key) ? current : [...current, key]);
            publishAnnouncement(`${t('homeDeviceApproval.decisionError')}: ${homeLabel(item.home)}`);
            return;
        }
        setDecisionErrorKeys((current) => current.filter((candidate) => candidate !== key));
        setExpandedRequestKeys((current) => current.filter((candidate) => candidate !== key));
        const remainingItems = approvalItemsRef.current.filter((candidate) => (
            candidate.approval.approvalId !== item.approval.approvalId
            || candidate.home.id !== item.home.id
        ));
        approvalItemsRef.current = remainingItems;
        approvalSnapshotKeyRef.current = approvalSnapshotKey(remainingItems);
        setState({ kind: 'ready', items: remainingItems });
        publishAnnouncement(`${decision === 'approve' ? t('homeDeviceApproval.approved') : t('homeDeviceApproval.rejected')}: ${homeLabel(item.home)}`);
    }, [load, publishAnnouncement]);

    const runPendingEnrollmentOperation = React.useCallback(async (
        homeName: string,
        operationKind: 'resume' | 'cancel',
        operation: () => Promise<AccountPostAuthResult | null | void>,
    ) => {
        const pendingKey = 'pending-enrollment';
        setBusyKeys((current) => current.includes(pendingKey) ? current : [...current, pendingKey]);
        try {
            const pending = getPendingDirectoryHomeEnrollment();
            const result = await operation();
            if (mountedRef.current && pending && result && operationKind === 'resume') setContinuation({ input: pending.input, result });
            if (operationKind === 'cancel') setContinuation(null);
            publishAnnouncement(
                operationKind === 'cancel'
                    ? `${homeName}. ${t('homeDeviceApproval.stopWaiting')}`
                    : pendingEnrollmentResultAnnouncement(homeName, result),
            );
        } catch {
            publishAnnouncement(`${homeName}. ${t('errors.operationFailed')}. ${t('common.retry')}`);
        } finally {
            setBusyKeys((current) => current.filter((key) => key !== pendingKey));
        }
    }, [publishAnnouncement]);
    const pendingEnrollmentHome = pendingEnrollment
        ? homes.find((candidate) => (
            candidate.serverIdentityId === pendingEnrollment.homeServerIdentityId
            || (candidate.legacyServerIds ?? []).includes(pendingEnrollment.homeServerIdentityId)
        )) ?? null
        : null;
    const pendingEnrollmentName = pendingEnrollmentHome?.name
        ?? pendingEnrollment?.homeServerIdentityId
        ?? '';
    const pendingEnrollmentDescriptor = pendingEnrollmentHome
        ? buildHomeConnectionDescriptorForProfile(pendingEnrollmentHome)
        : null;
    const pendingEnrollmentTarget = pendingEnrollmentDescriptor
        ? formatHomeEnrollmentTargetLabel(pendingEnrollmentDescriptor)
        : null;
    const pendingEnrollmentExpiry = pendingEnrollment?.kind === 'approval_required'
        ? formatEnrollmentExpiry(pendingEnrollment.expiresAtMs)
        : '';
    const pendingEnrollmentBusy = busyKeys.includes('pending-enrollment');

    const poll = React.useCallback(async (): Promise<AccountDirectoryActivePollingOutcome> => {
        try {
            const [loaded, resumed] = await Promise.all([
                load('poll'),
                pendingEnrollment ? resumePendingDirectoryHomeEnrollment() : Promise.resolve(null),
            ]);
            if (mountedRef.current && pendingEnrollment && resumed && resumed.kind !== 'approval_required') {
                setContinuation({ input: pendingEnrollment.input, result: resumed });
            }
            if (resumed && resumed.kind !== 'approval_required') publishAnnouncement(pendingEnrollmentResultAnnouncement(pendingEnrollmentName, resumed));
            return loaded === 'backoff' || (resumed?.kind === 'failure' && resumed.recovery === 'retry_stage') ? 'backoff' : 'completed';
        } catch {
            // The visible pending card and explicit Retry remain available.
            return 'backoff';
        }
    }, [load, pendingEnrollment, pendingEnrollmentName, publishAnnouncement]);
    useAccountDirectoryActivePolling(poll);

    const pendingEnrollmentGroup = pendingEnrollment ? (
        <ItemGroup title={t('common.homeProductName')}>
            <Item
                testID="settings.server.homeEnrollment.pending"
                title={pendingEnrollmentName}
                subtitle={[
                    pendingEnrollmentTarget,
                    pendingEnrollment.kind === 'approval_required'
                        ? t('connect.waitingForApproval')
                        : t('connect.homeEnrollmentRetryBody'),
                    pendingEnrollmentExpiry
                        ? `${t('connect.expiresAtLabel')}: ${pendingEnrollmentExpiry}`
                        : null,
                ].filter((value): value is string => typeof value === 'string').join(' · ')}
                accessibilityLabel={`${pendingEnrollmentName}. ${
                    pendingEnrollment.kind === 'approval_required'
                        ? t('connect.waitingForApproval')
                        : t('connect.homeEnrollmentRetryBody')
                }${pendingEnrollmentExpiry ? `. ${t('connect.expiresAtLabel')}: ${pendingEnrollmentExpiry}` : ''}`}
                mode="info"
                showChevron={false}
            />
            <Item
                testID="settings.server.homeEnrollment.pending.retry"
                title={t('common.retry')}
                accessibilityLabel={`${t('common.retry')}: ${pendingEnrollmentName}`}
                disabled={pendingEnrollmentBusy}
                loading={pendingEnrollmentBusy}
                onPress={() => void runPendingEnrollmentOperation(
                    pendingEnrollmentName,
                    'resume',
                    resumePendingDirectoryHomeEnrollment,
                )}
            />
            <Item
                testID="settings.server.homeEnrollment.pending.cancel"
                title={t('homeDeviceApproval.stopWaiting')}
                accessibilityLabel={`${t('homeDeviceApproval.stopWaiting')}: ${pendingEnrollmentName}`}
                disabled={pendingEnrollmentBusy}
                onPress={() => void runPendingEnrollmentOperation(
                    pendingEnrollmentName,
                    'cancel',
                    cancelPendingDirectoryHomeEnrollment,
                )}
            />
        </ItemGroup>
    ) : null;

    const renderSection = (content: React.ReactNode) => (
        <>
            <PoliteAccessibilityStatus
                announcement={announcement.text}
                statusTestID="settings.server.homeApprovals.status"
                transitionKey={String(announcement.revision)}
            />
            {pendingEnrollmentGroup}
            {continuation && continuation.result.kind !== 'stopped' ? (
                <View testID="settings.server.homeEnrollment.continuation">
                    {homeAuthentication ? <AccountServiceHomeAuthenticationAdapter {...homeAuthentication}
                        returnTo={AUTHENTICATED_ACCOUNT_ENTRY_ROUTE} accountEntryReturnTo={invokingPath}
                        onBack={() => setHomeAuthentication(null)}
                        onResult={(result) => {
                            setContinuation({ input: homeAuthentication.input, result });
                            setHomeAuthentication(null);
                        }} /> : <AccountServiceContinuation input={continuation.input} result={continuation.result}
                        onOpenHomeAuthentication={(input, homeServerIdentityId, previous) => setHomeAuthentication({ input, homeServerIdentityId, previous })}
                        onReauthenticate={(input) => router.push(buildAuthenticatedAccountEntryHref({
                            service: input.service,
                            intent: input.intent,
                            returnTo: invokingPath,
                        }))}
                        onResult={(result, input) => setContinuation({ input: input ?? continuation.input, result })}
                        onBack={() => setContinuation(null)} />}
                </View>
            ) : null}
            {content}
        </>
    );

    // Pending approvals are rare. While the first check runs, the section adds nothing rather than a
    // loading row that would vanish again and move every section below it.
    if (state.kind === 'loading' && state.items.length === 0) {
        return renderSection(null);
    }

    if (state.kind === 'error' && state.items.length === 0) {
        return renderSection(
            <ItemGroup title={t('homeDeviceApproval.title')}>
                <ItemLoadStateRows
                    testID="settings.server.homeApprovals.error"
                    state={{
                        kind: 'failed',
                        reason: [t('homeDeviceApproval.loadError'), state.reason].filter(Boolean).join(' '),
                        onRetry: () => load(),
                        // When only unreachable Homes failed, the page's banner may already say so.
                        ...(state.unreachableServerIds.length > 0 ? { homeServerIds: state.unreachableServerIds } : {}),
                    }}
                />
            </ItemGroup>,
        );
    }

    if (state.items.length === 0) {
        return renderSection(null);
    }

    return renderSection(
        <ItemGroup title={t('homeDeviceApproval.title')}>
            {state.items.map((item) => {
                const key = `${item.home.id}:${item.approval.approvalId}`;
                const busy = busyKeys.includes(key);
                const decisionFailed = decisionErrorKeys.includes(key);
                const requestDetailsExpanded = expandedRequestKeys.includes(key);
                const requesterFingerprint = createHomeLoginRequesterFingerprintV1(
                    item.approval.requesterBoxPublicKeyBase64,
                );
                const approvalExpiresAt = formatEnrollmentExpiry(item.approval.expiresAtMs);
                const requestingDeviceName = item.approval.deviceLabel?.trim() || t('homeDeviceApproval.deviceFallback');
                const approvalDetails = [
                    t('homeDeviceApproval.homeLabel', { home: homeLabel(item.home) }),
                    t('homeDeviceApproval.expiresLabel', { expiry: approvalExpiresAt }),
                ];
                return (
                    <React.Fragment key={key}>
                        <Item
                            testID={`settings.server.homeApprovals.${item.approval.approvalId}`}
                            title={requestingDeviceName}
                            subtitle={approvalDetails.join(' · ')}
                            accessibilityLabel={`${requestingDeviceName}. ${approvalDetails.join('. ')}`}
                            mode="info"
                            showChevron={false}
                        />
                        <Item
                            testID={`settings.server.homeApprovals.${item.approval.approvalId}.details`}
                            title={t('homeDeviceApproval.requestDetails')}
                            subtitle={t('homeDeviceApproval.requestDetailsHint')}
                            accessibilityExpanded={requestDetailsExpanded}
                            onPress={() => setExpandedRequestKeys((current) => current.includes(key)
                                ? current.filter((candidate) => candidate !== key)
                                : [...current, key])}
                            showChevron
                        />
                        {requestDetailsExpanded ? (
                            <View
                                testID={`settings.server.homeApprovals.${item.approval.approvalId}.fingerprint`}
                                style={styles.requesterDetails}
                            >
                                <Text>{t('homeDeviceApproval.requestDetailsHelp')}</Text>
                                <Text selectable style={styles.requesterFingerprint}>
                                    {t('homeDeviceApproval.fingerprintLabel')}: {requesterFingerprint}
                                </Text>
                            </View>
                        ) : null}
                        {decisionFailed ? (
                            <Item
                                testID={`settings.server.homeApprovals.${item.approval.approvalId}.error`}
                                title={t('homeDeviceApproval.decisionError')}
                                subtitle={t('homeDeviceApproval.decisionRecovery')}
                                mode="info"
                                showChevron={false}
                            />
                        ) : null}
                        <Item
                            testID={`settings.server.homeApprovals.${item.approval.approvalId}.approve`}
                            title={t('homeDeviceApproval.approve')}
                            accessibilityLabel={`${t('homeDeviceApproval.approve')}: ${requestingDeviceName}`}
                            disabled={busy}
                            loading={busy}
                            onPress={() => void decide(item, 'approve')}
                        />
                        <Item
                            testID={`settings.server.homeApprovals.${item.approval.approvalId}.reject`}
                            title={t('homeDeviceApproval.reject')}
                            accessibilityLabel={`${t('homeDeviceApproval.reject')}: ${requestingDeviceName}`}
                            disabled={busy}
                            destructive
                            onPress={() => void decide(item, 'reject')}
                        />
                    </React.Fragment>
                );
            })}
        </ItemGroup>,
    );
}
