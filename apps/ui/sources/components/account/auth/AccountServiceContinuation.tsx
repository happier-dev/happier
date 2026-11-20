import * as React from 'react';
import { retryableLazy } from '@/components/ui/performance/retryableLazy';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { resolvePostAuthLanding } from '@/components/onboarding/state/resolvePostAuthLanding';
import { SecretKeyEntryForm } from '@/components/account/restore/SecretKeyEntryForm';
import { PairingLinkEntryForm } from '@/components/account/restore/PairingLinkEntryForm';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { inspectHomeQrInviteDeepLink } from '@/auth/pairing/pairingUrl';
import { SurfaceStateCard, type SurfaceStateAction } from '@/components/ui/surfaces/SurfaceStateCard';
import { oauthProviderIconName } from '@/components/account/auth/homeAuthenticationActionPresentation';
import { StepMotionLayer } from '@/components/ui/motion/stepMotion/StepMotionLayer';
import { runStepMove } from '@/components/ui/motion/stepMotion/StepMotionStage';
import { StepTransitionFrame, resolveStepTransitionDirection, type StepTransitionDirection } from '@/components/ui/motion/StepTransitionFrame';
import { ActionListSection } from '@/components/ui/lists/ActionListSection';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Modal } from '@/modal';
import { t } from '@/text';
import { completeAccountServicePostAuth, confirmAccountServiceHomeRelink, isCompletedAccountPostAuthResult, resumeAccountServicePostAuth, supplyAccountServiceHomeMaterial,
    type AccountPostAuthInput, type AccountPostAuthResult } from '@/sync/ops/accountDirectory/completeAccountServicePostAuth';
import { getPendingDirectoryHomeEnrollment, subscribePendingDirectoryHomeEnrollment, resumePendingDirectoryHomeEnrollment, cancelPendingDirectoryHomeEnrollment } from '@/sync/ops/accountDirectory/enrollDirectoryHome';
import { useAccountDirectoryActivePolling } from '@/sync/ops/accountDirectory/useAccountDirectoryActivePolling';
import { formatEnrollmentExpiry } from '@/auth/pairing/pairingPresentation';
import { resolveServerProfileForPortableIdentity } from '@/sync/domains/server/serverProfiles';
import { openEnrolledHomeOrReturnToShell, type OpenEnrolledHomeResult } from '@/auth/pairing/openEnrolledHome';
import { useAuth } from '@/auth/context/AuthContext';
import { toServerUrlDisplay } from '@/sync/domains/server/url/serverUrlDisplay';
import { WelcomeActionAdmissionContext } from '@/components/onboarding/preAuth/WelcomeActionList';
import { describeAccountPostAuthResultReason, describeAccountServiceFailure } from './accountServiceFailurePresentation';
import { resolveHomeDisplayLabel } from '@/components/settings/server/homeDisplayName';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { useOptionalCurrentUiContextReader, usePublishCurrentUiContext } from '@/components/appShell/currentUiContext/CurrentUiContextProvider';
import type { CurrentUiContextAccountHomeContinuationCommand, CurrentUiContextMountedEnrichment } from '@/components/appShell/currentUiContext/currentUiContextModel';
import type { AccountHomeContinuationInputV1 } from '@happier-dev/protocol/actions';
import { mergeAbortSignals } from '@/utils/runtime/abortSignals';

type HomeContinuationStep = Omit<Extract<AccountHomeContinuationInputV1, { operation: 'choose' }>, 'commandId'>
    | Omit<Exclude<AccountHomeContinuationInputV1, { operation: 'choose' }>, 'commandId'>;

const loadRestoreScanComputerQrView = () => import('@/components/account/restore/RestoreScanComputerQrView');
const RestoreScanComputerQrView = retryableLazy(async () => ({ default: (await loadRestoreScanComputerQrView()).RestoreScanComputerQrView }));

type RecoveryView = 'key' | 'scan' | 'paste';
/** Recovery views read left to right: the card, its scanner, the scanner's paste form. */
const RECOVERY_VIEW_ORDER: Record<RecoveryView, number> = { key: 0, scan: 1, paste: 2 };

