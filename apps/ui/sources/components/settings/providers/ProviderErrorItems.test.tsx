import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDeferred, renderScreen, standardCleanup } from '@/dev/testkit';
import { installSettingsViewCommonModuleMocks } from '../settingsViewTestHelpers';

const push = vi.hoisted(() => vi.fn());

installSettingsViewCommonModuleMocks({
    router: async () => ({ useRouter: () => ({ push }) }),
});
vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: Record<string, unknown>) => React.createElement('Item', props),
}));

describe('ProviderErrorItems', () => {
    afterEach(standardCleanup);
    beforeEach(() => push.mockReset());

    it('renders and dispatches the exact typed recovery action', async () => {
        const { ProviderErrorItems } = await import('./ProviderErrorItems');
        const screen = await renderScreen(<ProviderErrorItems error={{
            v: 1,
            code: 'provider_secret_missing',
            retryable: false,
            action: 'add_secret',
            connectionId: 'pc_a',
        }} />);
        expect(screen.findAllByType('Item').map((item) => item.props.title)).toEqual([
            'settingsProviders.errors.secretMissingTitle',
            'settingsProviders.errors.actions.addSecret',
        ]);
        expect(screen.findAllByType('Item')[0]?.props.icon.props.name).toBe('warning');
        await React.act(async () => { await screen.findAllByType('Item')[1]?.props.onPress?.(); });
        expect(push).toHaveBeenCalledWith('/(app)/settings/providers/pc_a');
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
        await React.act(async () => { await screen.findAllByType('Item')[1]?.props.onPress?.(); });
        expect(retry).toHaveBeenCalledOnce();
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
            const action = screen.findAllByType('Item')[1];
            action?.props.onPress?.();
            action?.props.onPress?.();
            await Promise.resolve();
        });

        expect(retry).toHaveBeenCalledOnce();
        expect(screen.findAllByType('Item')[1]?.props).toMatchObject({
            loading: true,
            disabled: true,
        });

        await React.act(async () => {
            deferred.resolve();
            await deferred.promise;
            await Promise.resolve();
        });
        expect(screen.findAllByType('Item')[1]?.props.loading).toBe(false);
        expect(screen.findAllByType('Item')[1]?.props.disabled).toBe(false);

        await React.act(async () => {
            screen.findAllByType('Item')[1]?.props.onPress?.();
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
            screen.findAllByType('Item')[1]?.props.onPress?.();
            await Promise.resolve();
        });
        expect(screen.findAllByType('Item')[1]?.props.loading).toBe(true);

        await React.act(async () => {
            deferred.reject(new Error('recovery failed'));
            try {
                await deferred.promise;
            } catch {
                // The component owns the action rejection and restores availability.
            }
            await Promise.resolve();
        });
        expect(screen.findAllByType('Item')[1]?.props.loading).toBe(false);
        expect(screen.findAllByType('Item')[1]?.props.disabled).toBe(false);

        await React.act(async () => {
            screen.findAllByType('Item')[1]?.props.onPress?.();
            await Promise.resolve();
        });
        expect(retry).toHaveBeenCalledTimes(2);
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

        const items = screen.findAllByType('Item');
        expect(items.map((item) => item.props.title)).toEqual([
            'settingsProviders.errors.rpcResponseInvalidTitle',
            'settingsProviders.errors.actions.retry',
        ]);
        expect(items[0]?.props.title).not.toBe('settingsProviders.errors.unreachableTitle');
        await React.act(async () => { await items[1]?.props.onPress?.(); });
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

        const items = screen.findAllByType('Item');
        expect(items.map((item) => item.props.title)).toEqual([
            'settingsProviders.errors.mutationOutcomeUnknownTitle',
            'settingsProviders.errors.actions.reviewCurrentState',
        ]);
        await React.act(async () => { await items[1]?.props.onPress?.(); });
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
            await screen.findAllByType('Item')[1]?.props.onPress?.();
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
            await screen.findAllByType('Item')[1]?.props.onPress?.();
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
            await screen.findAllByType('Item')[1]?.props.onPress?.();
        });
        expect(push).toHaveBeenCalledWith('/(app)/settings/providers/pc_ambiguous_create');
        expect(reviewConnection).toHaveBeenCalledOnce();
    });
});
