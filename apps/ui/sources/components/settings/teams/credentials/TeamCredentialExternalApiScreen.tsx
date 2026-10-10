import * as React from 'react';
import { useNavigation } from '@/components/appShell/workspace/destinationRoute';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import {
    type TeamCredentialExternalApiKeySummaryV1,
} from '@happier-dev/protocol/teams';

import { useTemporaryCopyFeedback } from '@/components/ui/copy/useTemporaryCopyFeedback';
import {
    resolveApiTokenExpiryInstant,
    type ApiTokenExpiryPreset,
} from '@/components/settings/apiTokens/apiTokenSettingsController';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { SectionButtonRow } from '@/components/ui/lists/SectionButtonRow';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { useTeamMembersRoster } from '@/hooks/teams/useTeamMembersRoster';
import { Modal } from '@/modal';
import { formatAccountDisplayName } from '@/sync/domains/account/formatAccountDisplayName';
import { isTeamActionApprovalPendingError } from '@/sync/ops/teams/teamActionClient';
import {
    authorizeTeamCredentialExternalApiKey,
    createTeamCredentialExternalApiKey,
    listTeamCredentialExternalApiKeys,
    revokeAllTeamCredentialExternalApiKeys,
    revokeTeamCredentialExternalApiKey,
} from '@/sync/ops/teams/teamCredentialOperations';
import { t, type TranslationKey } from '@/text';
import { setClipboardStringSafe } from '@/utils/ui/clipboard';
import { useUnsavedChangesBeforeRemoveGuard } from '@/utils/navigation/useUnsavedChangesBeforeRemoveGuard';
import {
    runUnsavedChangesGuard,
    type ActiveUnsavedChangesGuard,
} from '@/utils/navigation/runGuardedNavigation';

import { TeamSection } from '../TeamSection';
import type { TeamSectionContext } from '../teamSectionContext';
import { teamCredentialExternalApiPath } from '../teamsRoutes';
import { credentialApprovalFailureMessage, credentialFailureMessage } from './teamCredentialPresentation';
import { useTeamCredentialResourceView } from './useTeamCredentialResourceView';
import { useTeamCredentialExternalApiAvailability } from './useTeamCredentialExternalApiAvailability';
import { TeamCredentialAudiencePicker } from './TeamCredentialAudiencePicker';

const KEY_LABEL_MAX_LENGTH = 120;
const EXPIRY_PRESETS: readonly ApiTokenExpiryPreset[] = ['30d', '90d', '1y', 'none'];
const EXPIRY_LABELS = {
    '30d': 'settingsApiTokens.create.expiryOptions.30d',
    '90d': 'settingsApiTokens.create.expiryOptions.90d',
    '1y': 'settingsApiTokens.create.expiryOptions.1y',
    none: 'settingsApiTokens.create.expiryOptions.none',
} satisfies Record<ApiTokenExpiryPreset, TranslationKey>;

type Reveal = Readonly<{ token: string; replacedKey: TeamCredentialExternalApiKeySummaryV1 | null }>;

/**
 * When a key was last used and when it stops working.
 *
 * Expiry is a fact about the key rather than a state the Home moves it through:
 * an expired key stays listed so its owner can see which tool broke and replace
 * it deliberately, instead of watching a row disappear.
 */
function keyStatusLine(key: TeamCredentialExternalApiKeySummaryV1, now: number): string {
    const parts: string[] = [];
    if (key.authenticationStatus === 'authentication_required') {
        parts.push(t('teams.credentials.externalApi.authenticationRequired'));
    } else if (key.authenticationStatus === 'unavailable') {
        parts.push(t('teams.credentials.externalApi.authenticationUnavailable'));
    }
    const used = key.lastUsedAt === null ? null : Date.parse(key.lastUsedAt);
    parts.push(used === null || Number.isNaN(used)
        ? t('teams.credentials.externalApi.neverUsed')
        : t('teams.credentials.externalApi.lastUsed', { when: formatInstant(used) }));
    const expires = key.expiresAt === null ? null : Date.parse(key.expiresAt);
    if (expires !== null && !Number.isNaN(expires)) {
        parts.push(expires <= now
            ? t('teams.credentials.externalApi.expired')
            : t('teams.credentials.externalApi.expiresOn', { when: formatInstant(expires) }));
    }
    return parts.join(' · ');
}

