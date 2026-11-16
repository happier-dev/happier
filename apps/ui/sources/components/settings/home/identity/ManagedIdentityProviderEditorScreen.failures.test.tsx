import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ManagedIdentityProviderV1Schema, type ManagedIdentityProviderV1 } from '@happier-dev/protocol/identity/providers';
import { createDeferred, renderScreen, standardCleanup } from '@/dev/testkit';
import { findTestInstanceByTypeContainingText } from '@/dev/testkit/render/renderScreen';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';

const announceMock = vi.hoisted(() => vi.fn());
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    const native = await createReactNativeWebMock();
    return { ...native, Platform: { ...native.Platform, OS: 'ios' }, AccessibilityInfo: { ...native.AccessibilityInfo, announceForAccessibility: announceMock } };
});
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock({ translate: key => key }));
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ confirmResult: true }).module);
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
const { ManagedOidcProviderEditorContent } = await import('./ManagedIdentityProviderEditorScreen');
const { Modal } = await import('@/modal');
let serverId: string;
const updatePath = '/v1/identity/providers/update';
const validatePath = '/v1/identity/providers/validate';

function provider(revision: number): ManagedIdentityProviderV1 {
    return ManagedIdentityProviderV1Schema.parse({
        v: 1,
        owner: { kind: 'home' },
        id: 'provider-1',
        kind: 'oidc',
        displayName: 'Corporate OIDC',
        enabled: false,
        firstEnabledAt: null,
        securityRevision: 3,
        revision,
        config: {
            v: 1,
            kind: 'oidc',
            issuer: 'https://id.example',
            clientId: 'client-1',
            clientAuthenticationMethod: 'client_secret_post',
            scopes: 'openid profile email',
            httpTimeoutSeconds: 15,
            claims: { login: 'preferred_username', email: 'email', groups: 'groups' },
            allow: { usersAllowlist: [], emailDomains: [], groupsAny: [], groupsAll: [] },
            fetchUserInfo: true,
            storeRefreshToken: false,
            ui: { buttonColor: null, iconHint: null },
        },
        secret: { configured: true, health: 'configured' },
        teamConsumers: [],
        lastSuccessfulTest: null,
        createdByAccountId: 'account-1',
        createdAt: 1,
        updatedAt: 1,
    });
}

function renderEditor(onSaved = vi.fn(() => ({ kind: 'completed' as const }))) {
    return renderScreen(<ManagedOidcProviderEditorContent
        scope={{ serverId, accountId: 'account-1' }} owner={{ kind: 'home' }}
        provider={provider(4)} mutationsAvailable onSaved={onSaved}
    />);
}

beforeEach(async () => {
    standardCleanup();
    await harness.reset();
    serverId = await harness.addHome({ name: 'Identity Home', serverUrl: 'https://identity-home.example', accountId: 'account-1' });
    announceMock.mockClear();
    vi.mocked(Modal.confirm).mockReset().mockResolvedValue(true);
});

