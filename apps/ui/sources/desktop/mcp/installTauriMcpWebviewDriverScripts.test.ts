import { afterEach, describe, expect, it, vi } from 'vitest';

import { installTauriMcpWebviewDriverScripts } from './installTauriMcpWebviewDriverScripts';
import { maybeInstallTauriMcpBridge } from './maybeInstallTauriMcpBridge';

describe('installTauriMcpWebviewDriverScripts', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('installs resolveRef helpers expected by mcp-server-tauri tooling', () => {
        const element = { tagName: 'BUTTON' } as unknown as Element;
        const reverseRefs = new Map<string, Element>([['e1', element]]);

        const windowObj = {
            __MCP__: {
                reverseRefs,
            },
        } as unknown as typeof globalThis;

        const documentObj = {
            querySelector: () => element,
            querySelectorAll: () => [element],
            evaluate: () => ({ singleNodeValue: element, snapshotLength: 1, snapshotItem: () => element }),
        } as unknown as Document;

        installTauriMcpWebviewDriverScripts({ windowObj, documentObj });

        expect(typeof (windowObj as unknown as { __MCP__?: { resolveRef?: unknown } }).__MCP__?.resolveRef).toBe('function');
        expect(typeof (windowObj as unknown as { __MCP__?: { resolveAll?: unknown } }).__MCP__?.resolveAll).toBe('function');
        expect(typeof (windowObj as unknown as { __MCP__?: { countAll?: unknown } }).__MCP__?.countAll).toBe('function');
    });

    it('installs a canonical local-settings writer helper for the Tauri MCP bridge', async () => {
        const applied: Array<Record<string, unknown>> = [];
        let flushCount = 0;
        const windowObj = {
            __MCP__: {},
        } as unknown as typeof globalThis;
        const documentObj = {
            querySelector: () => null,
            querySelectorAll: () => [],
            evaluate: () => ({ singleNodeValue: null, snapshotLength: 0, snapshotItem: () => null }),
        } as unknown as Document;

        installTauriMcpWebviewDriverScripts({
            windowObj,
            documentObj,
            applyLocalSettings: (delta) => {
                applied.push(delta);
            },
            flushDesktopOverlaySync: () => {
                flushCount += 1;
            },
        });

        const result = await (
            windowObj as unknown as {
                __MCP__?: {
                    applyHappierLocalSettings?: (delta: unknown) => Promise<{ ok: boolean; appliedKeys?: string[] }>;
                };
            }
        ).__MCP__?.applyHappierLocalSettings?.({
            desktopOverlayEnabled: true,
            desktopOverlayVisibilityMode: 'active_sessions',
        });

        expect(result).toMatchObject({
            ok: true,
            appliedKeys: ['desktopOverlayEnabled', 'desktopOverlayVisibilityMode'],
        });
        expect(applied).toEqual([
            {
                desktopOverlayEnabled: true,
                desktopOverlayVisibilityMode: 'active_sessions',
            },
        ]);
        expect(flushCount).toBe(1);
    });

    it('overwrites any preexisting applyHappierLocalSettings implementation so desktop overlay settings always flush', async () => {
        const applied: Array<Record<string, unknown>> = [];
        let flushCount = 0;
        let legacyCalled = 0;
        const windowObj = {
            __MCP__: {
                applyHappierLocalSettings: () => {
                    legacyCalled += 1;
                    return { ok: false, reason: 'legacy' };
                },
            },
        } as unknown as typeof globalThis;
        const documentObj = {
            querySelector: () => null,
            querySelectorAll: () => [],
            evaluate: () => ({ singleNodeValue: null, snapshotLength: 0, snapshotItem: () => null }),
        } as unknown as Document;

        installTauriMcpWebviewDriverScripts({
            windowObj,
            documentObj,
            applyLocalSettings: (delta) => {
                applied.push(delta);
            },
            flushDesktopOverlaySync: () => {
                flushCount += 1;
            },
        });

        const result = await (
            windowObj as unknown as {
                __MCP__?: {
                    applyHappierLocalSettings?: (delta: unknown) => Promise<{ ok: boolean; appliedKeys?: string[] }>;
                };
            }
        ).__MCP__?.applyHappierLocalSettings?.({
            desktopOverlayEnabled: true,
        });

        expect(result).toMatchObject({
            ok: true,
            appliedKeys: ['desktopOverlayEnabled'],
        });
        expect(legacyCalled).toBe(0);
        expect(applied).toEqual([{ desktopOverlayEnabled: true }]);
        expect(flushCount).toBe(1);
    });

    it('awaits the overlay sync flush before reporting local-settings writes as complete', async () => {
        const windowObj = {
            __MCP__: {},
        } as unknown as typeof globalThis;
        const documentObj = {
            querySelector: () => null,
            querySelectorAll: () => [],
            evaluate: () => ({ singleNodeValue: null, snapshotLength: 0, snapshotItem: () => null }),
        } as unknown as Document;

        let flushCount = 0;
        installTauriMcpWebviewDriverScripts({
            windowObj,
            documentObj,
            applyLocalSettings: () => {},
            flushDesktopOverlaySync: async () => {
                await new Promise<void>((resolve) => {
                    setTimeout(resolve, 0);
                });
                flushCount += 1;
            },
        });

        const promise = (
            windowObj as unknown as {
                __MCP__?: {
                    applyHappierLocalSettings?: (delta: unknown) => Promise<{ ok: boolean }>;
                };
            }
        ).__MCP__?.applyHappierLocalSettings?.({ desktopOverlayEnabled: true });

        expect(flushCount).toBe(0);
        await promise;
        expect(flushCount).toBe(1);
    });

    it('installs a canonical session-visibility helper for the Tauri MCP bridge', async () => {
        const ensured: Array<{ sessionId: string; options?: { forceRefresh?: boolean } }> = [];
        const windowObj = {
            __MCP__: {},
        } as unknown as typeof globalThis;
        const documentObj = {
            querySelector: () => null,
            querySelectorAll: () => [],
            evaluate: () => ({ singleNodeValue: null, snapshotLength: 0, snapshotItem: () => null }),
        } as unknown as Document;

        installTauriMcpWebviewDriverScripts({
            windowObj,
            documentObj,
            ensureSessionVisible: async (sessionId, options) => {
                ensured.push({ sessionId, options });
                return true;
            },
        });

        const result = await (
            windowObj as unknown as {
                __MCP__?: {
                    ensureHappierSessionVisible?: (
                        sessionId: unknown,
                        options?: { forceRefresh?: boolean },
                    ) => Promise<{ ok: boolean; sessionId?: string }>;
                };
            }
        ).__MCP__?.ensureHappierSessionVisible?.('sess_overlay', { forceRefresh: true });

        expect(result).toEqual({
            ok: true,
            sessionId: 'sess_overlay',
        });
        expect(ensured).toEqual([
            {
                sessionId: 'sess_overlay',
                options: { forceRefresh: true },
            },
        ]);
    });

    it('installs a deterministic desktop-overlay QA seed helper for canonical proof states', async () => {
        const seededModes: string[] = [];
        const windowObj = {
            __MCP__: {},
        } as unknown as typeof globalThis;
        const documentObj = {
            querySelector: () => null,
            querySelectorAll: () => [],
            evaluate: () => ({ singleNodeValue: null, snapshotLength: 0, snapshotItem: () => null }),
        } as unknown as Document;

        installTauriMcpWebviewDriverScripts({
            windowObj,
            documentObj,
            seedDesktopOverlayQaState: async (mode) => {
                seededModes.push(mode);
                return {
                    ok: true,
                    mode,
                    cardKind: mode,
                };
            },
        });

        const result = await (
            windowObj as unknown as {
                __MCP__?: {
                    seedDesktopActivityOverlayQaState?: (mode: unknown) => Promise<{ ok: boolean; mode?: string }>;
                };
            }
        ).__MCP__?.seedDesktopActivityOverlayQaState?.('permission_request');

        expect(result).toMatchObject({
            ok: true,
            mode: 'permission_request',
        });
        expect(seededModes).toEqual(['permission_request']);
    });

    it('briefly pins desktop-overlay QA seed state so live runtime refresh cannot overwrite proof captures', async () => {
        vi.useFakeTimers();

        const seededModes: string[] = [];
        const windowObj = {
            __MCP__: {},
        } as unknown as typeof globalThis;
        const documentObj = {
            querySelector: () => null,
            querySelectorAll: () => [],
            evaluate: () => ({ singleNodeValue: null, snapshotLength: 0, snapshotItem: () => null }),
        } as unknown as Document;

        installTauriMcpWebviewDriverScripts({
            windowObj,
            documentObj,
            seedDesktopOverlayQaState: async (mode) => {
                seededModes.push(mode);
                return {
                    ok: true,
                    mode,
                    cardKind: mode,
                };
            },
        });

        await (
            windowObj as unknown as {
                __MCP__?: {
                    seedDesktopActivityOverlayQaState?: (mode: unknown) => Promise<{ ok: boolean; mode?: string }>;
                };
            }
        ).__MCP__?.seedDesktopActivityOverlayQaState?.('quota_summary');

        await vi.advanceTimersByTimeAsync(350);

        expect(seededModes.length).toBeGreaterThan(1);
        expect(new Set(seededModes)).toEqual(new Set(['quota_summary']));
    });

    it('stops the previous desktop-overlay QA seed pin before pinning a new proof state', async () => {
        vi.useFakeTimers();

        const seededModes: string[] = [];
        const windowObj = {
            __MCP__: {},
        } as unknown as typeof globalThis;
        const documentObj = {
            querySelector: () => null,
            querySelectorAll: () => [],
            evaluate: () => ({ singleNodeValue: null, snapshotLength: 0, snapshotItem: () => null }),
        } as unknown as Document;

        installTauriMcpWebviewDriverScripts({
            windowObj,
            documentObj,
            seedDesktopOverlayQaState: async (mode) => {
                seededModes.push(mode);
                return {
                    ok: true,
                    mode,
                    cardKind: mode,
                };
            },
        });

        const mcp = (
            windowObj as unknown as {
                __MCP__?: {
                    seedDesktopActivityOverlayQaState?: (mode: unknown) => Promise<{ ok: boolean; mode?: string }>;
                };
            }
        ).__MCP__;

        await mcp?.seedDesktopActivityOverlayQaState?.('permission_request');
        await mcp?.seedDesktopActivityOverlayQaState?.('user_question');
        await vi.advanceTimersByTimeAsync(250);

        expect(seededModes).toContain('permission_request');
        expect(seededModes.at(-1)).toBe('user_question');
        expect(seededModes.slice(2)).not.toContain('permission_request');
    });

    it('maybeInstallTauriMcpBridge installs scripts only on desktop', () => {
        const element = { tagName: 'BUTTON' } as unknown as Element;
        const reverseRefs = new Map<string, Element>([['e1', element]]);
        const windowObj = {
            __MCP__: {
                reverseRefs,
            },
        } as unknown as typeof globalThis;
        const documentObj = {
            querySelector: () => element,
            querySelectorAll: () => [element],
            evaluate: () => ({ singleNodeValue: element, snapshotLength: 1, snapshotItem: () => element }),
        } as unknown as Document;

        maybeInstallTauriMcpBridge({ isDesktopShell: false, windowObj, documentObj });
        expect((windowObj as unknown as { __MCP__?: { resolveRef?: unknown } }).__MCP__?.resolveRef).toBeUndefined();

        maybeInstallTauriMcpBridge({ isDesktopShell: true, windowObj, documentObj });
        expect(typeof (windowObj as unknown as { __MCP__?: { resolveRef?: unknown } }).__MCP__?.resolveRef).toBe('function');
    });
});
