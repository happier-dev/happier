function parseOptionalBoolean(raw) {
    const value = (raw ?? '').toString().trim().toLowerCase()
    if (!value) return null
    if (value === '1' || value === 'true' || value === 'yes' || value === 'on') return true
    if (value === '0' || value === 'false' || value === 'no' || value === 'off') return false
    return null
}

export function resolveUiPostinstallTasks({ env }) {
    const tasks = [
        'patch-package',
        'verify-native-patch-compilation',
        'verify-vendored-reanimated-patch',
        'verify-vendored-legend-patch',
        'verify-expo-router-web-modal-patch',
        'verify-sentry-react-native-replay-post-init-patch',
        'install-react-native-enriched-markdown-web-wasm',
        'verify-react-native-enriched-markdown-web-streaming-patch',
    ]

    const vendorWebAssetsOverride = parseOptionalBoolean(env?.HAPPIER_UI_VENDOR_WEB_ASSETS)
    const vendorWebAssetsEnabled = vendorWebAssetsOverride ?? true

    if (vendorWebAssetsEnabled) {
        tasks.push(
            'setup-skia-web',
            'vendor-monaco',
            'vendor-kokoro-web',
            'vendor-pierre-diffs-worker',
            'vendor-codemirror-webview-bundle',
            'vendor-xterm-webview-bundle',
            'vendor-tiptap-webview-bundle',
            'vendor-mermaid-webview-bundle',
        )
    }

    return tasks
}
