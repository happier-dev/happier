import * as React from 'react';
import { View } from 'react-native';
import { Image } from 'expo-image';
import { StyleSheet } from 'react-native-unistyles';

import { QRCode } from '@/components/qr/QRCode';

import { PAIRING_QR_PALETTE } from './pairingQrPalette';
import { isPairingQrMarked } from './pairingQrMark';

const PAPER_PADDING_PX = 12;
const MARK_BOX_PX = 44;
const MARK_PX = 30;

/**
 * The pairing code on white paper with the Happier mark in its centre. The mark covers modules, so it
 * is drawn only when the quartile error-correction level (which recovers up to a quarter of the code;
 * the mark covers about a twentieth) costs no density: the same module grid as the admission level
 * (`medium`, `buildRenderableHomeQrInviteDeepLink`). A longer link is drawn plain at `medium`, so the
 * mark never makes a code harder to scan.
 */
export const PairingQrCode = React.memo(function PairingQrCode(props: Readonly<{
    link: string;
    /** The paper's outer size, in px. */
    size: number;
    testID?: string;
}>) {
    const marked = React.useMemo(() => isPairingQrMarked(props.link), [props.link]);
    const codeSize = props.size - (2 * PAPER_PADDING_PX);
    return (
        <View testID={props.testID} style={[styles.paper, { width: props.size, height: props.size }]}>
            <QRCode
                data={props.link}
                size={codeSize}
                errorCorrectionLevel={marked ? 'quartile' : 'medium'}
                // The paper's padding is the code's quiet zone, so the code fills the paper inside it and may take
                // half of that padding when whole-pixel modules need it (at least six pixels of white stay around it).
                quietZone={false}
                bleed={PAPER_PADDING_PX / 2}
            />
            {marked ? (
                <View pointerEvents="none" style={styles.markSlot}>
                    <View style={styles.mark}>
                        <Image
                            source={require('@/assets/images/logo-black.png')}
                            contentFit="contain"
                            style={styles.markImage}
                        />
                    </View>
                </View>
            ) : null}
        </View>
    );
});

const styles = StyleSheet.create(() => ({
    paper: {
        padding: PAPER_PADDING_PX,
        borderRadius: 18,
        backgroundColor: PAIRING_QR_PALETTE.paper,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: PAIRING_QR_PALETTE.edge,
        boxShadow: `0 8px 22px ${PAIRING_QR_PALETTE.shadow}`,
    },
    markSlot: {
        ...StyleSheet.absoluteFillObject,
        alignItems: 'center',
        justifyContent: 'center',
    },
    mark: {
        width: MARK_BOX_PX,
        height: MARK_BOX_PX,
        borderRadius: 12,
        backgroundColor: PAIRING_QR_PALETTE.paper,
        alignItems: 'center',
        justifyContent: 'center',
    },
    markImage: {
        width: MARK_PX,
        height: MARK_PX,
    },
}));
