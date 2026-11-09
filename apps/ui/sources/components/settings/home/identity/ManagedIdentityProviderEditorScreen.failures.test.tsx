import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { findTestInstanceByTypeContainingText } from '@/dev/testkit/render/renderScreen';

import type { ManagedIdentityProviderV1 } from '@happier-dev/protocol/identity/providers';

import { renderScreen, standardCleanup } from '@/dev/testkit';

const executeMock = vi.hoisted(() => vi.fn());
const announceMock = vi.hoisted(() => vi.fn());

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock().module;
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});
vi.mock('@/components/ui/accessibility/announceAccessibilityMessage', () => ({
    announceAccessibilityMessage: announceMock,
}));
vi.mock('./managedIdentityProviderClient', () => ({
    createManagedIdentityProviderClient: () => ({ execute: executeMock }),
}));

import { ManagedOidcProviderEditorContent } from './ManagedIdentityProviderEditorScreen';

function provider(revision: number): ManagedIdentityProviderV1 {
    return {
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
    };
}

function renderEditor() {
    return renderScreen(
        <ManagedOidcProviderEditorContent
            scope={{ serverId: 'home-1', accountId: 'account-1' }}
            owner={{ kind: 'home' }}
            provider={provider(4)}
            mutationsAvailable
            onSaved={() => ({ kind: 'completed' })}
        />,
    );
}

beforeEach(() => {
    standardCleanup();
    executeMock.mockReset();
    announceMock.mockReset();
});

/**
 * A failed save used to read "that did not go through" whether the Home was
 * unreachable, the administrator's permission had been revoked, or the record
 * had already been removed — three outcomes with three different next steps.
 * The editor must present the exact outcome, and announce it, because the
 * message appears in a footer far from the control that was pressed.
 */