export function AccountServiceContinuation(props: Readonly<{
    input: AccountPostAuthInput;
    result: AccountPostAuthResult;
    onResult: (result: AccountPostAuthResult, input?: AccountPostAuthInput) => void | Promise<void>;
    onBack: () => void;
    onReauthenticate?: (input: AccountPostAuthInput) => void | Promise<void>;
    onOpenHomeAuthentication?: (
        input: AccountPostAuthInput,
        homeServerIdentityId: string,
        previous: AccountPostAuthResult,
    ) => void | Promise<void>;
}>): React.ReactElement {
    const [recovery, setRecovery] = React.useState<Readonly<{ view: RecoveryView; direction: StepTransitionDirection }>>(
        { view: 'key', direction: 'replace' });
    const recoveryView = recovery.view;
    const router = useRouter();
    const auth = useAuth();
    const activeHome = useActiveServerSnapshot();
    const setRecoveryView = (view: RecoveryView) => {
        if (view === recoveryView) return;
        const direction = resolveStepTransitionDirection({
            previousIndex: RECOVERY_VIEW_ORDER[recoveryView], nextIndex: RECOVERY_VIEW_ORDER[view],
        });
        const commit = () => setRecovery({ view, direction });
        if (auth.isAuthenticated) commit();
        else runStepMove({ layer: 'account-recovery', kind: direction === 'backward' ? 'back' : 'step', commit });
    };
    const hasAuthenticatedHomeAccount = auth.isAuthenticated && auth.credentialAuthorityKind === 'account';
    const mountedAction = useMountedActionExecution(hasAuthenticatedHomeAccount ? activeHome.serverId : null);
    const currentContext = useOptionalCurrentUiContextReader();
    const [openUnavailable, setOpenUnavailable] = React.useState(false);
    const [pairingLink, setPairingLink] = React.useState<string | null>(null);
    const [approvalStopped, setApprovalStopped] = React.useState(false);
    const admission = React.useContext(WelcomeActionAdmissionContext);
    const inFlight = React.useRef(false);
    const [busy, setBusy] = React.useState(false);
    const run = async (actionId: string, action: () => unknown) => {
        if (inFlight.current || props.input.signal?.aborted) return false;
        inFlight.current = true;
        setBusy(true);
        let executed = false;
        try { await admission.run(actionId, async () => { executed = true; await action(); }); }
        finally { inFlight.current = false; setBusy(false); }
        return executed;
    };
    const pending = React.useSyncExternalStore(subscribePendingDirectoryHomeEnrollment, getPendingDirectoryHomeEnrollment, getPendingDirectoryHomeEnrollment);
    const ownsPending = pending?.input.session === props.input.session
        && JSON.stringify(pending.input.intent) === JSON.stringify(props.input.intent);
    const canPoll = ownsPending && pending?.kind !== 'partial_commit';
    useAccountDirectoryActivePolling(async () => {
        if (!canPoll) return 'completed';
        const result = await resumePendingDirectoryHomeEnrollment();
        if (result) await props.onResult(result);
        return result?.kind === 'failure' && result.recovery === 'retry_stage' ? 'backoff' : 'completed';
    }, canPoll);

    const back = async () => {
        if (ownsPending && pending) await cancelPendingDirectoryHomeEnrollment(pending);
        props.onBack();
    };
    const retry = async (input = props.input) => { await props.onResult(await resumeAccountServicePostAuth(input, props.result)); };
    const material = props.result.kind === 'home_material_required' ? props.result : null;
    const failure = props.result.kind === 'failure' ? props.result : null;
    const retainedProfile = ownsPending && pending?.kind === 'partial_commit'
        && failure?.code.source === 'home' && failure.code.code === 'partial_commit'
        && pending.homeServerIdentityId === failure.targetHomeServerIdentityId ? pending : null;
    const failurePresentation = failure ? describeAccountServiceFailure(failure.code) : null;
    const successful = isCompletedAccountPostAuthResult(props.result);
    const completedHomeServerIdentityId = successful && 'homeServerIdentityId' in props.result
        ? props.result.homeServerIdentityId
        : undefined;
    const target = material?.homeServerIdentityId ?? failure?.targetHomeServerIdentityId ?? completedHomeServerIdentityId
        ?? (props.result.kind === 'explicit_target_not_linked' || props.result.kind === 'approval_required' ? props.result.homeServerIdentityId : undefined);
    const targetProfile = target ? resolveServerProfileForPortableIdentity(target) : null;
    const verifiedAccountServiceName = props.input.service.snapshot.features.accountServicePresentation?.displayName?.trim() || undefined;
    // Routine copy names the service the user actually chose, never the
    // internal "Account Service" concept. The verified presentation name is the
    // authority; its address is the only honest fallback.
    const serviceDisplayName = verifiedAccountServiceName ?? toServerUrlDisplay(props.input.service.endpointUrl);
    const homeName = props.input.session.snapshot.homes.find((home) => home.homeServerIdentityId === target)?.label
        ?? (targetProfile?.kind === 'resolved' ? resolveHomeDisplayLabel(targetProfile.profile, targetProfile.profile.id) : t('common.homeProductName'));
    const openHomeGenerationRef = React.useRef(0);
    React.useEffect(() => () => {
        openHomeGenerationRef.current += 1;
    }, []);
    const paired = material ? async (value: Parameters<typeof supplyAccountServiceHomeMaterial>[2]) => {
        const result = await supplyAccountServiceHomeMaterial(props.input, material, value);
        setRecoveryView('key');
        setPairingLink(null);
        await props.onResult(result);
    } : undefined;

    const expired = failure?.code.source === 'home' && failure.code.code === 'expired';
    // A declined approval is as legitimately restartable as an expired one: the
    // other device answered, so a fresh attempt is the allowed distinct action.
    const approvalRejected = (failure?.code.source === 'home' && failure.code.code === 'rejected')
        || (failure?.code.source === 'directory' && failure.code.code === 'approval_rejected');
    const restartable = expired || approvalRejected;
    const canRetry = failure?.recovery === 'retry_stage';
    const noHomes = props.result.kind === 'account_connected_no_homes';
    const explicitTargetNotLinked = props.result.kind === 'explicit_target_not_linked';
    const directHomeAuthentication = target && props.onOpenHomeAuthentication
        && (failure?.recovery === 'use_home_auth' || explicitTargetNotLinked)
        ? () => run('direct-home-auth', () => props.onOpenHomeAuthentication!(props.input, target, props.result))
        : null;
    const offersScan = material !== null || noHomes || explicitTargetNotLinked || failure?.recovery === 'use_home_auth';
    // Offering scan means the next press mounts the lazy scanner; load it now so
    // the recovery view slides in instead of flashing a spinner.
    React.useEffect(() => {
        if (offersScan) void loadRestoreScanComputerQrView().catch(() => undefined);
    }, [offersScan]);
    const canOpenEnrolledHome = props.result.kind === 'home_enrolled' && targetProfile?.kind === 'resolved' && !openUnavailable;
    const stopWaiting = async () => {
        const current = getPendingDirectoryHomeEnrollment();
        if (current?.input.session === props.input.session
            && JSON.stringify(current.input.intent) === JSON.stringify(props.input.intent)) {
            await cancelPendingDirectoryHomeEnrollment(current);
        }
        setApprovalStopped(true);
    };
    const relink = async (input = props.input, alreadyConfirmed = false) => {
        const confirmed = alreadyConfirmed || await Modal.confirm(
            t('settingsAccount.accountServiceRelinkConfirmTitle', { accountService: verifiedAccountServiceName }),
            t('settingsAccount.accountServiceRelinkConfirmBody', { accountService: verifiedAccountServiceName }),
            { confirmText: t('common.continue'), cancelText: t('common.cancel') });
        if (confirmed) await props.onResult(await confirmAccountServiceHomeRelink(input));
    };
    const openEnrolledHome = async (signal = props.input.signal): Promise<OpenEnrolledHomeResult> => {
        if (props.result.kind !== 'home_enrolled') return 'cancelled';
        const profile = resolveServerProfileForPortableIdentity(props.result.homeServerIdentityId);
        if (profile.kind !== 'resolved') {
            // The saved profile went away after enrollment: nothing can be
            // opened, so the card stops offering it rather than doing nothing.
            setOpenUnavailable(true);
            return 'cancelled';
        }
        const generation = openHomeGenerationRef.current + 1;
        openHomeGenerationRef.current = generation;
        const isCurrent = () => generation === openHomeGenerationRef.current && signal?.aborted !== true;
        const outcome = await openEnrolledHomeOrReturnToShell({
            profileId: profile.profile.id,
            targetLabel: homeName,
            isCurrent,
            refreshAuth: auth.refreshFromActiveServer,
        });
        if (outcome !== 'opened') return outcome;
        // The authorized focus transition retires its old Account binding.
        // Original input cancellation and actual unmount still withdraw interest.
        if (generation !== openHomeGenerationRef.current || props.input.signal?.aborted) return 'cancelled';
        // An opened Home lands on the shell showing it. A declined retry
        // ('returned_to_shell') keeps this card, so Open and Back stay available.
        resolvePostAuthLanding({ replace: router.replace });
        return 'opened';
    };
    const scanOrPaste: SurfaceStateAction = { label: t('connect.scanExistingHomeQrTitle'), onPress: () => setRecoveryView('scan') };
    const signInToHome: SurfaceStateAction | null = directHomeAuthentication
        ? { label: t('settingsAccount.accountServiceOAuth.notLinked.signInAction', { homeName }), onPress: directHomeAuthentication }
        : null;
    const performStep = async (step: HomeContinuationStep, signal = props.input.signal, alreadyConfirmed = false) => {
        signal?.throwIfAborted();
        const input = signal === props.input.signal ? props.input : { ...props.input, signal };
        if (step.operation === 'choose') {
            const chosen: AccountPostAuthInput = { ...input,
                intent: { kind: 'enter', target: { kind: 'explicit', homeServerIdentityId: step.homeServerIdentityId } } };
            await props.onResult(await completeAccountServicePostAuth(chosen), chosen);
        } else if (step.operation === 'retry') await retry(input);
        else if (step.operation === 'refresh') await props.onResult(await completeAccountServicePostAuth(input));
        else if (step.operation === 'stop_waiting') await stopWaiting();
        else if (step.operation === 'relink') await relink(input, alreadyConfirmed);
        else return await openEnrolledHome(signal);
    };
    const enrichment = React.useMemo((): CurrentUiContextMountedEnrichment | null => {
        const account = mountedAction.binding;
        // Before a Home Account exists there is no requester/answerer authority.
        // The existing human bootstrap and material acquisition remain UI-only.
        if (!hasAuthenticatedHomeAccount || !mountedAction.ready || !account || recoveryView !== 'key') return null;
        const commands: NonNullable<CurrentUiContextMountedEnrichment['commands']>[number][] = [];
        const add = (title: string, step: HomeContinuationStep, description?: string) => {
            const command: CurrentUiContextAccountHomeContinuationCommand = {
                ...step, kind: 'accountHomeContinuation', account,
                invoke: async ({ signal, context }) => {
                    const cancellation = mergeAbortSignals([props.input.signal, signal]);
                    try {
                        const completion: { outcome: OpenEnrolledHomeResult | void } = { outcome: undefined };
                        const completed = await run('account.home_continuation.invoke', async () => {
                            completion.outcome = await performStep(step, cancellation.signal, context.surface !== 'ui');
                        });
                        if (!completed) throw Object.assign(new Error('Continuation is already running or retired'), { code: 'continuation_busy' });
                        if (step.operation === 'open' && completion.outcome !== 'opened') {
                            const code = completion.outcome === 'cancelled' ? 'cancelled' : 'home_open_not_completed';
                            throw Object.assign(new Error(code), { code });
                        }
                        return { status: 'completed' };
                    } finally { cancellation.dispose(); }
                },
            };
            commands.push({ title, ...(description ? { description } : {}), command });
        };
        if (props.result.kind === 'choose_home') {
            for (const home of props.result.homes) add(home.label,
                { operation: 'choose', homeServerIdentityId: home.homeServerIdentityId }, home.canonicalServerUrl);
        }
        if (restartable || noHomes) add(t('common.refresh'), { operation: 'refresh' });
        else if (canRetry) add(t('common.retry'), { operation: 'retry' });
        if (props.result.kind === 'approval_required' && !approvalStopped) add(t('approvals.stopWaiting'), { operation: 'stop_waiting' });
        if (failure?.recovery === 'relink_home') add(t('settingsAccount.accountServiceLinkThisHome'), { operation: 'relink' });
        if (canOpenEnrolledHome) add(t('settingsAccount.accountServiceOAuth.actions.openHome', { homeName }), { operation: 'open' });
        return { entity: { kind: 'account.home_continuation', label: serviceDisplayName }, commands };
    }, [hasAuthenticatedHomeAccount, mountedAction.binding, mountedAction.ready, recoveryView, props.input, props.result, props.onResult,
        auth.refreshFromActiveServer, restartable, noHomes, canRetry, approvalStopped,
        failure?.recovery, canOpenEnrolledHome, homeName, serviceDisplayName]);
    const currentPublication = usePublishCurrentUiContext(enrichment);
    const requestStep = async (step: HomeContinuationStep) => {
        if (!hasAuthenticatedHomeAccount) {
            await run('account-home-bootstrap', () => performStep(step));
            return;
        }
        if (!mountedAction.ready) return;
        const ownedCommand = enrichment?.commands?.find(({ command }) => command.kind === 'accountHomeContinuation'
            && command.operation === step.operation
            && (step.operation !== 'choose' || (command.operation === 'choose' && command.homeServerIdentityId === step.homeServerIdentityId)))?.command;
        if (!ownedCommand) return;
        if (!await currentPublication.activateCurrent(props.input.signal)) return;
        const descriptor = currentContext?.readCurrentUiContext()?.commands.find(({ id }) => {
            const command = currentContext.resolveCurrentUiCommand(id)?.command;
            return command === ownedCommand;
        });
        if (!descriptor) return;
        await mountedAction.execute('account.home_continuation.invoke', { ...step, commandId: descriptor.id }, { signal: props.input.signal });
    };
    const refresh: SurfaceStateAction = { label: t('common.refresh'), onPress: () => requestStep({ operation: 'refresh' }) };
    const backAction: SurfaceStateAction = { label: t('common.back'), onPress: back };

    let content: React.ReactElement;
    if (recoveryView === 'paste') {
        content = <PairingLinkEntryForm onBack={() => setRecoveryView('scan')} onSubmit={async (link) => {
            if (!inspectHomeQrInviteDeepLink(link, target ? { homeServerIdentityId: target, direction: 'trusted_home_displays' } : undefined)) return false;
            setPairingLink(link);
            setRecoveryView('scan');
            return true;
        }} />;
    } else if (recoveryView === 'scan') {
        content = <React.Suspense fallback={<ActivitySpinner />}><RestoreScanComputerQrView embedded
            entryIntent="add_home"
            expectedHomeServerIdentityId={target} initialPairingLink={pairingLink}
            onCredentials={paired} onBack={() => { setPairingLink(null); setRecoveryView('key'); }}
            onAuthenticated={material ? undefined : async (authenticatedHome) => {
                const result = await resumeAccountServicePostAuth(props.input, props.result, authenticatedHome);
                setRecoveryView('key');
                setPairingLink(null);
                await props.onResult(result);
            }}
            onOpenSecretKeyLogin={material ? () => setRecoveryView('key') : undefined}
            onOpenPairingLinkEntry={() => setRecoveryView('paste')} /></React.Suspense>;
    } else if (material) {
        content = <View>
            <SecretKeyEntryForm description={t('welcome.accountKeyDescription', { service: homeName })}
                submitTitle={t('welcome.accountKeySubmit')} onBack={() => { void back(); }}
                secondaryAction={{ label: scanOrPaste.label, onPress: () => { void scanOrPaste.onPress(); } }}
                onSubmit={async ({ secret }) => {
                    const result = await supplyAccountServiceHomeMaterial(props.input, material, secret);
                    await props.onResult(result);
                    return { kind: result.kind === 'home_material_required' ? 'invalid_key' : result.kind === 'failure' ? 'failed' : 'completed' };
                }} />
        </View>;
    } else if (props.result.kind === 'choose_home') {
        content = <View>
            {/*
              * Offline Homes stay eligible (R-DIRECTORY forbids filtering to
              * manufacture a sole choice), so the row itself has to carry the
              * address and the preferred hint — otherwise identically labelled
              * Homes are indistinguishable and the user picks blind.
              */}
            <ActionListSection actions={props.result.homes.map((home) => ({
                id: home.homeServerIdentityId,
                testID: `account-service-choose-home-${home.homeServerIdentityId}`,
                label: home.label,
                subtitle: home.preferred
                    ? `${home.canonicalServerUrl} · ${t('settingsAccount.accountServicePreferredHome')}`
                    : home.canonicalServerUrl,
                disabled: busy || admission.pendingActionId !== null || (hasAuthenticatedHomeAccount && !mountedAction.ready),
                onPress: () => requestStep({ operation: 'choose', homeServerIdentityId: home.homeServerIdentityId }),
            }))} />
            <RoundButton title={t('common.back')} display="secondary" onPress={back} />
        </View>;
    } else if (props.result.kind === 'approval_required' && approvalStopped) {
        // Stopping the wait is not the same as leaving: the Account sign-in survives
        // it, and the user cannot tell that from an immediate dismissal.
        content = <SurfaceStateCard testID="account-service-approval-stopped" kind="warning"
            title={t('settingsAccount.accountServiceOAuth.approvalWait.cancelledTitle')}
            reason={t('settingsAccount.accountServiceOAuth.approvalWait.cancelledBody')}
            accessibilitySemantics="status"
            action={{ label: t('common.back'), onPress: props.onBack }} />;
    } else {
        // One card, one obvious primary: every alternative is the card's own
        // secondary action, never a heavier bare button beneath it.
        const [action, secondaryAction]: readonly [SurfaceStateAction, SurfaceStateAction?] = retainedProfile
            ? [{ label: t('connect.retryRetainedHome', { home: homeName }), onPress: () => run('retry-retained-home', async () => {
                const result = await resumePendingDirectoryHomeEnrollment(retainedProfile);
                if (result) await props.onResult(result);
            }) }, backAction]
            : restartable ? [{ label: t('settingsAccount.accountServiceOAuth.actions.startAgain'), onPress: refresh.onPress }]
            : canRetry ? [{ label: t('common.retry'), onPress: () => requestStep({ operation: 'retry' }) }]
            : failure?.recovery === 'reauthenticate_account' && props.onReauthenticate
                ? [{ label: t('common.continue'), onPress: () => run('reauthenticate', () => props.onReauthenticate!(props.input)) }]
            : failure?.recovery === 'relink_home' ? [{ label: t('settingsAccount.accountServiceLinkThisHome'), onPress: () => requestStep({ operation: 'relink' }) }]
            : failure?.recovery === 'use_home_auth' ? (signInToHome ? [signInToHome, scanOrPaste] : [scanOrPaste])
            : props.result.kind === 'approval_required' ? [{ label: t('approvals.stopWaiting'), onPress: () => requestStep({ operation: 'stop_waiting' }) }]
            : canOpenEnrolledHome
                ? [{ label: t('settingsAccount.accountServiceOAuth.actions.openHome', { homeName }), onPress: () => requestStep({ operation: 'open' }) }, backAction]
            : successful ? [{ label: t('common.done'), onPress: back }]
            : noHomes ? [refresh, scanOrPaste]
            : explicitTargetNotLinked ? (signInToHome ? [signInToHome, scanOrPaste] : [scanOrPaste])
            : [backAction];
        content = <View><SurfaceStateCard testID={`account-service-continuation-${props.result.kind}`}
            kind={failure ? 'error' : successful ? 'success' : 'warning'}
            iconName={explicitTargetNotLinked && props.input.signInProvider
                ? oauthProviderIconName(props.input.signInProvider.id, props.input.signInProvider.presentation)
                : undefined}
            title={props.result.kind === 'approval_required' ? t('settingsAccount.accountServiceOAuth.stages.waitingApproval')
                : props.result.kind === 'account_connected'
                    ? t('settingsAccount.accountServiceSignedInTo', { accountService: serviceDisplayName })
                    : successful ? t('settingsAccount.accountServiceOAuth.success.title', { homeName })
                    : noHomes ? t('settingsAccount.accountServiceSignedInTo', { accountService: serviceDisplayName })
                        : explicitTargetNotLinked ? t('settingsAccount.accountServiceOAuth.notLinked.title', { homeName })
                        : failurePresentation ? failurePresentation.title : t('common.error')}
            reason={describeAccountPostAuthResultReason(props.result, { signInToHome: signInToHome !== null, homeName })}
            {...(props.result.kind === 'approval_required'
                ? { detail: `${homeName} · ${formatEnrollmentExpiry(props.result.expiresAtMs)}` }
                : {})}
            accessibilitySemantics={failure ? 'alert' : 'status'}
            action={action}
            {...(secondaryAction ? { secondaryAction } : {})} />
        </View>;
    }
    if (!auth.isAuthenticated) return <StepMotionLayer layerKey="account-recovery" stepKey={recoveryView}>{content}</StepMotionLayer>;
    return <StepTransitionFrame transitionKey={recoveryView} direction={recovery.direction}>{content}</StepTransitionFrame>;
}
