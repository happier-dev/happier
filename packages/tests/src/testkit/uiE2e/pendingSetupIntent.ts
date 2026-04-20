import type { Page } from '@playwright/test';

function normalizeStorageScope(value: string): string {
    const trimmed = String(value ?? '').trim();
    if (!trimmed) return '';
    const sanitized = trimmed.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/_+/g, '_');
    return sanitized.slice(0, 64);
}

export async function seedDismissedPendingSetupIntent(
    page: Pick<Page, 'addInitScript' | 'evaluate'>,
    storageScopeRaw: string,
): Promise<void> {
    const scope = normalizeStorageScope(storageScopeRaw);
    const apply = (scoped: string) => {
        const record = JSON.stringify({
            branch: 'thisComputer',
            phase: 'dismissed',
            relayUrl: null,
            createdAtMs: Date.now(),
        });

        try {
            // Current key family (used by pendingSetupIntent.web.ts):
            window.localStorage.setItem('pending-setup-intent-record', record);
            if (scoped) {
                window.localStorage.setItem(`pending-setup-intent-record__${scoped}`, record);
            }

            // Legacy MMKV key family:
            window.localStorage.setItem('mmkv.pending-setup-intent\\\\record', record);
            if (scoped) {
                window.localStorage.setItem(`mmkv.pending-setup-intent__${scoped}\\\\record`, record);
            }
        } catch {
            // Ignore storage failures (opaque origin / sandboxed contexts).
        }
    };

    await page.addInitScript(apply, scope);
    try {
        await page.evaluate(apply, scope);
    } catch {
        // Ignore evaluation failures prior to navigation; the init script will still run.
    }
}
