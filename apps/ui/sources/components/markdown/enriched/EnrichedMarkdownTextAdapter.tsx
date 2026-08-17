import * as React from 'react';
import { Platform, type StyleProp, type TextStyle } from 'react-native';
import { EnrichedMarkdownText, type EnrichedMarkdownTextProps } from 'react-native-enriched-markdown';

import { resolveEnrichedMarkdownMd4cFlags } from './enrichedMarkdownConstants';
import {
    normalizeMarkdownLinkUrl,
    openMarkdownLinkUrl,
    sanitizeEnrichedMarkdownLinkTargets,
} from './enrichedMarkdownLinkHandling';
import { useEnrichedMarkdownRuntimeStatus } from './preloadEnrichedMarkdownRuntime';
import { resolveEnrichedMarkdownFlavor } from './resolveEnrichedMarkdownFlavor';
import { useEnrichedMarkdownStyle } from './useEnrichedMarkdownStyle';
import type { MarkdownRenderingProfile } from '../rendering/MarkdownRenderingProfile';
import {
    resolveStreamingTextRevealConfig,
    type StreamingTextRevealPreset,
} from '../streaming/streamingTextRevealConfig';
import { useWebRevealStyleInsertion } from '../streaming/useWebRevealStyleInsertion';

const ENRICHED_REVEAL_STYLE_ID = 'happier-streaming-enriched-markdown-reveal-style';
const ENRICHED_REVEAL_DURATION_VAR = '--happier-streaming-enriched-markdown-duration';
const ENRICHED_REVEAL_EASING_VAR = '--happier-streaming-enriched-markdown-easing';
const ENRICHED_REVEAL_TRANSLATE_Y_VAR = '--happier-streaming-enriched-markdown-y';
const ENRICHED_LEADING_MARGIN_STYLE_ID = 'happier-enriched-markdown-leading-margin-style';

let enrichedRevealStyleInjected = false;
let enrichedLeadingMarginStyleInjected = false;

function injectEnrichedRevealStyle(): void {
    if (enrichedRevealStyleInjected || Platform.OS !== 'web') return;
    if (typeof document === 'undefined') return;

    enrichedRevealStyleInjected = true;
    if (document.getElementById(ENRICHED_REVEAL_STYLE_ID)) return;

    const style = document.createElement('style');
    style.id = ENRICHED_REVEAL_STYLE_ID;
    style.textContent = [
        '@keyframes happierStreamingEnrichedMarkdownReveal {',
        `  from { opacity: 0; transform: translateY(var(${ENRICHED_REVEAL_TRANSLATE_Y_VAR}, 2px)); }`,
        '  to { opacity: 1; transform: translateY(0); }',
        '}',
        '[data-happier-enriched-markdown-reveal="text"] {',
        '  animation-name: happierStreamingEnrichedMarkdownReveal;',
        `  animation-duration: var(${ENRICHED_REVEAL_DURATION_VAR}, 150ms);`,
        `  animation-timing-function: var(${ENRICHED_REVEAL_EASING_VAR}, ease-out);`,
        '  animation-fill-mode: both;',
        '  display: inline-block;',
        '}',
        '@media (prefers-reduced-motion: reduce) {',
        '  [data-happier-enriched-markdown-reveal="text"] {',
        '    animation: none !important;',
        '    opacity: 1 !important;',
        '    transform: none !important;',
        '  }',
        '}',
    ].join('\n');
    document.head.appendChild(style);
}

function injectEnrichedLeadingMarginStyle(): void {
    if (enrichedLeadingMarginStyleInjected || Platform.OS !== 'web') return;
    if (typeof document === 'undefined') return;

    enrichedLeadingMarginStyleInjected = true;
    if (document.getElementById(ENRICHED_LEADING_MARGIN_STYLE_ID)) return;

    const style = document.createElement('style');
    style.id = ENRICHED_LEADING_MARGIN_STYLE_ID;
    style.textContent = [
        '[data-happier-enriched-markdown-trim-leading-margin="true"] :is(h1, h2, h3, h4, h5, h6, p, blockquote, pre, ul, ol, table):first-child {',
        '  margin-top: 0 !important;',
        '}',
    ].join('\n');
    document.head.appendChild(style);
}

