import * as React from 'react';
import { Pressable } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { createTwoFilesPatch } from 'diff';
import { Ionicons } from '@expo/vector-icons';

import { getSingularPatch } from '@pierre/diffs';
import type { DiffLineAnnotation, FileDiffMetadata, FileDiffOptions, OnDiffLineClickProps } from '@pierre/diffs';
import { FileDiff, Virtualizer, WorkerPoolContext, useVirtualizer } from '@pierre/diffs/react';

import { useSetting } from '@/sync/domains/state/storage';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { t } from '@/text';
import { looksLikeUnifiedDiff } from '@/scm/diff/looksLikeUnifiedDiff';
import { extractUnifiedDiffForSingleFile } from '@/scm/diff/extractUnifiedDiffForSingleFile';

import type { DiffViewerProps } from '../diffViewerTypes';
import { ensureHappierPierreThemesRegistered } from './pierreThemeRegistry.web';
import { getPierreDiffWorkerPool } from './pierreWorkerPool.web';
import { buildPierreDiffOptionsBase } from './buildPierreDiffOptionsBase.web';
import { resolvePierreLanguageOverride } from './resolvePierreLanguageOverride.web';
import { buildCodeLinesFromUnifiedDiff } from '@/components/ui/code/model/buildCodeLinesFromUnifiedDiff';
import type { CodeLine } from '@/components/ui/code/model/codeLineTypes';

class PierreDiffErrorBoundary extends React.Component<
    Readonly<{ children: React.ReactNode; fallback: React.ReactNode }>,
    Readonly<{ hasError: boolean }>
> {
    override state = { hasError: false };

    static getDerivedStateFromError(): { hasError: boolean } {
        return { hasError: true };
    }

    override componentDidCatch() {
        // Intentionally empty: this boundary exists to prevent Pierre from crashing the app
        // on binary/no-hunk diffs and other unexpected patch shapes.
    }

    override render() {
        if (this.state.hasError) return this.props.fallback;
        return this.props.children;
    }
}

function resolveClickedSideFromNumberElement(numberElement: unknown): 'additions' | 'deletions' | null {
    const el: any = numberElement as any;
    if (!el) return null;

    const getAttr = (node: any, name: string): string | null => {
        try {
            return typeof node?.getAttribute === 'function' ? (node.getAttribute(name) as string | null) : null;
        } catch {
            return null;
        }
    };

    const closest = (node: any, selector: string): any => {
        try {
            return typeof node?.closest === 'function' ? node.closest(selector) : null;
        } catch {
            return null;
        }
    };

    // If the DOM already knows the line type, use it.
    const row = closest(el, '[data-line-type]');
    const lineType = getAttr(row, 'data-line-type') ?? getAttr(el, 'data-line-type');
    if (lineType === 'change-deletion') return 'deletions';
    if (lineType === 'change-addition') return 'additions';

    // Explicit column-side attributes (used by some Pierre renderers/themes).
    const explicitColumnSide = getAttr(el, 'data-column-side')
        ?? getAttr(el, 'data-side')
        ?? getAttr(closest(el, '[data-column-side]'), 'data-column-side')
        ?? getAttr(closest(el, '[data-side]'), 'data-side');
    if (explicitColumnSide === 'deletions' || explicitColumnSide === 'left' || explicitColumnSide === 'original') return 'deletions';
    if (explicitColumnSide === 'additions' || explicitColumnSide === 'right' || explicitColumnSide === 'modified') return 'additions';

    // Fallback: infer based on left/right position within the row.
    const getRect = (node: any): { left: number; width: number } | null => {
        try {
            return typeof node?.getBoundingClientRect === 'function' ? (node.getBoundingClientRect() as any) : null;
        } catch {
            return null;
        }
    };

    const rowRect = getRect(row);
    const cellRect = getRect(el);
    if (rowRect && cellRect && Number.isFinite(rowRect.left) && Number.isFinite(rowRect.width) && Number.isFinite(cellRect.left) && Number.isFinite(cellRect.width)) {
        const rowCenter = rowRect.left + rowRect.width / 2;
        const cellCenter = cellRect.left + cellRect.width / 2;
        return cellCenter < rowCenter ? 'deletions' : 'additions';
    }

    return null;
}

