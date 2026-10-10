import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierPublicLinkCard } from '@happier-dev/plugin-ui/presentation';

import { ToolbarButton } from '@/components/ui/buttons/ToolbarButton';
import { CopiedPill } from '@/components/ui/copy/CopiedPill';
import { useTemporaryCopyFeedback } from '@/components/ui/copy/useTemporaryCopyFeedback';
import { Switch } from '@/components/ui/forms/Switch';
import { Item } from '@/components/ui/lists/Item';
import { Icon } from '@/components/ui/icons/Icon';
import { ITEM_SUBTITLE_TEXT_METRICS, ITEM_TITLE_TEXT_METRICS } from '@/components/ui/lists/itemDensityMetrics';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { StatusDot } from '@/components/ui/status/StatusDot';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { Typography } from '@/constants/Typography';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { Modal } from '@/modal';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { SessionPublicLinkPublication } from '@/sync/domains/social/sessionPublicLinkPublication';
import type { SharingAuthoritySession } from '@/sync/domains/social/sessionSharingMutationAuthority';
import { t } from '@/text';
import { HappyError } from '@/utils/errors/errors';
import { setClipboardStringSafe } from '@/utils/ui/clipboard';

import type { ExternalSessionSharingAvailability } from '@/components/sessions/external/sharing/useExternalSessionSharingAvailability';
import { buildPublicShareApplicationUrl, resolvePublicShareApplicationBaseUrl } from '@/components/sessions/sharing/publicShareApplicationUrl';
import { useSessionPublicLinkController, type SessionPublicLinkCreateOptions } from './useSessionPublicLinkController';

const QR_SIZE_PX = 168;
/**
 * The QR renderer (Skia on native) loads only when someone asks for the code, as it did behind the
 * former publication dialog, so opening Collaboration never pays for it.
 */
const LazyQRCode = React.lazy(() => import('@/components/qr/QRCode').then((module) => ({ default: module.QRCode })));

const styles = StyleSheet.create({
    line: { marginHorizontal: 4 },
});

type Expiry = '7' | '30' | 'never';
type Uses = 'unlimited' | '10' | '50';

function readOptions(expiry: Expiry, uses: Uses, isConsentRequired: boolean, networkOff: boolean): SessionPublicLinkCreateOptions {
    return {
        ...(expiry === 'never' ? {} : { expiresInDays: Number(expiry) }),
        ...(uses === 'unlimited' ? {} : { maxUses: Number(uses) }),
        isConsentRequired,
        ...(networkOff ? { networkOff: true } : {}),
    };
}

function presentFailure(error: unknown): void {
    const message = error instanceof HappyError ? error.message
        : error instanceof Error ? error.message
            : t('errors.unknownError');
    Modal.alert(t('common.error'), message);
}

/** What the link grants, in plain words, then its limits: "Expires Oct 6 · 3 of 10 uses · asks for consent". */
export type PublicLinkCardPublication = Pick<SessionPublicLinkPublication, 'id' | 'expiresAt' | 'maxUses' | 'useCount' | 'isConsentRequired'>
    & Readonly<{ token?: string | null; publicUrl?: string | null; networkOff?: boolean }>;

export function describeSessionPublicLink(publicShare: PublicLinkCardPublication, grantsLabel = t('session.collaboration.pane.linkGrants')): string {
    const limits = [
        publicShare.expiresAt
            ? t('session.collaboration.pane.linkExpires', { date: new Date(publicShare.expiresAt).toLocaleDateString() })
            : t('session.collaboration.pane.linkNeverExpires'),
        typeof publicShare.maxUses === 'number'
            ? t('session.sharing.usageCountWithMax', { used: publicShare.useCount, max: publicShare.maxUses })
            : t('session.sharing.usageCountUnlimited', { used: publicShare.useCount }),
        publicShare.isConsentRequired ? t('session.collaboration.pane.linkAsksConsent') : t('session.collaboration.pane.linkNoConsent'),
    ];
    return `${grantsLabel} ${limits.join(' · ')}`;
}

export type SessionCollaborationPublicLink = ReturnType<typeof useSessionPublicLinkController> & Readonly<{
    /** The exact Home's `sharing.public` decision. */
    enabled: boolean;
}>;

/**
 * The one publication controller for a Collaboration pane: the access card reads whether a link
 * is on and the Share panel renders the link, from the same instance.
 *
 * It fetches nothing without the explicit `managePublicLink` capability, so an ordinary
 * collaborator neither sees publication state nor produces avoidable owner-only rejections.
 */
