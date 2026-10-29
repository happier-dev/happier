function parseOptionalBoolean(raw) {
    const value = (raw ?? '').toString().trim().toLowerCase()
    if (!value) return null
    if (value === '1' || value === 'true' || value === 'yes' || value === 'on') return true
    if (value === '0' || value === 'false' || value === 'no' || value === 'off') return false
    return null
}

export function resolveUiPostinstallTasks({ env }) {
    const tasks = [
        'prepare-atmosphere-renderers',
        'verify-patched-dependencies',
        'verify-native-patch-compilation',
        'verify-vendored-reanimated-patch',
        'verify-vendored-legend-patch',
        'verify-sentry-native-replay-postinit-patch',
        'verify-expo-router-web-modal-patch',
        'install-react-native-enriched-markdown-web-wasm',
        'verify-react-native-enriched-markdown-web-streaming-patch',
    ]

    const vendorWebAssetsOverride = parseOptionalBoolean(env?.HAPPIER_UI_VENDOR_WEB_ASSETS)
    const vendorWebAssetsEnabled = vendorWebAssetsOverride ?? true

    if (vendorWebAssetsEnabled) {
        tasks.push(
            'setup-skia-web',
            'vendor-monaco',
            'vendor-pdfjs',
            'vendor-pierre-diffs-worker',
            'vendor-password-kdf-worker',
            'vendor-crypto-worker',
            'vendor-codemirror-webview-bundle',
            'vendor-xterm-webview-bundle',
            'vendor-tiptap-webview-bundle',
            'vendor-mermaid-webview-bundle',
            'vendor-pdfjs-webview-bundle',
        )

        // The browser Iroh assets (Lane 06 A7.2/A8) are deliberately absent
        // here. Every other vendored asset is target-agnostic, but the browser
        // wasm endpoint is web-only and ~4.9MB: install time has no target, so
        // vendoring it could only write to the shared source `public/` tree that
        // the Tauri and native exports copy verbatim. Its producer is
        // `tools/iroh/buildBrowserIrohAssets.mjs --output-dir <web output>`,
        // run by the web release build against its own export output.
    }

    // Dependency refresh verifies installed packages. Source compilers own
    // their output freshness and last-green reuse at UI preparation instead.
    const active = env?.HAPPIER_UI_POSTINSTALL_DEPENDENCIES_ONLY === '1'
        ? tasks.filter(task => !['prepare-atmosphere-renderers', 'vendor-password-kdf-worker', 'vendor-crypto-worker',
            'vendor-tiptap-webview-bundle', 'vendor-mermaid-webview-bundle', 'vendor-pdfjs-webview-bundle'].includes(task))
        : tasks
    if (env?.HAPPIER_UI_POSTINSTALL_TASKS == null) return active
    const selected = JSON.parse(env.HAPPIER_UI_POSTINSTALL_TASKS)
    if (!Array.isArray(selected) || selected.some(task => typeof task !== 'string' || !tasks.includes(task))) {
        throw new Error('Invalid HAPPIER_UI_POSTINSTALL_TASKS: expected known UI postinstall task ids')
    }
    return active.filter(task => selected.includes(task))
}

// The task owner also maps the declared producer inputs. Shared orchestration
// and verification helpers affect all tasks; source-only compilers retain their
// own freshness when dependency-only preparation excludes their tasks.
const taskInputOwners = {
    'tools/react-native-enriched-markdown': ['install-react-native-enriched-markdown-web-wasm'],
    'tools/diffs': ['vendor-pierre-diffs-worker'],
    'tools/password': ['vendor-password-kdf-worker'],
    'tools/crypto': ['vendor-crypto-worker'],
    'tools/atmosphere': ['prepare-atmosphere-renderers'],
    'tools/sourceAsset.mjs': ['vendor-password-kdf-worker', 'vendor-crypto-worker', 'prepare-atmosphere-renderers'],
    'tools/codemirror': ['vendor-codemirror-webview-bundle'],
    'tools/xterm': ['vendor-xterm-webview-bundle'],
    'tools/tiptap': ['vendor-tiptap-webview-bundle'],
    'tools/mermaid': ['vendor-mermaid-webview-bundle'],
    'tools/pdfjs': ['vendor-pdfjs', 'vendor-pdfjs-webview-bundle'],
}

export function resolveUiPostinstallTaskInputs({ tasks, installFreshnessInputs }) {
    return Object.fromEntries(tasks.map(task => [task, installFreshnessInputs.filter(input => {
        const owners = Object.entries(taskInputOwners)
            .find(([root]) => input === root || input.startsWith(`${root}/`))?.[1]
        return owners == null || owners.includes(task)
    })]))
}