function buildPatchFromOldNew(params: Readonly<{ fileName: string; oldText: string; newText: string; contextLines: number }>): string {
    return createTwoFilesPatch(
        params.fileName,
        params.fileName,
        params.oldText,
        params.newText,
        '',
        '',
        { context: params.contextLines },
    );
}

function extractFirstDiffSegment(patch: string): string {
    if (typeof patch !== 'string') return '';
    const text = patch;

    const indices: number[] = [];
    const re = /^diff[ \t]/gm;
    let match: RegExpExecArray | null = null;
    while ((match = re.exec(text)) !== null) {
        if (typeof match.index === 'number') {
            indices.push(match.index);
            if (indices.length >= 2) break;
        }
    }
    if (indices.length >= 2) {
        const first = indices[0]!;
        const second = indices[1]!;
        return text.slice(first, second).trimEnd() + '\n';
    }

    // Some SCMs emit unified diffs without `diff ...` headers. Fall back to splitting on `---` preludes.
    const preludeIndices: number[] = [];
    const preludeRe = /^---[ \t]/gm;
    while ((match = preludeRe.exec(text)) !== null) {
        if (typeof match.index === 'number') {
            preludeIndices.push(match.index);
            if (preludeIndices.length >= 2) break;
        }
    }
    if (preludeIndices.length >= 2) {
        const first = preludeIndices[0]!;
        const second = preludeIndices[1]!;
        return text.slice(first, second).trimEnd() + '\n';
    }

    return patch;
}

function sanitizeUnifiedPatchForPierre(patch: string): string {
    if (typeof patch !== 'string') return '';
    const firstSegment = extractFirstDiffSegment(patch);
    if (!firstSegment) return '';

    // Preserve git-style `diff --git` headers when present. Some upstream logic (language inference,
    // selection id stability) relies on the canonical git prelude.
    if (/^diff --git[ \t]/m.test(firstSegment)) {
        return firstSegment.trimEnd() + '\n';
    }

    // For non-git diff headers (e.g. `diff -r ...`), strip to the unified `---/+++` prelude.
    const preludeIndex = firstSegment.search(/^---[ \t]/m);
    const withoutHeaders = preludeIndex > 0 ? firstSegment.slice(preludeIndex) : firstSegment;
    return withoutHeaders.trimEnd() + '\n';
}

function normalizeDiffPath(value: string): string {
    return String(value ?? '').replace(/\\/g, '/').replace(/^\.\/+/, '').trim();
}

function extractUnifiedPreludeDiffForSingleFile(params: Readonly<{ patch: string; filePath: string }>): string {
    const patch = typeof params.patch === 'string' ? params.patch : '';
    const normalizedPath = normalizeDiffPath(params.filePath);
    if (!patch || !normalizedPath) return patch;

    const normalizedPatch = patch.replace(/\r\n/g, '\n');
    const preludeMatches = normalizedPatch.match(/^---[ \t]/gm) ?? [];
    if (preludeMatches.length <= 1) return patch;

    const lines = normalizedPatch.split('\n');
    const preludeIndices: number[] = [];
    for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i] ?? '';
        if (line.startsWith('--- ')) preludeIndices.push(i);
    }
    if (preludeIndices.length <= 1) return patch;

    const needles = [`a/${normalizedPath}`, normalizedPath];
    for (let i = 0; i < preludeIndices.length; i += 1) {
        const start = preludeIndices[i]!;
        const end = preludeIndices[i + 1] ?? lines.length;
        const headerLine = lines[start] ?? '';

        if (!needles.some((needle) => headerLine.includes(needle))) continue;

        const segment = lines.slice(start, end).join('\n');
        return patch.includes('\r\n') ? segment.replace(/\n/g, '\r\n') : segment;
    }

    return patch;
}

