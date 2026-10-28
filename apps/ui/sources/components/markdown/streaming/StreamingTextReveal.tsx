import * as React from 'react';
import type { StyleProp, TextStyle } from 'react-native';
import { Platform } from 'react-native';
import { splitStreamingRevealTextParts } from 'react-native-enriched-markdown/lib/module/web/streamingReveal.js';

import { Text } from '@/components/ui/text/Text';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { resolveAppendedSuffixRevealRanges } from './reveal/resolveAppendedSuffixRevealRanges';
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
    // The OS reduced-motion preference is a host fact owned by the shared process-wide
    // store; reading it through the established hook keeps this streaming row one of its
    // many readers instead of allocating a fresh matchMedia probe per render. The call
    // stays above the web-only branch below so hook order is stable on every platform.
    const reducedMotion = useReducedMotionPreference();
    const revealConfig = resolveStreamingTextRevealConfig({
        animated: props.animated,
        preset: props.preset,
        reducedMotion,
    });
    const previousTextRef = React.useRef('');
    const previousText = previousTextRef.current;
    const parts = React.useMemo(() => {
        // Plain text is a single appended-suffix reveal. `resolveAppendedSuffixRevealRanges`
        // owns which characters are new (including the empty-baseline mount rule); the
        // shared package splitter owns word semantics for both streaming surfaces
        // (plain and enriched).
        return splitStreamingRevealTextParts({
            text: props.text,
            startOffset: 0,
            activeRanges: resolveAppendedSuffixRevealRanges({
                previousText,
                currentText: props.text,
            }),
        });
    }, [previousText, props.text]);

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
