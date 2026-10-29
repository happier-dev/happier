import * as React from 'react';
import { Platform } from 'react-native';

import type { AskSelection } from './useAskSelection';
import { readDiffLineFromDomNode } from '../diff/diffTextSelection';
import { PIERRE_DIFF_HOST_SELECTOR } from '../diff/pierre/pierreDomLine';
import type { LanguageIntelligenceRange } from '@happier-dev/protocol/machines/languageIntelligence';

type DomNodeLike = Readonly<{ parentElement?: DomElementLike | null; nodeType?: number }>;
type DomElementLike = DomNodeLike & Readonly<{ id?: string; contains?: (node: unknown) => boolean }>;

/** Rendered code rows carry `<view id>-f:<line>`: the line of a DOM node is its row's. */
export function readCodeLineFromDomNode(node: DomNodeLike | null | undefined): number | null {
    let element: DomElementLike | null | undefined = node && node.nodeType === 1 ? node as DomElementLike : node?.parentElement;
    while (element) {
        const match = typeof element.id === 'string' ? /-f:(\d+)$/u.exec(element.id) : null;
        if (match) return Number(match[1]);
        element = element.parentElement;
    }
    return null;
}

/** A rendered (Markdown) selection's lines in its source: where its first and last lines first occur. */
export function resolveSourceLinesForText(source: string, text: string): Readonly<{ startLine: number; endLine: number }> | null {
    const selected = text.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
    if (selected.length === 0) return null;
    const lines = source.split(/\r?\n/u);
    const find = (needle: string, from: number) => {
        for (let index = from; index < lines.length; index += 1) if (lines[index]!.includes(needle)) return index;
        return -1;
    };
    const first = find(selected[0]!, 0);
    if (first < 0) return null;
    const last = selected.length === 1 ? first : find(selected[selected.length - 1]!, first);
    return { startLine: first + 1, endLine: (last < 0 ? first : last) + 1 };
}

type ComposedRange = Readonly<{ startContainer: Node; startOffset: number; endContainer: Node; endOffset: number; collapsed: boolean }>;
type SelectionWithComposedRanges = Selection & { getComposedRanges?: (options: Readonly<{ shadowRoots: ShadowRoot[] }>) => ComposedRange[] };

/** Containment across open shadow roots (a renderer that draws inside one, e.g. Pierre). */
function composedContains(root: Node, node: Node | null): boolean {
    let current: Node | null = node;
    while (current) {
        if (current === root) return true;
        current = current.parentNode ?? (current as Partial<ShadowRoot>).host ?? null;
    }
    return false;
}

/** The selection's real endpoints, reaching into the open shadow roots under `root` (StaticRange otherwise retargets to the host). */
function readSelectionEndpoints(selection: Selection, root: Element, shadowHostSelector: string | undefined) {
    const range = selection.getRangeAt(0);
    const getComposedRanges = (selection as SelectionWithComposedRanges).getComposedRanges;
    const shadowRoots = shadowHostSelector && typeof getComposedRanges === 'function'
        ? Array.from(root.querySelectorAll(shadowHostSelector)).flatMap((host) => host.shadowRoot ? [host.shadowRoot] : [])
        : [];
    if (shadowRoots.length === 0) return { start: range.startContainer, end: range.endContainer, collapsed: selection.isCollapsed, range };
    const composed = getComposedRanges!.call(selection, { shadowRoots })[0];
    if (!composed) return null;
    let inner: Range | null = null;
    try {
        inner = document.createRange();
        inner.setStart(composed.startContainer, composed.startOffset);
        inner.setEnd(composed.endContainer, composed.endOffset);
    } catch {
        inner = null;
    }
    return { start: composed.startContainer, end: composed.endContainer, collapsed: composed.collapsed, range: inner ?? range };
}

/** The same composed selection endpoints, restricted to current-file code text for range formatting. */
export function readDomCodeSelectionRange(root: unknown): LanguageIntelligenceRange | null {
    if (typeof window === 'undefined' || typeof Element === 'undefined' || !(root instanceof Element)) return null;
    const selection = window.getSelection?.();
    if (!selection?.rangeCount) return null;
    const endpoints = readSelectionEndpoints(selection, root, PIERRE_DIFF_HOST_SELECTOR);
    if (!endpoints || endpoints.collapsed || !composedContains(root, endpoints.start) || !composedContains(root, endpoints.end)) return null;
    const position = (node: Node, offset: number) => {
        const line = readDiffLineFromDomNode(node)?.newLine;
        const element = node.nodeType === 1 ? node as Element : node.parentElement;
        const code = element?.closest('[data-code-text], [data-line][data-line-type]');
        if (line == null || !code || !code.contains(node)) return null;
        const prefix = node.ownerDocument!.createRange();
        prefix.selectNodeContents(code);
        prefix.setEnd(node, offset);
        return { line: line - 1, character: prefix.toString().length };
    };
    const start = position(endpoints.range.startContainer, endpoints.range.startOffset);
    const end = position(endpoints.range.endContainer, endpoints.range.endOffset);
    return start && end ? { start, end } : null;
}

/**
 * The browser's text selection inside one rendered body, as the Ask controls' selection source (web).
 * `resolveLines` maps the selection to lines (code rows by their DOM line facts, Markdown by its source,
 * diffs by side). `shadowHostSelector` names renderer hosts whose open shadow roots hold selectable text.
 */
export function useDomTextSelection(input: Readonly<{
    rootRef: React.RefObject<unknown>;
    active: boolean;
    shadowHostSelector?: string;
    resolveLines: (range: Readonly<{ startNode: DomNodeLike | null; endNode: DomNodeLike | null; text: string }>) => Readonly<{ startLine: number; endLine: number; side?: 'before' | 'after' }> | null;
}>) {
    const latest = React.useRef(input);
    latest.current = input;
    const getSelection = React.useCallback((): AskSelection | null => {
        if (Platform.OS !== 'web' || typeof window === 'undefined' || !latest.current.active) return null;
        const selection = window.getSelection?.();
        const root = latest.current.rootRef.current as Element | null;
        if (!selection || selection.rangeCount === 0 || !root?.contains) return null;
        const endpoints = readSelectionEndpoints(selection, root, latest.current.shadowHostSelector);
        if (!endpoints || endpoints.collapsed) return null;
        if (!composedContains(root, endpoints.start) || !composedContains(root, endpoints.end)) return null;
        const range = endpoints.range;
        const text = selection.toString() || range.toString();
        if (text.trim().length === 0) return null;
        const lines = latest.current.resolveLines({ startNode: endpoints.start as DomNodeLike, endNode: endpoints.end as DomNodeLike, text });
        if (!lines) return null;
        const bounds = range.getBoundingClientRect();
        // The toolbar rises from the selection's start: its first painted line box, not the union.
        const start = Array.from(range.getClientRects()).find((box) => box.width > 0 && box.height > 0) ?? bounds;
        return { ...lines, text, rect: { x: start.left, y: start.top, width: bounds.width, height: bounds.height } };
    }, []);
    const subscribeSelection = React.useCallback((listener: () => void) => {
        if (Platform.OS !== 'web' || typeof document === 'undefined') return () => {};
        document.addEventListener('selectionchange', listener);
        return () => document.removeEventListener('selectionchange', listener);
    }, []);
    return { getSelection, subscribeSelection };
}
