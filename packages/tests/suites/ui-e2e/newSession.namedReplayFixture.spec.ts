import { expect, test } from '@playwright/test';

import { captureNamedSessionComposerState, openNamedSessionComposer } from '../../src/testkit/liveQa/openNamedSessionComposer';

test('binds the exact Machine on the docked composer when Home keeps its URL', async ({ page }, testInfo) => {
    const home = 'http://named-session-fixture.localhost/';
    await page.route(url => url.origin === new URL(home).origin, route =>
        route.fulfill({
            contentType: 'text/html',
            body: `
                <script>if (location.pathname === '/new') history.replaceState(null, '', '/');</script>
                <button data-testid="home-header-start-new-session" onclick="composer.hidden = false">New session</button>
                <section id="composer" hidden>
                    <textarea data-testid="new-session-composer-input"></textarea>
                    <button data-testid="agent-input-machine-chip" onclick="machines.hidden = false">Machine</button>
                    <section id="machines" hidden>
                        <button data-testid="new-session-machine-option:other-machine" onclick="selected.value = 'other'">Other</button>
                        <button data-testid="new-session-machine-option:named-machine"
                          onclick="selected.value = 'named'; machines.hidden = true">Exact Machine</button>
                    </section>
                    <output data-testid="selection" id="selected"></output>
                </section>`,
        }),
    );

    // Exercise the old route assertion against an actual redirected browser
    // document before checking the supported shell action.
    await page.goto(home + 'new?machineId=named-machine');
    expect(new URL(page.url()).searchParams.get('machineId')).toBeNull();
    const failedRouteState = await captureNamedSessionComposerState(page);
    expect(failedRouteState).toMatchObject({ route: 'home', composer: false });
    await testInfo.attach('failed-route-dom', { body: JSON.stringify(failedRouteState), contentType: 'application/json' });

    await openNamedSessionComposer(page, 'named-machine', 3_000);
    expect(page.url()).toBe(home);
    expect(await page.getByTestId('selection').textContent()).toBe('named');
    expect(await captureNamedSessionComposerState(page)).toMatchObject({ route: 'home', composer: true, machineChip: true });
});
