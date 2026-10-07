import * as React from 'react';
import { parseSavedSecretCatalogReferenceV1, type SavedSecretCatalogEntryV1, type SavedSecretResourceEnvelopeCensusRecipientV1 } from '@happier-dev/protocol/account/settings/savedSecretCatalogV1';
import type { SavedSecret } from '@happier-dev/protocol/profiles/backendProfileSchema';

import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Item } from '@/components/ui/lists/Item';
import { Text } from '@/components/ui/text/Text';
import { Modal } from '@/modal';
import { getSyncSingleton } from '@/sync/runtime/getSyncSingleton';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import {
    promotePersonalSavedSecretResource,
    readSavedSecretResourceRecipientReadiness,
    repairApprovedSavedSecretResourceEnvelopesBestEffort,
    setSavedSecretResourceGrants,
} from '@/sync/ops/settings/savedSecretResourceOperations';
import { formatAccountDisplayName } from '@/sync/domains/account/formatAccountDisplayName';
import { isTeamActionApprovalPendingError } from '@/sync/ops/teams/teamActionClient';
import type { ActionApprovalRegistration } from '@/components/approvals/actionApprovalContinuation';
import { t } from '@/text';
import {
    sameSavedSecretGrantDraft,
    savedSecretGrantDraftFromAudience,
    savedSecretGrantInputs,
    type SavedSecretGrantDraft,
} from '@/components/sharing/secrets/savedSecretGrantDraft';
import { SavedSecretShareSheet } from '@/components/sharing/secrets/SavedSecretShareSheet';

/**
 * Who a Saved Secret reaches — for a secret that is already shared, and for one
 * that is still personal and is being shared for the first time.
 *
 * Promotion is irreversible: it rewrites the Account-settings reference and
 * seals the value into a Home-side resource, and nothing demotes it again. So
 * the two cases are one editor rather than two: recipients are chosen first,
 * and the single write that follows carries them. Backing out of a personal
 * target leaves a personal secret.
 */
export type SavedSecretAccessTarget =
    | Readonly<{ kind: 'shared'; entry: SavedSecretCatalogEntryV1 }>
    | Readonly<{ kind: 'personal'; secret: SavedSecret; expectedSettingsVersion: number }>;

function draftFromTarget(target: SavedSecretAccessTarget): SavedSecretGrantDraft {
    return savedSecretGrantDraftFromAudience(target.kind === 'shared' ? target.entry.audience : null);
}

/** What one recipient can do with an E2EE secret, in the owner's words. */
function recipientReadinessLabel(recipient: SavedSecretResourceEnvelopeCensusRecipientV1): string {
    if (recipient.readiness.status === 'available') {
        return recipient.envelopeStatus === 'prepared'
            ? t('secrets.catalog.status.ready')
            : t('secrets.catalog.status.preparing_encrypted_access');
    }
    switch (recipient.readiness.reason) {
        case 'plain_account': return t('secrets.catalog.recipientHomeManagedRequired');
        case 'encryption_setup_required': return t('secrets.catalog.recipientEncryptionSetupRequired');
        case 'encryption_inconsistent': return t('secrets.catalog.recipientEncryptionRepairRequired');
    }
}

type RecipientReadinessState =
    | Readonly<{ status: 'loading' }>
    | Readonly<{ status: 'ready'; revision: number; recipients: readonly SavedSecretResourceEnvelopeCensusRecipientV1[] }>
    | Readonly<{ status: 'error' }>;

/**
 * The owner's per-recipient view of one E2EE secret, read from the Home's
 * envelope census (plan 10.08 §0.5, §10.5, §13.4). A Home-managed secret has
 * no envelopes, so it asks nothing.
 */
