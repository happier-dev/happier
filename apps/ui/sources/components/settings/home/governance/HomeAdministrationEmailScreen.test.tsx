import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Imported from their own testkit modules rather than the `@/dev/testkit` barrel, for the reason
 * `HomeAdministrationTeamsScreen.test.tsx` gives: the barrel binds the real transports before the
 * Home boundaries are installed.
 */
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import {
    homeEmailSettingEntriesFixture,
    homeGovernanceProjectionFixture,
    homeMailDeliveryReadinessFixture,
    homeSettingsProjectionFixture,
} from '@/dev/testkit/fixtures/homeGovernanceFixtures';
import {
    createHomeGovernanceHarness,
    installHomeGovernanceBoundaries,
    waitForHomeGovernance,
} from '@/dev/testkit/harness/homeGovernanceHarness';
import { collectRenderedTestIds } from '@/dev/testkit/render/collectRenderedTestIds';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';

import { installSettingsViewCommonModuleMocks } from '../../settingsViewTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@react-navigation/native', async () => {
    const { createReactNavigationNativeMock } = await import('@/dev/testkit/mocks/reactNavigation');
    return createReactNavigationNativeMock();
});

installSettingsViewCommonModuleMocks({
    router: async () => ({
        useRouter: () => ({ push: vi.fn(), back: vi.fn() }),
        useNavigation: () => ({ setOptions: vi.fn() }),
        useLocalSearchParams: () => ({}),
    }),
});

// Only the network and the device credential store are replaced; the Action executor, strict
// schemas, the registry codec and the page's form logic are the production ones.
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);

const GOVERNANCE_PATH = '/v1/home/governance/get';
const SETTINGS_GET = '/v1/home/settings/get';
const SETTINGS_SET = '/v1/home/settings/set';
const MAIL_GET = '/v1/home/mail-delivery/get';
const MAIL_TEST = '/v1/home/mail-delivery/test';
const HOST = 'HAPPIER_AUTH_EMAIL_SMTP_HOST';
const PASSWORD = 'HAPPIER_AUTH_EMAIL_SMTP_PASSWORD';

type RenderedNode = Readonly<{ children: ReadonlyArray<RenderedNode | string> }>;

/** Every string rendered under the node carrying `testID`: what the person actually reads. */
function textUnder(node: RenderedNode | null): string {
    if (!node) return '';
    return node.children.map((child) => (typeof child === 'string' ? child : textUnder(child))).join('|');
}

async function addHome(options?: Readonly<{ admin?: boolean }>): Promise<string> {
    const home = await harness.addHome({ name: 'Home A', serverUrl: 'https://home-a.example' });
    const projection = homeGovernanceProjectionFixture();
    harness.answer(home, GOVERNANCE_PATH, {
        body: options?.admin
            ? {
                ...projection,
                viewer: { ...projection.viewer, homeRole: 'admin' },
                capabilities: { ...projection.capabilities, manageHomeSettings: false },
            }
            : projection,
    });
    return home;
}

async function renderEmail(serverId: string) {
    const { HomeAdministrationEmailScreen } = await import('./HomeAdministrationEmailScreen');
    const { resetHomeGovernanceEngineForTests } = await import('@/sync/engine/home/governance/homeGovernanceEngine');
    resetHomeGovernanceEngineForTests();
    const screen = await renderScreen(<HomeAdministrationEmailScreen serverId={serverId} />);
    await waitForHomeGovernance(() => {
        expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('home-email-status-sending');
    });
    return screen;
}

beforeEach(async () => {
    const { resetHomeGovernanceSnapshotsForTests } = await import('@/sync/store/home/governance/homeGovernanceSnapshots');
    resetHomeGovernanceSnapshotsForTests();
    resetServerFeaturesClientForTests();
    await harness.reset();
});

afterEach(() => {
    standardCleanup();
});

