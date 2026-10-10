import * as React from 'react';
import type { HomeGovernanceProjectionV1 } from '@happier-dev/protocol/home/governance';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Imported from their own testkit modules rather than the `@/dev/testkit` barrel, for the reason
 * `HomeAuthenticationPolicySections.test.tsx` states: the barrel would bind the real transports
 * before `installHomeGovernanceBoundaries` replaces the network leaf.
 */
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { homeGovernanceProjectionFixture } from '@/dev/testkit/fixtures/homeGovernanceFixtures';
import {
    createHomeGovernanceHarness,
    installHomeGovernanceBoundaries,
    waitForHomeGovernance,
} from '@/dev/testkit/harness/homeGovernanceHarness';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import type { HomeAdministrationContext } from './homeAdministrationContext';

import { installSettingsViewCommonModuleMocks } from '../../settingsViewTestHelpers';

const routerPush = vi.hoisted(() => vi.fn());
installSettingsViewCommonModuleMocks({
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({ router: { push: routerPush } }).module;
    },
});
// The generated bundled-artifact inventory is an unrelated build product absent from remote
// source mirrors; the empty projection keeps this suite on the real Action path.
vi.mock('@/sync/domains/plugins/availability/generatedBundledPluginUiArtifacts', () => ({
    BUNDLED_PLUGIN_UI_APP_ARTIFACTS: [],
}));
vi.mock('@/sync/domains/plugins/availability/bundledAppExactArtifactSource', () => ({
    createBundledPluginUiAppExactArtifactSource: () => Object.freeze({
        kind: 'appExact' as const,
        fetch: vi.fn(async () => null),
    }),
}));
vi.mock('@/sync/domains/plugins/availability/reader', () => ({
    createPluginAccountAvailabilityReader: vi.fn(),
    createPluginAccountAvailabilityReaderStore: () => Object.freeze({
        replace: () => null,
        clear: () => null,
        subscribe: () => () => undefined,
        bind: vi.fn(),
    }),
    projectPluginAccountAvailabilityMaterializationIdentity: vi.fn(),
}));

const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);

const POLICY_PATH = '/v1/home/policy/set';

type Options = HomeGovernanceProjectionV1['authenticationOptions'];
type Authentication = HomeGovernanceProjectionV1['policy']['authentication'];

function renderedControlIsDisabled(control: { props: Record<string, unknown> } | null): boolean {
    const props = control?.props;
    const accessibilityState = props?.accessibilityState as { disabled?: boolean } | undefined;
    return props?.disabled === true || props?.['aria-disabled'] === true || accessibilityState?.disabled === true;
}

function renderedTabIsSelected(control: { props: Record<string, unknown> } | null): boolean {
    const props = control?.props;
    const accessibilityState = props?.accessibilityState as { checked?: boolean } | undefined;
    return props?.['aria-checked'] === true || accessibilityState?.checked === true;
}

const BASE_OPTIONS: Options = {
    methods: [
        { id: 'key_challenge', displayName: 'Recovery key', actions: [{ id: 'login', enabled: true, mode: 'keyed' }] },
        { id: 'github', displayName: 'GitHub', actions: [] },
    ],
    permittedAccountModes: ['e2ee'],
    recommendedProvisioningMode: 'e2ee',
    signInService: { deploymentMode: 'self', canDisable: true },
};

const NARROWED: Authentication = {
    status: 'narrowed',
    enabledMethodIds: ['key_challenge'],
    permittedAccountModes: ['e2ee'],
    recommendedProvisioningMode: null,
    admission: 'invitation_only',
    signInServiceDisabled: false,
};

async function renderEditor(input: Readonly<{
    options?: Partial<Options>;
    authentication?: Authentication;
    revision?: number;
    refresh?: () => void;
}> = {}) {
    const { SignInPolicyEditor } = await import('./HomeSignInPolicySections');
    const serverId = await harness.addHome({ name: 'Home A', serverUrl: 'https://home-a.example', accountId: 'owner' });
    const projection = homeGovernanceProjectionFixture({
        authenticationOptions: { ...BASE_OPTIONS, ...input.options },
    });
    projection.policy = {
        ...projection.policy,
        revision: input.revision ?? 6,
        authentication: input.authentication ?? NARROWED,
    };
    harness.answer(serverId, '/v1/home/governance/get', { body: projection });
    const context: HomeAdministrationContext = {
        scope: { serverId, accountId: 'owner' },
        homeName: 'Home A',
        projection,
        mutationsAvailable: true,
        approvalPending: false,
        refresh: input.refresh ?? vi.fn(),
    };
    const screen = await renderScreen(<SignInPolicyEditor context={context} />);
    return { screen, serverId, projection };
}

