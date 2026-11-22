import * as React from 'react';
import { Platform, type StyleProp, type TextStyle } from 'react-native';

import { Text } from '@/components/ui/text/Text';
import { splitMaskedConnectedAccountIdentity } from '@/sync/domains/connectedServices/maskAccountEmail';
import { t } from '@/text';

/** A fixed-shape stand-in drawn under the blur: never the real characters, so the blur hides nothing recoverable. */
const BLURRED_PLACEHOLDER = 'xxxxx';

/**
 * A connected-account identity as `present(...)` returned it (lab `csvc` PV). Hidden runs are a partial blur
 * where the platform draws one (web: a blurred fixed-shape placeholder), and the owner's `•••` text elsewhere;
 * the readable letters stay sharp so accounts can still be told apart. It masks nothing itself.
 */
export const ConnectedAccountIdentityText = React.memo(function ConnectedAccountIdentityText(props: Readonly<{
    value: string;
    style?: StyleProp<TextStyle>;
    numberOfLines?: number;
    testID?: string;
}>) {
    const parts = splitMaskedConnectedAccountIdentity(props.value);
    const masked = parts.some((part) => part.masked);
    if (!masked || Platform.OS !== 'web') {
        // An address wraps once, between its name and its domain, never mid-word: the domain is one atomic
        // inline, which is a soft wrap opportunity on either side of it (the text stays one string). On one line
        // it is plain text cut at its end, so the local part that tells accounts apart stays whole and the domain
        // gives way ("leeroy.brun@gma…"); an atomic domain there would drop out whole with no ellipsis.
        const at = props.numberOfLines === 1 ? -1 : props.value.indexOf('@');
        return (
            <Text testID={props.testID} style={[props.style, Platform.OS === 'web' ? WORD_WRAP_STYLE : null]} numberOfLines={props.numberOfLines}>
                {Platform.OS === 'web' && at > 0 && at < props.value.length - 1
                    ? <>{props.value.slice(0, at + 1)}<Text style={ATOMIC_STYLE}>{props.value.slice(at + 1)}</Text></>
                    : props.value}
            </Text>
        );
    }
    return (
        <Text
            testID={props.testID}
            style={[props.style, WORD_WRAP_STYLE]}
            numberOfLines={props.numberOfLines}
            accessibilityLabel={t('connectedServicesCollection.identityHidden')}
        >
            {parts.map((part, index) => part.masked ? (
                <Text key={index} style={BLUR_STYLE} aria-hidden>{BLURRED_PLACEHOLDER}</Text>
            ) : part.text)}
        </Text>
    );
});

const ATOMIC_STYLE = { display: 'inline-block' } as unknown as TextStyle;
// RNW's emergency word breaks turn short account names into fragments in narrow quota columns.
const WORD_WRAP_STYLE = { wordBreak: 'normal', overflowWrap: 'normal' } as unknown as TextStyle;
// `filter` is a web style React Native's types do not list.
const BLUR_STYLE = { filter: 'blur(3.5px)', userSelect: 'none' } as unknown as TextStyle;
