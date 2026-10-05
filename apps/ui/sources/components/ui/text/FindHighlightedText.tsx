import * as React from 'react';
import { Platform } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { Text } from '@/components/ui/text/Text';
import type { FindTextRange } from '@happier-dev/plugin-ui/presentation';

type FindMarkStyle = Readonly<{ backgroundColor: string; color?: string; borderRadius?: number; boxShadow?: string }>;

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
    if (!props.ranges?.length) return props.text;
    const events = new Map<number, { all: number; current: number }>([[0, { all: 0, current: 0 }], [props.text.length, { all: 0, current: 0 }]]);
    const addEvent = (offset: number, delta: number, current: boolean) => {
        const event = events.get(offset) ?? { all: 0, current: 0 };
        event.all += delta;
        if (current) event.current += delta;
        events.set(offset, event);
    };
    for (const range of props.ranges) {
        const start = Math.max(0, Math.min(props.text.length, range.start));
        const end = Math.max(0, Math.min(props.text.length, range.end));
        if (end <= start) continue;
        addEvent(start, 1, range.current);
        addEvent(end, -1, range.current);
    }
    const positions = [...events.keys()].sort((a, b) => a - b);
    let active = 0;
    let activeCurrent = 0;
    return <>{positions.slice(0, -1).map((start, index) => {
        const event = events.get(start)!;
        active += event.all;
        activeCurrent += event.current;
        const end = positions[index + 1]!;
        if (end <= start) return null;
        const text = props.text.slice(start, end);
        const current = activeCurrent > 0;
        return active > 0 ? <Text key={start} useDefaultTypography={false} selectable={props.selectable} testID={current ? 'find-match-current' : 'find-match-all'}
            style={current ? marks.current : marks.all}>{text}</Text> : text;
    })}</>;
}

export function sliceFindRanges(ranges: readonly FindTextRange[] | undefined, start: number, length: number) {
    return ranges?.filter((range) => range.end > start && range.start < start + length)
        .map((range) => ({ start: Math.max(0, range.start - start), end: Math.min(length, range.end - start), current: range.current }));
}
