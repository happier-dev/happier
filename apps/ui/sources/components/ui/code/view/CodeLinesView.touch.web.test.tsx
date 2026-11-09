// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createThemeFixture } from '@/dev/testkit';
import { installCodeViewCommonModuleMocks } from './codeViewTestHelpers';
import { buildCodeLinesFromFile } from '../model/buildCodeLinesFromFile';
import { createCodeIntelligenceController } from '@/sync/domains/workspaces/languageIntelligence/createCodeIntelligenceController';
import type { CodeIntelligenceServerPort } from '@/sync/domains/workspaces/languageIntelligence/codeIntelligenceDocument';

installCodeViewCommonModuleMocks({ reactNative: async () => import('react-native-web'), realVirtualizer: true });
const { CodeLinesViewCore } = await import('./CodeLinesViewCore');
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

// The browser's touch/caret geometry is the boundary. Rows and RN-web Pressability stay real.
function pointer(type: string, target: Element) {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: 60, clientY: 10 });
    Object.defineProperty(event, 'pointerType', { value: 'touch' });
    target.dispatchEvent(event);
}
function touch(type: 'touchstart' | 'touchend' | 'touchcancel', target: Element) {
    const point: Touch = { identifier: 1, target, clientX: 60, clientY: 10, pageX: 60, pageY: 10,
        screenX: 60, screenY: 10, radiusX: 1, radiusY: 1, rotationAngle: 0, force: 1 };
    target.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true,
        touches: type === 'touchstart' ? [point] : [], targetTouches: type === 'touchstart' ? [point] : [], changedTouches: [point] }));
}

