import * as React from 'react';
import { View } from 'react-native';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import type { FindTextRange } from '@happier-dev/plugin-ui/presentation';
import { FindHighlightedText } from '@/components/ui/text/FindHighlightedText';

export type ScmChangeMarkSize = 'regular' | 'compact';

/**
 * The status mark of a changed file (M, A, D, R, U, !): the letter and tone from the one change-kind
 * owner (`scm/scmChangeKind.ts`), in a box that keeps names aligned. Regular is the default two-line
 * row's 16 px mark; compact is the one-line row's and the Git tree's 14 px mark (Git lab TV).
 */
const MARK_BOX_PX: Readonly<Record<ScmChangeMarkSize, number>> = { regular: 16, compact: 14 };
const MARK_FONT_PX: Readonly<Record<ScmChangeMarkSize, number>> = { regular: 12, compact: 11 };

export const ScmChangeMark = React.memo(function ScmChangeMark(props: Readonly<{
    code: string;
    color: string | undefined;
    size: ScmChangeMarkSize;
    accessibilityLabel?: string;
    testID?: string;
    findRanges?: readonly FindTextRange[];
}>) {
    const box = MARK_BOX_PX[props.size];
    return (
        <View style={{ width: box, alignItems: 'center', justifyContent: 'center' }}>
            <Text
                testID={props.testID}
                accessibilityLabel={props.accessibilityLabel}
                style={{ fontSize: MARK_FONT_PX[props.size], color: props.color, ...Typography.mono('semiBold') }}
            >
                {props.findRanges?.length ? <FindHighlightedText text={props.code} ranges={props.findRanges} /> : props.code}
            </Text>
        </View>
    );
});