async function modal() {
    const { Modal } = await import('@/modal');
    return Modal;
}

beforeEach(async () => {
    await harness.reset();
    const { storage } = await import('@/sync/domains/state/storage');
    storage.setState({ settingsScope: null, settings: {} as never });
    const Modal = await modal();
    vi.mocked(Modal.confirm).mockReset();
    vi.mocked(Modal.confirm).mockResolvedValue(false);
    vi.mocked(Modal.alertAsync).mockClear();
});
afterEach(() => {
    standardCleanup();
});

type RenderedNode = Readonly<{ children: ReadonlyArray<RenderedNode | string> }>;

/** Every string rendered under a node: what the person actually reads. */
function textUnder(node: RenderedNode | null): string {
    if (!node) return '';
    return node.children.map((child) => (typeof child === 'string' ? child : textUnder(child))).join('|');
}

/** After the Home's answer the card is a few renders away; anything longer is a missing card, not a slow host. */
const CARD_WAIT = { timeout: 5_000, interval: 20 } as const;

describe('SignInPolicyEditor', () => {
    it('saves a narrowing in one revision-guarded write without asking', async () => {
        const { screen, serverId, projection } = await renderEditor();
        harness.answer(serverId, POLICY_PATH, { body: { ...projection.policy, revision: 7 } });

        expect(renderedControlIsDisabled(screen.findByTestId('home-policy-auth-save'))).toBe(true);
        await screen.pressByTestIdAsync('home-policy-auth-admission:closed');
        expect(renderedTabIsSelected(screen.findByTestId('home-policy-auth-admission:closed'))).toBe(true);
        await screen.pressByTestIdAsync('home-policy-auth-save');

        await waitForHomeGovernance(() => expect(harness.requestsFor(POLICY_PATH)).toHaveLength(1));
        expect(harness.requestsFor(POLICY_PATH)[0]?.input).toEqual({
            expectedRevision: 6,
            authenticationPolicy: {
                v: 1,
                enabledMethodIds: ['key_challenge'],
                permittedAccountModes: ['e2ee'],
                admission: 'closed',
                signInService: null,
            },
        });
        expect(vi.mocked((await modal()).confirm)).not.toHaveBeenCalled();
    });

    it('asks at this Home’s address, inline at the row it widens, then resends the same document confirmed', async () => {
        const { screen, serverId, projection } = await renderEditor();
        harness.answer(serverId, POLICY_PATH, {
            select: (input) => ((input as { confirmWidening?: unknown }).confirmWidening === true
                ? { body: { ...projection.policy, revision: 7 } }
                : { status: 409, body: { error: 'home_policy_widening_unconfirmed' } }),
        });

        await screen.pressByTestIdAsync('home-policy-auth-admission:self_service');
        await screen.pressByTestIdAsync('home-policy-auth-save');

        // The confirmation is the page's own inline card under the row it widens (lab `hcPolicies-W`), not a dialog.
        // Once the Home has answered, the card follows within a few renders: a bounded wait, so a missing or
        // misplaced card fails on this assertion instead of the test deadline.
        await waitForHomeGovernance(() => expect(harness.requestsFor(POLICY_PATH).length).toBeGreaterThan(0));
        await vi.waitFor(() => expect(screen.findByTestId('home-policy-auth-widening:admission')).not.toBeNull(), CARD_WAIT);
        expect(vi.mocked((await modal()).confirm)).not.toHaveBeenCalled();
        const card = textUnder(screen.findByTestId('home-policy-auth-widening:admission'));
        expect(card).toContain('homeGovernance.signInPolicy.widening.titleAnyone');
        expect(card).toContain('homeGovernance.signInPolicy.widening.exposureAnyone(host=home-a.example)');
        expect(card).toContain('homeGovernance.signInPolicy.widening.unchanged');
        expect(card).toContain('homeGovernance.signInPolicy.widening.recorded');
        expect(harness.requestsFor(POLICY_PATH)).toHaveLength(1);

        await screen.pressByTestIdAsync('home-policy-auth-widening-confirm');
        await waitForHomeGovernance(() => expect(harness.requestsFor(POLICY_PATH)).toHaveLength(2));
        const [refused, confirmed] = harness.requestsFor(POLICY_PATH);
        const document = {
            v: 1,
            enabledMethodIds: ['key_challenge'],
            permittedAccountModes: ['e2ee'],
            admission: 'self_service',
            signInService: null,
        };
        expect(refused?.input).toEqual({ expectedRevision: 6, authenticationPolicy: document });
        expect(confirmed?.input).toEqual({ expectedRevision: 6, authenticationPolicy: document, confirmWidening: true });
        await waitForHomeGovernance(() => expect(screen.findByTestId('home-policy-auth-widening:admission')).toBeNull());
    });

    it('names the method a widening turns on at its row, and keeps the draft untouched when the owner declines', async () => {
        const { screen, serverId } = await renderEditor();
        harness.answer(serverId, POLICY_PATH, { status: 409, body: { error: 'home_policy_widening_unconfirmed' } });

        await screen.pressByTestIdAsync('home-policy-auth-method:github');
        expect(screen.findByTestId('home-policy-auth-method:github-switch')?.props.value).toBe(true);
        await screen.pressByTestIdAsync('home-policy-auth-save');

        await waitForHomeGovernance(() => expect(harness.requestsFor(POLICY_PATH).length).toBeGreaterThan(0));
        await vi.waitFor(() => expect(screen.findByTestId('home-policy-auth-widening:github')).not.toBeNull(), CARD_WAIT);
        expect(textUnder(screen.findByTestId('home-policy-auth-widening:github'))).toContain('homeGovernance.signInPolicy.widening.titleMethod(method=GitHub)');
        await screen.pressByTestIdAsync('home-policy-auth-widening-cancel');
        await waitForHomeGovernance(() => expect(renderedControlIsDisabled(screen.findByTestId('home-policy-auth-save'))).toBe(false));
        // Declining writes nothing more and says nothing more: the owner chose not to.
        expect(screen.findByTestId('home-policy-auth-widening:github')).toBeNull();
        expect(harness.requestsFor(POLICY_PATH)).toHaveLength(1);
        expect(vi.mocked((await modal()).alertAsync)).not.toHaveBeenCalled();
        expect(screen.findByTestId('home-policy-auth-method:github-switch')?.props.value).toBe(true);
    });

    it('shows a method the deployment fixes read-only with its key, and leads one that needs its sign-in app to where it is set', async () => {
        const { screen } = await renderEditor({
            options: {
                methods: [
                    { id: 'key_challenge', displayName: 'Recovery key', actions: [{ id: 'login', enabled: true, mode: 'keyed' }] },
                    { id: 'mtls', displayName: 'Device certificates (mTLS)', actions: [], fixedBy: 'HAPPIER_FEATURE_AUTH_MTLS__ENABLED' },
                    { id: 'github', displayName: 'GitHub', actions: [], unavailable: { requires: ['GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET'] } },
                ],
            },
            authentication: { ...NARROWED, enabledMethodIds: ['key_challenge', 'mtls', 'github'] },
        });

        expect(screen.findByTestId('home-policy-auth-method:mtls-switch')?.props.disabled).toBe(true);
        expect(screen.findByTestId('home-policy-auth-method:mtls-switch')?.props.value).toBe(false);
        expect(screen.findByTestId('home-policy-auth-method:mtls.fixed-key:0')?.children).toEqual(['HAPPIER_FEATURE_AUTH_MTLS__ENABLED']);
        expect(screen.getTextContent()).not.toMatch(/fixedBy(Deployment)?\(/);
        // GitHub's credentials are Home-editable: no deployment sentence and no env keys, a link to
        // the row that sets them instead (DR-03, lab `hcPolicies-R`).
        expect(screen.findByTestId('home-policy-auth-method:github-switch')).toBeNull();
        expect(screen.findByTestId('home-policy-auth-method:github.unavailable-key:0')).toBeNull();
        expect(screen.getTextContent()).not.toContain('GITHUB_CLIENT_ID');
        expect(screen.getTextContent()).toContain('homeGovernance.signInPolicy.needsGithubApp');
        expect(screen.findByTestId('home-policy-auth-method:mtls')?.props.onPress).toBeUndefined();
        screen.findByTestId('home-policy-auth-method:github')?.props.onPress();
        expect(routerPush).toHaveBeenCalledWith(expect.stringMatching(
            /\/sign-in-providers\?setting=homeAdministration\.signInProviders\.githubSignIn$/,
        ));
    });

    it('summarises company sign-in among the methods and leads to where its providers are managed', async () => {
        const { screen, serverId } = await renderEditor();
        const row = screen.findByTestId('home-policy-auth-company-sign-in');
        expect(row).not.toBeNull();
        row?.props.onPress();
        expect(routerPush).toHaveBeenLastCalledWith(
            `/settings/home/${serverId}/sign-in-providers?setting=${encodeURIComponent('homeAdministration.signInProviders.homeConnections')}`,
        );
    });

    it('keeps the deployment wording, with its keys, for a method whose keys only the deployment can set', async () => {
        const { screen } = await renderEditor({
            options: {
                methods: [
                    { id: 'key_challenge', displayName: 'Recovery key', actions: [{ id: 'login', enabled: true, mode: 'keyed' }] },
                    { id: 'github', displayName: 'GitHub', actions: [], unavailable: { requires: ['DATABASE_URL'] } },
                ],
            },
        });

        expect(screen.findByTestId('home-policy-auth-method:github.unavailable-key:0')?.children).toEqual(['DATABASE_URL']);
        expect(screen.findByTestId('home-policy-auth-method:github-switch')?.props.disabled).toBe(true);
        expect(screen.findByTestId('home-policy-auth-method:github')?.props.onPress).toBeUndefined();
    });

    it('shows the pending storage policy selected and says it applies after a restart', async () => {
        const { screen } = await renderEditor({
            options: { storagePolicy: { running: 'required_e2ee', pending: 'optional', fixedBy: null } },
            authentication: { ...NARROWED, storagePolicy: 'optional' },
        });

        expect(renderedTabIsSelected(screen.findByTestId('home-policy-auth-storage:optional'))).toBe(true);
        expect(renderedTabIsSelected(screen.findByTestId('home-policy-auth-storage:required_e2ee'))).toBe(false);
        expect(screen.getTextContent()).toContain(
            'homeGovernance.signInPolicy.storageAppliesAfterRestart(running=homeGovernance.signInPolicy.storageRequired)',
        );
    });

    it('carries the stored anonymous sign-up and storage decisions over when another field is saved', async () => {
        const { screen, serverId, projection } = await renderEditor({
            options: {
                anonymousSignup: { enabled: true, fixedBy: null },
                storagePolicy: { running: 'required_e2ee', pending: 'optional', fixedBy: null },
            },
            authentication: { ...NARROWED, anonymousSignup: true, storagePolicy: 'optional' },
        });
        harness.answer(serverId, POLICY_PATH, { body: { ...projection.policy, revision: 7 } });

        await screen.pressByTestIdAsync('home-policy-auth-admission:closed');
        await screen.pressByTestIdAsync('home-policy-auth-save');

        await waitForHomeGovernance(() => expect(harness.requestsFor(POLICY_PATH)).toHaveLength(1));
        expect(harness.requestsFor(POLICY_PATH)[0]?.input).toMatchObject({
            authenticationPolicy: { admission: 'closed', anonymousSignup: true, storagePolicy: 'optional' },
        });
    });

    it('locks anonymous sign-up and the storage policy the deployment fixes', async () => {
        const { screen } = await renderEditor({
            options: {
                anonymousSignup: { enabled: false, fixedBy: 'AUTH_ANONYMOUS_SIGNUP_ENABLED' },
                storagePolicy: { running: 'required_e2ee', pending: null, fixedBy: 'HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY' },
            },
        });

        expect(screen.findByTestId('home-policy-auth-anonymous-switch')?.props.disabled).toBe(true);
        expect(screen.findByTestId('home-policy-auth-anonymous.fixed-key:0')?.children).toEqual(['AUTH_ANONYMOUS_SIGNUP_ENABLED']);
        expect(renderedControlIsDisabled(screen.findByTestId('home-policy-auth-storage:optional'))).toBe(true);
        expect(screen.findByTestId('home-policy-auth-storage.fixed-key:0')?.children).toEqual(['HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY']);
        expect(screen.getTextContent()).not.toMatch(/fixedBy(Deployment)?\(/);
    });

    it('never lets the last sign-in method or account type be switched off', async () => {
        const { screen } = await renderEditor();

        expect(screen.findByTestId('home-policy-auth-method:key_challenge-switch')?.props.disabled).toBe(true);
        expect(screen.findByTestId('home-policy-auth-mode:e2ee-switch')?.props.disabled).toBe(true);
    });

    it('keeps a stored method the deployment no longer lists visible until it is removed, and requires a valid recommendation', async () => {
        const { screen, serverId, projection } = await renderEditor({
            authentication: {
                ...NARROWED,
                enabledMethodIds: ['retired_method'],
                permittedAccountModes: ['plain'],
                recommendedProvisioningMode: 'plain',
            },
        });
        harness.answer(serverId, POLICY_PATH, { body: { ...projection.policy, revision: 7 } });

        expect(screen.findByTestId('home-policy-auth-method:retired_method-switch')?.props.value).toBe(true);
        await screen.pressByTestIdAsync('home-policy-auth-method:key_challenge');
        await screen.pressByTestIdAsync('home-policy-auth-method:retired_method');
        await screen.pressByTestIdAsync('home-policy-auth-mode:e2ee');
        await screen.pressByTestIdAsync('home-policy-auth-mode:plain');
        // An authored recommendation is not silently removed by an account-type edit.
        expect(renderedControlIsDisabled(screen.findByTestId('home-policy-auth-save'))).toBe(true);
        await screen.pressByTestIdAsync('home-policy-auth-recommended:e2ee');
        await screen.pressByTestIdAsync('home-policy-auth-save');

        await waitForHomeGovernance(() => expect(harness.requestsFor(POLICY_PATH)).toHaveLength(1));
        expect(harness.requestsFor(POLICY_PATH)[0]?.input).toMatchObject({
            authenticationPolicy: {
                enabledMethodIds: ['key_challenge'],
                permittedAccountModes: ['e2ee'],
                recommendedProvisioningMode: 'e2ee',
            },
        });
    });

    it('keeps the draft through a stale revision and asks for a reload', async () => {
        const refresh = vi.fn();
        const { screen, serverId } = await renderEditor({ refresh });
        harness.answer(serverId, POLICY_PATH, { status: 409, body: { error: 'home_policy_revision_conflict' } });

        await screen.pressByTestIdAsync('home-policy-auth-admission:closed');
        await screen.pressByTestIdAsync('home-policy-auth-save');

        await waitForHomeGovernance(() => expect(refresh).toHaveBeenCalled());
        expect(renderedTabIsSelected(screen.findByTestId('home-policy-auth-admission:closed'))).toBe(true);
        expect(renderedControlIsDisabled(screen.findByTestId('home-policy-auth-save'))).toBe(false);
    });

    it('writes an inherited document without authoring deployment values', async () => {
        const { screen, serverId, projection } = await renderEditor({
            authentication: { status: 'inherited' },
            options: { signInService: { deploymentMode: 'disabled', canDisable: false } },
        });
        harness.answer(serverId, POLICY_PATH, { body: { ...projection.policy, revision: 7 } });

        await screen.pressByTestIdAsync('home-policy-auth-admission:closed');
        await screen.pressByTestIdAsync('home-policy-auth-save');

        await waitForHomeGovernance(() => expect(harness.requestsFor(POLICY_PATH)).toHaveLength(1));
        expect(harness.requestsFor(POLICY_PATH)[0]?.input).toEqual({
            expectedRevision: 6,
            authenticationPolicy: { v: 1, admission: 'closed', signInService: null },
        });
    });
});