function useSavedSecretRecipientReadiness(input: Readonly<{
    scope: ServerAccountScope;
    resourceId: string | null;
    /** The census belongs to one revision; a new revision is a new read. */
    revision: number | null;
}>): Readonly<{ state: RecipientReadinessState | null; reload: () => void }> {
    const [state, setState] = React.useState<RecipientReadinessState | null>(null);
    const [attempt, setAttempt] = React.useState(0);
    const { serverId, accountId } = input.scope;
    React.useEffect(() => {
        if (input.resourceId === null) {
            setState(null);
            return;
        }
        let current = true;
        setState((previous) => previous?.status === 'ready' ? previous : { status: 'loading' });
        void readSavedSecretResourceRecipientReadiness({
            scope: { serverId, accountId },
            resourceId: input.resourceId,
        }).then((result) => {
            if (!current) return;
            setState(result.ok
                ? { status: 'ready', revision: result.revision, recipients: result.recipients }
                : { status: 'error' });
        }, () => {
            if (current) setState({ status: 'error' });
        });
        return () => { current = false; };
    }, [accountId, attempt, input.resourceId, input.revision, serverId]);
    const reload = React.useCallback(() => setAttempt((value) => value + 1), []);
    return { state, reload };
}

export const SavedSecretAccessEditor = React.memo(function SavedSecretAccessEditor(props: Readonly<{
    target: SavedSecretAccessTarget;
    scope: ServerAccountScope;
    onClose: () => void;
    onSaved: () => Promise<void>;
    onDirtyChange?: (dirty: boolean) => void;
    approvalPending?: boolean;
    approvalId?: string | null;
    onOpenApproval?: () => void;
    requestApproval?: (registration: ActionApprovalRegistration) => void;
    /**
     * The owner's explicit, separately confirmed conversion to Home-managed
     * storage — the remedy for a recipient who cannot hold an envelope.
     * Absent where that direction is not allowed.
     */
    onMakeHomeManaged?: () => void;
}>) {
    const { theme } = useUnistyles();
    const target = props.target;
    const entry = target.kind === 'shared' ? target.entry : null;
    const parsed = entry === null ? null : parseSavedSecretCatalogReferenceV1(entry.ref);
    const [draft, setDraft] = React.useState(() => draftFromTarget(target));
    const [baselineDraft, setBaselineDraft] = React.useState(draft);
    const dirty = !sameSavedSecretGrantDraft(draft, baselineDraft);
    React.useEffect(() => { props.onDirtyChange?.(dirty); }, [dirty, props.onDirtyChange]);
    const [saving, setSaving] = React.useState(false);
    const [failure, setFailure] = React.useState<'changed' | 'unavailable' | 'failed' | 'outcome_unknown' | null>(null);
    /**
     * Which revision an in-flight save was issued against. A response that
     * arrives after the row moved must not close the editor.
     */
    const targetKey = entry === null
        ? `${props.scope.serverId}:${props.scope.accountId}:personal:${target.kind === 'personal' ? target.secret.id : ''}`
        : `${props.scope.serverId}:${props.scope.accountId}:${entry.ref}:${entry.revision ?? -1}`;
    const currentTargetKey = React.useRef(targetKey);
    currentTargetKey.current = targetKey;
    /**
     * Which secret is being edited — not which version of it.
     *
     * The draft used to be reset on the fenced key above, so an ordinary
     * background catalog refresh looked like a different target and silently
     * wiped an in-progress recipient selection (and any `outcome_unknown`
     * notice). Currentness is carried by `basis` instead, exactly as the Team
     * credential editor does it: seed once, keep the draft, offer an explicit
     * reload.
     */
    const targetIdentity = entry === null
        ? `${props.scope.serverId}:${props.scope.accountId}:personal:${target.kind === 'personal' ? target.secret.id : ''}`
        : `${props.scope.serverId}:${props.scope.accountId}:${entry.ref}`;
    const currentTargetIdentity = React.useRef(targetIdentity);
    currentTargetIdentity.current = targetIdentity;
    const targetMounted = React.useRef(false);
    /** The revision this draft was seeded from; the save is fenced on it. */
    const [basis, setBasis] = React.useState<number | null>(() => entry?.revision ?? null);
    const movedUnderEditor = entry !== null && basis !== null && entry.revision !== basis;
    const ownsEncryptedResource = entry !== null
        && entry.relationship === 'owner'
        && entry.encryptionMode === 'e2ee'
        && parsed?.kind === 'shared_resource';
    const readiness = useSavedSecretRecipientReadiness({
        scope: props.scope,
        resourceId: ownsEncryptedResource && parsed?.kind === 'shared_resource' ? parsed.id : null,
        revision: entry?.revision ?? null,
    });
    const [finishingSharing, setFinishingSharing] = React.useState(false);

    React.useEffect(() => {
        targetMounted.current = true;
        return () => { targetMounted.current = false; };
    }, [targetIdentity]);

    React.useEffect(() => {
        const nextDraft = draftFromTarget(props.target);
        setDraft(nextDraft);
        setBaselineDraft(nextDraft);
        setBasis(props.target.kind === 'shared' ? props.target.entry.revision : null);
        setSaving(false);
        setFailure(null);
    }, [targetIdentity]);

    if (entry !== null && (parsed?.kind !== 'shared_resource' || entry.revision === null || entry.encryptionMode === null)) {
        return (
            <View style={styles.body}>
                <Text accessibilityRole="alert" style={[styles.notice, { color: theme.colors.state.danger.foreground }]}>
                    {t('secrets.catalog.operationFailed')}
                </Text>
                <View style={styles.actions}>
                    <RoundButton size="small" display="secondary" title={t('common.cancel')} onPress={props.onClose} />
                </View>
            </View>
        );
    }

    const save = async () => {
        // The revision fence is a correctness rule: a press from
        // a stale render must not replace an audience somebody
        // else already changed.
        if (movedUnderEditor) return;
        const requestedTargetKey = targetKey;
        const currentGrantCount = (entry?.audience?.accounts.length ?? 0)
            + (entry?.audience?.teams.length ?? 0)
            + (entry?.audience?.groups.length ?? 0);
        const nextGrantCount = draft.length;
        // Sharing a personal secret is itself the first
        // disclosure, so it is confirmed exactly like the first
        // external grant on an already-shared one.
        if ((currentGrantCount === 0 && nextGrantCount > 0) || target.kind === 'personal') {
            const target = t('secrets.catalog.shareDisclosureTargetCount', { count: nextGrantCount });
            const confirmed = await Modal.confirm(
                t('secrets.catalog.shareDisclosureTitle'),
                t('secrets.catalog.shareDisclosureBody'),
                {
                    cancelText: t('common.cancel'),
                    confirmText: t('secrets.catalog.shareDisclosureConfirm', { target }),
                },
            );
            if (!confirmed || currentTargetKey.current !== requestedTargetKey) return;
        }
        setSaving(true);
        setFailure(null);
        const encryption = getSyncSingleton().encryption;
        try {
        const finishApproved = async () => {
            if (!targetMounted.current || currentTargetKey.current !== requestedTargetKey) return;
            setSaving(false);
            await props.onSaved();
            if (targetMounted.current && currentTargetKey.current === requestedTargetKey) props.onClose();
        };
        const onApprovalFailed = () => {
            if (!targetMounted.current || currentTargetKey.current !== requestedTargetKey) return;
            setSaving(false);
            setFailure('failed');
        };
        // One write either way: the personal target becomes a
        // shared resource carrying these grants, and the shared
        // one replaces its audience under its own revision fence.
        const result = target.kind === 'personal'
            ? await promotePersonalSavedSecretResource({
                scope: props.scope,
                expectedSettingsVersion: target.expectedSettingsVersion,
                secret: target.secret,
                ...savedSecretGrantInputs(draft),
                onApprovalSucceeded: finishApproved,
                onApprovalFailed,
            })
            : await setSavedSecretResourceGrants({
                scope: props.scope,
                resourceId: parsed!.id,
                expectedRevision: basis ?? entry!.revision!,
                encryptionMode: entry!.encryptionMode!,
                ...savedSecretGrantInputs(draft),
                decryptDataKeyEnvelope: (value) => encryption
                    ? encryption.decryptEncryptionKey(value, props.scope)
                    : Promise.resolve(null),
                onApprovalSucceeded: finishApproved,
                onApprovalFailed,
            });
        if (!targetMounted.current || currentTargetKey.current !== requestedTargetKey) return;
        setSaving(false);
        if (!result.ok) {
            setFailure(result.reason);
            if (result.reason === 'outcome_unknown') {
                await props.onSaved().catch(() => undefined);
            }
            return;
        }
        try {
            await props.onSaved();
        } catch {
            if (targetMounted.current && currentTargetKey.current === requestedTargetKey) setFailure('failed');
            return;
        }
        if (targetMounted.current && currentTargetKey.current === requestedTargetKey) props.onClose();
        } catch (cause) {
            if (!targetMounted.current || currentTargetKey.current !== requestedTargetKey) return;
            if (isTeamActionApprovalPendingError(cause)) {
                props.requestApproval?.(cause.registration);
                return;
            }
            setSaving(false);
            setFailure('failed');
        } finally {
            // Revision changes fence the result, but the same editor still owns
            // the completed request's busy state and must offer recovery.
            if (targetMounted.current && currentTargetIdentity.current === targetIdentity) setSaving(false);
        }
    };

    const finishSharing = async (revision: number) => {
        const encryption = getSyncSingleton().encryption;
        if (!encryption || !parsed || parsed.kind !== 'shared_resource') return;
        setFinishingSharing(true);
        try {
            await repairApprovedSavedSecretResourceEnvelopesBestEffort({
                scope: props.scope,
                resourceId: parsed.id,
                expectedRevision: revision,
                decryptDataKeyEnvelope: (value) => encryption.decryptEncryptionKey(value, props.scope),
            });
        } finally {
            setFinishingSharing(false);
            readiness.reload();
        }
    };

    const failureText = failure
        ? failure === 'outcome_unknown'
            ? t('secrets.catalog.outcomeUnknown')
            : t('secrets.catalog.operationFailed')
        : movedUnderEditor ? t('secrets.catalog.operationFailed') : null;

    // Rendered inside the secret's expanded row: the recipients, what each one needs, then the one
    // write. Nothing is shared until Save (or Share, for a still-personal secret) is pressed.
    return (
        <View style={styles.body} testID="saved-secret-access-editor-body">
            {props.approvalId && props.onOpenApproval ? (
                <View style={styles.row} testID="saved-secret-access-approval">
                    <Text accessibilityLiveRegion="polite" style={[styles.notice, styles.grow, { color: theme.colors.text.secondary }]}>
                        {t('secrets.catalog.approvalPending')}
                    </Text>
                    <RoundButton size="small" display="secondary" title={t('approvals.title')} onPress={props.onOpenApproval} />
                </View>
            ) : null}
            <SavedSecretShareSheet
                scope={props.scope}
                draft={draft}
                onChange={setDraft}
                disabled={saving || props.approvalPending}
                retainedAudience={entry?.audience ?? undefined}
            />

            {readiness.state ? (() => {
                const state = readiness.state;
                if (state.status === 'error') {
                    return (
                        <View style={styles.row}>
                            <Text style={[styles.notice, styles.grow, { color: theme.colors.text.secondary }]}>
                                {t('secrets.catalog.recipientReadinessUnavailable')}
                            </Text>
                            <RoundButton
                                testID="saved-secret-recipient-readiness-retry"
                                size="small"
                                display="secondary"
                                title={t('common.retry')}
                                onPress={readiness.reload}
                            />
                        </View>
                    );
                }
                const recipients = state.status === 'ready'
                    ? state.recipients.filter((recipient) => recipient.account.accountId !== props.scope.accountId)
                    : [];
                if (state.status === 'ready' && recipients.length === 0) return null;
                const owesEnvelopes = recipients.some((recipient) => (
                    recipient.readiness.status === 'available' && recipient.envelopeStatus !== 'prepared'
                ));
                const needsHomeManaged = recipients.some((recipient) => (
                    recipient.readiness.status === 'unavailable' && recipient.readiness.reason === 'plain_account'
                ));
                const busy = saving || finishingSharing || Boolean(props.approvalPending);
                return (
                    <View style={styles.readiness}>
                        <Text style={[styles.readinessTitle, { color: theme.colors.text.primary }]}>
                            {t('secrets.catalog.recipientReadinessTitle')}
                        </Text>
                        {state.status === 'loading' ? (
                            <Item title={t('secrets.catalog.recipientReadinessTitle')} loading showChevron={false} showDivider={false} />
                        ) : null}
                        {recipients.map((recipient) => (
                            <Item
                                key={recipient.account.accountId}
                                testID={`saved-secret-recipient:${recipient.account.accountId}`}
                                title={formatAccountDisplayName(recipient.account) ?? t('secrets.catalog.unavailableName')}
                                subtitle={recipientReadinessLabel(recipient)}
                                mode="info"
                                showChevron={false}
                                showDivider={false}
                            />
                        ))}
                        {(owesEnvelopes && state.status === 'ready') || (needsHomeManaged && props.onMakeHomeManaged) ? (
                            <View style={styles.actions}>
                                {owesEnvelopes && state.status === 'ready' ? (
                                    <RoundButton
                                        testID="saved-secret-recipient-finish-sharing"
                                        size="small"
                                        display="secondary"
                                        title={t('secrets.catalog.recipientFinishSharing')}
                                        loading={finishingSharing}
                                        disabled={busy}
                                        onPress={() => { void finishSharing(state.revision); }}
                                    />
                                ) : null}
                                {needsHomeManaged && props.onMakeHomeManaged ? (
                                    <RoundButton
                                        testID="saved-secret-recipient-make-home-managed"
                                        size="small"
                                        display="secondary"
                                        title={t('secrets.catalog.actions.convertToPlain')}
                                        disabled={busy}
                                        onPress={props.onMakeHomeManaged}
                                    />
                                ) : null}
                            </View>
                        ) : null}
                    </View>
                );
            })() : null}

            {failureText ? (
                <Text
                    testID="saved-secret-access-failure"
                    accessibilityRole="alert"
                    accessibilityLiveRegion="polite"
                    style={[styles.notice, { color: theme.colors.state.danger.foreground }]}
                >
                    {failureText}
                </Text>
            ) : null}
            <View style={styles.actions}>
                <RoundButton
                    testID="saved-secret-access-save"
                    size="small"
                    title={target.kind === 'personal' ? t('secretsSettings.share') : t('common.save')}
                    loading={saving || props.approvalPending}
                    disabled={saving || props.approvalPending || movedUnderEditor}
                    onPress={() => { void save(); }}
                />
                {movedUnderEditor && entry !== null ? (
                    <RoundButton
                        testID="saved-secret-access-reload"
                        size="small"
                        display="secondary"
                        title={t('common.retry')}
                        disabled={saving || props.approvalPending}
                        onPress={() => {
                            // Adopting the Home's current recipients is an
                            // explicit choice, never something a refresh does.
                            const nextDraft = draftFromTarget(props.target);
                            setDraft(nextDraft);
                            setBaselineDraft(nextDraft);
                            setBasis(entry.revision);
                            setFailure(null);
                        }}
                    />
                ) : null}
                <RoundButton
                    testID="saved-secret-access-cancel"
                    size="small"
                    display="secondary"
                    title={t('common.cancel')}
                    disabled={saving || props.approvalPending}
                    onPress={props.onClose}
                />
            </View>
        </View>
    );
});

const styles = StyleSheet.create(() => ({
    body: { paddingHorizontal: 16, paddingTop: 4, paddingBottom: 16, gap: 14 },
    row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
    grow: { flexShrink: 1 },
    actions: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
    readiness: { gap: 4 },
    readinessTitle: { fontSize: 14, lineHeight: 20 },
    notice: { fontSize: 13, lineHeight: 18 },
}));