export function useSessionCollaborationPublicLink(input: Readonly<{
    scope: ServerAccountScope;
    sessionId: string;
    session: SharingAuthoritySession | null;
    availability: ExternalSessionSharingAvailability;
    authorityCurrent?: boolean;
}>): SessionCollaborationPublicLink {
    // The canonical exact-server decision owner, like every sibling section:
    // a raw snapshot bit would be a second, fail-open reading of the same fact.
    const enabled = useFeatureEnabled('sharing.public', {
        scopeKind: 'spawn',
        serverId: input.scope.serverId,
    });
    const controller = useSessionPublicLinkController({
        scope: input.scope,
        sessionId: input.sessionId,
        session: input.session,
        availability: input.availability,
        authorityCurrent: input.authorityCurrent ?? true,
        publicLinkEnabled: enabled,
    });
    return { ...controller, enabled };
}

/**
 * The public link, shown as the thing itself inside the Share panel (lab `collab` SH): the link with
 * Copy, what it grants in plain words, its expiry, uses and consent, then QR code, New link… and
 * Turn off (which asks first).
 *
 * A public link is an anonymous, view-only bearer capability: it is not a principal and never
 * appears as an access row. It cannot be edited — only made again with new options, or turned off —
 * so those are the only controls offered. The bearer is known only to the client that created it;
 * a link made elsewhere says so instead of showing a URL it cannot build.
 *
 * A viewer without `managePublicLink` is told who can create a link rather than shown a blank section.
 */
export function SessionPublicLinkSection(props: Readonly<{
    link: SessionCollaborationPublicLink;
    /** The exact Session is known, so a missing capability is a fact rather than a first read. */
    hasSession: boolean;
    /** The Session's storage can be published at all (hosted, or materialized). */
    shareable: boolean;
    testID?: string;
    presentation?: 'card' | 'inline';
}>): React.ReactElement | null {
    const { link } = props;
    if (!link.enabled) return null;
    if (!link.canManage) {
        if (!props.hasSession) return null;
        return (
            <View style={styles.line}>
                <SurfaceStateCard
                    testID="session-public-link-denied"
                    size="line"
                    kind="denied"
                    iconName="link"
                    title={t('session.collaboration.pane.linkDenied')}
                />
            </View>
        );
    }
    if (!props.shareable) return null;
    return (
        <SessionPublicLinkCard
            presentation={props.presentation}
            testID={props.testID ?? 'session-public-link-card'}
            publicShare={link.publicShare}
            serverUrl={link.shareableServerUrl}
            loading={link.loading}
            loaded={link.hasLoaded}
            failed={link.error}
            readOnly={!link.canMutate}
            pendingApproval={link.pendingApproval !== null}
            onRetry={link.reload}
            onOpenPendingApproval={link.openPendingApproval}
            onCreate={link.create}
            onDelete={link.remove}
        />
    );
}

/**
 * The card itself, driven only by its props so every publication state renders from the one
 * controller. `readOnly` withdraws every mutation while the authority behind it is not current,
 * without hiding a link that was already issued.
 */
