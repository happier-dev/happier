import React from 'react';
import { FlatList, Platform, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import type { CodeLine } from '@/components/ui/code/model/codeLineTypes';
import type { CodeLinesSyntaxHighlightingConfig } from '@/components/ui/code/highlighting/useCodeLinesSyntaxHighlighting';

import { CodeLineRow } from './CodeLineRow';

type ShikiInlineToken = Readonly<{ text: string; color: string }>;

type ShikiToken = Readonly<{ content: string; color?: string }>;
type ShikiCodeToTokensResult = Readonly<{ tokens: readonly (readonly ShikiToken[])[]; fg?: string }>;
type ShikiHighlighter = Readonly<{
    codeToTokens: (code: string, params: { lang: string; theme: string }) => ShikiCodeToTokensResult;
}>;

const shikiHighlighterCache = new Map<string, Promise<ShikiHighlighter>>();

async function getShikiHighlighter(params: { theme: string; language: string }): Promise<ShikiHighlighter> {
    const key = `${params.theme}:${params.language}`;
    const existing = shikiHighlighterCache.get(key);
    if (existing) return existing;

    const promise = (async () => {
        const shiki = await import('shiki');
        // Shiki expects language ids like "ts"; our file-language resolver returns human names.
        const lang = params.language.toLowerCase() === 'typescript'
            ? 'ts'
            : params.language.toLowerCase() === 'javascript'
                ? 'js'
                : params.language.toLowerCase() === 'py'
                    ? 'python'
                    : params.language.toLowerCase();

        return shiki.createHighlighter({
            themes: [params.theme],
            langs: [lang],
        });
    })();

    shikiHighlighterCache.set(key, promise);
    return promise;
}

export function CodeLinesView(props: {
    lines: readonly CodeLine[];
    selectedLineIds?: ReadonlySet<string>;
    onPressLine?: (line: CodeLine) => void;
    onPressAddComment?: (line: CodeLine) => void;
    isCommentActive?: (line: CodeLine) => boolean;
    renderAfterLine?: (line: CodeLine) => React.ReactNode;
    contentPaddingHorizontal?: number;
    contentPaddingVertical?: number;
    wrapLines?: boolean;
    virtualized?: boolean;
    showLineNumbers?: boolean;
    showPrefix?: boolean;
    syntaxHighlighting?: CodeLinesSyntaxHighlightingConfig;
    scrollToLineId?: string;
    highlightLineId?: string;
}) {
    const { theme } = useUnistyles();
    const selected = props.selectedLineIds ?? new Set<string>();
    const paddingHorizontal = props.contentPaddingHorizontal ?? 0;
    const paddingVertical = props.contentPaddingVertical ?? 0;
    const wrapLines = props.wrapLines ?? true;
    const virtualized = props.virtualized ?? true;
    const showLineNumbers = props.showLineNumbers ?? true;
    const showPrefix = props.showPrefix ?? true;

    const effectiveSyntaxHighlighting = React.useMemo(() => {
        const cfg = props.syntaxHighlighting;
        if (!cfg || cfg.mode === 'off') {
            return { mode: 'off' as const, language: null as string | null, maxLineLength: 0 };
        }

        // Best-effort perf guardrails: treat JS string length as bytes (works well for ASCII source).
        if (props.lines.length > cfg.maxLines) {
            return { mode: 'off' as const, language: null as string | null, maxLineLength: 0 };
        }
        let totalChars = 0;
        for (const line of props.lines) {
            totalChars += (line.renderCodeText ?? '').length;
            if (totalChars > cfg.maxBytes) {
                return { mode: 'off' as const, language: null as string | null, maxLineLength: 0 };
            }
        }

        return { mode: cfg.mode, language: cfg.language, maxLineLength: cfg.maxLineLength };
    }, [props.lines, props.syntaxHighlighting]);

    const [advancedTokensByIndex, setAdvancedTokensByIndex] = React.useState<readonly (readonly ShikiInlineToken[] | null)[] | null>(null);
    const [advancedTokensRevision, setAdvancedTokensRevision] = React.useState(0);

    const shikiTheme = theme.dark ? 'github-dark' : 'github-light';
    const shikiEnabled = effectiveSyntaxHighlighting.mode === 'advanced'
        && Platform.OS === 'web'
        && Boolean(effectiveSyntaxHighlighting.language);

    const codeLinesForShiki = React.useMemo(() => {
        if (!shikiEnabled) return null;
        return props.lines.map((l) => (l.renderIsHeaderLine ? '' : (l.renderCodeText ?? '')));
    }, [props.lines, shikiEnabled]);

    React.useEffect(() => {
        if (!shikiEnabled) {
            setAdvancedTokensByIndex(null);
            return;
        }
        if (!effectiveSyntaxHighlighting.language) {
            setAdvancedTokensByIndex(null);
            return;
        }
        const inputLines = codeLinesForShiki;
        if (!inputLines) return;

        let cancelled = false;

        void (async () => {
            try {
                const highlighter = await getShikiHighlighter({
                    theme: shikiTheme,
                    language: effectiveSyntaxHighlighting.language,
                });

                const lang = effectiveSyntaxHighlighting.language.toLowerCase() === 'typescript'
                    ? 'ts'
                    : effectiveSyntaxHighlighting.language.toLowerCase() === 'javascript'
                        ? 'js'
                        : effectiveSyntaxHighlighting.language.toLowerCase() === 'py'
                            ? 'python'
                            : effectiveSyntaxHighlighting.language.toLowerCase();

                const res = highlighter.codeToTokens(inputLines.join('\n'), {
                    lang,
                    theme: shikiTheme,
                });

                const fg = typeof res.fg === 'string' ? res.fg : '#000';
                const tokens2d = res.tokens ?? [];

                const out: Array<readonly ShikiInlineToken[] | null> = [];
                for (let i = 0; i < props.lines.length; i++) {
                    const line = props.lines[i];
                    if (!line || line.renderIsHeaderLine) {
                        out.push(null);
                        continue;
                    }
                    if ((line.renderCodeText ?? '').length > effectiveSyntaxHighlighting.maxLineLength) {
                        out.push(null);
                        continue;
                    }
                    const row = tokens2d[i] ?? [];
                    out.push(row.map((t) => ({
                        text: t.content ?? '',
                        color: t.color ?? fg,
                    })));
                }

                if (cancelled) return;
                setAdvancedTokensByIndex(out);
                setAdvancedTokensRevision((v) => v + 1);
            } catch {
                if (cancelled) return;
                setAdvancedTokensByIndex(null);
            }
        })();

        return () => {
            cancelled = true;
        };
    }, [
        codeLinesForShiki,
        effectiveSyntaxHighlighting.language,
        effectiveSyntaxHighlighting.maxLineLength,
        props.lines,
        shikiEnabled,
        shikiTheme,
    ]);

    const renderLine = (item: CodeLine, index: number) => (
        <View>
            <CodeLineRow
                line={item}
                selected={selected.has(item.id)}
                highlighted={props.highlightLineId === item.id}
                onPressLine={props.onPressLine}
                onPressAddComment={props.onPressAddComment}
                commentActive={props.isCommentActive ? props.isCommentActive(item) : false}
                wrapLines={wrapLines}
                showLineNumbers={showLineNumbers}
                showPrefix={showPrefix}
                syntaxHighlighting={effectiveSyntaxHighlighting}
                advancedTokens={(effectiveSyntaxHighlighting.mode === 'advanced' ? (advancedTokensByIndex?.[index] ?? undefined) : undefined) ?? undefined}
            />
            {props.renderAfterLine ? props.renderAfterLine(item) : null}
        </View>
    );

    const listRef = React.useRef<FlatList<CodeLine> | null>(null);

    const scrollIndex = React.useMemo(() => {
        const id = props.scrollToLineId;
        if (!id) return -1;
        return props.lines.findIndex((l) => l.id === id);
    }, [props.lines, props.scrollToLineId]);

    React.useEffect(() => {
        if (scrollIndex < 0) return;
        // Defer until after layout to avoid "no item at index" on first paint.
        const timer = setTimeout(() => {
            try {
                listRef.current?.scrollToIndex({ index: scrollIndex, viewPosition: 0.25, animated: true });
            } catch {
                // Best-effort only; failures should not break rendering.
            }
        }, 0);
        return () => clearTimeout(timer);
    }, [scrollIndex]);

    // FlatList is a PureComponent: when behavior depends on props outside `data`, we must provide `extraData`
    // to ensure rows get re-rendered. This matters for "selected" state and inline review-comment composers.
    const listExtraData = React.useMemo(() => ({
        selectedLineIds: props.selectedLineIds,
        renderAfterLine: props.renderAfterLine,
        onPressLine: props.onPressLine,
        onPressAddComment: props.onPressAddComment,
        isCommentActive: props.isCommentActive,
        wrapLines,
        showLineNumbers,
        showPrefix,
        syntaxHighlighting: effectiveSyntaxHighlighting,
        highlightLineId: props.highlightLineId,
        advancedTokensRevision,
    } as const), [
        effectiveSyntaxHighlighting,
        advancedTokensRevision,
        props.highlightLineId,
        props.isCommentActive,
        props.onPressAddComment,
        props.onPressLine,
        props.renderAfterLine,
        props.selectedLineIds,
        showLineNumbers,
        showPrefix,
        wrapLines,
    ]);

    return (
        <FlatList
            ref={(node) => {
                // react-test-renderer does not provide a stable ref object; we store it manually.
                listRef.current = node as any;
            }}
            data={props.lines as CodeLine[]}
            keyExtractor={(item) => item.id}
            renderItem={({ item, index }) => renderLine(item, index)}
            extraData={listExtraData}
            disableVirtualization={!virtualized}
            contentContainerStyle={{
                paddingHorizontal,
                paddingVertical,
            }}
            ListFooterComponent={<View style={{ height: 16 }} />}
            onScrollToIndexFailed={(info) => {
                // Best-effort retry: FlatList can fail if measurement hasn't completed yet.
                setTimeout(() => {
                    try {
                        listRef.current?.scrollToIndex({ index: info.index, viewPosition: 0.25, animated: true });
                    } catch {
                        // ignore
                    }
                }, 50);
            }}
        />
    );
}
