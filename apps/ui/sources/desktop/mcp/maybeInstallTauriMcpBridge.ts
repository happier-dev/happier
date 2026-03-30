import { isTauriDesktop } from '@/utils/platform/tauri';

import { installTauriMcpWebviewDriverScripts } from './installTauriMcpWebviewDriverScripts';

type McpBridgeWindowLike = typeof globalThis;

export function maybeInstallTauriMcpBridge(options?: Readonly<{
    isDesktopShell?: boolean;
    documentObj?: Document;
    windowObj?: McpBridgeWindowLike;
}>) {
    const isDesktopShell = options?.isDesktopShell ?? isTauriDesktop();
    if (!isDesktopShell) {
        return;
    }
    installTauriMcpWebviewDriverScripts({
        windowObj: options?.windowObj,
        documentObj: options?.documentObj,
    });
}

export function installTauriMcpBridgeOnce(options?: Readonly<{
    isDesktopShell?: boolean;
    documentObj?: Document;
    windowObj?: McpBridgeWindowLike;
}>) {
    const g = globalThis as unknown as Record<string, unknown> | undefined;
    if (!g) {
        return;
    }
    const key = '__HAPPIER_TAURI_MCP_BRIDGE_INSTALLED__';
    if (g[key] === true) {
        return;
    }
    g[key] = true;
    maybeInstallTauriMcpBridge(options);
}

