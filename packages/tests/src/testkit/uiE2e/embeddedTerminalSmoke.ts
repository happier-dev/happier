import { expect, type Page } from '@playwright/test';

export function getEmbeddedTerminalInput(page: Page, testIdPrefix: string) {
    return page.getByTestId(`${testIdPrefix}-terminal-xterm`).locator('textarea').first();
}

export async function expectEmbeddedTerminalTranscript(
    page: Page,
    testIdPrefix: string,
    needle: string,
    timeoutMs = 60_000,
): Promise<void> {
    const terminal = page.getByTestId(`${testIdPrefix}-terminal-xterm`);
    await expect(terminal).toHaveCount(1, { timeout: timeoutMs });
    await expect.poll(
        async () => await terminal.getAttribute('data-happier-terminal-text'),
        { timeout: timeoutMs },
    ).toContain(needle);
}

export async function readEmbeddedTerminalShellSize(page: Page, testIdPrefix: string): Promise<Readonly<{ cols: number; rows: number }>> {
    const terminal = page.getByTestId(`${testIdPrefix}-terminal-xterm`);
    const cols = Number(await terminal.getAttribute('data-happier-terminal-cols'));
    const rows = Number(await terminal.getAttribute('data-happier-terminal-rows'));
    if (!Number.isInteger(cols) || cols <= 0 || !Number.isInteger(rows) || rows <= 0) {
        throw new Error(`Invalid embedded terminal size: ${cols}x${rows}`);
    }
    return { cols, rows };
}

export async function expectEmbeddedTerminalUrlBanner(page: Page, testIdPrefix: string, url: string): Promise<void> {
    await expect(page.getByTestId(`${testIdPrefix}-url-banner`)).toContainText(url, { timeout: 60_000 });
}

export async function expectEmbeddedTerminalExited(
    page: Page,
    testIdPrefix: string,
    timeoutMs = 60_000,
): Promise<void> {
    await expect(page.getByTestId(`${testIdPrefix}-overlay`)).toHaveCount(1, { timeout: timeoutMs });
}

export async function expectEmbeddedTerminalConnected(
    page: Page,
    testIdPrefix: string,
    timeoutMs = 60_000,
): Promise<void> {
    await expect(page.getByTestId(`${testIdPrefix}-overlay`)).toHaveCount(0, { timeout: timeoutMs });
}
