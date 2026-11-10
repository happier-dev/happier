import * as React from 'react';
import { INLINE_REFERENCE_HREF_PREFIX_V1 } from '@happier-dev/protocol/runtime/input/inlineReferenceTokenV1';
import { Platform, type StyleProp, type TextStyle } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { readIconSvgCssUrl } from '@/components/ui/icons/iconSvgMarkup';
import { resolveReferenceChipIconName } from '@/components/ui/referenceChip/referenceChipIcon';
import { referenceChipLinkRule, type ReferenceChipInks } from '@/components/ui/referenceChip/referenceChipStyles';
import { nativeReferenceChipColor, nativeReferenceChipGlyph } from '@/components/ui/referenceChip/nativeReferenceChip';
import { NATIVE_REFERENCE_CHIP_ANATOMY } from '@/components/ui/forms/multiTextInputTypography';
import { Typography } from '@/constants/Typography';
import { EnrichedMarkdownText, type EnrichedMarkdownTextProps } from 'react-native-enriched-markdown';
import { useHappierTextSelectability } from '@happier-dev/plugin-ui/presentation';

import { resolveEnrichedMarkdownMd4cFlags } from './enrichedMarkdownConstants';
import {
    normalizeMarkdownLinkUrl,
    openMarkdownLinkUrl,
    sanitizeEnrichedMarkdownWithInlineReferences,
} from './enrichedMarkdownLinkHandling';
import {
    readMarkdownInlineReferenceTarget,
    type MarkdownInlineReference,
    type MarkdownInlineReferences,
} from '../markdownInlineReferences';
import { useEnrichedMarkdownRuntimeStatus } from './preloadEnrichedMarkdownRuntime';
import { resolveEnrichedMarkdownFlavor } from './resolveEnrichedMarkdownFlavor';
import { useEnrichedMarkdownStyle } from './useEnrichedMarkdownStyle';
import type { MarkdownRenderingProfile } from '../rendering/MarkdownRenderingProfile';
import {
    resolveStreamingTextRevealConfig,
    type StreamingTextRevealPreset,
} from '../streaming/streamingTextRevealConfig';
import { useWebRevealStyleInsertion } from '../streaming/useWebRevealStyleInsertion';
import { MarkdownWorkspaceFileLinksContext } from '../rendering/MarkdownLinkPolicyContext';
import { useMarkdownAppLinkOpener } from './useMarkdownAppLinkOpener';

const ENRICHED_REVEAL_STYLE_ID = 'happier-streaming-enriched-markdown-reveal-style';
const ENRICHED_REVEAL_DURATION_VAR = '--happier-streaming-enriched-markdown-duration';
const ENRICHED_REVEAL_EASING_VAR = '--happier-streaming-enriched-markdown-easing';
const ENRICHED_REVEAL_TRANSLATE_Y_VAR = '--happier-streaming-enriched-markdown-y';
const ENRICHED_LEADING_MARGIN_STYLE_ID = 'happier-enriched-markdown-leading-margin-style';
const ENRICHED_WIDGET_STYLE_ID = 'happier-enriched-markdown-widget-style';

let enrichedRevealStyleInjected = false;
let enrichedLeadingMarginStyleInjected = false;
let enrichedWidgetStyleInjected = false;

