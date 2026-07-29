import { Platform } from "react-native";

import { isTauriDesktop } from "@/utils/platform/tauri";

import type { LocalServicePreviewPlatform } from "./url";

/**
 * Canonical resolver for the {@link LocalServicePreviewPlatform} a local-service preview / plugin
 * surface is presented on. One owner so the session-details and workspace-details panels (and any
 * future preview-platform-override caller) cannot drift apart.
 *
 * Resolution order (finding #13 / Phase 5.5):
 *   1. A genuine explicit override wins (a cross-platform target the caller chose).
 *   2. The native device OS (`ios`/`android`).
 *   3. Tauri desktop — checked BEFORE collapsing to `web`, because Tauri runs the web bundle so
 *      `Platform.OS === 'web'` inside the desktop app. Resolving to `desktop` is what lets the
 *      browser-surface selector reach the native Wry WebView instead of the sandboxed iframe.
 *   4. A plain web browser → `web`.
 */
export function resolveLocalServicePreviewPlatform(
    explicitPlatform?: LocalServicePreviewPlatform | null,
): LocalServicePreviewPlatform {
    if (explicitPlatform) {
        return explicitPlatform;
    }
    if (Platform.OS === "ios" || Platform.OS === "android") {
        return Platform.OS;
    }
    if (isTauriDesktop()) {
        return "desktop";
    }
    return "web";
}