describe('managed provider failures through the real Action client', () => {
    it.each([
        ['forbidden', 403, 'identityAdministration.errorForbidden'],
        ['identity_provider_not_found', 404, 'identityAdministration.errorMissing'],
        ['identity_provider_invalid', 400, 'identityAdministration.errorInvalid'],
    ])('explains a %s save failure in its own terms', async (code, status, expected) => {
        harness.answer(serverId, updatePath, { status, body: { error: code } });
        const screen = await renderEditor();
        await act(async () => screen.changeTextByTestId('identity-provider-name', 'Edited OIDC'));
        await screen.pressByTestIdAsync('identity-provider-save');
        expect(screen.getTextContent()).toContain(expected);
    });

    it('keeps a dispatched save with a lost response distinct from an offline preflight', async () => {
        harness.answer(serverId, updatePath, { dispatchThenFail: true });
        const screen = await renderEditor();
        await act(async () => screen.changeTextByTestId('identity-provider-name', 'Edited OIDC'));
        await screen.pressByTestIdAsync('identity-provider-save');
        expect(screen.getTextContent()).toContain('identityAdministration.error');
        expect(screen.findByTestId('identity-provider-name')?.props.value).toBe('Edited OIDC');
        expect(harness.requestsFor(updatePath)).toHaveLength(1);
    });

    it('announces a failed save through the native accessibility boundary', async () => {
        harness.answer(serverId, updatePath, { status: 403, body: { error: 'forbidden' } });
        const screen = await renderEditor();
        await act(async () => screen.changeTextByTestId('identity-provider-name', 'Edited OIDC'));
        await screen.pressByTestIdAsync('identity-provider-save');
        expect(announceMock).toHaveBeenCalledWith('identityAdministration.errorForbidden');
    });

    it('explains a failed configuration validation with the same vocabulary', async () => {
        harness.answer(serverId, validatePath, { status: 409, body: { error: 'oidc_discovery_failed' } });
        const screen = await renderEditor();
        await screen.pressByTestIdAsync('identity-provider-test');
        expect(screen.getTextContent()).toContain('identityAdministration.errorInvalid');
    });

    it('keeps local field validation ahead of network dispatch', async () => {
        const screen = await renderEditor();
        await act(async () => screen.changeTextByTestId('identity-provider-issuer', 'http://insecure.example'));
        await screen.pressByTestIdAsync('identity-provider-save');
        expect(screen.getTextContent()).toContain('identityAdministration.invalidIssuer');
        expect(harness.requestsFor(updatePath)).toHaveLength(0);
    });

    it('completes an Ask save from the native confirmation without manufacturing an Inbox approval', async () => {
        await harness.requireUiApproval(serverId, 'identity.providers.update');
        harness.answer(serverId, updatePath, { body: { ...provider(5), displayName: 'Edited OIDC' } });
        const onSaved = vi.fn(() => ({ kind: 'completed' as const }));
        const screen = await renderEditor(onSaved);
        await act(async () => screen.changeTextByTestId('identity-provider-name', 'Edited OIDC'));
        await screen.pressByTestIdAsync('identity-provider-save');
        expect(Modal.confirm).toHaveBeenCalledOnce();
        expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ revision: 5, displayName: 'Edited OIDC' }), expect.objectContaining({ onApprovalFailed: expect.any(Function) }));
        expect(harness.artifacts(serverId).list()).toHaveLength(0);
    });

    it('keeps a declined Ask save as an editable draft without dispatching it', async () => {
        await harness.requireUiApproval(serverId, 'identity.providers.update');
        vi.mocked(Modal.confirm).mockResolvedValue(false);
        const onSaved = vi.fn(() => ({ kind: 'completed' as const }));
        const screen = await renderEditor(onSaved);
        await act(async () => screen.changeTextByTestId('identity-provider-name', 'Edited OIDC'));
        await screen.pressByTestIdAsync('identity-provider-save');
        expect(Modal.confirm).toHaveBeenCalledOnce();
        expect(harness.requestsFor(updatePath)).toHaveLength(0);
        expect(onSaved).not.toHaveBeenCalled();
        expect(screen.findByTestId('identity-provider-name')?.props.value).toBe('Edited OIDC');
        expect(screen.findByTestId('identity-provider-save')?.props.disabled).toBe(false);
    });

    it('confirms the update and secret replacement separately and saves the final server revision', async () => {
        await harness.requireUiApproval(serverId, 'identity.providers.update');
        await harness.requireUiApproval(serverId, 'identity.providers.secret.replace');
        harness.answer(serverId, updatePath, { body: provider(5) });
        harness.answer(serverId, '/v1/identity/providers/secret/replace', { body: { ...provider(6), securityRevision: 4 } });
        const onSaved = vi.fn(() => ({ kind: 'completed' as const }));
        const screen = await renderEditor(onSaved);
        await act(async () => screen.changeTextByTestId('identity-provider-client-secret', 'replacement-secret'));
        await screen.pressByTestIdAsync('identity-provider-save');
        expect(harness.requestsFor('/v1/identity/providers/secret/replace')).toEqual([
            expect.objectContaining({ input: expect.objectContaining({ expectedRevision: 5, clientSecret: 'replacement-secret' }) }),
        ]);
        expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ revision: 6, securityRevision: 4 }), expect.objectContaining({ onApprovalFailed: expect.any(Function) }));
        expect(harness.artifacts(serverId).list()).toHaveLength(0);
    });

    it('marks configuration validated only when the real response settles', async () => {
        const held = createDeferred<void>();
        harness.answer(serverId, validatePath, { body: provider(5), respondAfter: held.promise });
        const screen = await renderEditor();
        const validating = screen.pressByTestIdAsync('identity-provider-test');
        await waitForHomeGovernance(() => expect(harness.requestsFor(validatePath)).toHaveLength(1));
        expect(findTestInstanceByTypeContainingText(screen.findByTestId('identity-provider-test')!, 'Text', 'identityAdministration.validated')).toBeUndefined();
        await act(async () => held.resolve());
        await validating;
        expect(findTestInstanceByTypeContainingText(screen.findByTestId('identity-provider-test')!, 'Text', 'identityAdministration.validated')).toBeDefined();
    });

    it('finishes a created provider from the real create response', async () => {
        harness.answer(serverId, '/v1/identity/providers/create', { body: provider(1) });
        const onSaved = vi.fn(() => ({ kind: 'completed' as const }));
        const screen = await renderScreen(<ManagedOidcProviderEditorContent
            scope={{ serverId, accountId: 'account-1' }} owner={{ kind: 'home' }}
            provider={null} mutationsAvailable onSaved={onSaved}
        />);
        await act(async () => {
            screen.changeTextByTestId('identity-provider-name', 'Corporate OIDC');
            screen.changeTextByTestId('identity-provider-issuer', 'https://id.example');
            screen.changeTextByTestId('identity-provider-client-id', 'client-1');
            screen.changeTextByTestId('identity-provider-client-secret', 'secret-1');
        });
        await screen.pressByTestIdAsync('identity-provider-save');
        expect(onSaved).toHaveBeenCalledWith(provider(1), expect.objectContaining({ onApprovalFailed: expect.any(Function) }));
    });

    it('does not resume a late save response after its editor unmounts', async () => {
        const held = createDeferred<void>();
        harness.answer(serverId, updatePath, { body: { ...provider(5), displayName: 'Edited OIDC' }, respondAfter: held.promise });
        const onSaved = vi.fn(() => ({ kind: 'completed' as const }));
        const screen = await renderEditor(onSaved);
        await act(async () => screen.changeTextByTestId('identity-provider-name', 'Edited OIDC'));
        const saving = screen.pressByTestIdAsync('identity-provider-save');
        await waitForHomeGovernance(() => expect(harness.requestsFor(updatePath)).toHaveLength(1));
        await screen.unmount();
        await act(async () => held.resolve());
        await saving;
        expect(onSaved).not.toHaveBeenCalled();
    });
});
