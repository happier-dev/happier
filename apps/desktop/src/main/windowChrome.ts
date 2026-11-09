import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type DesktopWindowChromeStrategy =
    | 'none'
    | 'native-macos-traffic-lights'
    | 'native-windows-frame'
    | 'custom-controls';

export type DesktopWindowChromePolicy = Readonly<{
    strategy: DesktopWindowChromeStrategy;
    canSetNativeTitleBar?: boolean;
    useNativeTitleBar?: boolean;
    nativeTitleBarRestartRequired?: boolean;
    nativeTitleBarPersistenceError?: boolean;
}>;

export function resolveWindowChromeStrategy(
    platform: NodeJS.Platform,
    useNativeTitleBar = false,
): DesktopWindowChromeStrategy {
    if (platform === 'darwin') return 'native-macos-traffic-lights';
    return platform === 'win32' && useNativeTitleBar ? 'native-windows-frame' : 'custom-controls';
}

/** One main-process authority for the saved choice and the frame actually created by Electron. */
export class DesktopWindowChrome {
    readonly #platform: NodeJS.Platform;
    readonly #userDataPath: () => string;
    #loaded = false;
    #savedNativeTitleBar = false;
    #appliedNativeTitleBar = false;
    #persistenceError = false;

    constructor(options: Readonly<{ platform?: NodeJS.Platform; userDataPath: () => string }>) {
        this.#platform = options.platform ?? process.platform;
        this.#userDataPath = options.userDataPath;
    }

    #preferencePath(): string {
        return join(this.#userDataPath(), 'window-chrome.json');
    }

    #load(): void {
        if (this.#loaded || this.#platform !== 'win32') return;
        this.#loaded = true;
        try {
            const saved: unknown = JSON.parse(readFileSync(this.#preferencePath(), 'utf8'));
            if (!saved || typeof saved !== 'object' || !('useNativeTitleBar' in saved)
                || typeof saved.useNativeTitleBar !== 'boolean') {
                throw new Error('invalid native title bar preference');
            }
            this.#savedNativeTitleBar = saved.useNativeTitleBar;
        } catch (error) {
            if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return;
            this.#persistenceError = true;
            console.warn('[window] desktop_native_title_bar_preference_read_failed', error);
        }
    }

    /** Called immediately before BrowserWindow construction, including a later reopened main window. */
    prepareWindow(): Readonly<{ frame: boolean; titleBarStyle?: 'hiddenInset' }> {
        this.#load();
        this.#appliedNativeTitleBar = this.#savedNativeTitleBar;
        const strategy = resolveWindowChromeStrategy(this.#platform, this.#appliedNativeTitleBar);
        return {
            frame: strategy === 'native-macos-traffic-lights' || strategy === 'native-windows-frame',
            ...(strategy === 'native-macos-traffic-lights' ? { titleBarStyle: 'hiddenInset' as const } : {}),
        };
    }

    readPolicy(): DesktopWindowChromePolicy {
        this.#load();
        return {
            strategy: resolveWindowChromeStrategy(this.#platform, this.#appliedNativeTitleBar),
            ...(this.#platform === 'win32' ? {
                canSetNativeTitleBar: true,
                useNativeTitleBar: this.#savedNativeTitleBar,
                nativeTitleBarRestartRequired: this.#savedNativeTitleBar !== this.#appliedNativeTitleBar,
                ...(this.#persistenceError ? { nativeTitleBarPersistenceError: true } : {}),
            } : {}),
        };
    }

    setNativeTitleBar(useNativeTitleBar: boolean): DesktopWindowChromePolicy {
        if (this.#platform !== 'win32') throw new Error('desktop_set_native_title_bar is supported only on Windows');
        this.#load();
        const destination = this.#preferencePath();
        const temporary = `${destination}.${randomUUID()}.tmp`;
        try {
            mkdirSync(dirname(destination), { recursive: true });
            writeFileSync(temporary, JSON.stringify({ useNativeTitleBar }), { flag: 'wx' });
            renameSync(temporary, destination);
            this.#savedNativeTitleBar = useNativeTitleBar;
            this.#persistenceError = false;
        } catch (error) {
            this.#persistenceError = true;
            console.warn('[window] desktop_native_title_bar_preference_write_failed', error);
        } finally {
            try {
                rmSync(temporary, { force: true });
            } catch (error) {
                console.warn('[window] desktop_native_title_bar_preference_cleanup_failed', error);
            }
        }
        // Electron's frame option is creation-only. Keep this window and all its webviews alive.
        return this.readPolicy();
    }
}
