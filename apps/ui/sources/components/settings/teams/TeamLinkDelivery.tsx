import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { QRCode } from '@/components/qr';
import { tryCreateQRMatrix } from '@/components/qr/qrMatrix';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { CopiedPill } from '@/components/ui/copy/CopiedPill';
import { useTemporaryCopyFeedback } from '@/components/ui/copy/useTemporaryCopyFeedback';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SectionButtonRow } from '@/components/ui/lists/SectionButtonRow';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { Modal } from '@/modal';
import { t } from '@/text';
import { setClipboardStringSafe } from '@/utils/ui/clipboard';
import { isTextSharingAvailable, shareTextSafe } from '@/utils/ui/shareText';

/**
 * The one way a Team link is handed to a person.
 *
 * Two links reach a member: the invitation bearer, which is a secret handed over
 * exactly once at creation or reissue, and the ordinary member sign-in page,
 * which carries no bearer and may be published anywhere. They differ in what
 * they authorize and therefore in their copy — but not in *how* they are handed
 * over. Keeping copy, share and QR in one component is what stops those two from
 * drifting into offering different deliveries of the same shape, which is the
 * kind of difference nobody notices until a manager cannot scan the link they
 * were just shown.
 *
 * The URL is rendered, never stored: it lives in the calling screen's memory for
 * as long as that screen can legitimately hand it over.
 */

const QR_SIZE = 180;

const TeamLinkQr = React.memo(function TeamLinkQr(props: Readonly<{
    url: string;
    accessibilityLabel: string;
    testID: string;
}>) {
    // The encoder owns its own capacity rule, and its shared non-throwing
    // boundary is asked *before* the renderer is mounted. Wrapping the element
    // in try/catch would not work at all — the child renders after this
    // function returns — and approximating the limit from the link's length
    // would be a second, wrong answer to a question the encoder already owns.
    const encodable = React.useMemo(
        () => tryCreateQRMatrix(props.url, 'medium').ok,
        [props.url],
    );

    if (!encodable) {
        return (
            <Item
                testID={`${props.testID}-too-large`}
                title={t('teams.invitations.qrTooLargeFallback')}
                showChevron={false}
            />
        );
    }

    return (
        <View
            testID={props.testID}
            accessible
            accessibilityLabel={props.accessibilityLabel}
            style={styles.qr}
        >
            <QRCode data={props.url} size={QR_SIZE} />
        </View>
    );
});

export const TeamLinkDelivery = React.memo(function TeamLinkDelivery(props: Readonly<{
    url: string;
    /** Distinguishes the surfaces that hand a link over, so a test can tell them apart. */
    testIDPrefix: string;
    title: string;
    copyLabel: string;
    shareLabel: string;
    qrAccessibilityLabel: string;
    /**
     * When supplied, QR delivery is an explicit action instead of an always-open
     * panel. Member sign-in uses this compact form; one-time invitation handoff
     * keeps the QR visible immediately.
     */
    qrActionLabel?: string;
    description?: string;
    /**
     * An in-app preview of where the link lands. Only a link the app itself can
     * route offers one; an invitation bearer is handed over, not opened by the
     * person holding the administration screen.
     */
    open?: Readonly<{ label: string; onPress: () => void }>;
}>) {
    const copyFeedback = useTemporaryCopyFeedback();
    const [qrRevealed, setQrRevealed] = React.useState(props.qrActionLabel === undefined);
    const { url } = props;
    // Asked once per render rather than per press: a control that is offered and
    // then does nothing is worse than one that was never offered.
    const sharingAvailable = isTextSharingAvailable();

    const copy = React.useCallback(async () => {
        const copied = await setClipboardStringSafe(url);
        if (!copied) {
            await Modal.alertAsync(t('common.error'), t('items.failedToCopyToClipboard'));
            return;
        }
        copyFeedback.markCopied();
    }, [url, copyFeedback]);

    const share = React.useCallback(async () => {
        if (await shareTextSafe(url) === 'unavailable') {
            await Modal.alertAsync(t('common.error'), t('teams.invitations.shareUnavailable'));
        }
    }, [url]);

    // The link itself, then its handover in one place (lab `tsInvites-K`): the QR beside the
    // buttons that copy and share it. What the link authorizes, and that it is shown once, is the
    // section's description.
    return (
        <ItemGroup title={props.title} description={props.description}>
            <Item
                testID={`${props.testIDPrefix}-link`}
                title={url}
                titleLines={1}
                mode="info"
                showChevron={false}
            />
            <SectionContentRow>
                <View style={styles.handover}>
                    {qrRevealed ? (
                        <TeamLinkQr
                            url={url}
                            accessibilityLabel={props.qrAccessibilityLabel}
                            testID={`${props.testIDPrefix}-qr`}
                        />
                    ) : null}
                    <View style={styles.actions}>
                        <SectionButtonRow>
                            <RoundButton
                                testID={`${props.testIDPrefix}-copy-link`}
                                size="small"
                                display="secondary"
                                title={props.copyLabel}
                                onPress={copy}
                            />
                            {sharingAvailable ? (
                                <RoundButton
                                    testID={`${props.testIDPrefix}-share-link`}
                                    size="small"
                                    display="inverted"
                                    title={props.shareLabel}
                                    onPress={share}
                                />
                            ) : null}
                            {props.qrActionLabel ? (
                                <RoundButton
                                    testID={`${props.testIDPrefix}-show-qr`}
                                    size="small"
                                    display="inverted"
                                    title={props.qrActionLabel}
                                    expanded={qrRevealed}
                                    onPress={() => setQrRevealed((visible) => !visible)}
                                />
                            ) : null}
                            {props.open ? (
                                <RoundButton
                                    testID={`${props.testIDPrefix}-open`}
                                    size="small"
                                    display="inverted"
                                    title={props.open.label}
                                    onPress={props.open.onPress}
                                />
                            ) : null}
                            <CopiedPill
                                visible={copyFeedback.isCopied()}
                                testID={`${props.testIDPrefix}-copy-link-copied`}
                            />
                        </SectionButtonRow>
                    </View>
                </View>
            </SectionContentRow>
        </ItemGroup>
    );
});

const styles = StyleSheet.create(() => ({
    // The QR and its buttons sit side by side and wrap beneath each other on a narrow page.
    handover: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: 16,
    },
    actions: {
        flexGrow: 1,
        flexShrink: 1,
    },
    qr: {
        alignSelf: 'center',
    },
}));
