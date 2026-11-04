import { onTestFinished, vi } from 'vitest';

/** Browser clipboard ports only; keep the mounted clipboard and Action owners real. */
export function installBrowserClipboardBoundary(
    writeText: ((value: string) => Promise<void>) | undefined,
    legacyCopied?: boolean,
) {
    const textField = { value: '', select: vi.fn() };
    const execCommand = vi.fn(() => legacyCopied ?? false);
    const removeChild = vi.fn();
    const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    const navigatorPort = typeof navigator === 'undefined' ? {} : navigator;
    const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigatorPort, 'clipboard');
    Object.defineProperty(navigatorPort, 'clipboard', { configurable: true, value: writeText ? { writeText } : undefined });
    if (!navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', { configurable: true, value: navigatorPort });
    onTestFinished(() => {
        if (clipboardDescriptor) Object.defineProperty(navigatorPort, 'clipboard', clipboardDescriptor);
        else Reflect.deleteProperty(navigatorPort, 'clipboard');
        if (!navigatorDescriptor) Reflect.deleteProperty(globalThis, 'navigator');
    });
    // Most mounted surfaces only need the modern port. A document stub would
    // also opt unrelated theme/layout code into a browser lifecycle.
    if (legacyCopied !== undefined) {
        const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
        Object.defineProperty(globalThis, 'document', { configurable: true, value: {
            createElement: vi.fn(() => textField),
            body: { appendChild: vi.fn(), removeChild },
            execCommand,
        } });
        onTestFinished(() => {
            if (documentDescriptor) Object.defineProperty(globalThis, 'document', documentDescriptor);
            else Reflect.deleteProperty(globalThis, 'document');
        });
    }
    return { textField, execCommand, removeChild };
}
