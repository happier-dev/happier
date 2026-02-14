import React from 'react';
import { FlatList, View } from 'react-native';

import type { CodeLine } from '@/components/ui/code/model/codeLineTypes';
import type { CodeLinesSyntaxHighlightingConfig } from '@/components/ui/code/highlighting/useCodeLinesSyntaxHighlighting';

import { CodeLineRow } from './CodeLineRow';

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
}) {
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

        // Until advanced tokenization lands, treat advanced as simple to avoid a "no highlight" trap.
        const mode = cfg.mode === 'advanced' ? 'simple' : cfg.mode;
        return { mode, language: cfg.language, maxLineLength: cfg.maxLineLength };
    }, [props.lines, props.syntaxHighlighting]);

    const renderLine = (item: CodeLine) => (
        <View>
            <CodeLineRow
                line={item}
                selected={selected.has(item.id)}
                onPressLine={props.onPressLine}
                onPressAddComment={props.onPressAddComment}
                commentActive={props.isCommentActive ? props.isCommentActive(item) : false}
                wrapLines={wrapLines}
                showLineNumbers={showLineNumbers}
                showPrefix={showPrefix}
                syntaxHighlighting={effectiveSyntaxHighlighting}
            />
            {props.renderAfterLine ? props.renderAfterLine(item) : null}
        </View>
    );

    // FlatList is a PureComponent: when behavior depends on props outside `data`, we must provide `extraData`
    // to ensure rows get re-rendered. This matters for "selected" state and inline review-comment composers.
    const listExtraData = React.useMemo(() => {
        if (!virtualized) return null;
        return {
            selectedLineIds: props.selectedLineIds,
            renderAfterLine: props.renderAfterLine,
            onPressLine: props.onPressLine,
            onPressAddComment: props.onPressAddComment,
            isCommentActive: props.isCommentActive,
            wrapLines,
            showLineNumbers,
            showPrefix,
            syntaxHighlighting: effectiveSyntaxHighlighting,
        } as const;
    }, [
        effectiveSyntaxHighlighting,
        props.isCommentActive,
        props.onPressAddComment,
        props.onPressLine,
        props.renderAfterLine,
        props.selectedLineIds,
        showLineNumbers,
        showPrefix,
        virtualized,
        wrapLines,
    ]);

    if (!virtualized) {
        return (
            <View style={{ paddingHorizontal, paddingVertical }}>
                {props.lines.map((item) => (
                    <React.Fragment key={item.id}>
                        {renderLine(item)}
                    </React.Fragment>
                ))}
                <View style={{ height: 16 }} />
            </View>
        );
    }

    return (
        <FlatList
            data={props.lines as CodeLine[]}
            keyExtractor={(item) => item.id}
            renderItem={({ item }) => renderLine(item)}
            extraData={listExtraData}
            contentContainerStyle={{
                paddingHorizontal,
                paddingVertical,
            }}
            ListFooterComponent={<View style={{ height: 16 }} />}
        />
    );
}