describe('code-row browser touch lifecycle', () => {
    it.each([true, false])('activates colored and plain View tokens without throwing with semantic highlighting %s', async enabled => {
        const host = document.createElement('div'); document.body.appendChild(host);
        const root = createRoot(host);
        const activate = vi.fn(() => true), select = vi.fn();
        const lines = buildCodeLinesFromFile({ text: 'const target = plain;' });
        // Script only the remote language server; the controller and document holder stay real.
        const request = vi.fn<CodeIntelligenceServerPort['query']>().mockResolvedValue({ status: 'ok', kind: 'semanticTokens',
            tokens: [{ serverId: 's', legend: { tokenTypes: ['function'], tokenModifiers: [] }, data: [0, 6, 6, 0, 0] }] });
        const controller = createCodeIntelligenceController({
            scope: { serverId: 'home', machineId: 'machine', rootPath: '/repo' }, path: 'a.ts', languageId: 'typescript',
            accountLifetime: { scope: { serverId: 'home', accountId: 'account' }, isCurrent: () => true,
                onRetire: () => ({ dispose() {} }) },
            getText: () => lines[0]!.renderCodeText,
            query: async () => ({ status: 'ok', source: 'text_matches', coverage: 'complete', hasMore: false, locations: [] }),
            openLocation() {},
            languageServer: {
                sync: async input => ({ status: 'ok', generation: 'g1', ...('version' in input.op ? { version: input.op.version } : {}),
                    servers: [{ serverId: 's', label: 'Server', state: 'ready', loading: false, generation: 'g1' }],
                    capabilities: { hover: true, definition: true, references: true, documentSymbol: false, diagnostics: 'none',
                        acceptsExternalChanges: false, semanticTokensRange: true } }),
                query: request,
                watch: (_input, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })),
                restart: async () => ({ status: 'ok' }),
            },
        });
        const observers: Array<{ callback: IntersectionObserverCallback; nodes: Element[]; observer: IntersectionObserver }> = [];
        class VisibleRowsObserver {
            nodes: Element[] = [];
            constructor(callback: IntersectionObserverCallback) {
                // Browser viewport observation is the boundary; semantic demand and row rendering stay real.
                observers.push({ callback, nodes: this.nodes, observer: this as unknown as IntersectionObserver });
            }
            observe(node: Element) { this.nodes.push(node); }
            disconnect() {}
        }
        vi.stubGlobal('IntersectionObserver', VisibleRowsObserver);
        const previousCaret = Object.getOwnPropertyDescriptor(document, 'caretPositionFromPoint');
        const errors: unknown[] = [];
        const onError = (event: ErrorEvent) => { errors.push(event.error); event.preventDefault(); };
        window.addEventListener('error', onError);
        try {
            await controller.activate(); // Model the already-warmed server used by a View consumer.
            await act(async () => root.render(<CodeLinesViewCore lines={lines} virtualized={false}
                onPressLine={select} intelligence={{ onPointerToken: vi.fn(), onActivateToken: activate, semantic: { controller, enabled } }}
                syntaxHighlighting={{ mode: 'simple', language: 'typescript', maxBytes: lines[0]!.renderCodeText.length,
                    maxLines: lines.length, maxLineLength: lines[0]!.renderCodeText.length }} />));
            await act(async () => {
                for (const { callback, nodes, observer } of observers) callback(nodes.map(target => ({ target, isIntersecting: true }) as IntersectionObserverEntry), observer);
            });
            expect(request).toHaveBeenCalledTimes(enabled ? 1 : 0);
            const code = host.querySelector('[data-code-text]')!;
            for (const name of ['target', 'plain']) {
                const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
                let text = walker.nextNode();
                while (text && !text.textContent?.includes(name)) text = walker.nextNode();
                expect(text).not.toBeNull();
                const offset = text!.textContent!.indexOf(name) + 1;
                Object.defineProperty(document, 'caretPositionFromPoint', { configurable: true, value: () => ({ offsetNode: text, offset }) });
                const target = text!.parentElement!;
                const expectedInk = document.createElement('span');
                const syntax = createThemeFixture().colors.syntax;
                expectedInk.style.color = enabled && name === 'target' ? syntax.function : syntax.default;
                expect(getComputedStyle(target).color).toBe(expectedInk.style.color);
                activate.mockClear(); select.mockClear();
                await act(async () => { target.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 60, clientY: 10 })); });
                expect(errors).toEqual([]);
                expect(activate).not.toHaveBeenCalled();
                expect(select).toHaveBeenCalledExactlyOnceWith(lines[0], expect.anything());
                select.mockClear();
                await act(async () => { target.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true, clientX: 60, clientY: 10 })); });
                expect(errors).toEqual([]);
                expect(activate).toHaveBeenCalledExactlyOnceWith(lines[0]!.id, lines[0]!.renderCodeText.indexOf(name) + 1,
                    expect.objectContaining({ via: 'modifier' }), 1);
                expect(select).not.toHaveBeenCalled();
                activate.mockClear();
                await act(async () => {
                    pointer('pointerdown', target); touch('touchstart', target); pointer('pointerup', target);
                    touch('touchend', target); pointer('click', target);
                });
                expect(errors).toEqual([]);
                expect(activate).toHaveBeenCalledExactlyOnceWith(lines[0]!.id, lines[0]!.renderCodeText.indexOf(name) + 1,
                    expect.objectContaining({ via: 'touch' }), 1);
                expect(select).not.toHaveBeenCalled();
                activate.mockClear();
                // RN-web's document keyup handler delivers the DOM event itself, unlike its synthetic click.
                // The same row press must accept both shapes without treating keyboard selection as a token click.
                const rowPress = code.closest('[tabindex="0"]')!;
                await act(async () => {
                    rowPress.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }));
                    rowPress.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Enter' }));
                });
                expect(errors).toEqual([]);
                expect(activate).not.toHaveBeenCalled();
                expect(select).toHaveBeenCalledExactlyOnceWith(lines[0], expect.anything());
            }
        } finally {
            window.removeEventListener('error', onError);
            await act(async () => root.unmount()); controller.dispose(); host.remove(); vi.unstubAllGlobals();
            if (previousCaret) Object.defineProperty(document, 'caretPositionFromPoint', previousCaret);
            else Reflect.deleteProperty(document, 'caretPositionFromPoint');
        }
    });
    it('commits tap-to-name on the real row press, never before the compatibility click, and leaves gutter/blank taps selecting', async () => {
        const host = document.createElement('div'); document.body.appendChild(host);
        const root = createRoot(host);
        const activate = vi.fn(() => true), select = vi.fn();
        const lines = buildCodeLinesFromFile({ text: 'const target = 1;\n\n' });
        const previousCaret = Object.getOwnPropertyDescriptor(document, 'caretPositionFromPoint');
        try {
            await act(async () => root.render(<CodeLinesViewCore lines={lines} virtualized={false} interactionMode="commitSelection"
                onPressLine={select} onPressLineRange={vi.fn()} intelligence={{ onPointerToken: vi.fn(), onActivateToken: activate }} />));
            const code = host.querySelector('[data-code-text]')!;
            Object.defineProperty(document, 'caretPositionFromPoint', { configurable: true, value: () => ({ offsetNode: code.firstChild, offset: 8 }) });
            await act(async () => { pointer('pointerdown', code); touch('touchstart', code); pointer('pointerup', code); });
            // Opening a sheet before click changes the browser's click target to its dismiss layer.
            expect(activate).not.toHaveBeenCalled();
            await act(async () => { touch('touchend', code); pointer('click', code); });
            expect(activate).toHaveBeenCalledWith(lines[0]!.id, 8, expect.objectContaining({ via: 'touch' }), 1);
            expect(select).not.toHaveBeenCalled();

            activate.mockClear();
            const gutter = code.parentElement!.previousElementSibling!;
            const blank = host.querySelectorAll('[data-code-text]')[1]!;
            for (const target of [gutter, blank]) await act(async () => {
                pointer('pointerdown', target); touch('touchstart', target); pointer('pointerup', target); touch('touchend', target); pointer('click', target);
            });
            expect(activate).not.toHaveBeenCalled();
            expect(select.mock.calls.map(([line]) => line.id)).toEqual([lines[0]!.id, lines[1]!.id]);
            select.mockClear();
            activate.mockReturnValue(false);
            await act(async () => { pointer('pointerdown', code); touch('touchstart', code); pointer('pointerup', code); touch('touchend', code); pointer('click', code); });
            expect(select).toHaveBeenCalledExactlyOnceWith(lines[0], expect.anything());
            select.mockClear(); activate.mockClear(); activate.mockReturnValue(true);
            await act(async () => {
                code.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
                code.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true, clientX: 60, clientY: 10 }));
            });
            expect(activate).toHaveBeenCalledExactlyOnceWith(lines[0]!.id, 8, expect.objectContaining({ via: 'modifier' }), 1);
            expect(select).not.toHaveBeenCalled();
        } finally {
            await act(async () => root.unmount()); host.remove();
            if (previousCaret) Object.defineProperty(document, 'caretPositionFromPoint', previousCaret);
            else Reflect.deleteProperty(document, 'caretPositionFromPoint');
        }
    });
    it('lets the existing long-press comment and release cancellation own the gesture instead of naming', async () => {
        vi.useFakeTimers();
        const host = document.createElement('div'); document.body.appendChild(host);
        const root = createRoot(host);
        const activate = vi.fn(), comment = vi.fn(), select = vi.fn();
        const lines = buildCodeLinesFromFile({ text: 'const target = 1;' });
        try {
            await act(async () => root.render(<CodeLinesViewCore lines={lines} virtualized={false} interactionMode="comment"
                onPressLine={select} onPressLineRange={vi.fn()} onPressAddComment={comment}
                intelligence={{ onPointerToken: vi.fn(), onActivateToken: activate }} />));
            const code = host.querySelector('[data-code-text]')!;
            await act(async () => { pointer('pointerdown', code); touch('touchstart', code); vi.advanceTimersByTime(700); });
            await act(async () => { pointer('pointerup', code); touch('touchend', code); pointer('click', code); });
            expect(comment).toHaveBeenCalledWith(lines[0]);
            expect(activate).not.toHaveBeenCalled();
            expect(select).not.toHaveBeenCalled();
            comment.mockClear();
            await act(async () => { pointer('pointerdown', code); touch('touchstart', code); pointer('pointercancel', code); touch('touchcancel', code); });
            expect(comment).not.toHaveBeenCalled();
            expect(activate).not.toHaveBeenCalled();
        } finally { await act(async () => root.unmount()); host.remove(); }
    });
});
