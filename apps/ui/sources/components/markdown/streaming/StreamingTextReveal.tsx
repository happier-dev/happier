import * as React from 'react';
import type { StyleProp, TextStyle } from 'react-native';
import { Platform } from 'react-native';

import { Text } from '@/components/ui/text/Text';
import {
    readCommonPrefixLength,
    splitStreamingRevealTextParts,
} from './reveal/splitStreamingRevealTextParts';
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
    const parts = React.useMemo(() => splitStreamingRevealTextParts({
        text: props.text,
        commonPrefixLength,
    }), [commonPrefixLength, props.text]);

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

    let cursor = 0;
    return (
        <Text selectable={props.selectable} style={props.style}>
            {parts.map((part, index) => {
                const start = cursor;
                const end = start + part.text.length;
                cursor = end;

                if (!part.animated) {
                    return part.text;
                }

                return React.createElement(
                    'span',
                    {
                        key: index,
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