export const PierreDiffViewer = React.memo<DiffViewerProps>((props) => {
    const { theme } = useUnistyles();
    const isDark = theme.dark === true;
    const sharedVirtualizer = useVirtualizer();
    const containerRef = React.useRef<HTMLDivElement | null>(null);

    const tokenizeMaxLineLengthSetting = useSetting('filesDiffTokenizationMaxLineLength');
    const intraLineDiffEnabledSetting = useSetting('filesDiffIntraLineWordDiffEnabled');
    const intraLineDiffMaxPatchLinesSetting = useSetting('filesDiffIntraLineWordDiffMaxPatchLines');
    const intraLineDiffMaxLineLengthSetting = useSetting('filesDiffIntraLineWordDiffMaxLineLength');
    const diffPresentationStyleSetting = useSetting('filesDiffPresentationStyle');

    const tokenizeMaxLineLength = typeof tokenizeMaxLineLengthSetting === 'number'
        ? tokenizeMaxLineLengthSetting
        : (settingsDefaults.filesDiffTokenizationMaxLineLength as number);
    const intraLineDiffEnabled = typeof intraLineDiffEnabledSetting === 'boolean'
        ? intraLineDiffEnabledSetting
        : (settingsDefaults.filesDiffIntraLineWordDiffEnabled as boolean);
    const intraLineDiffMaxPatchLines = typeof intraLineDiffMaxPatchLinesSetting === 'number'
        ? intraLineDiffMaxPatchLinesSetting
        : (settingsDefaults.filesDiffIntraLineWordDiffMaxPatchLines as number);
    const intraLineDiffMaxLineLength = typeof intraLineDiffMaxLineLengthSetting === 'number'
        ? intraLineDiffMaxLineLengthSetting
        : (settingsDefaults.filesDiffIntraLineWordDiffMaxLineLength as number);
    const diffStyle = props.presentationStyleOverride === 'unified' || props.presentationStyleOverride === 'split'
        ? props.presentationStyleOverride
        : diffPresentationStyleSetting === 'unified' || diffPresentationStyleSetting === 'split'
            ? diffPresentationStyleSetting
            : (settingsDefaults.filesDiffPresentationStyle === 'split' ? 'split' : 'unified');

    ensureHappierPierreThemesRegistered();

    const patch = React.useMemo(() => {
        if (props.mode === 'unified') return props.unifiedDiff;
        const fileName = props.filePath ?? 'diff';
        const contextLines = props.contextLines ?? 3;
        return buildPatchFromOldNew({ fileName, oldText: props.oldText, newText: props.newText, contextLines });
    }, [props]);

    const sanitizedPatch = React.useMemo(() => {
        if (props.mode !== 'unified') return patch;
        let candidate = patch;
        const filePath = typeof props.filePath === 'string' ? props.filePath : null;
        if (filePath && typeof candidate === 'string') {
            const diffHeaderCount = (candidate.match(/^diff --git /gm) ?? []).length;
            if (diffHeaderCount > 1) {
                candidate = extractUnifiedDiffForSingleFile({ patch: candidate, path: filePath });
            } else {
                const preludeCount = (candidate.match(/^---[ \t]/gm) ?? []).length;
                // Only apply prelude-based extraction when the patch truly has no `diff ...` headers.
                // For non-git `diff -r ...` formats, our existing sanitizer handles header trimming
                // by splitting at `diff` boundaries; prelude-only extraction can accidentally keep
                // the next file's `diff ...` line as a trailing "invalid" row.
                const hasAnyDiffHeader = /^diff[ \t]/m.test(candidate);
                if (!hasAnyDiffHeader && preludeCount > 1) {
                    candidate = extractUnifiedPreludeDiffForSingleFile({ patch: candidate, filePath });
                }
            }
        }
        return sanitizeUnifiedPatchForPierre(candidate);
    }, [patch, props.filePath, props.mode]);

    const pool = getPierreDiffWorkerPool({ style: diffStyle });

    const parsedPatch = React.useMemo(() => {
        // Avoid calling Pierre's parser for known non-unified placeholders (binary diffs)
        // and for empty diff strings. Some versions log diagnostics before throwing.
        if (!looksLikeUnifiedDiff(sanitizedPatch)) return null;
        try {
            return getSingularPatch(sanitizedPatch);
        } catch {
            return null;
        }
    }, [sanitizedPatch]);

    const needsCodeLines = Boolean(
        props.onPressLine
        || props.onPressAddComment
        || props.isCommentActive
        || props.renderAfterLine
        || (props.selectedLineIds && props.selectedLineIds.size > 0)
        || props.scrollToLineId
        || props.highlightLineId
    );

    const codeLines: readonly CodeLine[] | null = React.useMemo(() => {
        if (!needsCodeLines) return null;
        return buildCodeLinesFromUnifiedDiff({
            unifiedDiff: sanitizedPatch,
            hideFilePrelude: true,
        });
    }, [needsCodeLines, sanitizedPatch]);

    const codeLinesByAdditionLine = React.useMemo(() => {
        if (!codeLines) return null;
        const map = new Map<number, CodeLine>();
        for (const line of codeLines) {
            if (line.renderIsHeaderLine) continue;
            const n = line.newLine;
            if (typeof n !== 'number' || n <= 0) continue;
            map.set(n, line);
        }
        return map;
    }, [codeLines]);

    const codeLinesByDeletionLine = React.useMemo(() => {
        if (!codeLines) return null;
        const map = new Map<number, CodeLine>();
        for (const line of codeLines) {
            if (line.renderIsHeaderLine) continue;
            const n = line.oldLine;
            if (typeof n !== 'number' || n <= 0) continue;
            map.set(n, line);
        }
        return map;
    }, [codeLines]);

    const mapPierreDiffLineToCodeLine = React.useCallback((event: Pick<OnDiffLineClickProps, 'annotationSide' | 'lineNumber'> & Partial<Pick<OnDiffLineClickProps, 'lineType' | 'numberElement'>>): CodeLine | null => {
        const lineNumber = event.lineNumber;
        if (typeof lineNumber !== 'number' || lineNumber <= 0) return null;
        const lineType = event.lineType;
        if (lineType === 'change-deletion') return codeLinesByDeletionLine?.get(lineNumber) ?? null;
        if (lineType === 'change-addition') return codeLinesByAdditionLine?.get(lineNumber) ?? null;
        if (lineType === 'context' || lineType === 'context-expanded') {
            const deletionCandidate = codeLinesByDeletionLine?.get(lineNumber) ?? null;
            const additionCandidate = codeLinesByAdditionLine?.get(lineNumber) ?? null;

            const deletionIsContext = deletionCandidate?.kind === 'context';
            const additionIsContext = additionCandidate?.kind === 'context';

            if (deletionIsContext && !additionIsContext) return deletionCandidate;
            if (additionIsContext && !deletionIsContext) return additionCandidate;

            const domSide = resolveClickedSideFromNumberElement(event.numberElement);
            const preferredSide = domSide ?? event.annotationSide;
            if (preferredSide === 'deletions') return deletionCandidate ?? additionCandidate ?? null;
            return additionCandidate ?? deletionCandidate ?? null;
        }
        if (event.annotationSide === 'deletions') return codeLinesByDeletionLine?.get(lineNumber) ?? null;
        return codeLinesByAdditionLine?.get(lineNumber) ?? null;
    }, [codeLinesByAdditionLine, codeLinesByDeletionLine]);

    const lineAnnotations: DiffLineAnnotation<React.ReactNode>[] | undefined = React.useMemo(() => {
        if (!codeLines) return undefined;
        if (!props.renderAfterLine) return undefined;

        const out: DiffLineAnnotation<React.ReactNode>[] = [];
        for (const line of codeLines) {
            if (line.renderIsHeaderLine) continue;
            const node = props.renderAfterLine(line);
            if (!node) continue;

            const side = line.kind === 'remove' ? 'deletions' : 'additions';
            const lineNumber = side === 'deletions' ? line.oldLine : line.newLine;
            if (typeof lineNumber !== 'number' || lineNumber <= 0) continue;

            out.push({ side, lineNumber, metadata: node });
        }

        return out.length > 0 ? out : undefined;
    }, [codeLines, props]);

    const renderAnnotation = React.useCallback((annotation: DiffLineAnnotation<React.ReactNode>) => {
        return annotation.metadata ?? null;
    }, []);

    const fileDiff: FileDiffMetadata = React.useMemo(() => {
        const parsed = parsedPatch;
        if (!parsed) {
            // This value is only used if we end up rendering <FileDiff>. When the patch is invalid,
            // we render a fallback state instead of crashing Pierre.
            return { name: typeof props.filePath === 'string' ? props.filePath : 'diff', hunks: [] } as any;
        }
        const pathFromProp = typeof props.filePath === 'string' && props.filePath.trim() ? props.filePath.trim() : null;
        const pathCandidate = pathFromProp ?? (typeof parsed.name === 'string' && parsed.name.trim() ? parsed.name.trim() : null);
        const languageOverride = resolvePierreLanguageOverride(pathCandidate);
        if (!languageOverride) return parsed;
        return { ...parsed, lang: languageOverride };
    }, [parsedPatch, props.filePath]);

    const baseOptions = React.useMemo<FileDiffOptions<React.ReactNode>>(() => {
        return buildPierreDiffOptionsBase({
            isDark,
            diffStyle,
            patchText: sanitizedPatch,
            wrapLines: props.wrapLines !== false,
            showLineNumbers: props.showLineNumbers !== false,
            showPrefix: props.showPrefix !== false,
            tokenizeMaxLineLength,
            intraLineDiff: {
                enabled: intraLineDiffEnabled === true,
                maxPatchLines: intraLineDiffMaxPatchLines,
                maxLineLength: intraLineDiffMaxLineLength,
            },
        });
    }, [diffStyle, intraLineDiffEnabled, intraLineDiffMaxLineLength, intraLineDiffMaxPatchLines, isDark, props.showLineNumbers, props.showPrefix, props.wrapLines, sanitizedPatch, tokenizeMaxLineLength]);

    const selectedLineUnsafeCSS = React.useMemo(() => {
        if (!codeLines) return '';
        const selected = props.selectedLineIds ?? null;
        if (!selected || selected.size === 0) return '';

        const selectedAdditions: number[] = [];
        const selectedDeletions: number[] = [];

        for (const line of codeLines) {
            if (line.renderIsHeaderLine) continue;
            if (!selected.has(line.id)) continue;
            if (line.kind === 'add') {
                if (typeof line.newLine === 'number' && line.newLine > 0) selectedAdditions.push(line.newLine);
            } else if (line.kind === 'remove') {
                if (typeof line.oldLine === 'number' && line.oldLine > 0) selectedDeletions.push(line.oldLine);
            }
        }

        if (selectedAdditions.length === 0 && selectedDeletions.length === 0) return '';

        const additionLineSelectors = selectedAdditions.map((n) => `[data-line-type='change-addition'][data-line='${n}']`).join(',\n');
        const deletionLineSelectors = selectedDeletions.map((n) => `[data-line-type='change-deletion'][data-line='${n}']`).join(',\n');
        const additionNumberSelectors = selectedAdditions.map((n) => `[data-line-type='change-addition'][data-column-number='${n}']`).join(',\n');
        const deletionNumberSelectors = selectedDeletions.map((n) => `[data-line-type='change-deletion'][data-column-number='${n}']`).join(',\n');

        return [
            additionLineSelectors,
            deletionLineSelectors,
        ].filter(Boolean).join(',\n') + ` {\n  background-color: var(--diffs-bg-selection);\n}\n` + [
            additionNumberSelectors,
            deletionNumberSelectors,
        ].filter(Boolean).join(',\n') + ` {\n  color: var(--diffs-selection-number-fg);\n  background-color: var(--diffs-bg-selection-number);\n}\n`;
    }, [codeLines, props.selectedLineIds]);

    const highlightLineUnsafeCSS = React.useMemo(() => {
        if (!codeLines) return '';
        const highlightId = props.highlightLineId ?? null;
        if (!highlightId) return '';
        const target = codeLines.find((l) => l.id === highlightId) ?? null;
        if (!target || target.renderIsHeaderLine) return '';

        const lineType = target.kind === 'remove'
            ? 'change-deletion'
            : target.kind === 'add'
                ? 'change-addition'
                : 'context';
        const lineNumber = lineType === 'change-deletion' ? target.oldLine : target.newLine;
        if (typeof lineNumber !== 'number' || lineNumber <= 0) return '';

        const lineSelector = `[data-line-type='${lineType}'][data-line='${lineNumber}']`;
        const numberSelector = `[data-line-type='${lineType}'][data-column-number='${lineNumber}']`;

        return `${lineSelector} {\n  box-shadow: inset 0 0 0 1px var(--diffs-selection-base);\n}\n${numberSelector} {\n  box-shadow: inset 0 0 0 1px var(--diffs-selection-base);\n}\n`;
    }, [codeLines, props.highlightLineId]);

    const composedUnsafeCSS = React.useMemo(() => {
        return [selectedLineUnsafeCSS, highlightLineUnsafeCSS].filter(Boolean).join('\n');
    }, [highlightLineUnsafeCSS, selectedLineUnsafeCSS]);

    const lastInjectedUnsafeCSSRef = React.useRef<string>('');

    const unsafeCSSForPierre = React.useMemo(() => {
        if (composedUnsafeCSS.length > 0) return composedUnsafeCSS;
        if (lastInjectedUnsafeCSSRef.current.length > 0) return '/* happier:pierre:clear */';
        return '';
    }, [composedUnsafeCSS]);

    React.useEffect(() => {
        if (composedUnsafeCSS.length > 0) {
            lastInjectedUnsafeCSSRef.current = composedUnsafeCSS;
        } else if (unsafeCSSForPierre.includes('happier:pierre:clear')) {
            // Selection/highlight cleared; do not keep forcing the clear marker.
            lastInjectedUnsafeCSSRef.current = '';
        }
    }, [composedUnsafeCSS, unsafeCSSForPierre]);

    const options = React.useMemo<FileDiffOptions<React.ReactNode>>(() => {
        return {
            ...baseOptions,
            unsafeCSS: unsafeCSSForPierre.length > 0 ? unsafeCSSForPierre : undefined,
        };
    }, [baseOptions, unsafeCSSForPierre]);

    const interactiveOptions = React.useMemo(() => {
        if (!needsCodeLines) return null;

        const withClicks: FileDiffOptions<React.ReactNode> = {
            ...options,
            enableHoverUtility: Boolean(props.onPressAddComment),
            lineHoverHighlight: props.onPressAddComment ? 'line' : options.lineHoverHighlight,
            onLineClick: props.onPressLine
                ? (ev: any) => {
                    const mapped = mapPierreDiffLineToCodeLine(ev);
                    if (!mapped) return;
                    props.onPressLine?.(mapped);
                }
                : undefined,
            onLineNumberClick: props.onPressAddComment
                ? (ev: any) => {
                    const mapped = mapPierreDiffLineToCodeLine(ev);
                    if (!mapped) return;
                    props.onPressAddComment?.(mapped);
                }
                : undefined,
        };

        return withClicks;
    }, [mapPierreDiffLineToCodeLine, needsCodeLines, options, props.onPressAddComment, props.onPressLine]);

    const renderHoverUtility = React.useCallback((getHoveredLine: () => { lineNumber: number; side: 'additions' | 'deletions' } | undefined) => {
        if (!props.onPressAddComment) return null;
        const hovered = getHoveredLine?.() ?? undefined;
        if (!hovered) return null;
        const mapped = mapPierreDiffLineToCodeLine({ annotationSide: hovered.side, lineNumber: hovered.lineNumber });
        if (!mapped) return null;
        if (mapped.renderIsHeaderLine) return null;

        const active = props.isCommentActive ? props.isCommentActive(mapped) : false;

        return (
            <Pressable
                accessibilityRole="button"
                onPress={() => props.onPressAddComment?.(mapped)}
                style={{
                    paddingLeft: 8,
                    paddingTop: 2,
                    cursor: 'pointer' as any,
                }}
            >
                <Ionicons
                    name={active ? 'close-circle-outline' : 'add-circle-outline'}
                    size={16}
                    color={(theme as any)?.colors?.textSecondary ?? '#999'}
                />
            </Pressable>
        );
    }, [mapPierreDiffLineToCodeLine, props, theme]);

    React.useEffect(() => {
        const scrollId = props.scrollToLineId ?? null;
        if (!scrollId) return;
        if (!codeLines) return;

        const target = codeLines.find((l) => l.id === scrollId) ?? null;
        if (!target || target.renderIsHeaderLine) return;

        const lineType = target.kind === 'remove'
            ? 'change-deletion'
            : target.kind === 'add'
                ? 'change-addition'
                : 'context';
        const lineNumber = lineType === 'change-deletion' ? target.oldLine : target.newLine;
        if (typeof lineNumber !== 'number' || lineNumber <= 0) return;

        const root = containerRef.current;
        if (!root) return;

        const host = root.querySelector('diffs-container') as any;
        const shadowRoot = host?.shadowRoot ?? null;
        const queryRoot: ParentNode = shadowRoot ?? root;

        const selector = `[data-line-type='${lineType}'][data-line='${lineNumber}']`;
        const el = (queryRoot as any)?.querySelector?.(selector) as any;
        if (!el || typeof el.scrollIntoView !== 'function') return;
        try {
            el.scrollIntoView({ block: 'center' });
        } catch {
            // ignore
        }
    }, [codeLines, props.scrollToLineId]);

    if (!parsedPatch) {
        const raw = typeof patch === 'string' ? patch.trim() : '';
        const message = raw.length > 0 ? raw : t('files.noChanges');
        return (
            <div
                ref={containerRef}
                data-testid="pierre-diff-fallback"
                className="happier-pierre-diff-wrapper"
                style={{
                    padding: 16,
                    color: (theme as any)?.colors?.textSecondary ?? (isDark ? '#b0b0b0' : '#6a6a6a'),
                    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, \"Liberation Mono\", \"Courier New\", monospace',
                    fontSize: 12,
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                }}
            >
                {message}
            </div>
        );
    }

    const fallbackNode = (() => {
        const raw = typeof sanitizedPatch === 'string' ? sanitizedPatch.trim() : '';
        const message = raw.length > 0 ? raw : t('files.noChanges');
        return (
            <div
                data-testid="pierre-diff-fallback"
                className="happier-pierre-diff-wrapper"
                style={{
                    padding: 16,
                    color: (theme as any)?.colors?.textSecondary ?? (isDark ? '#b0b0b0' : '#6a6a6a'),
                    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, \"Liberation Mono\", \"Courier New\", monospace',
                    fontSize: 12,
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                }}
            >
                {message}
            </div>
        );
    })();

    const body = props.virtualized && !sharedVirtualizer ? (
        <Virtualizer
            style={{ maxHeight: 'inherit', overflowY: 'auto' }}
        >
            <FileDiff
                fileDiff={fileDiff}
                options={(interactiveOptions ?? options) as any}
                lineAnnotations={lineAnnotations as any}
                renderAnnotation={lineAnnotations ? (renderAnnotation as any) : undefined}
                renderHoverUtility={props.onPressAddComment ? (renderHoverUtility as any) : undefined}
                style={{ display: 'block', width: '100%' }}
            />
        </Virtualizer>
    ) : (
        <FileDiff
            fileDiff={fileDiff}
            options={(interactiveOptions ?? options) as any}
            lineAnnotations={lineAnnotations as any}
            renderAnnotation={lineAnnotations ? (renderAnnotation as any) : undefined}
            renderHoverUtility={props.onPressAddComment ? (renderHoverUtility as any) : undefined}
            style={{ display: 'block', width: '100%' }}
        />
    );

    return (
        <div ref={containerRef} data-testid="pierre-diff-viewer" className="happier-pierre-diff-wrapper">
            <WorkerPoolContext.Provider value={pool ?? undefined}>
                <PierreDiffErrorBoundary key={typeof sanitizedPatch === 'string' ? sanitizedPatch : String(sanitizedPatch)} fallback={fallbackNode}>
                    {body}
                </PierreDiffErrorBoundary>
            </WorkerPoolContext.Provider>
        </div>
    );
});
