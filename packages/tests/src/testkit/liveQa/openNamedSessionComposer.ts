import type { Page } from '@playwright/test';

import { visibleNewSessionComposer } from '../uiE2e/createSessionFromNewSessionComposer';

const newSessionEntryIds = [
    'home-header-start-new-session',
    'sidebar-start-new-session',
    'tabbar-start-new-session',
    'session-getting-started-start-new-session',
];

export async function openNamedSessionComposer(page: Page, machineId: string, timeoutMs: number): Promise<void> {
    if (!/^[\w-]+$/u.test(machineId)) throw new Error('Invalid fixture Machine ID');

    // Docked New Session mounts in the shell and may leave the Home URL unchanged.
    // Bind the Machine on the mounted composer through the exact picker row.
    await page.locator(newSessionEntryIds.map(id => `[data-testid="${id}"]:visible`).join(', ')).first().click({ timeout: timeoutMs });
    const composer = visibleNewSessionComposer(page);
    await composer.waitFor({ state: 'visible', timeout: timeoutMs });
    await page.getByTestId('agent-input-machine-chip').filter({ visible: true }).first().click({ timeout: timeoutMs });
    await page.getByTestId(`new-session-machine-option:${machineId}`)
        .or(page.getByTestId(`new-session-machine:${machineId}`))
        .filter({ visible: true }).first().click({ timeout: timeoutMs });
    await composer.waitFor({ state: 'visible', timeout: timeoutMs });
}

const composerStateIds = [
    'new-session-composer-input',
    'session-drafts-hydrating',
    'new-session-draft-loading',
    'agent-input-machine-chip',
    'agent-input-agent-chip',
    'new-session-composer-send',
    'new-session-launch-approval',
];

export async function captureNamedSessionComposerState(page: Page) {
    // Keep this allowlisted and omit text, query strings, and input values.
    const screen = await page.locator('body').evaluate((body, ids) => ({
        pathname: location.pathname,
        visible: Array.from(body.querySelectorAll('[data-testid]')).flatMap(node => {
            const id = node.getAttribute('data-testid');
            return id && ids.includes(id) && node.getClientRects().length > 0 ? [id] : [];
        }),
    }), composerStateIds, { timeout: 1_000 }).catch(() => null);
    if (!screen) return null;

    const path = screen.pathname.replace(/\/+$/u, '') || '/';
    const shown = new Set(screen.visible);
    return {
        route: path === '/new' ? 'new' : path.startsWith('/new/pick/') ? 'picker'
            : path.startsWith('/session/') ? 'session' : path === '/' ? 'home' : 'other',
        composer: shown.has('new-session-composer-input'),
        draftHydrating: shown.has('session-drafts-hydrating') || shown.has('new-session-draft-loading'),
        machineChip: shown.has('agent-input-machine-chip'),
        providerChip: shown.has('agent-input-agent-chip'),
        send: shown.has('new-session-composer-send'),
        launchApproval: shown.has('new-session-launch-approval'),
    };
}
