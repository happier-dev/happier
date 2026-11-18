// @vitest-environment jsdom
import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { API_TOKEN_ENVIRONMENT_ACTION_IDS_V1, API_TOKEN_FULL_GRANT_V1 } from '@happier-dev/protocol/auth/apiTokenGrant';
import { renderScreen, standardCleanup, waitForTestEvent } from '@/dev/testkit';
import { createApiTokenSettingsControllerHarness, disposeApiTokenSettingsControllerHarnesses } from './apiTokenSettingsControllerTestHarness';
import type { CustomModalChromeConfig } from '@/modal';
import type { ApiTokenSettingsController } from './apiTokenSettingsController';
let ApiTokenCreateModal: typeof import('./ApiTokenCreateModal')['ApiTokenCreateModal'];

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

afterEach(async () => { await standardCleanup(); await disposeApiTokenSettingsControllerHarnesses(); });

// The platform shell owns chrome. Render its published footer without feeding
// mocked layout objects back into the content, as in the token owner's tests.
async function renderDeploymentModal(controller: ApiTokenSettingsController, title: string) {
    const setChrome = vi.fn<(chrome: CustomModalChromeConfig | null) => void>();
    const screen = await renderScreen(<ApiTokenCreateModal controller={controller} deploymentTitle={title}
        onClose={() => {}} setChrome={setChrome} />);
    return { screen, async footer() {
        const chrome = setChrome.mock.calls.at(-1)?.[0];
        if (chrome?.kind !== 'card') throw new Error('Expected token modal chrome');
        return await renderScreen(<>{chrome.footer}</>);
    } };
}

it('creates only the selected Environment deployment grant while allowing its saved Ask choice', async () => {
    const { controller, requests } = await createApiTokenSettingsControllerHarness({ mode: 'plain' });
    ({ ApiTokenCreateModal } = await import('./ApiTokenCreateModal'));
    await controller.refreshEncryptionAvailability();
    controller.setCreateDraft({ label: 'Staging CI', expiryPreset: '90d', access: 'limited', grant: {
        ...API_TOKEN_FULL_GRANT_V1,
        actions: { families: [], ids: [...API_TOKEN_ENVIRONMENT_ACTION_IDS_V1] },
        targets: { sessions: [], machines: [], environments: ['env-staging'] }, deployApproval: 'automatic',
    } });
    const { screen, footer } = await renderDeploymentModal(controller, 'Staging');
    expect(screen.findByTestId('settings-api-tokens-access:full')).toBeNull();
    await (await footer()).pressByTestIdAsync('settings-api-tokens-create-continue');
    expect(screen.findByTestId('api-token-grant-actions')).toBeNull();
    expect(screen.findByTestId('api-token-grant-targets')).toBeNull();
    await screen.pressByTestIdAsync('api-token-grant-deploy-approval:ask');
    await (await footer()).pressByTestIdAsync('settings-api-tokens-create-submit');
    await waitForTestEvent(controller.subscribe, () => { expect(controller.getState().reveal?.token).toBeTruthy(); });
    const request = requests.find(row => row.path.endsWith('/create'));
    expect(request?.body.grant).toEqual({ ...API_TOKEN_FULL_GRANT_V1,
        actions: { families: [], ids: [...API_TOKEN_ENVIRONMENT_ACTION_IDS_V1] },
        targets: { sessions: [], machines: [], environments: ['env-staging'] },
    });
    expect(controller.getState().reveal?.token).toBeTruthy();
    expect(request?.body.encryption).toBeUndefined();
    expect(request?.body.authorizeUnattendedTeamAccess).not.toBe(true);
});

it('mints a deployment token with encryption access on an encrypted Account, as on a plain one (CI-E2EE-176)', async () => {
    const { controller, requests } = await createApiTokenSettingsControllerHarness({ mode: 'e2ee' });
    ({ ApiTokenCreateModal } = await import('./ApiTokenCreateModal'));
    await controller.refreshEncryptionAvailability();
    // The CI sheet's preset asks for encryption access; the owner keeps it where the Account can mint it.
    controller.setCreateDraft({ label: 'Production CI', expiryPreset: '90d', access: 'limited', encryptionAccess: true, grant: {
        ...API_TOKEN_FULL_GRANT_V1,
        actions: { families: [], ids: [...API_TOKEN_ENVIRONMENT_ACTION_IDS_V1] },
        targets: { sessions: [], machines: [], environments: ['env-production'] },
    } });
    const { screen, footer } = await renderDeploymentModal(controller, 'Production');
    expect(controller.getState().encryptionAvailability).toBe('ready');
    expect(screen.findByTestId('settings-api-tokens-deployment-client-required')).toBeNull();
    expect((await footer()).findByTestId('settings-api-tokens-create-continue')?.props.disabled).toBe(false);
    await (await footer()).pressByTestIdAsync('settings-api-tokens-create-continue');
    await (await footer()).pressByTestIdAsync('settings-api-tokens-create-submit');
    await waitForTestEvent(controller.subscribe, () => { expect(controller.getState().reveal?.token).toBeTruthy(); });
    expect(requests.find(row => row.path.endsWith('/create'))?.body.encryption).toBeDefined();
});

it('reopens an existing Environment token as its nonsecret summary and CI step', async () => {
    const { controller, requests, scope } = await createApiTokenSettingsControllerHarness({ mode: 'plain' });
    await controller.refreshEncryptionAvailability();
    controller.setCreateDraft({ label: 'Staging CI', expiryPreset: '90d', access: 'limited', grant: {
        ...API_TOKEN_FULL_GRANT_V1,
        actions: { families: [], ids: [...API_TOKEN_ENVIRONMENT_ACTION_IDS_V1] },
        targets: { sessions: [], machines: [], environments: ['env-staging'] }, deployApproval: 'automatic',
    } });
    await controller.createToken();
    const revealed = controller.getState().reveal!;
    expect(revealed.token).toBeTruthy();
    controller.clearReveal();
    const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
    const lifetime = captureActiveServerAccountScopeLifetime();
    if (!lifetime) throw new Error('Missing fixture Account lifetime');
    const { DeploymentCiSheet } = await import('@/components/projects/deployments/DeploymentCiToken');
    const screen = await renderScreen(<DeploymentCiSheet controller={controller} onClose={() => {}}
        input={{ environmentId: 'env-staging', name: 'Staging', protection: 'nonProduction',
            serverIdentityId: scope.serverId, serverApiUrl: 'https://home.example.test', scope, lifetime }} />);
    await waitForTestEvent(screen.subscribe, () => {
        expect(screen.findByTestId(`settings-api-tokens-row:${revealed.apiToken.tokenId}`)).not.toBeNull();
        expect(screen.findByTestId('project-deployments.environment.ci.step')).not.toBeNull();
    });
    expect(JSON.stringify(screen.tree.toJSON())).not.toContain(revealed.token);
    expect(screen.findByTestId('settings-api-tokens-create-label')).toBeNull();
    expect(requests.filter(row => row.path.endsWith('/create'))).toHaveLength(1);
});