function formatInstant(at: number): string {
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(at));
}

const ExternalApiContent = React.memo(function ExternalApiContent(props: Readonly<{
    context: TeamSectionContext;
    resourceId: string;
}>) {
    const { context, resourceId } = props;
    const view = useTeamCredentialResourceView({ context, resourceId });
    const canReadKeys = view.canManage || view.catalogResource?.mayBroker === true;
    const availability = useTeamCredentialExternalApiAvailability(context.scope.serverId);
    const roster = useTeamMembersRoster({
        scope: context.scope,
        address: context.address,
        filter: 'all',
        enabled: availability.available && view.canManage,
    });
    const [keys, setKeys] = React.useState<readonly TeamCredentialExternalApiKeySummaryV1[]>([]);
    const [resolved, setResolved] = React.useState(false);
    const [listError, setListError] = React.useState(false);
    const [listing, setListing] = React.useState(false);
    const [busy, setBusy] = React.useState(false);
    const [label, setLabel] = React.useState('');
    const [membershipId, setMembershipId] = React.useState<string | null>(null);
    const [membershipName, setMembershipName] = React.useState<string | null>(null);
    const [expiry, setExpiry] = React.useState<ApiTokenExpiryPreset>('none');
    const [replacing, setReplacing] = React.useState<TeamCredentialExternalApiKeySummaryV1 | null>(null);
    const [reveal, setReveal] = React.useState<Reveal | null>(null);
    const [secretCopied, setSecretCopied] = React.useState(false);
    const copyFeedback = useTemporaryCopyFeedback(1_500);
    const [notice, setNotice] = React.useState<string | null>(null);
    const navigation = useNavigation();
    const router = useRouter();
    const replaceRoute = router.replace;
    // This route can be reused while its qualified Home/resource parameters
    // change. Keep the identity current during render so an older Home's
    // response cannot paint keys (or a one-time bearer) into the new target.
    const targetKey = `${context.scope.serverId}:${context.scope.accountId}:${context.address.teamId}:${resourceId}`;
    const targetPath = teamCredentialExternalApiPath(context.address, resourceId);
    const currentTargetKey = React.useRef(targetKey);
    const acceptedTarget = React.useRef({
        key: targetKey,
        path: targetPath,
    });
    const listingTargetKey = React.useRef<string | null>(null);
    // The accepted target whose key list has already been requested by the
    // screen itself. Accepting a target and the view becoming manageable both
    // ask for the first read; this makes them one read. Explicit retry and
    // outcome-unknown recovery call `reload` directly and are not affected.
    const initialListTargetKey = React.useRef<string | null>(null);
    const reloadAcceptedTarget = React.useRef<() => void>(() => {});
    const revealWouldBeLost = reveal !== null && !secretCopied;
    const revealWouldBeLostRef = React.useRef(revealWouldBeLost);
    revealWouldBeLostRef.current = revealWouldBeLost;

    const requestRevealLossDecision = React.useCallback(async () => {
        const confirmed = await Modal.confirm(
            t('teams.credentials.externalApi.revealDismiss.title'),
            t('teams.credentials.externalApi.revealDismiss.body'),
            {
                cancelText: t('teams.credentials.externalApi.revealDismiss.keepVisible'),
                confirmText: t('teams.credentials.externalApi.revealDismiss.confirm'),
            },
        );
        return confirmed ? 'discard' as const : 'keepEditing' as const;
    }, []);
    const revealLossGuard = React.useMemo<ActiveUnsavedChangesGuard>(() => ({
        isDirtyRef: revealWouldBeLostRef,
        requestDecision: requestRevealLossDecision,
        tag: 'TeamCredentialExternalApiScreen.reveal.beforeRemove',
    }), [requestRevealLossDecision]);
    const continuePreventedNavigation = React.useCallback((action: unknown) => {
        if (!action) return;
        (navigation as { dispatch?: (value: unknown) => void }).dispatch?.(action);
    }, [navigation]);

    useUnsavedChangesBeforeRemoveGuard({
        isDirty: revealWouldBeLost,
        isDirtyRef: revealWouldBeLostRef,
        requestDecision: requestRevealLossDecision,
        onContinue: continuePreventedNavigation,
        tag: revealLossGuard.tag,
    });

    React.useEffect(() => {
        // Native-stack swipe dismissal can bypass beforeRemove on some platform
        // versions. While the only clear bearer has not been copied, keep exits
        // on the guarded header/system navigation path.
        (navigation as { setOptions?: (options: { gestureEnabled: boolean }) => void })
            .setOptions?.({ gestureEnabled: !revealWouldBeLost });
    }, [navigation, revealWouldBeLost]);

    React.useEffect(() => () => {
        (navigation as { setOptions?: (options: { gestureEnabled: boolean }) => void })
            .setOptions?.({ gestureEnabled: true });
    }, [navigation]);

    React.useEffect(() => {
        if (acceptedTarget.current.key === targetKey) return;

        const previousPath = acceptedTarget.current.path;
        const nextTarget = {
            key: targetKey,
            path: targetPath,
        };
        let active = true;
        void Promise.resolve(runUnsavedChangesGuard(revealLossGuard, () => {
            if (!active) return;
            acceptedTarget.current = nextTarget;
            currentTargetKey.current = nextTarget.key;
            setKeys([]);
            setResolved(false);
            setListError(false);
            setListing(false);
            listingTargetKey.current = null;
            setBusy(false);
            setLabel('');
            setMembershipId(null);
            setMembershipName(null);
            setExpiry('none');
            setReplacing(null);
            setReveal(null);
            setSecretCopied(false);
            copyFeedback.clearCopiedFeedback();
            setNotice(null);
            initialListTargetKey.current = nextTarget.key;
            reloadAcceptedTarget.current();
        })).then((continued) => {
            if (active && !continued) replaceRoute(previousPath);
        });
        return () => {
            active = false;
        };
    }, [copyFeedback.clearCopiedFeedback, replaceRoute, revealLossGuard, targetKey, targetPath]);

    const reload = React.useCallback(async () => {
        const requestedTargetKey = targetKey;
        // A same-mounted route replacement is not authoritative until the
        // one-time-reveal guard accepts it. Do not read the next resource early;
        // the acceptance continuation below starts its one canonical reload.
        if (acceptedTarget.current.key !== requestedTargetKey) return;
        if (listingTargetKey.current === requestedTargetKey) return;
        listingTargetKey.current = requestedTargetKey;
        setListing(true);
        try {
            const outcome = await listTeamCredentialExternalApiKeys({ scope: context.scope, resourceId });
            if (currentTargetKey.current !== requestedTargetKey) return;
            setResolved(true);
            if (outcome.kind === 'succeeded') {
                setKeys(outcome.value.keys);
                setListError(false);
                setNotice(null);
            } else {
                setListError(true);
                setNotice(t('teams.credentials.externalApi.keysLoadFailed'));
            }
        } finally {
            if (listingTargetKey.current === requestedTargetKey) listingTargetKey.current = null;
            if (currentTargetKey.current === requestedTargetKey) setListing(false);
        }
    }, [context.scope, resourceId, targetKey]);
    reloadAcceptedTarget.current = () => void reload();
    const applyMutationFailure = React.useCallback((failure: Parameters<typeof credentialFailureMessage>[0]) => {
        setNotice(credentialFailureMessage(failure));
        if (failure.kind === 'outcome_unknown') void reload();
    }, [reload]);

    React.useEffect(() => {
        if (!availability.available || !canReadKeys) return;
        if (acceptedTarget.current.key !== targetKey || initialListTargetKey.current === targetKey) return;
        initialListTargetKey.current = targetKey;
        void reload();
    }, [availability.available, canReadKeys, reload, targetKey]);

    const clearReveal = React.useCallback(() => {
        if (!reveal) return;
        setReveal(null);
        setSecretCopied(false);
        copyFeedback.clearCopiedFeedback();
    }, [copyFeedback.clearCopiedFeedback, reveal]);

    const closeReveal = React.useCallback(() => {
        void runUnsavedChangesGuard(revealLossGuard, clearReveal);
    }, [clearReveal, revealLossGuard]);

    if (!view.featureEnabled) {
        return (
            <ItemGroup description={t('teams.credentials.externalApi.unavailable')}>
                <Item
                    testID="team-credential-external-unavailable"
                    title={t('teams.credentials.externalApi.title')}
                    showChevron={false}
                />
            </ItemGroup>
        );
    }
    if (view.resolved && !canReadKeys) {
        return (
            <ItemGroup description={view.resource ? t('teams.credentials.forbidden') : t('teams.credentials.detail.notFound')}>
                <Item testID="team-credential-external-forbidden" title={t('teams.denied.title')} showChevron={false} />
            </ItemGroup>
        );
    }
    if (view.resource === null && view.catalogResource === null) {
        return (
            <ItemGroup description={view.error ? credentialFailureMessage(view.error) : undefined}>
                <Item
                    testID={view.error
                        ? 'team-credential-external-resource-retry'
                        : 'team-credential-external-loading'}
                    title={view.error ? t('teams.unavailable.retry') : t('common.loading')}
                    loading={!view.error}
                    onPress={view.error ? () => void view.reload() : undefined}
                    showChevron={false}
                />
            </ItemGroup>
        );
    }
    if (!availability.available) {
        const unavailable = availability.reason === 'home_not_public_https'
            ? t('teams.credentials.externalApi.publicHttpsRequired')
            : t('teams.credentials.externalApi.unavailable');
        return (
            <ItemGroup description={unavailable}>
                <Item
                    testID="team-credential-external-unavailable"
                    title={t('teams.credentials.externalApi.title')}
                    showChevron={false}
                />
            </ItemGroup>
        );
    }
    const { baseUrl, protocols } = availability;

    const now = Date.now();
    const trimmedLabel = label.trim();
    // Local dispatch and the shell-owned approval are one continuous mutation
    // lifecycle. The local request finishes once the approval Artifact exists,
    // but the draft and all competing controls stay suspended until that
    // Artifact executes or settles terminally.
    const operationBusy = busy || context.approvalPending || listing;
    // Creating or replacing a key is safe only after the Home has supplied a
    // trustworthy key snapshot. An initial read failure is not an empty list,
    // and a failed refresh must not enable a duplicate while currentness is
    // unknown. Previously acknowledged rows remain visible below for recovery.
    const keyListTrusted = resolved && !listError;
    const memberNames = new Map(roster.rows.map((member) => [member.id, formatAccountDisplayName(member.account)]));

    async function authorizeKey(key: TeamCredentialExternalApiKeySummaryV1) {
        if (operationBusy || !key.canAuthorize) return;
        const requestedTargetKey = targetKey;
        const applyAuthorizedKey = (value: Readonly<{ key: TeamCredentialExternalApiKeySummaryV1 }>) => {
            if (currentTargetKey.current !== requestedTargetKey) return;
            setKeys((current) => current.map((entry) => entry.keyId === value.key.keyId ? value.key : entry));
        };
        setBusy(true);
        setNotice(null);
        try {
            const outcome = await authorizeTeamCredentialExternalApiKey({
                scope: context.scope, resourceId, keyId: key.keyId,
                handlers: {
                    onApprovalSucceeded: applyAuthorizedKey,
                    onApprovalFailed: (code) => {
                        if (currentTargetKey.current === requestedTargetKey) setNotice(credentialApprovalFailureMessage(code));
                    },
                },
            });
            if (currentTargetKey.current !== requestedTargetKey) return;
            if (outcome.kind === 'succeeded') applyAuthorizedKey(outcome.value);
            else applyMutationFailure(outcome.failure);
        } catch (cause) {
            if (currentTargetKey.current !== requestedTargetKey) return;
            if (isTeamActionApprovalPendingError(cause)) context.requestApproval(cause.registration);
            else setNotice(t('teams.errors.generic'));
        } finally {
            if (currentTargetKey.current === requestedTargetKey) setBusy(false);
        }
    }

    async function revokeKey(key: TeamCredentialExternalApiKeySummaryV1, requireConfirmation = true) {
        if (operationBusy) return;
        if (requireConfirmation) {
            const confirmed = await Modal.confirm(
                t('teams.credentials.externalApi.revokeTitle', { name: key.label }),
                t('teams.credentials.externalApi.revokeBody'),
                { confirmText: t('common.remove'), destructive: true },
            );
            if (!confirmed) return;
        }
        const requestedTargetKey = targetKey;
        setBusy(true);
        setNotice(null);
        try {
            const outcome = await revokeTeamCredentialExternalApiKey({
                scope: context.scope, resourceId, keyId: key.keyId, confirmedByPresentUser: true,
                handlers: {
                    onApprovalSucceeded: (value) => {
                        if (currentTargetKey.current !== requestedTargetKey) return;
                        if (value.revoked) {
                            setKeys((current) => current.filter((entry) => entry.keyId !== value.keyId));
                            setReveal((current) => current?.replacedKey?.keyId === value.keyId
                                ? { ...current, replacedKey: null }
                                : current);
                        }
                    },
                    onApprovalFailed: (code) => {
                        if (currentTargetKey.current !== requestedTargetKey) return;
                        setNotice(credentialApprovalFailureMessage(code));
                    },
                },
            });
            if (currentTargetKey.current !== requestedTargetKey) return;
            if (outcome.kind === 'succeeded') {
                setKeys((current) => current.filter((entry) => entry.keyId !== key.keyId));
                setReveal((current) => current?.replacedKey?.keyId === key.keyId
                    ? { ...current, replacedKey: null }
                    : current);
            } else applyMutationFailure(outcome.failure);
        } catch (cause) {
            if (currentTargetKey.current !== requestedTargetKey) return;
            if (isTeamActionApprovalPendingError(cause)) context.requestApproval(cause.registration);
            else setNotice(t('teams.errors.generic'));
        } finally {
            if (currentTargetKey.current === requestedTargetKey) setBusy(false);
        }
    }

    const revealValues = reveal === null ? [] : [
        { id: 'base-url', title: t('settingsProviders.authoring.baseUrl'), value: baseUrl, secret: false },
        { id: 'token', title: t('settingsProviders.authoring.apiKey'), value: reveal.token, secret: true },
        { id: 'environment', title: t('profiles.environmentVariables.title'), value: `HAPPIER_API_BASE_URL=${baseUrl}\nHAPPIER_API_KEY=${reveal.token}`, secret: true },
        ...(protocols.some((protocol) => protocol === 'openai_responses' || protocol === 'openai_chat_completions')
            ? [{ id: 'openai', title: t('teams.credentials.requestPolicy.protocol.openaiResponses'), value: `OPENAI_BASE_URL=${baseUrl}\nOPENAI_API_KEY=$HAPPIER_API_KEY`, secret: false }]
            : []),
        ...(protocols.includes('anthropic_messages')
            ? [{ id: 'anthropic', title: t('teams.credentials.requestPolicy.protocol.anthropicMessages'), value: `ANTHROPIC_BASE_URL=${baseUrl}\nANTHROPIC_API_KEY=$HAPPIER_API_KEY`, secret: false }]
            : []),
    ] as const;

    /** The one-time bearer and copy-only setup projections derived from it. */
    const revealGroup = reveal === null ? null : (
        <ItemGroup
            title={t('teams.credentials.externalApi.revealTitle')}
            description={t('teams.credentials.externalApi.revealBody')}
        >
            {revealValues.map((item) => (
                <Item
                    key={item.id}
                    testID={`team-credential-external-value:${item.id}`}
                    title={item.title}
                    subtitle={item.value}
                    detail={copyFeedback.isCopied(item.id) ? t('common.copied') : t('common.copy')}
                    accessibilityLabel={`${item.title}, ${copyFeedback.isCopied(item.id) ? t('common.copied') : t('common.copy')}`}
                    onPress={async () => {
                        const ok = await setClipboardStringSafe(item.value);
                        if (!ok) {
                            await Modal.alertAsync(t('common.error'), t('items.failedToCopyToClipboard'));
                            return;
                        }
                        copyFeedback.markCopied(item.id);
                        if (item.secret) setSecretCopied(true);
                    }}
                    showChevron={false}
                />
            ))}
            {reveal.replacedKey ? (
                <Item
                    testID="team-credential-external-replace-revoke-old"
                    title={t('teams.credentials.externalApi.revokeTitle', { name: reveal.replacedKey.label })}
                    detail={t('common.remove')}
                    destructive
                    disabled={operationBusy}
                    onPress={() => void revokeKey(reveal.replacedKey!, false)}
                    showChevron={false}
                />
            ) : null}
            <Item
                testID="team-credential-external-reveal-done"
                title={t('common.done')}
                onPress={closeReveal}
                showChevron={false}
            />
        </ItemGroup>
    );

    return (
        <>
            <ItemGroup description={t('teams.credentials.externalApi.subtitle')}>
                <Item
                    testID="team-credential-external-private"
                    title={t('teams.credentials.externalApi.privateTitle')}
                    detail={t('teams.credentials.externalApi.privateDetail')}
                    showChevron={false}
                />
                <Item
                    testID="team-credential-external-home-disclosure"
                    title={t('teams.credentials.externalApi.homeDisclosure')}
                    showChevron={false}
                />
                <Item
                    testID="team-credential-external-bearer-disclosure"
                    title={t('teams.credentials.externalApi.bearerDisclosure')}
                    showChevron={false}
                />
                <Item
                    testID="team-credential-external-usage-disclosure"
                    title={t('teams.credentials.externalApi.usageDisclosure')}
                    showChevron={false}
                />
            </ItemGroup>

            {revealGroup}

            {view.canManage ? <ItemGroup title={t('common.create')} description={notice ?? undefined}>
                {/*
                  * Replace stages a target that changes what the next Create does:
                  * it offers to revoke that exact key afterwards. Staging it
                  * invisibly meant a user who changed their mind had no way to see
                  * or undo it, so the next key they created came with a revoke
                  * prompt for a key they never meant to touch.
                  */}
                {replacing ? (
                    <Item
                        testID="team-credential-external-replace-staged"
                        title={t('secrets.actions.replace')}
                        subtitle={replacing.label}
                        detail={t('common.cancel')}
                        accessibilityLabel={[
                            t('secrets.actions.replace'),
                            replacing.label,
                            t('common.cancel'),
                        ].join(', ')}
                        disabled={operationBusy}
                        onPress={() => setReplacing(null)}
                        showChevron={false}
                    />
                ) : null}
                <SectionContentRow>
                    <FieldTextInput
                        testID="team-credential-external-label"
                        value={label}
                        onChangeText={setLabel}
                        placeholder={t('teams.credentials.externalApi.labelPlaceholder')}
                        accessibilityLabel={t('teams.credentials.externalApi.labelPlaceholder')}
                        editable={!operationBusy && keyListTrusted}
                        maxLength={KEY_LABEL_MAX_LENGTH}
                        autoCapitalize="sentences"
                    />
                </SectionContentRow>
                {membershipId ? (
                    <Item
                        testID={`team-credential-external-member:${membershipId}`}
                        title={membershipName ?? memberNames.get(membershipId) ?? t('teams.credentials.limits.unknownSubject')}
                        accessibilityLabel={[
                            t('teams.credentials.externalApi.assignLabel'),
                            membershipName ?? memberNames.get(membershipId) ?? t('teams.credentials.limits.unknownSubject'),
                        ].join(', ')}
                        selected
                        disabled={operationBusy || !keyListTrusted}
                        onPress={() => {
                            setMembershipId(null);
                            setMembershipName(null);
                        }}
                        showChevron={false}
                    />
                ) : null}
                <TeamCredentialAudiencePicker
                    scope={context.scope}
                    address={context.address}
                    excludedGroupIds={[]}
                    excludedMemberIds={[]}
                    allowedKinds={['member']}
                    label={t('teams.credentials.externalApi.assignLabel')}
                    disabled={operationBusy || !keyListTrusted}
                    onChoose={(principal) => {
                        if (principal.kind !== 'member') return;
                        setMembershipId(principal.id);
                        setMembershipName(principal.name);
                    }}
                    testID="team-credential-external-assignee"
                />
                {EXPIRY_PRESETS.map((preset) => (
                    <Item
                        key={preset}
                        testID={`team-credential-external-expiry:${preset}`}
                        title={t(EXPIRY_LABELS[preset])}
                        selected={expiry === preset}
                        disabled={operationBusy}
                        onPress={() => setExpiry(preset)}
                        showChevron={false}
                    />
                ))}
                <Item
                    testID="team-credential-external-create"
                    title={t('common.create')}
                    loading={operationBusy}
                    disabled={operationBusy || !keyListTrusted || !membershipId || trimmedLabel.length === 0}
                    onPress={async () => {
                        if (!membershipId || trimmedLabel.length === 0 || operationBusy || !keyListTrusted) return;
                        // A new creation replaces the open reveal, and that
                        // reveal is the only copy of its bearer: ask the same
                        // one reveal-loss question leaving the screen asks.
                        if (!await runUnsavedChangesGuard(revealLossGuard, clearReveal)) return;
                        const requestedTargetKey = targetKey;
                        setBusy(true); setNotice(null);
                        try {
                            const outcome = await createTeamCredentialExternalApiKey({
                                scope: context.scope, resourceId, teamMembershipId: membershipId, label: trimmedLabel,
                                expiresAt: resolveApiTokenExpiryInstant(expiry, Date.now()),
                                handlers: {
                                    // Creation's answer is the only copy of the
                                    // clear bearer. The approved execution must
                                    // flow through this exact mounted request;
                                    // a refresh can recover metadata, never the
                                    // one-time token.
                                    onApprovalSucceeded: (value) => {
                                        if (currentTargetKey.current !== requestedTargetKey) return;
                                        setKeys((current) => [
                                            value.key,
                                            ...current.filter((key) => key.keyId !== value.key.keyId),
                                        ]);
                                        setReveal({ token: value.token, replacedKey: replacing });
                                        setSecretCopied(false);
                                        setLabel('');
                                        setReplacing(null);
                                    },
                                    onApprovalFailed: (code) => {
                                        if (currentTargetKey.current !== requestedTargetKey) return;
                                        setNotice(credentialApprovalFailureMessage(code));
                                    },
                                },
                            });
                            if (currentTargetKey.current !== requestedTargetKey) return;
                            if (outcome.kind === 'succeeded') {
                                setKeys((current) => [
                                    outcome.value.key,
                                    ...current.filter((key) => key.keyId !== outcome.value.key.keyId),
                                ]);
                                setReveal({ token: outcome.value.token, replacedKey: replacing });
                                setSecretCopied(false);
                                setLabel('');
                                setReplacing(null);
                            } else applyMutationFailure(outcome.failure);
                        } catch (cause) {
                            if (currentTargetKey.current !== requestedTargetKey) return;
                            if (isTeamActionApprovalPendingError(cause)) context.requestApproval(cause.registration);
                            else setNotice(t('teams.errors.generic'));
                        } finally {
                            if (currentTargetKey.current === requestedTargetKey) setBusy(false);
                        }
                    }}
                    showChevron={false}
                />
            </ItemGroup>

            : null}

            <ItemGroup
                title={t('teams.credentials.externalApi.keysTitle')}
                description={!view.canManage && notice ? notice : view.canManage && keyListTrusted && keys.length === 0
                    ? t('teams.credentials.externalApi.keysEmptyBody')
                    : undefined}
            >
                {!resolved ? <Item testID="team-credential-external-loading" title={t('common.loading')} loading showChevron={false} /> : null}
                {keyListTrusted && keys.length === 0 ? (
                    <Item
                        testID="team-credential-external-empty"
                        title={t('teams.credentials.externalApi.keysEmpty')}
                        showChevron={false}
                    />
                ) : null}
                {keys.map((key) => (
                    <Item
                        key={key.keyId}
                        testID={`team-credential-external-key:${key.keyId}`}
                        title={key.label}
                        // The safe prefix is the only part of a key that may be
                        // shown again; it is enough to tell two keys apart.
                        subtitle={`${key.displayPrefix} · ${keyStatusLine(key, now)}`}
                        detail={view.canManage ? `${t('teams.credentials.externalApi.assignLabel')} ${memberNames.get(key.teamMembershipId) ?? t('teams.credentials.limits.unknownSubject')}` : undefined}
                        accessibilityLabel={[key.label, keyStatusLine(key, now), ...(view.canManage ? [memberNames.get(key.teamMembershipId) ?? t('teams.credentials.limits.unknownSubject')] : [])].join(', ')}
                        disabled={operationBusy}
                        showChevron={false}
                    />
                ))}
                {keys.filter((key) => key.canAuthorize && key.authenticationStatus === 'authentication_required').map((key) => (
                    <Item
                        key={`authorize:${key.keyId}`}
                        testID={`team-credential-external-authorize:${key.keyId}`}
                        title={t('teams.credentials.externalApi.authorize')}
                        subtitle={key.label}
                        disabled={operationBusy || !keyListTrusted || !context.canMutate}
                        onPress={() => void authorizeKey(key)}
                        showChevron={false}
                    />
                ))}
                {view.canManage ? keys.flatMap((key) => [
                    <Item
                        key={`replace:${key.keyId}`}
                        testID={`team-credential-external-replace:${key.keyId}`}
                        title={t('secrets.actions.replace')}
                        disabled={operationBusy}
                        onPress={() => {
                            setReplacing(key);
                            setLabel(key.label);
                            setMembershipId(key.teamMembershipId);
                            setMembershipName(memberNames.get(key.teamMembershipId) ?? null);
                        }}
                        showChevron={false}
                    />,
                    <Item
                        key={`revoke:${key.keyId}`}
                        testID={`team-credential-external-revoke:${key.keyId}`}
                        title={t('common.remove')}
                        destructive
                        disabled={operationBusy}
                        onPress={() => void revokeKey(key)}
                        showChevron={false}
                    />,
                ]) : null}
                {listError ? <Item
                    testID="team-credential-external-retry"
                    title={t('teams.credentials.externalApi.keysRetry')}
                    loading={listing}
                    disabled={listing}
                    onPress={listing ? undefined : () => void reload()}
                    showChevron={false}
                /> : null}
            </ItemGroup>

            {view.resource !== null && view.error ? (
                <ItemGroup description={credentialFailureMessage(view.error)}>
                    <Item
                        testID="team-credential-external-resource-retry"
                        title={t('teams.unavailable.retry')}
                        onPress={() => void view.reload()}
                        showChevron={false}
                    />
                </ItemGroup>
            ) : null}

            {view.canManage && keys.length > 0 ? (
                // Revoking every key turns external access off: the page's closing quiet button row.
                <ItemGroup surface="none">
                    <SectionButtonRow>
                    <RoundButton
                        testID="team-credential-external-revoke-all"
                        size="small"
                        display="destructive"
                        title={t('teams.credentials.externalApi.revokeAll')}
                        loading={operationBusy}
                        disabled={operationBusy}
                        onPress={async () => {
                            if (operationBusy) return;
                            // Revoking the last key is what turns external access
                            // off, so the consequence names that rather than
                            // counting rows.
                            const confirmed = await Modal.confirm(
                                t('teams.credentials.externalApi.revokeAll'),
                                t('teams.credentials.externalApi.revokeAllBody'),
                                { confirmText: t('common.remove'), destructive: true },
                            );
                            if (!confirmed) return;
                            const requestedTargetKey = targetKey;
                            setBusy(true); setNotice(null);
                            try {
                                const outcome = await revokeAllTeamCredentialExternalApiKeys({
                                    scope: context.scope, resourceId, confirmedByPresentUser: true,
                                    handlers: {
                                        onApprovalSucceeded: (value) => {
                                            if (currentTargetKey.current !== requestedTargetKey) return;
                                            if (value.resourceId === resourceId) setKeys([]);
                                        },
                                        onApprovalFailed: (code) => {
                                            if (currentTargetKey.current !== requestedTargetKey) return;
                                            setNotice(credentialApprovalFailureMessage(code));
                                        },
                                    },
                                });
                                if (currentTargetKey.current !== requestedTargetKey) return;
                                if (outcome.kind === 'succeeded') setKeys([]);
                                else applyMutationFailure(outcome.failure);
                            } catch (cause) {
                                if (currentTargetKey.current !== requestedTargetKey) return;
                                if (isTeamActionApprovalPendingError(cause)) context.requestApproval(cause.registration);
                                else setNotice(t('teams.errors.generic'));
                            } finally {
                                if (currentTargetKey.current === requestedTargetKey) setBusy(false);
                            }
                        }}
                    />
                    </SectionButtonRow>
                </ItemGroup>
            ) : null}
        </>
    );
});

export const TeamCredentialExternalApiScreen = React.memo(function TeamCredentialExternalApiScreen(props: Readonly<{
    serverId: string; teamId: string; resourceId: string;
}>) {
    return <TeamSection serverId={props.serverId} teamId={props.teamId} title={t('teams.credentials.externalApi.title')} description={t('teams.pages.credentialExternalApi')}>
        {(context) => <ExternalApiContent context={context} resourceId={props.resourceId} />}
    </TeamSection>;
});
