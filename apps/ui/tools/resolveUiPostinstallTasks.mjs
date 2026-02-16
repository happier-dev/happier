function parseOptionalBoolean(raw) {
    const value = (raw ?? '').toString().trim().toLowerCase()
    if (!value) return null
    if (value === '1' || value === 'true' || value === 'yes' || value === 'on') return true
    if (value === '0' || value === 'false' || value === 'no' || value === 'off') return false
    return null
}

export function resolveUiPostinstallTasks({ env }) {
    const tasks = ['patch-package']

    const vendorWebAssetsOverride = parseOptionalBoolean(env?.HAPPIER_UI_VENDOR_WEB_ASSETS)
    const vendorWebAssetsEnabled = vendorWebAssetsOverride ?? true

    if (vendorWebAssetsEnabled) {
        tasks.push(
            'verify-expo-router-web-modal-patch',
            'setup-skia-web',
            'vendor-monaco',
            'vendor-kokoro-web',
        )
    }

    return tasks
}
