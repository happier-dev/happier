import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDeferred, renderScreen, standardCleanup } from '@/dev/testkit';
import { installSettingsViewCommonModuleMocks } from '../settingsViewTestHelpers';

const push = vi.hoisted(() => vi.fn());

installSettingsViewCommonModuleMocks({
    router: async () => ({ useRouter: () => ({ push }) }),
});
const { presentConnectSheet } = await import('@/components/settings/connectedServices/setup/ConnectedServiceSetupModal');
const { resolvePressTriggerAnchor } = await import('@/components/ui/popover/resolvePointerMenuAnchor');
const { Modal } = await import('@/modal');
const state = (screen: Awaited<ReturnType<typeof renderScreen>>) =>
    screen.findAll((node) => typeof node.props.title === 'string' && node.props.testID?.startsWith('provider-error:') && 'kind' in node.props)[0];
const recovery = (screen: Awaited<ReturnType<typeof renderScreen>>) =>
    screen.findAll((node) => node.props.testID?.startsWith('provider-error-action:') && typeof node.props.onPress === 'function')[0];

describe('ProviderErrorItems', () => {
    afterEach(standardCleanup);
    beforeEach(() => push.mockReset());

    it.each(['rows', 'line'] as const)('anchors the key sheet to its %s recovery trigger', async (presentation) => {
        const { ProviderErrorItems } = await import('./ProviderErrorItems');
        // Modal presentation is the boundary; recovery dispatch and anchor resolution remain real.
        const show = vi.spyOn(Modal, 'show').mockReturnValue('recovery-key-sheet');
        try {
            const screen = await renderScreen(<ProviderErrorItems presentation={presentation}
                error={{ v: 1, code: 'provider_secret_missing', retryable: false, action: 'add_secret' }}
                configureSecret={(event?: unknown) => {
                    void presentConnectSheet({ service: { kind: 'key' }, intent: 'link', anchor: resolvePressTriggerAnchor(event) });
                }} />);
            const trigger = { measureInWindow: (_callback: unknown) => undefined };
            const button = recovery(screen);
            if (!button) throw new Error('Missing key recovery trigger');
            await React.act(async () => { await button.props.onPress({ currentTarget: trigger }); });
            expect(show.mock.calls.at(-1)?.[0]).toMatchObject({ props: { request: {
                anchor: { kind: 'view', ref: { current: trigger } },
            } } });
        } finally { show.mockRestore(); }
    });

    it('explains an empty saved gateway as setup, while retaining its typed diagnostic', async () => {
        const { ProviderErrorItems } = await import('./ProviderErrorItems');
        const screen = await renderScreen(<ProviderErrorItems error={{
            v: 1, code: 'provider_connection_invalid', retryable: false, action: 'review_connection',
            connectionId: 'pc_empty_gateway', reason: 'managed_purpose_bindings_missing',
        }} />);
        expect(state(screen)?.props).toMatchObject({
            kind: 'unavailable',
            title: 'settingsProviders.local.configureManaged',
            reason: 'settingsProviders.local.configureManagedDescription',
            diagnosticCode: 'provider_connection_invalid',
        });
    });

    it('renders and dispatches the exact typed recovery action', async () => {
        const { ProviderErrorItems } = await import('./ProviderErrorItems');
        const screen = await renderScreen(<ProviderErrorItems error={{
            v: 1,
            code: 'provider_secret_missing',
            retryable: false,
            action: 'add_secret',
            connectionId: 'pc_a',
        }} />);
        expect(state(screen)?.props).toMatchObject({
            kind: 'warning',
            title: 'settingsProviders.errors.secretMissingTitle',
            reason: 'settingsProviders.errors.secretMissingDescription',
            action: { label: 'settingsProviders.errors.actions.addSecret' },
        });
        await React.act(async () => { await recovery(screen)?.props.onPress?.(); });
        expect(push).toHaveBeenCalledWith('/(app)/settings/providers/pc_a');
    });

    it('fits one compact line in a picker: glyph + title, icon-only retry, detail behind the glyph', async () => {
        const retry = vi.fn();
        const { ProviderErrorItems } = await import('./ProviderErrorItems');
        const screen = await renderScreen(<ProviderErrorItems
            presentation="line"
            error={{ v: 1, code: 'provider_rpc_response_invalid', retryable: true, action: 'retry' }}
            retry={retry}
        />);

        // One line, no row chrome: no list Items at all.
        expect(state(screen)).toBeUndefined();
        const line = screen.findByTestId('provider-error:provider_rpc_response_invalid');
        expect(line).toBeTruthy();
        expect(screen.getTextContent()).toContain('settingsProviders.errors.rpcResponseInvalidTitle');
        // The description is reachable (tooltip / accessible name on the glyph), not a second line.
        expect(screen.getTextContent()).not.toContain('settingsProviders.errors.rpcResponseInvalidDescription');
        expect(screen.findByTestId('provider-error-detail:provider_rpc_response_invalid')?.props.accessibilityLabel)
            .toBe('settingsProviders.errors.rpcResponseInvalidDescription');
        // Retry is an icon-only control with an accessible name.
        const action = screen.findByTestId('provider-error-action:provider_rpc_response_invalid');
        expect(action?.props.accessibilityLabel).toBe('settingsProviders.errors.actions.retry');
        await React.act(async () => { await action?.props.onPress?.(); });
        expect(retry).toHaveBeenCalledOnce();
    });

    it('offers retry only when a retry callback is available', async () => {
        const retry = vi.fn();
        const { ProviderErrorItems } = await import('./ProviderErrorItems');
        const screen = await renderScreen(<ProviderErrorItems error={{
            v: 1,
            code: 'provider_endpoint_unreachable',
            retryable: true,
            action: 'retry',
        }} retry={retry} />);
        await React.act(async () => { await recovery(screen)?.props.onPress?.(); });
        expect(retry).toHaveBeenCalledOnce();
    });

    it('keeps a temporarily unavailable Saved Secret retryable instead of offering replacement', async () => {
        const retry = vi.fn();
        const { ProviderErrorItems } = await import('./ProviderErrorItems');
        const screen = await renderScreen(<ProviderErrorItems error={{
            v: 1,
            code: 'provider_secret_unavailable',
            retryable: true,
            action: 'retry',
            connectionId: 'pc_shared',
        }} retry={retry} />);

        expect(state(screen)?.props).toMatchObject({
            action: { label: 'settingsProviders.errors.actions.retry' },
        });
        await React.act(async () => { await recovery(screen)?.props.onPress?.(); });
        expect(retry).toHaveBeenCalledOnce();
        expect(push).not.toHaveBeenCalled();
    });

    it('admits one recovery dispatch until the pending action settles, then re-enables it', async () => {
        const deferred = createDeferred<void>();
        const retry = vi.fn(() => deferred.promise);
        const { ProviderErrorItems } = await import('./ProviderErrorItems');
        const screen = await renderScreen(<ProviderErrorItems error={{
            v: 1,
            code: 'provider_endpoint_unreachable',
            retryable: true,
            action: 'retry',
        }} retry={retry} />);

        await React.act(async () => {
            const action = recovery(screen);
            action?.props.onPress?.();
            action?.props.onPress?.();
            await Promise.resolve();
        });

        expect(retry).toHaveBeenCalledOnce();
        expect(state(screen)?.props.action).toMatchObject({
            busy: true,
            disabled: true,
        });

        await React.act(async () => {
            deferred.resolve();
            await deferred.promise;
            await Promise.resolve();
        });
        expect(state(screen)?.props.action.busy).toBe(false);
        expect(recovery(screen)?.props.disabled).toBe(false);

        await React.act(async () => {
            recovery(screen)?.props.onPress?.();
            await Promise.resolve();
        });
        expect(retry).toHaveBeenCalledTimes(2);
    });

    it('re-enables recovery after a rejected action without leaking the rejection', async () => {
        const deferred = createDeferred<void>();
        const retry = vi.fn()
            .mockImplementationOnce(() => deferred.promise)
            .mockResolvedValueOnce(undefined);
        const { ProviderErrorItems } = await import('./ProviderErrorItems');
        const screen = await renderScreen(<ProviderErrorItems error={{
            v: 1,
            code: 'provider_endpoint_unreachable',
            retryable: true,
            action: 'retry',
        }} retry={retry} />);

        await React.act(async () => {
            recovery(screen)?.props.onPress?.();
            await Promise.resolve();
        });
        expect(state(screen)?.props.action.busy).toBe(true);

        await React.act(async () => {
            deferred.reject(new Error('recovery failed'));
            try {
                await deferred.promise;
            } catch {
                // The component owns the action rejection and restores availability.
            }
            await Promise.resolve();
        });
        expect(state(screen)?.props.action.busy).toBe(false);
        expect(recovery(screen)?.props.disabled).toBe(false);

        await React.act(async () => {
            recovery(screen)?.props.onPress?.();
            await Promise.resolve();
        });
        expect(retry).toHaveBeenCalledTimes(2);
    });

    it('keeps the request identity and the shared cause code in the card\'s Details, not in its words', async () => {
        const { ProviderErrorItems } = await import('./ProviderErrorItems');
        const screen = await renderScreen(<ProviderErrorItems error={{
            v: 1, code: 'provider_rpc_response_invalid', retryable: true, action: 'retry', machineId: 'machine-a',
            requestId: 'req_7f3a',
        }} retry={vi.fn()} />);
        expect(state(screen)?.props).toMatchObject({ diagnosticCode: 'provider_rpc_response_invalid', diagnosticDetail: 'req_7f3a' });
        expect(state(screen)?.props.title).not.toContain('req_7f3a');
    });

    it('renders an invalid RPC response without claiming that the Provider endpoint is unreachable', async () => {
        const retry = vi.fn();
        const { ProviderErrorItems } = await import('./ProviderErrorItems');
        const screen = await renderScreen(<ProviderErrorItems error={{
            v: 1,
            code: 'provider_rpc_response_invalid',
            retryable: true,
            action: 'retry',
            machineId: 'machine-a',
        }} retry={retry} />);

        expect(state(screen)?.props).toMatchObject({
            title: 'settingsProviders.errors.rpcResponseInvalidTitle',
            action: { label: 'settingsProviders.errors.actions.retry' },
        });
        expect(state(screen)?.props.title).not.toBe('settingsProviders.errors.unreachableTitle');
        await React.act(async () => { await recovery(screen)?.props.onPress?.(); });
        expect(retry).toHaveBeenCalledOnce();
    });

    it('routes an unknown migration outcome to current state and ignores a replay closure', async () => {
        const replayMutation = vi.fn();
        const { ProviderErrorItems } = await import('./ProviderErrorItems');
        const screen = await renderScreen(<ProviderErrorItems error={{
            v: 1,
            code: 'provider_rpc_mutation_outcome_unknown',
            retryable: false,
            action: 'review_current_state',
            sourceProfileId: 'legacy-a',
            machineId: 'machine-a',
        }} retry={replayMutation} />);

        expect(state(screen)?.props).toMatchObject({
            title: 'settingsProviders.errors.mutationOutcomeUnknownTitle',
            action: { label: 'settingsProviders.errors.actions.reviewCurrentState' },
        });
        await React.act(async () => { await recovery(screen)?.props.onPress?.(); });
        expect(push).toHaveBeenCalledWith('/(app)/settings/profiles');
        expect(replayMutation).not.toHaveBeenCalled();
    });

    it('refreshes the owning current surface for a contextless mutation without routing or replaying', async () => {
        const replayMutation = vi.fn();
        const reviewCurrentState = vi.fn();
        const { ProviderErrorItems } = await import('./ProviderErrorItems');
        const screen = await renderScreen(<ProviderErrorItems error={{
            v: 1,
            code: 'provider_rpc_mutation_outcome_unknown',
            retryable: false,
            action: 'review_current_state',
            machineId: 'machine-a',
        }} retry={replayMutation} reviewCurrentState={reviewCurrentState} />);

        await React.act(async () => {
            await recovery(screen)?.props.onPress?.();
        });
        expect(reviewCurrentState).toHaveBeenCalledOnce();
        expect(replayMutation).not.toHaveBeenCalled();
        expect(push).not.toHaveBeenCalled();
    });

    it('keeps draft review distinct from authoritative current-state recovery', async () => {
        const reviewConnection = vi.fn();
        const { ProviderErrorItems } = await import('./ProviderErrorItems');
        const screen = await renderScreen(<ProviderErrorItems error={{
            v: 1,
            code: 'provider_connection_invalid',
            retryable: false,
            action: 'review_connection',
            connectionId: 'pc_unsaved_draft',
        }} reviewConnection={reviewConnection} />);

        await React.act(async () => {
            await recovery(screen)?.props.onPress?.();
        });
        expect(reviewConnection).toHaveBeenCalledOnce();
        expect(push).not.toHaveBeenCalled();

        await screen.update(<ProviderErrorItems error={{
            v: 1,
            code: 'provider_rpc_mutation_outcome_unknown',
            retryable: false,
            action: 'review_current_state',
            connectionId: 'pc_ambiguous_create',
            machineId: 'machine-a',
        }} reviewConnection={reviewConnection} />);
        await React.act(async () => {
            await recovery(screen)?.props.onPress?.();
        });
        expect(push).toHaveBeenCalledWith('/(app)/settings/providers/pc_ambiguous_create');
        expect(reviewConnection).toHaveBeenCalledOnce();
    });
});
