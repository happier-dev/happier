import { useEffectiveDiffPresentation } from '../diffPresentationStyle';
import { DiffHunkRowTextInsetContext } from '../hunks/DiffHunkRow';
import { DiffFindOpenedFoldRow } from '../DiffFindOpenedFoldRow';
import { CODE_LINE_BASE_HEIGHT } from '@/components/ui/code/view/CodeLineRow';
import * as React from 'react';
import { PierreDiffScrollAnchor } from './PierreDiffScrollAnchor.web';
import { useUnistyles } from 'react-native-unistyles';
import { glassSurfaceBackgroundColor } from '@/components/ui/glass/glassSurfacePaint';
import { createTwoFilesPatch } from 'diff';

import { hydratePartialDiff, parseDiffFromFile, parsePatchFiles, VirtualizedFileDiff, Virtualizer as PierreVirtualizer } from '@pierre/diffs';
import { applyHunks, parseUnifiedDiffHunks } from '@happier-dev/protocol/diff/hunks';
import type { DiffLineAnnotation, FileDiffMetadata, FileDiffOptions, OnDiffLineClickProps, FileDiff as PierreFileDiffInstance, SelectedLineRange } from '@pierre/diffs';
import { FileDiff, Virtualizer, VirtualizerContext, WorkerPoolContext, useVirtualizer } from '@pierre/diffs/react';
import { usePierreEnclosingScrollRoot, usePierreScrollRootVirtualizer } from './PierreScrollRootVirtualizerProvider.web';
import { readPierreDomLine } from './pierreDomLine';
import { localizePierreSeparatorText } from './pierreSeparatorText.web';

import { useSetting } from '@/sync/store/settingsReadHooks';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { t } from '@/text';
import { looksLikeUnifiedDiff } from '@/scm/diff/looksLikeUnifiedDiff';
import { extractUnifiedDiffForSingleFile } from '@/scm/diff/extractUnifiedDiffForSingleFile';

import type { DiffViewerProps } from '../diffViewerTypes';
import { ensureHappierPierreThemeRegistered, resolveHappierPierreThemeIds } from './pierreThemeRegistry.web';
import { getPierreDiffWorkerPool, getPierreDiffWorkerPoolFailed, subscribePierreDiffWorkerPool } from './pierreWorkerPool.web';
import { buildPierreDiffOptionsBase } from './buildPierreDiffOptionsBase.web';
import { pierreTextDiffContents } from './pierreTextDiffContents';
import { resolvePierreLanguageOverride } from './resolvePierreLanguageOverride.web';
import { buildCodeLinesFromUnifiedDiff } from '@/components/ui/code/model/buildCodeLinesFromUnifiedDiff';
import { buildCodeLinesFromTextDiff } from '@/components/ui/code/model/buildCodeLinesFromTextDiff';
import { buildCodeLinesFromFile } from '@/components/ui/code/model/buildCodeLinesFromFile';
import type { CodeLine } from '@/components/ui/code/model/codeLineTypes';
import { codeLineScrollTargetKey } from '@/components/ui/code/model/codeLineScrollTargetKey';
import { retainCodeLineLanding, scrollCodeLineIntoView } from '@/components/ui/code/view/scrollCodeLineIntoView';
import { resolveCodeLineRangeSelection } from '@/components/ui/code/interactions/resolveCodeLineRangeSelection';
import type { CodeTokenPointer } from '@/components/ui/code/interactions/codeTokenPress';
import { PIERRE_FIND_HIGHLIGHT_CSS, pierreCodeLineSelector, registerPierreFindHighlights } from './pierreFindHighlights.web';
import { bindPierreIntelligence, PIERRE_DIAGNOSTIC_HIGHLIGHT_NAMES } from './pierreIntelligence.web';
import { formatCodeEditorDiagnosticCss, resolveAgentWashColor, resolveCodeSelectionColor } from '@/components/ui/code/editor/editorTheme';
import { HappierUnifiedDiffViewer } from '../happier/HappierUnifiedDiffViewer';
import { HappierTextDiffViewer } from '../happier/HappierTextDiffViewer';
import { HAPPIER_UI_FONT_SCALE_CSS_VAR } from '@/components/ui/text/webUnistylesFontOverrides';
import { getDefaultFont } from '@/constants/Typography';
import { useEventCallback } from '@/hooks/ui/useEventCallback';
import { Icon } from '@/components/ui/icons/Icon';
import { resolveAgentIconSvgDataUri } from '@/agents/registry/AgentIcon';
import {
    REVIEW_COMMENT_LINE_AFFORDANCE_ICON_NAME,
    REVIEW_COMMENT_LINE_AFFORDANCE_ICON_TEST_ID,
    REVIEW_COMMENT_LINE_AFFORDANCE_TEST_ID,
} from '@/components/ui/code/reviewComments/ReviewCommentLineAffordance';
import {
    buildPierreInitialPresentationCacheKey,
    usePierreInitialPresentation,
} from './pierreInitialPresentation.web';

const HAPPIER_PIERRE_LINE_CLICK_HANDLED_KEY = '__happierPierreLineClickHandled';

type PierrePaint = Readonly<{
    node: HTMLElement;
    instance: PierreFileDiffInstance<React.ReactNode, undefined>;
    virtualizer: PierreVirtualizer | undefined;
}>;

function PierreFileDiffBody(props: React.ComponentProps<typeof FileDiff<React.ReactNode, undefined>> & Readonly<{
    onPaint: (paint: PierrePaint) => void;
}>) {
    const virtualizer = useVirtualizer();
    const { onPaint, ...fileProps } = props;
    const onPostRender = useEventCallback((node: HTMLElement, instance: PierreFileDiffInstance<React.ReactNode, undefined>) => {
        onPaint({ node, instance, virtualizer });
    });
    const options = React.useMemo(() => ({
        ...props.options,
        onPostRender,
    }), [onPostRender, props.options]);
    // Review rows sit in Pierre's code column; their label starts where its code text does (its 2ch inset).
    return <DiffHunkRowTextInsetContext.Provider value="2ch"><FileDiff {...fileProps} options={options} /></DiffHunkRowTextInsetContext.Provider>;
}

// Pierre supplies its pre/code backing from the syntax theme. Its public CSS adapter
// keeps that backing under the same content coat as the app's other code renderer.
const PIERRE_MATERIAL_UNSAFE_CSS = `
pre, code, [data-diffs-header], [data-diff], [data-file], [data-error-wrapper], [data-virtualizer-buffer] {
  --diffs-bg: var(--happier-diff-material-background);
}
[data-line-type='change-addition'], [data-line-type='change-deletion'] {
  /* 1.5 mixes a change row's colour into the backing (91%/88% backing); the app palette is already the row colour. */
  --mix-light: 0%;
  --mix-dark: 0%;
}
[data-no-newline][data-line-type] {
  /* EOF metadata describes the preceding source line; it is not another addition/deletion. */
  background: transparent;
}
[data-no-newline][data-line-type]::before { content: none; }
`;

// The patched library retains its original number/dataset for interactions. Desktop exposes both
// source coordinates; the compact phone gutter keeps the library's useful single coordinate.
const PIERRE_UNIFIED_GUTTER_UNSAFE_CSS = `
/* The separator band reads in the code face, like the Happier renderer's and the lab's (WT8). */
[data-separator] { font-family: var(--diffs-font-family, var(--diffs-font-fallback)); }
[data-separator-content] { display: flex; align-items: center; gap: 1ch; }
[data-hunk-context] { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; opacity: .8; }
/* Wrapped code fits the pane: a row slotted after a line (a change's Keep/Discard row) must not widen the code column past it. */
[data-diff][data-overflow=wrap] { --diffs-code-grid: var(--diffs-grid-number-column-width) minmax(0, 1fr); }
@media (min-width: 521px) {
  [data-unified] [data-gutter] { min-width: 8ch; }
  [data-unified] [data-column-number] { display: flex; gap: 1ch; justify-content: flex-end; }
  [data-unified] [data-column-number]::before { content: attr(data-old-line-number); display: inline-block; width: 3ch; text-align: right; }
  [data-unified] [data-line-number-content] { display: inline-block; width: 3ch; text-align: right; }
  [data-unified] [data-column-number][data-line-type='change-deletion'] [data-line-number-content] { visibility: hidden; }
}
`;