export function SessionPublicLinkCard(props: Readonly<{
    testID: string;
    presentation?: 'card' | 'inline';
    publicShare: PublicLinkCardPublication | null;
    /** Local bearer URL supplied by the creating client, never a transport projection. */
    shareUrl?: string | null;
    description?: string;
    grantsLabel?: string;
    serverUrl: string | null;
    loading: boolean;
    /** The publication has been read at least once, so "off" is a fact. */
    loaded: boolean;
    /** The latest read failed; anything read before stays shown. */
    failed: boolean;
    readOnly: boolean;
    pendingApproval: boolean;
    onRetry: () => void | Promise<void>;
    onOpenPendingApproval: () => void;
    onCreate: (options: SessionPublicLinkCreateOptions) => Promise<PublicLinkCardPublication | null>;
    onDelete: () => Promise<void>;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const { publicShare } = props;
    const [configuring, setConfiguring] = React.useState(false);
    const [showQr, setShowQr] = React.useState(false);
    const [expiry, setExpiry] = React.useState<Expiry>('7');
    const [uses, setUses] = React.useState<Uses>('unlimited');
    const [consent, setConsent] = React.useState(true);
    const [networkOff, setNetworkOff] = React.useState(false);
    const [creating, setCreating] = React.useState(false);
    const [revoking, setRevoking] = React.useState(false);
    const copyFeedback = useTemporaryCopyFeedback();
    // One outward request at a time: a second create would mint a second link and orphan the
    // first, and a second DELETE would surface its 404 after the first succeeded. The refs refuse
    // a same-tick second activation before React has committed the busy state.
    const inFlight = React.useRef(false);
    const mounted = React.useRef(true);
    React.useEffect(() => () => { mounted.current = false; }, []);
    const shareUrl = React.useMemo(() => props.shareUrl ?? publicShare?.publicUrl ?? (publicShare?.token
        ? buildPublicShareApplicationUrl({
            applicationBaseUrl: resolvePublicShareApplicationBaseUrl(),
            token: publicShare.token,
            serverUrl: props.serverUrl,
        })
        : null), [props.shareUrl, props.serverUrl, publicShare?.publicUrl, publicShare?.token]);
    const busy = creating || revoking;
    const mutationsDisabled = props.readOnly || props.pendingApproval || busy;

    const create = async () => {
        if (mutationsDisabled || inFlight.current) return;
        inFlight.current = true;
        setCreating(true);
        try {
            await props.onCreate(readOptions(expiry, uses, consent, networkOff));
            if (mounted.current) setConfiguring(false);
        } catch (error) {
            if (mounted.current) presentFailure(error);
        } finally {
            inFlight.current = false;
            if (mounted.current) setCreating(false);
        }
    };
    const turnOff = async () => {
        if (mutationsDisabled || inFlight.current) return;
        inFlight.current = true;
        try {
            const confirmed = await Modal.confirm(
                t('session.collaboration.pane.turnOffTitle'),
                t('session.collaboration.pane.turnOffBody'),
                { confirmText: t('session.collaboration.pane.turnOff'), cancelText: t('common.cancel'), destructive: true },
            );
            if (!confirmed || !mounted.current) return;
            setRevoking(true);
            await props.onDelete();
            if (mounted.current) { setShowQr(false); setConfiguring(false); }
        } catch (error) {
            if (mounted.current) presentFailure(error);
        } finally {
            inFlight.current = false;
            if (mounted.current) setRevoking(false);
        }
    };
    const copy = async () => {
        if (!shareUrl) return;
        const copied = await setClipboardStringSafe(shareUrl);
        if (!copied) {
            Modal.alert(t('common.error'), t('textSelection.failedToCopy'));
            return;
        }
        copyFeedback.markCopied('public-link');
    };

    const on = publicShare !== null;
    return (
        <HappierPublicLinkCard
            presentation={props.presentation}
            testID={props.testID}
            published={on}
            loaded={props.loaded}
            configuring={configuring}
            shareUrl={shareUrl}
            title={t('session.sharing.publicLink')}
            status={on ? t('session.collaboration.pane.linkOn') : t('session.collaboration.pane.linkOff')}
            hiddenLabel={t('session.collaboration.pane.linkHidden')}
            detail={publicShare ? describeSessionPublicLink(publicShare, props.grantsLabel) : ''}
            description={props.description ?? t('session.sharing.publicLinkDescription')}
            expiresLabel={t('session.sharing.expiresIn')}
            usesLabel={t('session.sharing.maxUsesLabel')}
            consentTitle={t('session.sharing.requireConsent')}
            consentDescription={t('session.sharing.requireConsentDescription')}
            replacementNote={t('session.collaboration.pane.newLinkReplaces')}
            colors={{ border: theme.colors.border.default, inset: theme.colors.surface.inset, surface: theme.colors.surface.base,
                text: theme.colors.text.primary, secondary: theme.colors.text.secondary, success: theme.colors.state.success.foreground }}
            typography={{ title: { ...Typography.default('semiBold'), ...ITEM_TITLE_TEXT_METRICS.compact },
                subtitle: { ...Typography.default(), ...ITEM_SUBTITLE_TEXT_METRICS.compact },
                emphasizedSubtitle: { ...Typography.default('semiBold'), ...ITEM_SUBTITLE_TEXT_METRICS.compact },
                mono: { ...Typography.mono(), ...ITEM_SUBTITLE_TEXT_METRICS.compact },
                consentTitle: { ...Typography.default(), ...ITEM_TITLE_TEXT_METRICS.compact } }}
            Text={Text}
            linkMark={<Icon name="link" size={15} color={theme.colors.text.secondary} />}
            statusMark={<StatusDot color={theme.colors.state.success.foreground} size={6} />}
            notices={<>{configuring ? <Item
                title={t('session.collaboration.pane.linkNetworkOff')}
                subtitle={t('session.collaboration.pane.linkNetworkConsequence')}
                accessoryLayout="adaptive"
                rightElement={<Switch testID="session-public-link-network-off"
                    accessibilityLabel={t('session.collaboration.pane.linkNetworkOff')}
                    value={networkOff} onValueChange={setNetworkOff} disabled={busy} />}
            /> : null}{props.failed ? (
                <SurfaceStateCard
                    testID="session-public-link-retry"
                    size="line"
                    kind="error"
                    title={t('session.collaboration.pane.linkLoadFailed')}
                    action={{ label: t('common.retry'), onPress: () => { void props.onRetry(); } }}
                />
            ) : props.loading && !on && !props.loaded ? (
                <SurfaceStateCard testID="session-public-link-loading" size="line" kind="loading" title={t('common.loading')} />
            ) : null}
            {props.pendingApproval ? (
                <SurfaceStateCard
                    testID="session-public-link-approval"
                    size="line"
                    kind="warning"
                    title={`${t('approvals.title')} · ${t('approvals.status.open')}`}
                    action={{ label: t('approvals.title'), onPress: props.onOpenPendingApproval }}
                />
            ) : null}</>}
            copyFeedback={<CopiedPill visible={copyFeedback.isCopied('public-link')} testID="session-public-link-copy-feedback" />}
            copyControl={<ToolbarButton
                testID="session-public-link-copy"
                label={t('common.copy')}
                icon={<Icon name="copy" size={14} color={theme.colors.text.secondary} />}
                onPress={() => { void copy(); }}
            />}
            qr={showQr && shareUrl ? (
                <React.Suspense fallback={<ActivitySpinner size="small" />}>
                    <LazyQRCode data={shareUrl} size={QR_SIZE_PX} />
                </React.Suspense>
            ) : null}
            qrControl={shareUrl ? (
                <ToolbarButton
                    testID="session-public-link-qr"
                    label={showQr ? t('session.collaboration.pane.hideQrCode') : t('session.collaboration.pane.qrCode')}
                    icon={<Icon name="qr-code" size={14} color={theme.colors.text.secondary} />}
                    active={showQr}
                    onPress={() => setShowQr((current) => !current)}
                />
            ) : null}
            newControl={<ToolbarButton
                testID="session-public-link-new"
                label={t('session.collaboration.pane.newLink')}
                icon={<Icon name="arrow-clockwise" size={14} color={theme.colors.text.secondary} />}
                disabled={mutationsDisabled}
                onPress={() => { setNetworkOff(publicShare?.networkOff ?? false); setConfiguring(true); }}
            />}
            turnOffControl={<ToolbarButton
                testID="session-public-link-turn-off"
                label={t('session.collaboration.pane.turnOff')}
                tone="danger"
                disabled={mutationsDisabled}
                busy={revoking}
                onPress={() => { void turnOff(); }}
            />}
            createControl={<ToolbarButton
                testID="session-public-link-create"
                label={t('session.sharing.createPublicLink')}
                tone={props.presentation === 'inline' ? 'default' : 'primary'}
                disabled={mutationsDisabled}
                onPress={() => { setNetworkOff(publicShare?.networkOff ?? false); setConfiguring(true); }}
            />}
            expiryControl={<SegmentedTabBar<Expiry>
                role="radiogroup"
                tabs={[
                    { id: '7', label: t('session.sharing.days7') },
                    { id: '30', label: t('session.sharing.days30') },
                    { id: 'never', label: t('session.sharing.never') },
                ]}
                activeTabId={expiry}
                onSelectTab={setExpiry}
                testIDPrefix="session-public-link-expiry"
                accessibilityLabel={t('session.sharing.expiresIn')}
                disabled={busy}
            />}
            usesControl={<SegmentedTabBar<Uses>
                role="radiogroup"
                tabs={[
                    { id: 'unlimited', label: t('session.sharing.unlimited') },
                    { id: '10', label: t('session.sharing.uses10') },
                    { id: '50', label: t('session.sharing.uses50') },
                ]}
                activeTabId={uses}
                onSelectTab={setUses}
                testIDPrefix="session-public-link-uses"
                accessibilityLabel={t('session.sharing.maxUsesLabel')}
                disabled={busy}
            />}
            consentControl={<Switch
                testID="session-public-link-consent"
                accessibilityLabel={t('session.sharing.requireConsent')}
                value={consent}
                onValueChange={setConsent}
                disabled={busy}
            />}
            cancelControl={<ToolbarButton
                testID="session-public-link-options-cancel"
                label={t('common.cancel')}
                disabled={busy}
                onPress={() => setConfiguring(false)}
            />}
            submitControl={<ToolbarButton
                testID="session-public-link-options-create"
                label={on ? t('session.sharing.regeneratePublicLink') : t('session.sharing.createPublicLink')}
                tone={props.presentation === 'inline' ? 'default' : 'primary'}
                disabled={mutationsDisabled}
                busy={creating}
                onPress={() => { void create(); }}
            />}
        />
    );
}