type EnrichedMarkdownTextAdapterProps = Readonly<{
    markdown: string;
    profile: MarkdownRenderingProfile;
    selectable: boolean;
    onLinkPress?: (url: string) => boolean | void;
    textStyle?: StyleProp<TextStyle>;
    streamingAnimated: boolean;
    streamingRevealPreset?: StreamingTextRevealPreset;
    testID?: string;
    suppressLeadingTopMargin?: boolean;
    fillContainer?: boolean;
    agentTexMath: boolean;
}>;

export const EnrichedMarkdownTextAdapter = React.memo((props: EnrichedMarkdownTextAdapterProps) => {
    const runtimeStatus = useEnrichedMarkdownRuntimeStatus();
    const styleBundle = useEnrichedMarkdownStyle({
        profile: props.profile,
        textStyle: props.textStyle,
    });

    const handleLinkPress = React.useCallback((event: { url: string }) => {
        const normalizedUrl = normalizeMarkdownLinkUrl(event.url);
        if (!normalizedUrl) return;
        if (props.onLinkPress?.(normalizedUrl) === true) return;
        void openMarkdownLinkUrl(normalizedUrl);
    }, [props.onLinkPress]);
    const revealConfig = resolveStreamingTextRevealConfig({
        animated: props.streamingAnimated,
        preset: props.streamingRevealPreset,
    });
    const sanitizedMarkdown = React.useMemo(
        () => sanitizeEnrichedMarkdownLinkTargets(props.markdown),
        [props.markdown],
    );
    const flavor = React.useMemo(
        () => resolveEnrichedMarkdownFlavor(sanitizedMarkdown),
        [sanitizedMarkdown],
    );
    const md4cFlags = resolveEnrichedMarkdownMd4cFlags(props.agentTexMath);

    useWebRevealStyleInsertion({
        enabled: revealConfig != null,
        injectStyle: injectEnrichedRevealStyle,
    });

    useWebRevealStyleInsertion({
        enabled: props.suppressLeadingTopMargin === true,
        injectStyle: injectEnrichedLeadingMarginStyle,
    });

    const platformProps = React.useMemo<Record<string, unknown>>(() => {
        if (Platform.OS === 'web') {
            const webProps: Record<string, unknown> = {
                'data-testid': props.testID,
            };
            if (props.streamingAnimated) {
                // Per-word, not per-block: the package stamps
                // `data-happier-enriched-markdown-reveal="text"` on the words its reveal
                // ranges classify as newly appended, and the injected keyframe above styles
                // exactly those spans. Stamping the attribute on the container instead made
                // the same keyframe fade the whole block in on every mount — including
                // windowing remounts of content that was already on screen — which no
                // range-level guard can undo, because CSS never sees that history.
                webProps.streamingAnimation = true;
            }
            if (props.suppressLeadingTopMargin === true) {
                webProps['data-happier-enriched-markdown-trim-leading-margin'] = 'true';
            }
            return webProps;
        }

        return {
            testID: props.testID,
            enableLinkPreview: false,
            allowFontScaling: true,
            streamingAnimation: props.streamingAnimated && flavor === 'commonmark',
        };
    }, [flavor, props.streamingAnimated, props.suppressLeadingTopMargin, props.testID]);

    const containerStyle = React.useMemo(() => {
        const baseContainerStyle = props.fillContainer === false
            ? { ...styleBundle.containerStyle, width: undefined }
            : styleBundle.containerStyle;
        if (Platform.OS !== 'web' || revealConfig == null) {
            return baseContainerStyle;
        }

        return ({
            ...baseContainerStyle,
            [ENRICHED_REVEAL_DURATION_VAR]: `${revealConfig.durationMs}ms`,
            [ENRICHED_REVEAL_EASING_VAR]: revealConfig.easing,
            [ENRICHED_REVEAL_TRANSLATE_Y_VAR]: `${revealConfig.translateYPx}px`,
        } as unknown) as EnrichedMarkdownTextProps['containerStyle'];
    }, [props.fillContainer, revealConfig, styleBundle.containerStyle]);

    return (
        <EnrichedMarkdownText
            key={runtimeStatus === 'ready' ? 'runtime-ready' : 'runtime-cold'}
            {...platformProps}
            markdown={sanitizedMarkdown}
            markdownStyle={styleBundle.markdownStyle}
            containerStyle={containerStyle}
            md4cFlags={md4cFlags}
            onLinkPress={handleLinkPress}
            selectable={props.selectable}
            allowTrailingMargin={false}
            flavor={flavor}
        />
    );
});
