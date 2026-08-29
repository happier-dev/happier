import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import open from 'open';
import { logger } from './logger';

function hasGraphicalLinuxSession(): boolean {
    return Boolean(
        process.env.DISPLAY?.trim()
        || process.env.WAYLAND_DISPLAY?.trim()
        || process.env.WSL_DISTRO_NAME?.trim()
        || process.env.WSL_INTEROP?.trim(),
    );
}

function isBunRuntime(): boolean {
    return Boolean((process.versions as NodeJS.ProcessVersions & { bun?: string }).bun);
}

async function hasExecutableOnPath(executable: string): Promise<boolean> {
    const pathValue = process.env.PATH ?? '';
    for (const directory of pathValue.split(delimiter)) {
        if (!directory) continue;
        try {
            await access(join(directory, executable), constants.X_OK);
            return true;
        } catch {
            // Keep searching PATH.
        }
    }
    return false;
}

/**
 * Attempts to open a URL in the default browser
 * 
 * @param url - The URL to open
 * @returns Promise<boolean> - true if successful, false if failed or in headless environment
 */
export async function openBrowser(url: string): Promise<boolean> {
    try {
        const noOpenRaw = (process.env.HAPPIER_NO_BROWSER_OPEN ?? '').toString().trim();
        const noOpen = Boolean(noOpenRaw) && noOpenRaw !== '0' && noOpenRaw.toLowerCase() !== 'false';
        if (noOpen) {
            logger.debug('[browser] Browser opening disabled (HAPPIER_NO_BROWSER_OPEN), skipping browser open');
            return false;
        }
        // Check if we're in a headless environment
        if (!process.stdout.isTTY || process.env.CI || process.env.HEADLESS) {
            logger.debug('[browser] Headless environment detected, skipping browser open');
            return false;
        }

        if (process.platform === 'linux' && !hasGraphicalLinuxSession()) {
            logger.debug('[browser] No graphical Linux session detected, skipping browser open');
            return false;
        }

        // The `open` package ships an xdg-open fallback for Node.js, but Bun-compiled
        // binaries cannot resolve that bundled script and delegate to PATH instead.
        if (
            process.platform === 'linux'
            && isBunRuntime()
            && !process.env.WSL_DISTRO_NAME
            && !process.env.WSL_INTEROP
            && !(await hasExecutableOnPath('xdg-open'))
        ) {
            logger.debug('[browser] xdg-open is unavailable, skipping browser open');
            return false;
        }

        logger.debug(`[browser] Attempting to open URL: ${url}`);
        await open(url);
        logger.debug('[browser] Browser opened successfully');
        return true;
    } catch (error) {
        logger.debug('[browser] Failed to open browser:', error);
        return false;
    }
}
