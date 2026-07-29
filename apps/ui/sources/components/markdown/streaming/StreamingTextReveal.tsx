import * as React from 'react';
import type { StyleProp, TextStyle } from 'react-native';
import { Platform } from 'react-native';
import {
    readCommonPrefixLength,
    splitStreamingRevealTextParts,
    type StreamingRevealRange,
} from 'react-native-enriched-markdown/lib/module/web/streamingReveal.js';

import { Text } from '@/components/ui/text/Text';
import { resolveStreamingTextRevealConfig, type StreamingTextRevealPreset } from './streamingTextRevealConfig';
import { useWebRevealStyleInsertion } from './useWebRevealStyleInsertion';

const REVEAL_STYLE_ID = 'happier-streaming-markdown-reveal-style';
const REVEAL_TRANSLATE_Y_VAR = '--happier-streaming-markdown-reveal-y';

let revealStyleInjected = false;

function injectRevealStyle(): void {
    if (revealStyleInjected || Platform.OS !== 'web') return;
    if (typeof document === 'undefined') return;

    revealStyleInjected = true;
    if (document.getElementById(REVEAL_STYLE_ID)) return;

    const style = document.createElement('style');
    style.id = REVEAL_STYLE_ID;
    style.textContent = [
        '@keyframes happierMarkdownWordReveal {',
        `  from { opacity: 0; transform: translateY(var(${REVEAL_TRANSLATE_Y_VAR}, 2px)); }`,
        '  to { opacity: 1; transform: translateY(0); }',
        '}',
    ].join('\n');
    document.head.appendChild(style);
}

export function StreamingTextReveal(props: {
    text: string;
    selectable?: boolean;
    style?: StyleProp<TextStyle>;
    animated?: boolean;
    preset?: StreamingTextRevealPreset;
}) {
    const revealConfig = resolveStreamingTextRevealConfig({
        animated: props.animated,
        preset: props.preset,
    });
    const previousTextRef = React.useRef('');
    const commonPrefixLength = readCommonPrefixLength(previousTextRef.current, props.text);
    const parts = React.useMemo(() => {
        // Plain text is a single appended-suffix reveal: everything after the common
        // prefix animates. The shared package splitter owns word semantics for both
        // streaming surfaces (plain and enriched).
        const appendedSuffixRanges: StreamingRevealRange[] =
            props.text.length > commonPrefixLength
                ? [{ start: commonPrefixLength, end: props.text.length, expiresAtMs: Number.MAX_SAFE_INTEGER }]
                : [];
        return splitStreamingRevealTextParts({
            text: props.text,
            startOffset: 0,
            activeRanges: appendedSuffixRanges,
        });
    }, [commonPrefixLength, props.text]);

    React.useEffect(() => {
        previousTextRef.current = props.text;
    }, [props.text]);

    useWebRevealStyleInsertion({
        enabled: revealConfig != null,
        injectStyle: injectRevealStyle,
    });

    if (Platform.OS !== 'web' || revealConfig == null) {
        return (
            <Text selectable={props.selectable} style={props.style}>
                {props.text}
            </Text>
        );
    }

    return (
        <Text selectable={props.selectable} style={props.style}>
            {parts.map((part, index) => {
                if (!part.animated) {
                    return part.text;
                }

                return React.createElement(
                    'span',
                    {
                        key: `${part.startOffset}:${index}`,
                        'data-happier-streaming-text-reveal': 'word',
                        style: {
                            [REVEAL_TRANSLATE_Y_VAR]: `${revealConfig.translateYPx}px`,
                            animationName: 'happierMarkdownWordReveal',
                            animationDuration: `${revealConfig.durationMs}ms`,
                            animationTimingFunction: revealConfig.easing,
                            animationFillMode: 'both',
                            display: 'inline-block',
                        },
                    },
                    part.text,
                );
            })}
        </Text>
    );
}