describe('HomeAdministrationEmailScreen', () => {
    it('keeps settings editable and shows a readiness error with Retry rather than hiding a failed companion', async () => {
        const home = await addHome();
        harness.answer(home, SETTINGS_GET, { body: homeSettingsProjectionFixture() });
        harness.answer(home, MAIL_GET, { status: 503, body: { error: 'temporarily_unavailable' } });
        const { HomeAdministrationEmailScreen } = await import('./HomeAdministrationEmailScreen');
        const { resetHomeGovernanceEngineForTests } = await import('@/sync/engine/home/governance/homeGovernanceEngine');
        resetHomeGovernanceEngineForTests();
        const screen = await renderScreen(<HomeAdministrationEmailScreen serverId={home} />);
        await waitForHomeGovernance(() => expect(screen.findByTestId('home-email-readiness-error')).not.toBeNull());
        expect(screen.findByTestId('home-email-host-input')).not.toBeNull();
        expect(screen.findByTestId('home-email-status-sending')).toBeNull();
        await act(async () => screen.changeTextByTestId('home-email-host-input', 'smtp.draft.example'));
        harness.answer(home, MAIL_GET, { body: homeMailDeliveryReadinessFixture() });
        await screen.pressByTestIdAsync('home-email-readiness-retry');
        await waitForHomeGovernance(() => expect(screen.findByTestId('home-email-status-sending')).not.toBeNull());
        expect(screen.findByTestId('home-email-readiness-error')).toBeNull();
        expect(screen.findHostByTestId('home-email-host-input')?.props.value).toBe('smtp.draft.example');
    });

    it('saves only what the owner changed, sends the password as a write-only replacement and never shows it back', async () => {
        const home = await addHome();
        harness.answer(home, SETTINGS_GET, { body: homeSettingsProjectionFixture({ revision: 3 }) });
        harness.answer(home, MAIL_GET, { body: homeMailDeliveryReadinessFixture() });
        harness.answer(home, SETTINGS_SET, {
            body: homeSettingsProjectionFixture({
                revision: 4,
                entries: homeEmailSettingEntriesFixture({ [HOST]: { value: 'smtp.example.org' } }),
            }),
        });

        const screen = await renderEmail(home);
        expect(screen.findByTestId('home-email-save')?.props.disabled).toBe(true);
        // Links name the host they open at, from the mail owner's readiness answer.
        expect(textUnder(screen.findByTestId('home-email-status-links'))).toContain('homeGovernance.email.linksOpenAt(host=app.example.com)');

        await act(async () => {
            screen.changeTextByTestId('home-email-host-input', 'smtp.example.org');
            screen.pressByTestId('home-email-password-replace');
        });
        await act(async () => {
            screen.changeTextByTestId('home-email-password-input', 'hunter2');
        });
        await act(async () => {
            await screen.pressByTestIdAsync('home-email-save');
        });

        await waitForHomeGovernance(() => expect(harness.requestsFor(SETTINGS_SET)).toHaveLength(1));
        expect(harness.requestsFor(SETTINGS_SET)[0]?.input).toEqual({
            expectedRevision: 3,
            values: { [HOST]: 'smtp.example.org' },
            secrets: { [PASSWORD]: { replace: 'hunter2' } },
        });
        await waitForHomeGovernance(() => {
            expect(screen.findByTestId('home-email-password-saved')).not.toBeNull();
        });
        // The answer is adopted: the field shows the Home's value, the password is a pill again,
        // and readiness is asked again because only the mail owner can say what changed.
        expect(screen.findHostByTestId('home-email-host-input')?.props.value).toBe('smtp.example.org');
        expect(screen.findByTestId('home-email-password-input')).toBeNull();
        await waitForHomeGovernance(() => expect(harness.requestsFor(MAIL_GET).length).toBeGreaterThanOrEqual(2));
    });

    it('asks before leaving with unsaved edits, keeps them when the owner stays, and lets a saved page go', async () => {
        const home = await addHome();
        harness.answer(home, SETTINGS_GET, { body: homeSettingsProjectionFixture({ revision: 3 }) });
        harness.answer(home, MAIL_GET, { body: homeMailDeliveryReadinessFixture() });
        harness.answer(home, SETTINGS_SET, {
            body: homeSettingsProjectionFixture({
                revision: 4,
                entries: homeEmailSettingEntriesFixture({ [HOST]: { value: 'smtp.example.org' } }),
            }),
        });
        const screen = await renderEmail(home);
        const { runGuardedNavigation } = await import('@/utils/navigation/runGuardedNavigation');
        const { Modal } = await import('@/modal');

        await act(async () => {
            screen.changeTextByTestId('home-email-host-input', 'smtp.example.org');
        });
        vi.mocked(Modal.alert).mockImplementation((_title, _message, buttons) => {
            buttons?.find((button) => button.style === 'cancel')?.onPress?.();
        });
        const blocked = vi.fn();
        await act(async () => { await runGuardedNavigation(blocked); });
        expect(Modal.alert).toHaveBeenCalledOnce();
        expect(blocked).not.toHaveBeenCalled();
        expect(screen.findHostByTestId('home-email-host-input')?.props.value).toBe('smtp.example.org');

        await act(async () => {
            await screen.pressByTestIdAsync('home-email-save');
        });
        await waitForHomeGovernance(() => expect(screen.findByTestId('home-email-save')?.props.disabled).toBe(true));
        vi.mocked(Modal.alert).mockClear();
        const leave = vi.fn();
        await act(async () => { await runGuardedNavigation(leave); });
        expect(leave).toHaveBeenCalledOnce();
        expect(Modal.alert).not.toHaveBeenCalled();
    });

    it('refuses a port outside the registry bounds before asking the Home', async () => {
        const home = await addHome();
        harness.answer(home, SETTINGS_GET, { body: homeSettingsProjectionFixture() });
        harness.answer(home, MAIL_GET, { body: homeMailDeliveryReadinessFixture() });

        const screen = await renderEmail(home);
        await act(async () => {
            screen.changeTextByTestId('home-email-port-input', '70000');
        });
        await act(async () => {
            await screen.pressByTestIdAsync('home-email-save');
        });

        expect(textUnder(screen.findByTestId('home-email-port-input.error'))).toBe('homeGovernance.email.invalidPort');
        expect(harness.requestsFor(SETTINGS_SET)).toHaveLength(0);
    });

    it('puts the Home refusal of a value under the field it names', async () => {
        const home = await addHome();
        harness.answer(home, SETTINGS_GET, { body: homeSettingsProjectionFixture() });
        harness.answer(home, MAIL_GET, { body: homeMailDeliveryReadinessFixture() });
        harness.answer(home, SETTINGS_SET, {
            status: 400,
            body: { error: 'home_settings_invalid', key: 'HAPPIER_AUTH_EMAIL_FROM_NAME', reason: 'invalid_type' },
        });

        const screen = await renderEmail(home);
        await act(async () => {
            screen.changeTextByTestId('home-email-fromName-input', 'Acme');
        });
        await act(async () => {
            await screen.pressByTestIdAsync('home-email-save');
        });

        await waitForHomeGovernance(() => {
            expect(textUnder(screen.findByTestId('home-email-fromName-input.error'))).toBe('homeGovernance.email.invalidValue');
        });
    });

    it('locks a key the deployment set, naming its env key instead of offering an inert field', async () => {
        const home = await addHome();
        harness.answer(home, SETTINGS_GET, {
            body: homeSettingsProjectionFixture({
                entries: homeEmailSettingEntriesFixture({
                    [HOST]: { value: 'smtp.deploy.example', source: 'deployment', fixed: true },
                    [PASSWORD]: { source: 'deployment', fixed: true, secretSet: true },
                }),
            }),
        });
        harness.answer(home, MAIL_GET, { body: homeMailDeliveryReadinessFixture() });

        const screen = await renderEmail(home);

        expect(screen.findByTestId('home-email-host-input')).toBeNull();
        const host = textUnder(screen.findByTestId('home-email-host'));
        // The deployment lock is the shared note: once, with the key as a code chip.
        expect(host).toContain('homeGovernance.fixedByDeploymentLead');
        expect(textUnder(screen.findByTestId('home-email-host.fixed-key:0'))).toBe(HOST);
        expect(host).not.toMatch(/fixedBy(Deployment)?\(/);
        expect(host).toContain('smtp.deploy.example');
        expect(textUnder(screen.findByTestId('home-email-password'))).toContain('homeSettings.secret.valueSet');
        expect(screen.findByTestId('home-email-password-replace')).toBeNull();
        // The rest of the form stays editable.
        expect(screen.findByTestId('home-email-username-input')).not.toBeNull();
    });

    it('shows an admin the settings read-only, with no form, no save and no test send', async () => {
        const home = await addHome({ admin: true });
        harness.answer(home, SETTINGS_GET, { body: homeSettingsProjectionFixture() });
        harness.answer(home, MAIL_GET, { body: homeMailDeliveryReadinessFixture() });

        const screen = await renderEmail(home);
        const ids = collectRenderedTestIds(screen.tree.toJSON());

        expect(ids).toContain('home-email-admin-read-only');
        expect(ids.filter((id) => id.endsWith('-input'))).toEqual([]);
        expect(ids).not.toContain('home-email-save');
        expect(ids).not.toContain('home-email-test-send');
        expect(textUnder(screen.findByTestId('home-email-password'))).toContain('homeSettings.secret.saved');
    });

    it('explains what is off while mail is not set up and offers no test send', async () => {
        const home = await addHome();
        harness.answer(home, SETTINGS_GET, {
            body: homeSettingsProjectionFixture({
                revision: 0,
                entries: homeEmailSettingEntriesFixture({
                    [HOST]: { value: null, source: 'default' },
                    [PASSWORD]: { source: 'default', secretSet: false },
                }),
            }),
        });
        harness.answer(home, MAIL_GET, {
            body: homeMailDeliveryReadinessFixture({ transportConfigured: false, ready: false }),
        });

        const screen = await renderEmail(home);
        const ids = collectRenderedTestIds(screen.tree.toJSON());

        expect(ids).toContain('home-email-not-set-up');
        expect(ids).not.toContain('home-email-test-send');
        // With nothing stored, the password is a plain field rather than Saved · Replace · Clear.
        expect(ids).toContain('home-email-password-input');
        expect(ids).not.toContain('home-email-password-saved');
    });

    it('reports a failed test send by its class only', async () => {
        const home = await addHome();
        harness.answer(home, SETTINGS_GET, { body: homeSettingsProjectionFixture() });
        harness.answer(home, MAIL_GET, { body: homeMailDeliveryReadinessFixture() });
        harness.answer(home, MAIL_TEST, { body: { status: 'failed', reason: 'transport_failed' } });

        const screen = await renderEmail(home);
        await act(async () => {
            screen.changeTextByTestId('home-email-test-to', 'ada@example.com');
        });
        await act(async () => {
            await screen.pressByTestIdAsync('home-email-test-send');
        });

        await waitForHomeGovernance(() => {
            expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('home-email-test-failed:transport_failed');
        });
        expect(harness.requestsFor(MAIL_TEST)[0]?.input).toEqual({ to: 'ada@example.com' });
    });
});