/** Style the incumbent task checkbox; keep its native input semantics and keyboard focus. */
function injectEnrichedWidgetStyle(): void {
    if (enrichedWidgetStyleInjected || Platform.OS !== 'web' || typeof document === 'undefined') return;
    enrichedWidgetStyleInjected = true;
    if (document.getElementById(ENRICHED_WIDGET_STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = ENRICHED_WIDGET_STYLE_ID;
    const scope = '[data-happier-enriched-markdown-profile="widget"]';
    const task = `${scope} li:has(> span > input[type="checkbox"]) > span`;
    style.textContent = [
        `${scope} { min-width: 0; }`,
        `${task} { display: flex; flex: 1; min-width: 0; align-items: flex-start; gap: 8px; }`,
        `${task} > input { appearance: none; flex-shrink: 0; margin: 2px 0 0 !important; border: 1px solid var(--happier-widget-check-border); background: transparent; position: relative; }`,
        `${task} > input:checked { background: var(--happier-widget-check-fill); border-color: var(--happier-widget-check-fill); }`,
        `${task} > input:checked::after { content: ""; position: absolute; width: 25%; height: 50%; left: 35%; top: 12%; border: solid var(--happier-widget-check-mark); border-width: 0 1.5px 1.5px 0; transform: rotate(45deg); }`,
        `@media (forced-colors: active) { ${task} > input { appearance: auto; } ${task} > input::after { display: none; } }`,
    ].join('\n');
    document.head.appendChild(style);
}

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
    /** A run followed by another segment of the same document keeps its last block's bottom margin (the rhythm between them). */
    keepTrailingMargin?: boolean;
    fillContainer?: boolean;
    agentTexMath: boolean;
    inlineReferences?: MarkdownInlineReferences;
    /** Older native binaries do not yet include the actual rendered text. */
    contextMenuItems?: readonly Readonly<{ text: string; onPress: (event: {
        text: string; renderedText?: string; selection: { start: number; end: number };
    }) => void }>[];
}>;

/**
 * The colours of the inline references in one run. The package draws a link with its own inline style,
 * so web uses one scoped rule per resolved reference; native consumes the same resolved presentation.
 * A reference that carries a severity reads as ink on its tint with the severity's dot leading the label
 * (Walkthrough lab WT5-R6): colour marks the severity, the words stay text. Every other reference is the
 * shared reference chip (`referenceChipStyles`), led by its glyph or picture.
 */
function useWebInlineReferenceStyle(scope: string, references: ReadonlyMap<string, MarkdownInlineReference>, ink: string, inks: ReferenceChipInks): void {
    const css = React.useMemo(() => [...(Platform.OS === 'web' ? references.entries() : [])].map(([href, reference]) => {
        const selector = `[data-happier-md-refs="${scope}"] a[href="${href.replace(/["\\]/g, (char) => `\\${char}`)}"]`;
        if (!reference.severity) {
            const icon = resolveReferenceChipIconName({ ref: href.slice(INLINE_REFERENCE_HREF_PREFIX_V1.length), glyph: reference.glyph });
            return referenceChipLinkRule(selector, {
                color: reference.foreground,
                background: reference.background,
                inks,
                thumbnailUri: reference.thumbnail?.uri ?? null,
                glyphUrl: icon ? readIconSvgCssUrl(icon) : null,
            });
        }
        const rule = `${selector} {`
            + ` color: ${reference.severity ? ink : reference.foreground} !important; background-color: ${reference.background} !important;`
            + ' text-decoration: none !important; border-radius: 6px; padding: 1px 6px; font-size: 0.86em; font-weight: 600;'
            // A long reference (a file path) wraps inside its message rather than running past the bubble; each
            // line keeps the chip's fill and inset.
            + ' overflow-wrap: anywhere; -webkit-box-decoration-break: clone; box-decoration-break: clone; }';
        return reference.severity
            ? `${rule}\n${selector}::before { content: ""; display: inline-block; width: 7px; height: 7px; border-radius: 4px;`
                + ` margin-right: 5px; vertical-align: 1px; background-color: ${reference.foreground}; }`
            : rule;
    }).join('\n'), [ink, inks, references, scope]);
    React.useLayoutEffect(() => {
        if (Platform.OS !== 'web' || typeof document === 'undefined' || !css) return undefined;
        const style = document.createElement('style');
        style.setAttribute('data-happier-md-refs-style', scope);
        style.textContent = css;
        document.head.appendChild(style);
        return () => { style.remove(); };
    }, [css, scope]);
}

export const EnrichedMarkdownTextAdapter = React.memo((props: EnrichedMarkdownTextAdapterProps) => {
    const workspaceFileLinks = React.useContext(MarkdownWorkspaceFileLinksContext);
    const selectable = useHappierTextSelectability(props.selectable);
    const runtimeStatus = useEnrichedMarkdownRuntimeStatus();
    const styleBundle = useEnrichedMarkdownStyle({
        profile: props.profile,
        textStyle: props.textStyle,
    });

    const inlineReferences = props.inlineReferences;
    const openAppHref = useMarkdownAppLinkOpener();
    const handleLinkPress = React.useCallback((event: { url: string }) => {
        // A cited reference belongs to its owner; it is never opened as a URL.
        if (event.url.startsWith(INLINE_REFERENCE_HREF_PREFIX_V1)) {
            const target = inlineReferences ? readMarkdownInlineReferenceTarget(event.url, inlineReferences.scheme) : null;
            if (target) inlineReferences?.onPress?.(target);
            return;
        }
        const normalizedUrl = normalizeMarkdownLinkUrl(event.url, { workspaceFileLinks });
        if (!normalizedUrl) return;
        void openMarkdownLinkUrl(normalizedUrl, undefined, { openAppHref, onLinkPress: props.onLinkPress });
    }, [inlineReferences, props.onLinkPress, workspaceFileLinks, openAppHref]);
    const revealConfig = resolveStreamingTextRevealConfig({
        animated: props.streamingAnimated,
        preset: props.streamingRevealPreset,
    });
    const sanitized = React.useMemo(
        () => sanitizeEnrichedMarkdownWithInlineReferences(props.markdown, inlineReferences, { workspaceFileLinks }),
        [inlineReferences, props.markdown, workspaceFileLinks],
    );
    const sanitizedMarkdown = sanitized.markdown;
    const referenceScope = React.useId();
    // The words take the ink of the prose they sit in.
    const { theme } = useUnistyles();
    const chipInks = React.useMemo<ReferenceChipInks>(() => ({
        secondary: theme.colors.text.secondary, tertiary: theme.colors.text.tertiary,
        accent: theme.colors.accent.blue, focus: theme.colors.border.focus,
    }), [theme.colors.accent.blue, theme.colors.border.focus, theme.colors.text.secondary, theme.colors.text.tertiary]);
    useWebInlineReferenceStyle(referenceScope, sanitized.references, String(styleBundle.markdownStyle.paragraph?.color ?? 'inherit'), chipInks);
    // Ordinary native links share the run's link colour; chips carry their own resolved inks.
    const markdownStyle = React.useMemo(() => {
        const base = styleBundle.markdownStyle;
        const citesSeverity = [...sanitized.references.values()].some((reference) => reference.severity);
        if (Platform.OS === 'web') return base;
        const referenceChips = JSON.stringify({
            anatomy: Object.fromEntries(Object.entries(NATIVE_REFERENCE_CHIP_ANATOMY)
                .map(([name, value]) => [name, value * styleBundle.uiFontScale])),
            fontSize: base.paragraph?.fontSize,
            fontFamily: Typography.default('medium').fontFamily,
            references: Object.fromEntries([...sanitized.references].map(([href, reference]) => [href, {
                label: reference.label,
                glyph: nativeReferenceChipGlyph(href.slice(INLINE_REFERENCE_HREF_PREFIX_V1.length), reference.glyph, Platform.OS, reference.thumbnail != null),
                thumbnail: reference.thumbnail?.uri ?? '',
                foreground: nativeReferenceChipColor(reference.foreground),
                background: nativeReferenceChipColor(reference.background),
                glyphInk: nativeReferenceChipColor(chipInks.secondary),
            }])),
        });
        return { ...base, link: { ...base.link, referenceChips,
            ...(citesSeverity && base.paragraph?.color ? { color: base.paragraph.color } : {}),
        } };
    }, [chipInks.secondary, sanitized.references, styleBundle.markdownStyle, styleBundle.uiFontScale]);
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

    useWebRevealStyleInsertion({ enabled: props.profile === 'widget', injectStyle: injectEnrichedWidgetStyle });

    const platformProps = React.useMemo<Record<string, unknown>>(() => {
        if (Platform.OS === 'web') {
            const webProps: Record<string, unknown> = {
                'data-testid': props.testID,
                'data-happier-enriched-markdown-profile': props.profile,
            };
            if (sanitized.references.size > 0) webProps['data-happier-md-refs'] = referenceScope;
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
    }, [flavor, props.profile, props.streamingAnimated, props.suppressLeadingTopMargin, props.testID, referenceScope, sanitized.references.size]);

    const containerStyle = React.useMemo(() => {
        const baseContainerStyle = props.fillContainer === false
            ? { ...styleBundle.containerStyle, width: undefined }
            : styleBundle.containerStyle;
        if (Platform.OS !== 'web') {
            return baseContainerStyle;
        }

        return ({
            ...baseContainerStyle,
            ...(props.profile === 'widget' ? {
                '--happier-widget-check-border': styleBundle.markdownStyle.taskList?.borderColor,
                '--happier-widget-check-fill': styleBundle.markdownStyle.taskList?.checkedColor,
                '--happier-widget-check-mark': styleBundle.markdownStyle.taskList?.checkmarkColor,
            } : {}),
            ...(revealConfig ? {
                [ENRICHED_REVEAL_DURATION_VAR]: `${revealConfig.durationMs}ms`,
                [ENRICHED_REVEAL_EASING_VAR]: revealConfig.easing,
                [ENRICHED_REVEAL_TRANSLATE_Y_VAR]: `${revealConfig.translateYPx}px`,
            } : {}),
        } as unknown) as EnrichedMarkdownTextProps['containerStyle'];
    }, [props.fillContainer, props.profile, revealConfig, styleBundle]);

    return (
        <EnrichedMarkdownText
            key={runtimeStatus === 'ready' ? 'runtime-ready' : 'runtime-cold'}
            {...platformProps}
            markdown={sanitizedMarkdown}
            markdownStyle={markdownStyle}
            containerStyle={containerStyle}
            md4cFlags={md4cFlags}
            onLinkPress={handleLinkPress}
            selectable={selectable}
            {...(props.contextMenuItems ? { contextMenuItems: props.contextMenuItems.map((item) => ({ text: item.text, onPress: item.onPress })) } : {})}
            allowTrailingMargin={props.keepTrailingMargin === true}
            flavor={flavor}
        />
    );
});
