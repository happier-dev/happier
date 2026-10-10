import * as React from 'react';
import { Platform } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { Text } from '@/components/ui/text/Text';
import { HappierFindHighlightedText, type FindMarkStyle, type FindTextRange } from '@happier-dev/plugin-ui/presentation';
export { sliceFindRanges } from '@happier-dev/plugin-ui/presentation';

/**
 * The two marks of every Find surface (Find lab `mark.fd-m`): every match is a soft tint that keeps the text's
 * own colour; the current one is the solid fill with its dark ink, so it reads on any syntax colour and in dark
 * mode. On the web the mark is drawn a hair past the glyphs (rounded, ringed, the current one lifted); native
 * nested text can only take the fill.
 */
function resolveFindMarkStyles(theme: ReturnType<typeof useUnistyles>['theme']): Readonly<{ all: FindMarkStyle; current: FindMarkStyle }> {
    const { matchAll, matchCurrent, matchCurrentForeground } = theme.colors.find;
    if (Platform.OS !== 'web') {
        return { all: { backgroundColor: matchAll }, current: { backgroundColor: matchCurrent, color: matchCurrentForeground } };
    }
    return {
        all: { backgroundColor: matchAll, borderRadius: 3, boxShadow: `0 0 0 1px ${matchAll}` },
        current: {
            backgroundColor: matchCurrent,
            color: matchCurrentForeground,
            borderRadius: 3,
            boxShadow: `0 0 0 1.5px ${matchCurrent}, ${theme.colors.shadowLevels[2].boxShadow}`,
        },
    };
}

/** Half-open UTF-16 display ranges; nested Text preserves parent typography and links. */
export function FindHighlightedText(props: Readonly<{ text: string; ranges?: readonly FindTextRange[]; selectable?: boolean }>) {
    const { theme } = useUnistyles();
    const marks = React.useMemo(() => resolveFindMarkStyles(theme), [theme]);
    return <HappierFindHighlightedText {...props} marks={marks} renderMatch={({ key, text, current, style, selectable }) =>
        <Text key={key} useDefaultTypography={false} selectable={selectable} testID={current ? 'find-match-current' : 'find-match-all'} style={style}>{text}</Text>} />;
}