const PIERRE_REVIEW_COMMENT_HOVER_SLOT_UNSAFE_CSS = `
[data-column-number] {
  --happier-review-comment-affordance-width: 28px;
  padding-left: calc(var(--happier-review-comment-affordance-width) + 2ch);
}

[data-gutter-utility-slot] {
  left: 0;
  right: auto;
  width: var(--happier-review-comment-affordance-width);
  justify-content: flex-start;
}
@media (max-width: 520px) {
  [data-column-number] {
    --happier-review-comment-affordance-width: 20px;
    padding-left: calc(var(--happier-review-comment-affordance-width) + .5ch);
  }
}
`;

// Review marks are paint only. Changing Pierre's unsafeCSS resets measured wrapped-row heights,
// so these selectors stay static while the existing paint lifecycle marks mounted rows.
const PIERRE_REVIEWED_LINE_UNSAFE_CSS = `
:is([data-unified], [data-additions], [data-deletions]) [data-line][data-happier-reviewed] {
  background-color: var(--diffs-bg);
  transition: background-color 140ms ease-out;
}
:is([data-unified], [data-additions], [data-deletions]) [data-column-number][data-happier-reviewed] {
  background-color: var(--diffs-bg);
  box-shadow: inset -2px 0 0 var(--happier-diff-reviewed-edge);
}
@media (prefers-reduced-motion: reduce) { [data-line] { transition: none; } }
:is([data-unified], [data-additions], [data-deletions]) [data-line][data-happier-agent-wash] {
  box-shadow: inset 0 0 0 100vmax var(--happier-agent-wash);
}
/* Absolute at its static position: it stands right after the text and never takes room, so it never wraps. */
[data-line][data-happier-agent-caret]::after {
  content: attr(data-happier-agent-caret);
  position: absolute;
  z-index: 1;
  height: 16px;
  margin: 3px 0 0 1px;
  padding: 0 6px 0 24px;
  border-radius: 1px 4px 4px 1px;
  white-space: nowrap;
  pointer-events: none;
  background: var(--happier-agent-mark, none) no-repeat 9px center / 11px 11px,
    linear-gradient(to right, var(--happier-agent-ink) 0 2px, transparent 2px 4px, var(--happier-agent-ink) 4px);
  color: var(--happier-agent-on-ink);
  font: 600 11px/16px var(--diffs-header-font-family);
  animation: happier-agent-caret-in 140ms ease-out;
}
/* No room after the text (a narrow pane): the flag stands left of the caret, the bar still at the text's end. */
[data-line][data-happier-agent-caret-flip]::after {
  transform: translateX(calc(-100% + 2px));
  padding: 0 24px 0 6px;
  border-radius: 4px 1px 1px 4px;
  background: var(--happier-agent-mark, none) no-repeat right 9px center / 11px 11px,
    linear-gradient(to left, var(--happier-agent-ink) 0 2px, transparent 2px 4px, var(--happier-agent-ink) 4px);
}
@keyframes happier-agent-caret-in { from { opacity: 0; } to { opacity: 1; } }
@media (prefers-reduced-motion: reduce) { [data-line][data-happier-agent-caret]::after { animation-duration: 120ms; } }
`;

/** Whether the caret's flag fits between the line's last text box and the line's end (measured, never estimated). */
function agentCaretFlagFits(line: HTMLElement): boolean {
    if (typeof line.getBoundingClientRect !== 'function' || typeof document.createRange !== 'function') return true;
    const flag = Number.parseFloat(getComputedStyle(line, '::after').width);
    if (!Number.isFinite(flag) || flag <= 0) return true;
    const range = document.createRange();
    range.selectNodeContents(line);
    const boxes = range.getClientRects();
    const last = boxes.length > 0 ? boxes[boxes.length - 1] : null;
    if (!last) return true;
    return line.getBoundingClientRect().right - last.right >= flag + 2;
}

class PierreDiffErrorBoundary extends React.Component<
    Readonly<{ children: React.ReactNode; fallback: React.ReactNode; resetKey: unknown }>,
    Readonly<{ hasError: boolean }>
