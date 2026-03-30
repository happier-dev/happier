import { describe, expect, it } from 'vitest';

import { installTauriMcpWebviewDriverScripts } from './installTauriMcpWebviewDriverScripts';
import { maybeInstallTauriMcpBridge } from './maybeInstallTauriMcpBridge';

describe('installTauriMcpWebviewDriverScripts', () => {
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