describe('ManagedOidcProviderEditorContent failure presentation', () => {
    it.each([
        ['forbidden', 'identityAdministration.errorForbidden'],
        ['identity_provider_not_found', 'identityAdministration.errorMissing'],
        ['home_unreachable', 'teams.unavailable.offline'],
        ['identity_provider_invalid', 'identityAdministration.errorInvalid'],
    ])('explains a %s save failure in its own terms', async (code, expected) => {
        executeMock.mockResolvedValueOnce({ kind: 'failed', failure: { code, retryable: false } });
        const screen = await renderEditor();
        await act(async () => {
            screen.changeTextByTestId('identity-provider-name', 'Edited OIDC');
        });

        await screen.pressByTestIdAsync('identity-provider-save');

        expect(screen.getTextContent()).toContain(expected);
    });

    it('announces the failure so a screen reader hears it away from the pressed control', async () => {
        executeMock.mockResolvedValueOnce({ kind: 'failed', failure: { code: 'forbidden', retryable: false } });
        const screen = await renderEditor();
        await act(async () => {
            screen.changeTextByTestId('identity-provider-name', 'Edited OIDC');
        });

        await screen.pressByTestIdAsync('identity-provider-save');

        expect(announceMock).toHaveBeenCalledWith('identityAdministration.errorForbidden');
    });

    it('explains a failed configuration validation with the same vocabulary', async () => {
        executeMock.mockResolvedValueOnce({ kind: 'failed', failure: { code: 'oidc_discovery_failed', retryable: false } });
        const screen = await renderEditor();

        await screen.pressByTestIdAsync('identity-provider-test');

        expect(screen.getTextContent())
            .toContain('identityAdministration.errorInvalid');
    });

    it('keeps local validation messages, which are not server outcomes', async () => {
        const screen = await renderEditor();
        await act(async () => {
            screen.changeTextByTestId('identity-provider-issuer', 'http://insecure.example');
        });

        await screen.pressByTestIdAsync('identity-provider-save');

        expect(screen.getTextContent())
            .toContain('identityAdministration.invalidIssuer');
        expect(executeMock).not.toHaveBeenCalled();
    });

    it('presents a pending save without navigating or leaving the editor busy', async () => {
        const onSaved = vi.fn(() => ({ kind: 'completed' as const }));
        const onApprovalPending = vi.fn();
        const approval = { artifactId: 'approval-1', onExecuted: vi.fn() };
        let completeApprovedSave: ((value: ManagedIdentityProviderV1) => void | Promise<void>) | undefined;
        executeMock.mockImplementationOnce(async (_actionId, _input, options) => {
            completeApprovedSave = options.onApprovalSucceeded;
            return { kind: 'approval_pending', artifactId: 'approval-1', approval };
        });
        const screen = await renderScreen(
            <ManagedOidcProviderEditorContent
                scope={{ serverId: 'home-1', accountId: 'account-1' }}
                owner={{ kind: 'home' }}
                provider={provider(4)}
                mutationsAvailable
                onSaved={onSaved}
                onApprovalPending={onApprovalPending}
            />,
        );
        await act(async () => {
            screen.changeTextByTestId('identity-provider-name', 'Edited OIDC');
        });

        await screen.pressByTestIdAsync('identity-provider-save');

        expect(screen.getTextContent())
            .not.toContain('connect.waitingForApproval');
        expect(Boolean(screen.findByTestId('identity-provider-save')!.props.accessibilityState?.busy)).toBe(false);
        expect(onSaved).not.toHaveBeenCalled();
        expect(onApprovalPending).toHaveBeenCalledWith(approval);
        expect(announceMock).not.toHaveBeenCalledWith('connect.waitingForApproval');

        await act(async () => {
            await completeApprovedSave?.({ ...provider(5), displayName: 'Edited OIDC' });
        });

        expect(onSaved).toHaveBeenCalledOnce();
        expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ revision: 5, displayName: 'Edited OIDC' }), expect.objectContaining({ onApprovalFailed: expect.any(Function) }));
    });

    it('does not mark a pending validation as completed', async () => {
        const approval = { artifactId: 'approval-1', onExecuted: vi.fn() };
        let completeApprovedValidation: ((value: ManagedIdentityProviderV1) => void | Promise<void>) | undefined;
        executeMock.mockImplementationOnce(async (_actionId, _input, options) => {
            completeApprovedValidation = options.onApprovalSucceeded;
            return { kind: 'approval_pending', artifactId: 'approval-1', approval };
        });
        const onApprovalPending = vi.fn();
        const screen = await renderScreen(
            <ManagedOidcProviderEditorContent
                scope={{ serverId: 'home-1', accountId: 'account-1' }}
                owner={{ kind: 'home' }}
                provider={provider(4)}
                mutationsAvailable
                onSaved={() => ({ kind: 'completed' })}
                onApprovalPending={onApprovalPending}
            />,
        );

        await screen.pressByTestIdAsync('identity-provider-test');

        expect(findTestInstanceByTypeContainingText(screen.findByTestId('identity-provider-test')!, 'Text', 'identityAdministration.validated')).toBeUndefined();
        expect(Boolean(screen.findByTestId('identity-provider-test')!.props.accessibilityState?.busy)).toBe(false);
        expect(screen.getTextContent())
            .not.toContain('connect.waitingForApproval');
        expect(onApprovalPending).toHaveBeenCalledWith(approval);

        await act(async () => {
            await completeApprovedValidation?.(provider(5));
        });

        expect(findTestInstanceByTypeContainingText(screen.findByTestId('identity-provider-test')!, 'Text', 'identityAdministration.validated')).toBeDefined();
    });

    it('surfaces an approved result failure and leaves the save available for retry', async () => {
        let reportApprovedFailure: ((code: string) => void) | undefined;
        executeMock.mockImplementationOnce(async (_actionId, _input, options) => {
            reportApprovedFailure = options.onApprovalFailed;
            return {
                kind: 'approval_pending',
                artifactId: 'approval-1',
                approval: { artifactId: 'approval-1', onExecuted: vi.fn() },
            };
        });
        const screen = await renderEditor();
        await act(async () => {
            screen.changeTextByTestId('identity-provider-name', 'Edited OIDC');
        });

        await screen.pressByTestIdAsync('identity-provider-save');
        await act(async () => reportApprovedFailure?.('home_unreachable'));

        expect(screen.getTextContent())
            .toContain('teams.unavailable.offline');
        expect(Boolean(screen.findByTestId('identity-provider-save')!.props.disabled)).toBe(false);
    });

    it('finishes a newly created provider from the approved result', async () => {
        const approval = { artifactId: 'approval-create', onExecuted: vi.fn() };
        let completeApprovedCreate: ((value: ManagedIdentityProviderV1) => void | Promise<void>) | undefined;
        executeMock.mockImplementationOnce(async (_actionId, _input, options) => {
            completeApprovedCreate = options.onApprovalSucceeded;
            return { kind: 'approval_pending', artifactId: approval.artifactId, approval };
        });
        const onSaved = vi.fn(() => ({ kind: 'completed' as const }));
        const onApprovalPending = vi.fn();
        const screen = await renderScreen(
            <ManagedOidcProviderEditorContent
                scope={{ serverId: 'home-1', accountId: 'account-1' }}
                owner={{ kind: 'home' }}
                provider={null}
                mutationsAvailable
                onSaved={onSaved}
                onApprovalPending={onApprovalPending}
            />,
        );
        await act(async () => {
            screen.changeTextByTestId('identity-provider-name', 'Corporate OIDC');
            screen.changeTextByTestId('identity-provider-issuer', 'https://id.example');
            screen.changeTextByTestId('identity-provider-client-id', 'client-1');
            screen.changeTextByTestId('identity-provider-client-secret', 'secret-1');
        });

        await screen.pressByTestIdAsync('identity-provider-save');

        expect(onApprovalPending).toHaveBeenCalledWith(approval);
        expect(onSaved).not.toHaveBeenCalled();

        await act(async () => {
            await completeApprovedCreate?.(provider(1));
        });

        expect(onSaved).toHaveBeenCalledWith(provider(1), expect.objectContaining({ onApprovalFailed: expect.any(Function) }));
    });

    it('finishes the secret-replacement step from its approved result', async () => {
        const approval = { artifactId: 'approval-secret', onExecuted: vi.fn() };
        let completeApprovedSecret: ((value: ManagedIdentityProviderV1) => void | Promise<void>) | undefined;
        executeMock
            .mockResolvedValueOnce({ kind: 'succeeded', value: provider(5) })
            .mockImplementationOnce(async (_actionId, _input, options) => {
                completeApprovedSecret = options.onApprovalSucceeded;
                return { kind: 'approval_pending', artifactId: approval.artifactId, approval };
            });
        const onSaved = vi.fn(() => ({ kind: 'completed' as const }));
        const onApprovalPending = vi.fn();
        const screen = await renderScreen(
            <ManagedOidcProviderEditorContent
                scope={{ serverId: 'home-1', accountId: 'account-1' }}
                owner={{ kind: 'home' }}
                provider={provider(4)}
                mutationsAvailable
                onSaved={onSaved}
                onApprovalPending={onApprovalPending}
            />,
        );
        await act(async () => {
            screen.changeTextByTestId('identity-provider-client-secret', 'replacement-secret');
        });

        await screen.pressByTestIdAsync('identity-provider-save');

        expect(executeMock).toHaveBeenNthCalledWith(
            2,
            'identity.providers.secret.replace',
            expect.objectContaining({ expectedRevision: 5, clientSecret: 'replacement-secret' }),
            expect.anything(),
        );
        expect(onApprovalPending).toHaveBeenCalledWith(approval);
        expect(onSaved).not.toHaveBeenCalled();

        await act(async () => {
            await completeApprovedSecret?.({ ...provider(6), securityRevision: 4 });
        });

        expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ revision: 6, securityRevision: 4 }), expect.objectContaining({ onApprovalFailed: expect.any(Function) }));
    });

    it('hands an approved provider update into a second approval for its exact secret replacement', async () => {
        const updateApproval = { artifactId: 'approval-update', onExecuted: vi.fn() };
        const secretApproval = { artifactId: 'approval-secret', onExecuted: vi.fn() };
        let completeApprovedUpdate: ((value: ManagedIdentityProviderV1) => void | Promise<void>) | undefined;
        let completeApprovedSecret: ((value: ManagedIdentityProviderV1) => void | Promise<void>) | undefined;
        executeMock
            .mockImplementationOnce(async (_actionId, _input, options) => {
                completeApprovedUpdate = options.onApprovalSucceeded;
                return { kind: 'approval_pending', artifactId: updateApproval.artifactId, approval: updateApproval };
            })
            .mockImplementationOnce(async (_actionId, _input, options) => {
                completeApprovedSecret = options.onApprovalSucceeded;
                return { kind: 'approval_pending', artifactId: secretApproval.artifactId, approval: secretApproval };
            });
        const onSaved = vi.fn(() => ({ kind: 'completed' as const }));
        const onApprovalPending = vi.fn();
        const screen = await renderScreen(
            <ManagedOidcProviderEditorContent
                scope={{ serverId: 'home-1', accountId: 'account-1' }}
                owner={{ kind: 'home' }}
                provider={provider(4)}
                mutationsAvailable
                onSaved={onSaved}
                onApprovalPending={onApprovalPending}
            />,
        );
        await act(async () => {
            screen.changeTextByTestId('identity-provider-name', 'Edited Corporate OIDC');
            screen.changeTextByTestId('identity-provider-client-secret', 'replacement-secret');
        });

        await screen.pressByTestIdAsync('identity-provider-save');
        expect(onApprovalPending).toHaveBeenNthCalledWith(1, updateApproval);

        await act(async () => {
            await completeApprovedUpdate?.({ ...provider(5), displayName: 'Edited Corporate OIDC' });
        });
        expect(executeMock).toHaveBeenNthCalledWith(
            2,
            'identity.providers.secret.replace',
            expect.objectContaining({
                expectedRevision: 5,
                clientSecret: 'replacement-secret',
            }),
            expect.objectContaining({
                onApprovalSucceeded: expect.any(Function),
                onApprovalFailed: expect.any(Function),
            }),
        );
        expect(onApprovalPending).toHaveBeenNthCalledWith(2, secretApproval);
        expect(onSaved).not.toHaveBeenCalled();

        await act(async () => {
            await completeApprovedSecret?.({
                ...provider(6),
                displayName: 'Edited Corporate OIDC',
                securityRevision: 4,
            });
        });
        expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({
            revision: 6,
            securityRevision: 4,
        }), expect.objectContaining({ onApprovalFailed: expect.any(Function) }));
    });

    it('does not resume an approved result after its editor origin unmounts', async () => {
        let completeApprovedSave: ((value: ManagedIdentityProviderV1) => void | Promise<void>) | undefined;
        executeMock.mockImplementationOnce(async (_actionId, _input, options) => {
            completeApprovedSave = options.onApprovalSucceeded;
            return {
                kind: 'approval_pending',
                artifactId: 'approval-1',
                approval: { artifactId: 'approval-1', onExecuted: vi.fn() },
            };
        });
        const onSaved = vi.fn(() => ({ kind: 'completed' as const }));
        const screen = await renderScreen(
            <ManagedOidcProviderEditorContent
                scope={{ serverId: 'home-1', accountId: 'account-1' }}
                owner={{ kind: 'home' }}
                provider={provider(4)}
                mutationsAvailable
                onSaved={onSaved}
            />,
        );
        await act(async () => {
            screen.changeTextByTestId('identity-provider-name', 'Edited OIDC');
        });
        await screen.pressByTestIdAsync('identity-provider-save');

        await screen.unmount();
        await completeApprovedSave?.({ ...provider(5), displayName: 'Edited OIDC' });

        expect(onSaved).not.toHaveBeenCalled();
    });
});