> {
    override state = { hasError: false };

    static getDerivedStateFromError(): { hasError: boolean } {
        return { hasError: true };
    }

    override componentDidUpdate(previous: Readonly<{ resetKey: unknown }>) {
        // Recover from a failed patch without remounting healthy scroll/virtualizer state.
        if (this.state.hasError && previous.resetKey !== this.props.resetKey) {
            this.setState({ hasError: false });
        }
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

function PierreReviewCommentHoverAffordance(props: {
    active: boolean;
    color: string;
    onPress: (event: MouseEvent | React.MouseEvent<HTMLButtonElement>) => void;
}) {
    const buttonRef = React.useRef<HTMLButtonElement | null>(null);
    const onPressRef = React.useRef(props.onPress);

    React.useEffect(() => {
        onPressRef.current = props.onPress;
    }, [props.onPress]);

    const handleClick = React.useCallback((event: MouseEvent | React.MouseEvent<HTMLButtonElement>) => {
        event.preventDefault();
        event.stopPropagation();
        if ('nativeEvent' in event) {
            event.nativeEvent.stopImmediatePropagation?.();
        } else {
            event.stopImmediatePropagation?.();
        }
        onPressRef.current(event);
    }, []);

    React.useEffect(() => {
        const button = buttonRef.current;
        if (!button) return undefined;
        button.addEventListener('click', handleClick);
        return () => button.removeEventListener('click', handleClick);
    }, [handleClick]);

    return (
        <button
            ref={buttonRef}
            aria-label={props.active ? t('files.reviewComments.closeCommentA11y') : t('files.reviewComments.addCommentA11y')}
            data-active={props.active ? 'true' : undefined}
            data-testid={REVIEW_COMMENT_LINE_AFFORDANCE_TEST_ID}
            onClick={handleClick}
            style={{
                width: 28,
                height: 24,
                borderRadius: 12,
                border: 0,
                padding: 0,
                background: 'transparent',
                color: props.color,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'pointer',
            }}
            type="button"
        >
            <Icon
                color={props.color}
                name={props.active ? 'x-circle' : REVIEW_COMMENT_LINE_AFFORDANCE_ICON_NAME}
                size={14}
                testID={REVIEW_COMMENT_LINE_AFFORDANCE_ICON_TEST_ID}
            />
        </button>
    );
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

function resolvePierreDiffLineFromPressEvent(event: unknown): (Pick<OnDiffLineClickProps, 'annotationSide' | 'lineNumber'> & Partial<Pick<OnDiffLineClickProps, 'lineType' | 'numberElement'>>) | null {
    const nativeEvent = ((event as { nativeEvent?: unknown } | null | undefined)?.nativeEvent ?? event) as any;
    const path = typeof nativeEvent?.composedPath === 'function'
        ? nativeEvent.composedPath()
        : [];
    if (!Array.isArray(path) || path.length === 0) return null;

    let lineNumber: number | null = null;
    let lineType: OnDiffLineClickProps['lineType'] | undefined;
    let numberElement: OnDiffLineClickProps['numberElement'] | undefined;

    for (const candidate of path) {
        const el = candidate as any;
        if (!el || typeof el.getAttribute !== 'function') continue;

        const columnNumber = el.getAttribute('data-column-number') as string | null;
        if (columnNumber && lineNumber == null) {
            const parsed = Number.parseInt(columnNumber, 10);
            if (Number.isFinite(parsed) && parsed > 0) {
                lineNumber = parsed;
                numberElement = el as OnDiffLineClickProps['numberElement'];
            }
        }

        const lineNumberAttr = el.getAttribute('data-line') as string | null;
        if (lineNumberAttr && lineNumber == null) {
            const parsed = Number.parseInt(lineNumberAttr, 10);
            if (Number.isFinite(parsed) && parsed > 0) {
                lineNumber = parsed;
            }
        }

        const candidateLineType = el.getAttribute('data-line-type') as string | null;
        if (
            candidateLineType === 'change-deletion'
            || candidateLineType === 'change-addition'
            || candidateLineType === 'context'
            || candidateLineType === 'context-expanded'
        ) {
            lineType = candidateLineType;
        }
    }

    if (lineNumber == null) return null;

    const annotationSide = lineType === 'change-deletion'
        ? 'deletions'
        : lineType === 'change-addition'
            ? 'additions'
            : (resolveClickedSideFromNumberElement(numberElement) ?? 'additions');

    return {
        annotationSide,
        lineNumber,
        lineType,
        numberElement,
    };
}

function readNativeEventObject(event: unknown): Record<string, unknown> | null {
    const wrapped = event as { nativeEvent?: unknown; event?: unknown } | null | undefined;
    const nativeEvent = wrapped?.nativeEvent ?? wrapped?.event ?? event;
    if (!nativeEvent || typeof nativeEvent !== 'object') return null;
    return nativeEvent as Record<string, unknown>;
}

function markPierreLineClickHandled(event: unknown) {
    const nativeEvent = readNativeEventObject(event);
    if (nativeEvent) nativeEvent[HAPPIER_PIERRE_LINE_CLICK_HANDLED_KEY] = true;
}

function pierreLineClickWasHandled(event: unknown): boolean {
    return readNativeEventObject(event)?.[HAPPIER_PIERRE_LINE_CLICK_HANDLED_KEY] === true;
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
        return text.slice(first, second).replace(/\n+$/, '') + '\n';
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
        return text.slice(first, second).replace(/\n+$/, '') + '\n';
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
        return firstSegment.replace(/\n+$/, '') + '\n';
    }

    // For non-git diff headers (e.g. `diff -r ...`), strip to the unified `---/+++` prelude.
    const preludeIndex = firstSegment.search(/^---[ \t]/m);
    const withoutHeaders = preludeIndex > 0 ? firstSegment.slice(preludeIndex) : firstSegment;
    return withoutHeaders.replace(/\n+$/, '') + '\n';
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

export function resolvePierreTypographyStyle(): React.CSSProperties & Readonly<{
    '--diffs-font-size': string;
    '--diffs-line-height': string;
    '--diffs-header-font-family': string;
}> {
    return {
        '--diffs-font-size': `calc(12px * var(${HAPPIER_UI_FONT_SCALE_CSS_VAR}, 1))`,
        '--diffs-line-height': `calc(${CODE_LINE_BASE_HEIGHT}px * var(${HAPPIER_UI_FONT_SCALE_CSS_VAR}, 1))`,
        '--diffs-header-font-family': getDefaultFont(),
    };
}

export function resolvePierreSelectionStyle(theme: { dark?: boolean; colors?: Record<string, any> } | null | undefined): React.CSSProperties {
    const colors = theme?.colors ?? {};
    const surfaceColors = colors.surface && typeof colors.surface === 'object' ? colors.surface : {};
    const surface = typeof surfaceColors.base === 'string' ? surfaceColors.base : undefined;
    const surfaceInset = typeof surfaceColors.inset === 'string' ? surfaceColors.inset : undefined;
    const stateColors = colors.state && typeof colors.state === 'object' ? colors.state : {};
    const successColors = stateColors.success && typeof stateColors.success === 'object' ? stateColors.success as Record<string, unknown> : {};
    const textColors = colors.text && typeof colors.text === 'object' ? colors.text as Record<string, unknown> : {};
    const selectionBase = typeof successColors.foreground === 'string'
        ? successColors.foreground
        : typeof textColors.link === 'string'
            ? textColors.link
            : surfaceInset;

    // Pierre's default red/green bases are deliberately vivid. The app's diff palette owns row,
    // gutter and word-emphasis colors so the same change reads alike in either renderer.
    const diff = colors.diff;
    const materialPaint = (color: string | undefined, nested = false) => color ? glassSurfaceBackgroundColor(color, 'content', nested) : undefined;
    const diffPalette: Record<string, string | undefined> = {
        '--happier-diff-material-background': materialPaint(diff?.context?.background ?? surface, true),
        '--happier-diff-reviewed-edge': typeof (colors.border as Record<string, unknown> | undefined)?.strong === 'string' ? (colors.border as Record<string, string>).strong : undefined,
        '--diffs-bg-buffer-override': materialPaint(diff?.context?.background ?? surface, true),
        '--diffs-bg-hover-override': materialPaint(typeof surfaceColors.elevated === 'string' ? surfaceColors.elevated : surface),
        '--diffs-bg-context-override': materialPaint(diff?.context?.background, true),
        '--diffs-bg-separator-override': materialPaint(diff?.context?.background, true),
        '--diffs-fg-number-override': diff?.lineNumber?.foreground,
        '--diffs-fg-number-addition-override': diff?.success,
        '--diffs-fg-number-deletion-override': diff?.error,
        '--diffs-addition-color-override': diff?.success,
        '--diffs-deletion-color-override': diff?.error,
        '--diffs-bg-addition-override': materialPaint(diff?.added?.background),
        '--diffs-bg-addition-number-override': materialPaint(diff?.added?.background),
        '--diffs-bg-addition-hover-override': materialPaint(diff?.added?.background),
        '--diffs-bg-addition-emphasis-override': materialPaint(diff?.inlineAdded?.background),
        '--diffs-bg-deletion-override': materialPaint(diff?.removed?.background),
        '--diffs-bg-deletion-number-override': materialPaint(diff?.removed?.background),
        '--diffs-bg-deletion-hover-override': materialPaint(diff?.removed?.background),
        '--diffs-bg-deletion-emphasis-override': materialPaint(diff?.inlineRemoved?.background),
    };

    return {
        ...diffPalette,
        // Track's agent caret and wash (P5 §3.10): ink, never a hue, from the code domain's owner.
        ['--happier-agent-wash' as any]: typeof textColors.primary === 'string'
            ? resolveAgentWashColor({ dark: theme?.dark === true, colors: { text: { primary: textColors.primary } } }) : undefined,
        ['--happier-agent-ink' as any]: textColors.primary,
        ['--happier-agent-on-ink' as any]: surface,
        ['--diffs-bg-selection' as any]: materialPaint(surfaceInset),
        ['--diffs-selection-number-fg' as any]: surface,
        ['--diffs-bg-selection-number' as any]: materialPaint(selectionBase),
        ['--diffs-selection-base' as any]: selectionBase,
    };
}

/**
 * A patch alone omits the unchanged text between its hunks. Completing the parsed patch from its before revision
 * (the hunks stay the patch's own) lets Pierre reveal that text, so Find can reach a match inside it.
 */
function completePatchFromBase(parsed: FileDiffMetadata, patch: string, baseText: string): FileDiffMetadata | null {
    if (!parsed.isPartial || (parsed.type !== 'change' && parsed.type !== 'rename-changed')) return null;
    const applied = applyHunks(baseText, parseUnifiedDiffHunks(patch));
    if (!applied.ok) return null;
    return hydratePartialDiff('clone', parsed, {
        oldFile: { name: parsed.prevName ?? parsed.name, contents: baseText },
        newFile: { name: parsed.name, contents: applied.text },
    });
}

/**
 * Starts the worker pool a list's diff bodies will draw with, before the first of them arrives
 * (`usePierreDiffRendererPreload`). The bodies then draw with Pierre at once, instead of first drawing
 * every line through the Happier renderer while the pool initializes.
 */
export function preparePierreDiffRenderer(params: Readonly<{
    style: 'unified' | 'split'; isDark: boolean; colors?: Record<string, unknown> | null;
}>): void {
    ensureHappierPierreThemeRegistered({ isDark: params.isDark, colors: params.colors });
    getPierreDiffWorkerPool({ style: params.style, themeIds: resolveHappierPierreThemeIds({ isDark: params.isDark, colors: params.colors }) });
}

export const PierreDiffViewer = React.memo<DiffViewerProps>((props) => {
    const { theme } = useUnistyles();
    const isDark = theme.dark === true;
    const inheritedVirtualizer = useVirtualizer();
    // A bounded body scrolls through its own complete diff. The enclosing file list's scroll
    // range includes only this body's viewport, so sharing that range makes later lines unreachable.
    // Inside a list that hands over its scroller (QB-81) the body is not bounded: it windows its lines
    // against that one scroller, whose range then holds the whole diff.
    const bounded = props.virtualized === true && !usePierreEnclosingScrollRoot();
    const scopedVirtualizer = usePierreScrollRootVirtualizer(bounded ? null : () => new PierreVirtualizer());
    const sharedVirtualizer = bounded ? undefined : scopedVirtualizer ?? inheritedVirtualizer;
    const containerRef = React.useRef<HTMLDivElement | null>(null);
    const lastScrolledLineIdRef = React.useRef<{ key: string; filePath: string | null | undefined } | null>(null);
    const typographyStyle = React.useMemo(() => resolvePierreTypographyStyle(), []);
    const selectionStyle = React.useMemo(() => ({
        ...resolvePierreSelectionStyle(theme),
        '--happier-find-match': theme.colors.find.matchAll,
        '--happier-find-current': theme.colors.find.matchCurrent,
        '--happier-find-current-foreground': theme.colors.find.matchCurrentForeground,
    }), [theme]);

    const tokenizeMaxLineLengthSetting = useSetting('filesDiffTokenizationMaxLineLength');
    const intraLineDiffEnabledSetting = useSetting('filesDiffIntraLineWordDiffEnabled');
    const intraLineDiffMaxPatchLinesSetting = useSetting('filesDiffIntraLineWordDiffMaxPatchLines');
    const intraLineDiffMaxLineLengthSetting = useSetting('filesDiffIntraLineWordDiffMaxLineLength');
    // The one split rule (`diffPresentationStyle`): the preference, drawn unified where the
    // enclosing Details group is too narrow for two readable sides.
    const effectiveDiffPresentation = useEffectiveDiffPresentation();

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
        : effectiveDiffPresentation.style;

    ensureHappierPierreThemeRegistered({ isDark, colors: theme.colors });
    const pierreThemeIds = resolveHappierPierreThemeIds({ isDark, colors: theme.colors });

    const patch = React.useMemo(() => {
        if (props.mode === 'unified') return props.unifiedDiff;
        const fileName = props.filePath ?? 'diff';
        const contextLines = props.contextLines ?? 3;
        return buildPatchFromOldNew({ fileName, oldText: props.oldText, newText: props.newText, contextLines });
    }, [props.mode, props.filePath, props.mode === 'unified' ? props.unifiedDiff : null,
        props.mode === 'text' ? props.oldText : null, props.mode === 'text' ? props.newText : null,
        props.mode === 'text' ? props.contextLines : null]);

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

    const subscribePool = React.useCallback((listener: () => void) => subscribePierreDiffWorkerPool(diffStyle, listener), [diffStyle]);
    const pool = getPierreDiffWorkerPool({ style: diffStyle, themeIds: pierreThemeIds });
    // Exact code remains readable while a healthy worker is still initializing.
    // The pool's readiness notification hands rendering back to Pierre.
    const getUseHappierRenderer = React.useCallback(() => getPierreDiffWorkerPoolFailed(diffStyle)
        || (pool !== null && !pool.isInitialized()), [diffStyle, pool]);
    const useHappierRenderer = React.useSyncExternalStore(subscribePool, getUseHappierRenderer, () => false);

    const parsedPatch = React.useMemo(() => {
        // Avoid calling Pierre's parser for known non-unified placeholders (binary diffs)
        // and for empty diff strings. Some versions log diagnostics before throwing.
        if (!looksLikeUnifiedDiff(sanitizedPatch)) return null;
        if (props.mode === 'unified') {
            // The provider or a Markdown author can supply an incomplete hunk. Pierre logs
            // a global diagnostic before throwing, so admit its declared line counts here
            // through the canonical hunk reader and keep unavailable evidence in this file.
            const hunks = parseUnifiedDiffHunks(sanitizedPatch);
            if (hunks.some((hunk) => hunk.lines.filter((line) => line.kind !== 'add').length !== hunk.oldLines
                || hunk.lines.filter((line) => line.kind !== 'remove').length !== hunk.newLines)) return null;
        }
        try {
            if (props.mode === 'text') {
                const name = props.filePath ?? 'diff';
                const { oldContents, newContents } = pierreTextDiffContents(props.oldText, props.newText);
                return parseDiffFromFile({ name, contents: oldContents }, { name, contents: newContents }, { context: props.contextLines ?? 3 });
            }
            // `getSingularPatch` console.errors the parsed array before throwing for a patch that is not exactly one
            // file diff (a hunk-only ```diff fence parses to none), which Expo shows as a red "[]" toast.
            // Counting here keeps that expected case silent and falls through to the plain-text fallback.
            const parsed = parsePatchFiles(sanitizedPatch);
            return parsed.length === 1 && parsed[0]!.files.length === 1 ? parsed[0]!.files[0]! : null;
        } catch {
            return null;
        }
    }, [sanitizedPatch, props.mode, props.filePath, props.mode === 'text' ? props.oldText : null, props.mode === 'text' ? props.newText : null, props.mode === 'text' ? props.contextLines : null]);

    const needsCodeLines = Boolean(
        props.onPressLine
        || props.onPressLineRange
        || props.onPressAddComment
        || props.isCommentActive
        || props.renderAfterLine
        || (props.selectedLineIds && props.selectedLineIds.size > 0)
        || props.scrollToLineId
        || props.highlightLineId
        || (props.highlightLineIds && props.highlightLineIds.size > 0)
        || props.findRangesByLineId?.size
        || props.intelligence
    );

    // Find searches the canonical corpus: the patch's rows plus the omitted unchanged rows its model filled in.
    const findLines = props.findActive && props.mode === 'unified' ? props.precomputedLines : undefined;
    const codeLines: readonly CodeLine[] | null = React.useMemo(() => {
        if (!needsCodeLines) return null;
        if (findLines) return findLines;
        if (props.mode === 'text') return buildCodeLinesFromTextDiff({
            oldText: props.oldText,
            newText: props.newText,
            contextLines: props.contextLines ?? 3,
        });
        return buildCodeLinesFromUnifiedDiff({
            unifiedDiff: sanitizedPatch,
            hideFilePrelude: true,
        });
    }, [findLines, needsCodeLines, sanitizedPatch, props.mode, props.mode === 'text' ? props.oldText : null,
        props.mode === 'text' ? props.newText : null, props.mode === 'text' ? props.contextLines : null]);

    // A match in omitted text opens its fold in place; Find's refold command (or stepping on) closes it again.
    const [refoldedFindLine, setRefoldedFindLine] = React.useState<string | null>(null);
    React.useEffect(() => { setRefoldedFindLine(null); }, [props.scrollToLineId, props.findActive, props.findRangesByLineId]);
    const contextBaseText = props.mode === 'unified' ? props.contextBaseText : undefined;
    const findTargetOmitted = Boolean(props.scrollToLineId && refoldedFindLine !== props.scrollToLineId
        && findLines?.some((line) => line.id === props.scrollToLineId && line.hunkIndex === null && !line.renderIsHeaderLine));
    const completedPatch = React.useMemo(() => {
        if (!findTargetOmitted || contextBaseText === undefined || !parsedPatch) return null;
        try { return completePatchFromBase(parsedPatch, sanitizedPatch, contextBaseText); } catch { return null; }
    }, [contextBaseText, findTargetOmitted, parsedPatch, sanitizedPatch]);
    const refoldFind = React.useCallback(() => {
        if (!completedPatch) return 'noRevealedFold' as const;
        setRefoldedFindLine(props.scrollToLineId ?? null);
        return 'refolded' as const;
    }, [completedPatch, props.scrollToLineId]);
    const registerFindRefold = props.registerFindRefold;
    React.useEffect(() => props.findActive ? registerFindRefold?.(refoldFind) : undefined,
        [props.findActive, refoldFind, registerFindRefold]);

    // Text comparisons can expand unchanged rows outside the patch. Reuse file-row identities there;
    // patch rows retain their existing diff identities and all callbacks carry the new source line.
    const intelligenceLines = React.useMemo(() => {
        if (!props.intelligence) return new Map<number, CodeLine>();
        const lines = props.mode === 'text'
            ? [...buildCodeLinesFromFile({ text: props.newText }), ...(codeLines ?? [])]
            : codeLines ?? [];
        return new Map(lines.filter(line => !line.renderIsHeaderLine && line.kind !== 'remove' && line.newLine !== null)
            .map(line => [line.newLine!, line]));
    }, [codeLines, props.intelligence !== undefined, props.mode, props.mode === 'text' ? props.newText : null]);

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

    const rangeSelectionEnabled = (props.interactionMode ?? 'read') !== 'read' && Boolean(props.onPressLineRange);
    const selectedLines = React.useMemo<SelectedLineRange | null>(() => {
        const selected = codeLines?.filter(line => !line.renderIsHeaderLine && props.selectedLineIds?.has(line.id));
        const first = selected?.[0];
        const last = selected?.at(-1);
        if (!first || !last) return null;
        const span = resolveCodeLineRangeSelection({ lines: codeLines ?? [], startLineId: first.id, endLineId: last.id });
        // Pierre controls one contiguous gesture; disconnected committed selections retain the row CSS marks.
        if (span.some(line => !props.selectedLineIds?.has(line.id))) return null;
        const side = first.kind === 'remove' ? 'deletions' : 'additions';
        const endSide = last.kind === 'remove' ? 'deletions' : 'additions';
        const start = side === 'deletions' ? first.oldLine : first.newLine;
        const end = endSide === 'deletions' ? last.oldLine : last.newLine;
        return start != null && end != null ? { start, side, end, endSide } : null;
    }, [codeLines, props.selectedLineIds]);

    const onLineSelected = useEventCallback((range: SelectedLineRange | null) => {
        if (!range || !codeLines || !rangeSelectionEnabled) return;
        const start = mapPierreDiffLineToCodeLine({ lineNumber: range.start, annotationSide: range.side ?? 'additions' });
        const end = mapPierreDiffLineToCodeLine({ lineNumber: range.end, annotationSide: range.endSide ?? range.side ?? 'additions' });
        if (!start || !end) return;
        const lines = resolveCodeLineRangeSelection({ lines: codeLines, startLineId: start.id, endLineId: end.id });
        if (lines.length) props.onPressLineRange?.(lines);
    });

    // The band over the region Find opened sits after the last row before it, or above the first row of the file.
    // The completed patch opens the whole run of omitted lines holding the match, and `hiddenCount` is that run.
    const findOpenedAnchor = React.useMemo(() => {
        if (!completedPatch || !findLines) return null;
        const isOmitted = (line: CodeLine | undefined) => line !== undefined && line.hunkIndex === null && !line.renderIsHeaderLine;
        let start = findLines.findIndex((line) => line.id === props.scrollToLineId);
        if (start < 0) return null;
        let end = start;
        while (start > 0 && isOmitted(findLines[start - 1])) start -= 1;
        while (isOmitted(findLines[end + 1])) end += 1;
        const hiddenCount = end - start + 1;
        for (let index = start - 1; index >= 0; index -= 1) {
            const line = findLines[index]!;
            if (line.renderIsHeaderLine) continue;
            const side: DiffLineAnnotation<React.ReactNode>['side'] = line.kind === 'remove' ? 'deletions' : 'additions';
            const lineNumber = side === 'deletions' ? line.oldLine : line.newLine;
            if (typeof lineNumber === 'number' && lineNumber > 0) return { side, lineNumber, hiddenCount };
        }
        return { side: 'additions' as const, lineNumber: 0, hiddenCount };
    }, [completedPatch, findLines, props.scrollToLineId]);

    const annotationContent = React.useMemo(() => {
        if (!codeLines || (!props.renderAfterLine && !findOpenedAnchor)) return undefined;

        const out = new Map<string, DiffLineAnnotation<React.ReactNode>>();
        const afterLine = new Map<string, string>();
        const fileAnnotationSide = codeLines.some((line) => line.newLine !== null) ? 'additions' : 'deletions';
        const append = (lineId: string, side: DiffLineAnnotation<React.ReactNode>['side'], lineNumber: number, node: React.ReactNode) => {
            const key = `${side}:${lineNumber}`;
            const previous = out.get(key);
            out.set(key, { side, lineNumber, metadata: previous ? <>{previous.metadata}{node}</> : node });
            afterLine.set(lineId, key);
        };
        let previousContentLine: CodeLine | null = null;
        const renderAfterLine = props.renderAfterLine;
        for (const line of renderAfterLine ? codeLines : []) {
            const anchor = line.renderIsHeaderLine ? previousContentLine : line;
            if (!line.renderIsHeaderLine && (line.oldLine !== null || line.newLine !== null)) previousContentLine = line;
            const node = renderAfterLine?.(line);
            if (!node) continue;

            if (line.renderIsHeaderLine && line.hunkIndex === 0) {
                // Pierre's public zero-line annotation sits above the first hunk/separator.
                append(line.id, fileAnnotationSide, 0, node);
                continue;
            }
            if (!anchor) continue;
            const side = anchor.kind === 'remove' ? 'deletions' : 'additions';
            const lineNumber = side === 'deletions' ? anchor.oldLine : anchor.newLine;
            if (typeof lineNumber !== 'number' || lineNumber <= 0) continue;

            append(line.id, side, lineNumber, node);
        }

        if (findOpenedAnchor) {
            const key = `${findOpenedAnchor.side}:${findOpenedAnchor.lineNumber}`;
            const previous = out.get(key);
            const band = <DiffFindOpenedFoldRow key="find-opened" hiddenCount={findOpenedAnchor.hiddenCount} onFoldAgain={refoldFind} />;
            out.set(key, { side: findOpenedAnchor.side, lineNumber: findOpenedAnchor.lineNumber, metadata: previous ? <>{previous.metadata}{band}</> : band });
        }
        return out.size > 0 ? { byPosition: out, afterLine } : undefined;
    }, [codeLines, findOpenedAnchor, props.renderAfterLine, refoldFind]);

    // Pierre treats a new nonempty array as a structural repaint, even when only React content changed.
    // Its existing slots render current content independently; retain only unchanged ordered positions.
    const annotationPositions = React.useRef<DiffLineAnnotation<React.ReactNode>[]>([]);
    const nextAnnotations = annotationContent ? [...annotationContent.byPosition.values()] : [];
    if (annotationPositions.current.length !== nextAnnotations.length || nextAnnotations.some((annotation, index) => (
        annotation.side !== annotationPositions.current[index]?.side || annotation.lineNumber !== annotationPositions.current[index]?.lineNumber
    ))) {
        annotationPositions.current = nextAnnotations.map(({ side, lineNumber }) => ({ side, lineNumber, metadata: null }));
    }
    const lineAnnotations = annotationPositions.current;
    const renderAnnotation = React.useCallback((annotation: DiffLineAnnotation<React.ReactNode>) => {
        return annotationContent?.byPosition.get(`${annotation.side}:${annotation.lineNumber}`)?.metadata ?? null;
    }, [annotationContent]);

    const fileDiff: FileDiffMetadata = React.useMemo(() => {
        const parsed = completedPatch ?? parsedPatch;
        if (!parsed) {
            // This value is only used if we end up rendering <FileDiff>. When the patch is invalid,
            // we render a fallback state instead of crashing Pierre.
            return { name: typeof props.filePath === 'string' ? props.filePath : 'diff', hunks: [] } as any;
        }
        const pathFromProp = typeof props.filePath === 'string' && props.filePath.trim() ? props.filePath.trim() : null;
        const pathCandidate = pathFromProp ?? (typeof parsed.name === 'string' && parsed.name.trim() ? parsed.name.trim() : null);
        const languageOverride = resolvePierreLanguageOverride(pathCandidate);
        const name = pathCandidate ?? 'diff';
        return {
            ...parsed,
            ...(languageOverride ? { lang: languageOverride } : {}),
            // The completed diff paints different rows from the same patch: its own key, so it mounts afresh.
            cacheKey: `${buildPierreInitialPresentationCacheKey({
                fileName: name,
                language: languageOverride,
                patch: sanitizedPatch,
            })}${completedPatch ? ':complete' : ''}`,
        };
    }, [completedPatch, parsedPatch, props.filePath, sanitizedPatch]);
    const initialPresentationForceFallback = usePierreInitialPresentation({
        cacheKey: fileDiff.cacheKey ?? buildPierreInitialPresentationCacheKey({
            fileName: typeof fileDiff.name === 'string' ? fileDiff.name : 'diff',
            language: typeof fileDiff.lang === 'string' ? fileDiff.lang : null,
            patch: sanitizedPatch,
        }),
        containerRef,
        fileDiff,
        parsedPatch,
        pool,
        renderingHappier: useHappierRenderer,
        virtualized: props.virtualized === true,
    });

    const baseOptions = React.useMemo<FileDiffOptions<React.ReactNode, undefined>>(() => {
        return buildPierreDiffOptionsBase({
            isDark,
            diffStyle,
            patchText: sanitizedPatch,
            wrapLines: props.wrapLines !== false,
            showLineNumbers: props.showLineNumbers !== false,
            showPrefix: props.showPrefix !== false,
            tokenizeMaxLineLength,
            themeIds: pierreThemeIds,
            intraLineDiff: {
                enabled: intraLineDiffEnabled === true,
                maxPatchLines: intraLineDiffMaxPatchLines,
                maxLineLength: intraLineDiffMaxLineLength,
            },
        });
    }, [diffStyle, intraLineDiffEnabled, intraLineDiffMaxLineLength, intraLineDiffMaxPatchLines, isDark, pierreThemeIds, props.showLineNumbers, props.showPrefix, props.wrapLines, sanitizedPatch, tokenizeMaxLineLength]);

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
        const highlightIds = new Set<string>();
        if (props.highlightLineId) highlightIds.add(props.highlightLineId);
        for (const id of props.highlightLineIds ?? []) {
            highlightIds.add(id);
        }
        if (highlightIds.size === 0) return '';

        const lineSelectors: string[] = [];
        const numberSelectors: string[] = [];
        for (const target of codeLines) {
            if (!highlightIds.has(target.id)) continue;
            if (target.renderIsHeaderLine) continue;

            const lineType = target.kind === 'remove'
                ? 'change-deletion'
                : target.kind === 'add'
                    ? 'change-addition'
                    : 'context';
            const lineNumber = lineType === 'change-deletion' ? target.oldLine : target.newLine;
            if (typeof lineNumber !== 'number' || lineNumber <= 0) continue;

            lineSelectors.push(pierreCodeLineSelector(target));
            numberSelectors.push(pierreCodeLineSelector(target, 'data-column-number'));
        }
        if (lineSelectors.length === 0 && numberSelectors.length === 0) return '';

        return `${lineSelectors.join(',\n')} {\n  box-shadow: inset 0 0 0 1px var(--diffs-selection-base);\n}\n${numberSelectors.join(',\n')} {\n  box-shadow: inset 0 0 0 1px var(--diffs-selection-base);\n}\n`;
    }, [codeLines, props.highlightLineId, props.highlightLineIds]);

    const reviewCommentHoverSlotUnsafeCSS = props.onPressAddComment
        ? PIERRE_REVIEW_COMMENT_HOVER_SLOT_UNSAFE_CSS
        : '';

    // P7 squiggles in the Changes body: the editors' one diagnostic underline, painted on Pierre's highlight ranges.
    const diagnosticUnsafeCSS = React.useMemo(() => props.intelligence
        ? formatCodeEditorDiagnosticCss({
            diagnosticErrorColor: theme.colors.state.danger.foreground,
            diagnosticWarningColor: theme.colors.state.warning.foreground,
        }, (severity) => `::highlight(${PIERRE_DIAGNOSTIC_HIGHLIGHT_NAMES[severity]})`)
        : '', [props.intelligence !== undefined, theme.colors.state.danger.foreground, theme.colors.state.warning.foreground]);

    // A text selection in the diff takes the editors' selection wash (ade-shell ask A1), not the browser's highlight.
    const textSelectionUnsafeCSS = `::selection { background-color: ${resolveCodeSelectionColor(theme.colors.accent.blue)}; }`;

    const composedUnsafeCSS = React.useMemo(() => {
        return [PIERRE_MATERIAL_UNSAFE_CSS, PIERRE_UNIFIED_GUTTER_UNSAFE_CSS, PIERRE_FIND_HIGHLIGHT_CSS, textSelectionUnsafeCSS, diagnosticUnsafeCSS, reviewCommentHoverSlotUnsafeCSS, selectedLineUnsafeCSS, highlightLineUnsafeCSS, PIERRE_REVIEWED_LINE_UNSAFE_CSS].filter(Boolean).join('\n');
    }, [textSelectionUnsafeCSS, diagnosticUnsafeCSS, highlightLineUnsafeCSS, reviewCommentHoverSlotUnsafeCSS, selectedLineUnsafeCSS]);

    const options = React.useMemo<FileDiffOptions<React.ReactNode, undefined>>(() => {
        return {
            ...baseOptions,
            unsafeCSS: composedUnsafeCSS,
        };
    }, [baseOptions, composedUnsafeCSS]);

    const pressAddCommentForPierreLine = React.useCallback((event: Pick<OnDiffLineClickProps, 'annotationSide' | 'lineNumber'> & Partial<Pick<OnDiffLineClickProps, 'lineType' | 'numberElement'>>): CodeLine | null => {
        const mapped = mapPierreDiffLineToCodeLine(event);
        if (!mapped) return null;
        if (mapped.renderIsHeaderLine) return null;
        props.onPressAddComment?.(mapped);
        return mapped;
    }, [mapPierreDiffLineToCodeLine, props.onPressAddComment]);

    const intelligenceClickRef = React.useRef<ReturnType<typeof bindPierreIntelligence>['onClick'] | null>(null);
    // The mounted body owns its in-flight gesture; a diagnostics repaint must not drop the release before click.
    const tokenTouchGesture = React.useRef<{ pointer: CodeTokenPointer | null; cancelled: boolean }>({ pointer: null, cancelled: false });
    const pressLineForPierreDomClick = React.useCallback((event: React.MouseEvent<HTMLDivElement>) => {
        if (pierreLineClickWasHandled(event)) return;
        if (intelligenceClickRef.current?.(event.nativeEvent)) {
            markPierreLineClickHandled(event);
            return;
        }
        if (!props.onPressLine) return;
        const eventTarget = resolvePierreDiffLineFromPressEvent(event);
        if (!eventTarget) return;
        if (rangeSelectionEnabled && eventTarget.numberElement) return;
        const mapped = mapPierreDiffLineToCodeLine(eventTarget);
        if (!mapped) return;
        if (mapped.renderIsHeaderLine) return;
        markPierreLineClickHandled(event);
        props.onPressLine(mapped);
    }, [mapPierreDiffLineToCodeLine, props.onPressLine, rangeSelectionEnabled]);

    const onLineClick = useEventCallback((event: OnDiffLineClickProps) => {
        if (rangeSelectionEnabled && event.numberColumn) return;
        if (pierreLineClickWasHandled(event)) return;
        markPierreLineClickHandled(event);
        const mapped = mapPierreDiffLineToCodeLine(event);
        if (mapped) props.onPressLine?.(mapped);
    });
    const onLineNumberClick = useEventCallback((event: OnDiffLineClickProps) => {
        pressAddCommentForPierreLine(event);
    });
    const hasPressLine = Boolean(props.onPressLine);
    const hasPressAddComment = Boolean(props.onPressAddComment);
    const interactiveOptions = React.useMemo(() => {
        if (!needsCodeLines) return null;

        const withClicks: FileDiffOptions<React.ReactNode, undefined> = {
            ...options,
            enableGutterUtility: hasPressAddComment,
            enableLineSelection: rangeSelectionEnabled,
            controlledSelection: rangeSelectionEnabled,
            onLineSelected,
            lineHoverHighlight: hasPressAddComment ? 'line' : options.lineHoverHighlight,
            onLineClick: hasPressLine ? onLineClick : undefined,
            onLineNumberClick: hasPressAddComment && !rangeSelectionEnabled ? onLineNumberClick : undefined,
        };

        return withClicks;
    }, [hasPressAddComment, hasPressLine, needsCodeLines, onLineClick, onLineNumberClick, onLineSelected, options, rangeSelectionEnabled]);

    const renderGutterUtility = React.useCallback((getHoveredLine: () => { lineNumber: number; side: 'additions' | 'deletions' } | undefined) => {
        if (!props.onPressAddComment) return null;
        const hovered = getHoveredLine?.() ?? undefined;
        const mapped = hovered
            ? mapPierreDiffLineToCodeLine({ annotationSide: hovered.side, lineNumber: hovered.lineNumber })
            : null;

        const active = mapped && !mapped.renderIsHeaderLine && props.isCommentActive
            ? props.isCommentActive(mapped)
            : false;

        return (
            <PierreReviewCommentHoverAffordance
                active={active}
                color={theme.colors.text.secondary}
                onPress={(event) => {
                    const eventTarget = resolvePierreDiffLineFromPressEvent(event);
                    const currentHovered = getHoveredLine?.();
                    const target = eventTarget ?? (currentHovered ? {
                        annotationSide: currentHovered.side,
                        lineNumber: currentHovered.lineNumber,
                    } : null);
                    if (!target) return;
                    pressAddCommentForPierreLine(target);
                }}
            />
        );
    }, [mapPierreDiffLineToCodeLine, pressAddCommentForPierreLine, props.isCommentActive, props.onPressAddComment, theme.colors.text.secondary]);

    const paintRef = React.useRef<PierrePaint | null>(null);
    const scrollTargetKey = codeLineScrollTargetKey(props.scrollToLineId, props.scrollToLineId ? props.findRangesByLineId?.get(props.scrollToLineId) : undefined, props.scrollToLineRequestId);
    const stopRetainedLanding = React.useRef<(() => void) | null>(null);
    React.useEffect(() => () => {
        stopRetainedLanding.current?.();
        stopRetainedLanding.current = null;
    }, [scrollTargetKey, props.filePath, props.findActive, useHappierRenderer, initialPresentationForceFallback]);
    const stopFindRef = React.useRef<() => void>(() => {});
    const stopIntelligenceRef = React.useRef<() => void>(() => {});
    const refreshFind = React.useCallback((paint: PierrePaint) => {
        stopFindRef.current();
        stopFindRef.current = registerPierreFindHighlights(paint.node.shadowRoot ?? paint.node, codeLines ?? [], props.findRangesByLineId);
    }, [codeLines, props.findRangesByLineId]);

    const landScrollTarget = (paint: PierrePaint, target: CodeLine, targetKey: string) => {
        const side = target.kind === 'remove' ? 'deletions' : 'additions';
        const lineNumber = side === 'deletions' ? target.oldLine : target.newLine;
        if (typeof lineNumber !== 'number' || lineNumber <= 0) return;
        // revealLine uses additions coordinates. A deletion is already inside a rendered hunk.
        if (side === 'additions' && paint.instance.revealLine(lineNumber)) return;
        const queryRoot = paint.node.shadowRoot ?? paint.node;
        const el = queryRoot.querySelector<HTMLElement>(pierreCodeLineSelector(target));
        const completeLanding = () => {
            lastScrolledLineIdRef.current = { key: targetKey, filePath: props.filePath };
            if (el && !annotation) {
                stopRetainedLanding.current?.();
                stopRetainedLanding.current = retainCodeLineLanding(el);
            }
        };
        // Header-start review units use their first code line as the portable reveal target.
        // Their action row is before that line: land on its existing annotation, not below it.
        const previous = codeLines?.[(codeLines?.indexOf(target) ?? 0) - 1];
        const annotationKey = props.hunks && !props.findActive && previous?.renderIsHeaderLine
            ? annotationContent?.afterLine.get(previous.id) : undefined;
        const annotation = annotationKey ? annotationContent?.byPosition.get(annotationKey) : undefined;
        const annotationNode = annotation
            ? paint.node.querySelector<HTMLElement>(`[slot="${paint.instance.getAnnotationSlotName(annotation)}"]`) : null;
        const annotationRect = annotationNode?.getBoundingClientRect();
        if (paint.virtualizer && paint.instance instanceof VirtualizedFileDiff) {
            const position = paint.instance.getLinePosition(lineNumber, side);
            if (!position) return;
            // A row that is already mounted is landed on directly, in whichever element scrolls it, a third of the way
            // down (clear of the sticky file header and the Find bar). Pierre's offset for rows it has not measured (wrapped
            // lines on a phone) can be far off, so the offset scroll below only brings an unmounted row into view.
            if (!annotation && scrollCodeLineIntoView(el)) {
                completeLanding();
                return;
            }
            const top = paint.virtualizer.getOffsetInScrollContainer(paint.node) + (
                annotationRect && annotationRect.height > 0
                    ? annotationRect.top - paint.node.getBoundingClientRect().top : position.top
            );
            // Find lands its match mid-viewport, as the plain-DOM landing below does, clear of the sticky
            // file header and the Find bar that a top-aligned line would sit under.
            const scrollRoot = paint.virtualizer.getRoot();
            const viewportHeight = scrollRoot instanceof HTMLElement ? scrollRoot.clientHeight : window.innerHeight;
            const lead = props.findActive && !annotation ? Math.max(0, (viewportHeight - position.height) / 2) : 0;
            paint.virtualizer.scrollTo({ top: Math.max(0, top - lead) });
            // A virtualized target may mount on the next paint. Keep that landing pending.
            if (annotation ? !annotationRect || annotationRect.height <= 0 : !el) return;
        } else {
            const node = annotationNode ?? el;
            if (!scrollCodeLineIntoView(node, annotationNode ? 'start' : 'reading')) return;
        }
        completeLanding();
    };

    const revealScrollTarget = React.useCallback((paint: PierrePaint) => {
        const scrollId = props.scrollToLineId ?? null;
        if (!scrollId) {
            lastScrolledLineIdRef.current = null;
            return;
        }
        const targetKey = scrollTargetKey;
        if (!targetKey) return;
        const landed = () => lastScrolledLineIdRef.current?.key === targetKey && lastScrolledLineIdRef.current.filePath === props.filePath;
        if (!codeLines) return;
        const target = codeLines.find((l) => l.id === scrollId) ?? null;
        if (!target || target.renderIsHeaderLine) return;
        if (landed()) return;
        // Pierre paints inside its virtualizer's render pass and restores that pass's scroll anchor afterwards,
        // so a landing made during the paint is undone (a Keep re-renders the rows and moves the target at once).
        // Land once the pass has finished.
        queueMicrotask(() => {
            if (landed()) return;
            landScrollTarget(paint, target, targetKey);
        });
    }, [annotationContent, codeLines, props.filePath, props.findActive, props.hunks, props.scrollToLineId, scrollTargetKey]);

    // The flag's mark, drawn by CSS on the ink plate in the surface colour (as View's `AgentIcon color`).
    const agentMarkId = props.agentPresence?.agentId ?? null;
    const agentMarkUri = React.useMemo(() => agentMarkId
        ? resolveAgentIconSvgDataUri(agentMarkId, theme, theme.colors.surface.base) : null, [agentMarkId, theme]);
    const paintReviewedLines = React.useCallback((paint: PierrePaint) => {
        const root = paint.node.shadowRoot ?? paint.node;
        for (const node of root.querySelectorAll<HTMLElement>('[data-line], [data-column-number]')) {
            const position = readPierreDomLine(node);
            const line = position?.newLine ? codeLinesByAdditionLine?.get(position.newLine)
                : position?.oldLine ? codeLinesByDeletionLine?.get(position.oldLine) : undefined;
            const changed = line?.kind === 'add' || line?.kind === 'remove';
            node.toggleAttribute('data-happier-reviewed', changed && props.reviewedLineIds?.has(line.id) === true);
            // The agent's caret and wash: new-side lines of the block it writes now (content rows only).
            const presence = props.agentPresence;
            const newLine = position?.newLine ?? null;
            const washed = presence != null && newLine !== null && node.hasAttribute('data-line')
                && newLine >= presence.startLine && newLine <= presence.endLine;
            node.toggleAttribute('data-happier-agent-wash', washed);
            if (washed && newLine === presence.endLine) {
                node.setAttribute('data-happier-agent-caret', presence.agentName);
                if (agentMarkUri) node.style.setProperty('--happier-agent-mark', `url("${agentMarkUri}")`);
                else node.style.removeProperty('--happier-agent-mark');
                node.toggleAttribute('data-happier-agent-caret-flip', !agentCaretFlagFits(node));
            } else if (node.hasAttribute('data-happier-agent-caret')) {
                node.removeAttribute('data-happier-agent-caret');
                node.removeAttribute('data-happier-agent-caret-flip');
                node.style.removeProperty('--happier-agent-mark');
            }
        }
    }, [agentMarkUri, codeLinesByAdditionLine, codeLinesByDeletionLine, props.agentPresence, props.reviewedLineIds]);

    const onPaint = React.useCallback((paint: PierrePaint) => {
        if (paintRef.current?.node !== paint.node) {
            tokenTouchGesture.current.pointer = null;
            tokenTouchGesture.current.cancelled = false;
        }
        paintRef.current = paint;
        localizePierreSeparatorText(paint.node.shadowRoot ?? paint.node);
        paintReviewedLines(paint);
        revealScrollTarget(paint);
        refreshFind(paint);
        stopIntelligenceRef.current();
        const binding = props.intelligence
            ? bindPierreIntelligence(paint.node.shadowRoot ?? paint.node, intelligenceLines, props.intelligence, tokenTouchGesture.current, props.rangeSelectionActive === true)
            : null;
        intelligenceClickRef.current = binding?.onClick ?? null;
        stopIntelligenceRef.current = () => {
            intelligenceClickRef.current = null;
            binding?.dispose();
        };
    }, [paintReviewedLines, refreshFind, revealScrollTarget, props.intelligence, props.rangeSelectionActive, intelligenceLines]);

    React.useEffect(() => {
        if (useHappierRenderer || initialPresentationForceFallback) {
            paintRef.current = null;
            stopFindRef.current();
            stopIntelligenceRef.current();
            return;
        }
        if (paintRef.current) onPaint(paintRef.current);
        return () => {
            stopFindRef.current();
            stopIntelligenceRef.current();
        };
    }, [initialPresentationForceFallback, onPaint, useHappierRenderer]);

    if (!parsedPatch) {
        if (props.errorFallback !== undefined) return <>{props.errorFallback}</>;
        const raw = typeof patch === 'string' ? patch.trim() : '';
        const message = raw.length > 0 ? raw : t('files.noChanges');
        return (
            <div
                ref={containerRef}
                data-testid="pierre-diff-fallback"
                className="happier-pierre-diff-wrapper"
                style={{
                    padding: 16,
                    color: (theme as any)?.colors?.text?.secondary ?? (isDark ? '#b0b0b0' : '#6a6a6a'),
                    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, \"Liberation Mono\", \"Courier New\", monospace',
                    fontSize: 'var(--diffs-font-size, 12px)',
                    lineHeight: 'var(--diffs-line-height, 20px)',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                }}
            >
                {message}
            </div>
        );
    }

    const fallbackNode = (() => {
        if (props.errorFallback !== undefined) return props.errorFallback;
        const raw = typeof sanitizedPatch === 'string' ? sanitizedPatch.trim() : '';
        const message = raw.length > 0 ? raw : t('files.noChanges');
        return (
            <div
                data-testid="pierre-diff-fallback"
                className="happier-pierre-diff-wrapper"
                style={{
                    padding: 16,
                    color: (theme as any)?.colors?.text?.secondary ?? (isDark ? '#b0b0b0' : '#6a6a6a'),
                    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, \"Liberation Mono\", \"Courier New\", monospace',
                    fontSize: 'var(--diffs-font-size, 12px)',
                    lineHeight: 'var(--diffs-line-height, 20px)',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                }}
            >
                {message}
            </div>
        );
    })();

    // Leading content scrolls with the diff, above its first line (Pierre measures the file's offset in its
    // scroller, so reveals still land on the change).
    const leading = props.leadingContent ? <div data-diff-leading-content="">{props.leadingContent}</div> : null;
    const body = props.virtualized && !sharedVirtualizer ? (
        <Virtualizer
            style={{ flex: 1, minHeight: 0, maxHeight: 'inherit', overflowY: 'auto' }}
        >
            {leading}
            <PierreFileDiffBody
                key={fileDiff.cacheKey}
                fileDiff={fileDiff}
                onPaint={onPaint}
                selectedLines={selectedLines}
                options={interactiveOptions ?? options}
                lineAnnotations={lineAnnotations}
                renderAnnotation={lineAnnotations ? renderAnnotation : undefined}
                renderGutterUtility={props.onPressAddComment ? renderGutterUtility : undefined}
                style={{ display: 'block', width: '100%' }}
            />
        </Virtualizer>
    ) : (
        <>
        {leading}
        <PierreFileDiffBody
            key={fileDiff.cacheKey}
            fileDiff={fileDiff}
            onPaint={onPaint}
            selectedLines={selectedLines}
            options={interactiveOptions ?? options}
            lineAnnotations={lineAnnotations}
            renderAnnotation={lineAnnotations.length > 0 ? renderAnnotation : undefined}
            renderGutterUtility={props.onPressAddComment ? renderGutterUtility : undefined}
            style={{ display: 'block', width: '100%' }}
        />
        </>
    );

    const wrapperStyle = bounded
        ? ({
            ...typographyStyle,
            ...selectionStyle,
            // A flex column, so the Virtualizer's `flex: 1` takes the wrapper's height and scrolls inside it.
            display: 'flex',
            flexDirection: 'column',
            flex: 1,
            minHeight: 0,
            maxHeight: 'inherit',
            overflow: 'hidden',
            ...(!sharedVirtualizer ? { position: 'absolute', inset: 0 } : null),
        } as React.CSSProperties)
        : ({ ...typographyStyle, ...selectionStyle } as React.CSSProperties);

    if (useHappierRenderer || initialPresentationForceFallback) {
        return (
            <div
                ref={containerRef}
                data-testid="pierre-diff-viewer"
                className="happier-pierre-diff-wrapper"
                style={wrapperStyle}
            >
                {useHappierRenderer ? props.mode === 'unified'
                    ? <HappierUnifiedDiffViewer {...props} lineInfoSeparators />
                    : <HappierTextDiffViewer {...props} />
                    : fallbackNode}
            </div>
        );
    }

    return (
        <div
            ref={containerRef}
            data-testid="pierre-diff-viewer"
            className="happier-pierre-diff-wrapper"
            onClickCapture={props.onPressLine || props.intelligence ? pressLineForPierreDomClick : undefined}
            style={wrapperStyle}
        >
            <VirtualizerContext.Provider value={sharedVirtualizer}>
                <WorkerPoolContext.Provider value={pool ?? undefined}>
                    <PierreDiffErrorBoundary resetKey={sanitizedPatch} fallback={fallbackNode}>
                        <PierreDiffScrollAnchor patch={sanitizedPatch} filePath={props.filePath} scrollTargetKey={scrollTargetKey ?? undefined} containerRef={containerRef}>
                            {body}
                        </PierreDiffScrollAnchor>
                    </PierreDiffErrorBoundary>
                </WorkerPoolContext.Provider>
            </VirtualizerContext.Provider>
        </div>
    );
});
