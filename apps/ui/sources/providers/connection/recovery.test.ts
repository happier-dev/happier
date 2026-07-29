import { describe, expect, it, vi } from 'vitest';
import { createProviderErrorV1 } from '@happier-dev/protocol';

import { dispatchProviderRecoveryAction } from './recovery';

describe('dispatchProviderRecoveryAction', () => {
    it('routes exact connection and model recovery without guessing ids', async () => {
        const push = vi.fn();
        expect(await dispatchProviderRecoveryAction({
            error: createProviderErrorV1('provider_model_not_found', { connectionId: 'pc_work' }),
            router: { push },
        })).toBe(true);
        expect(push).toHaveBeenCalledWith('/(app)/settings/providers/pc_work/models');
    });

    it('refuses context-dependent recovery when the typed error has no connection id', async () => {
        const push = vi.fn();
        expect(await dispatchProviderRecoveryAction({
            error: createProviderErrorV1('provider_secret_missing'),
            router: { push },
        })).toBe(false);
        expect(push).not.toHaveBeenCalled();
    });

    it('lets an unsaved authoring surface own Saved Secret recovery without routing to a draft id', async () => {
        const push = vi.fn();
        const configureSecret = vi.fn(async () => undefined);
        expect(await dispatchProviderRecoveryAction({
            error: createProviderErrorV1('provider_endpoint_unauthorized', { connectionId: 'pc_unsaved_draft' }),
            router: { push },
            configureSecret,
        })).toBe(true);
        expect(configureSecret).toHaveBeenCalledOnce();
        expect(push).not.toHaveBeenCalled();
    });

    it('delegates retry and restart actions to the owning surface', async () => {
        const retry = vi.fn(async () => undefined);
        const restart = vi.fn(async () => undefined);
        expect(await dispatchProviderRecoveryAction({
            error: createProviderErrorV1('provider_endpoint_unreachable'), router: { push: vi.fn() }, retry,
        })).toBe(true);
        expect(await dispatchProviderRecoveryAction({
            error: createProviderErrorV1('provider_binding_changed'), router: { push: vi.fn() }, reviewAndRestart: restart,
        })).toBe(true);
        expect(retry).toHaveBeenCalledOnce();
        expect(restart).toHaveBeenCalledOnce();
    });

    it('reloads a revision-conflicted connection instead of replaying the rejected stale mutation', async () => {
        const push = vi.fn();
        const staleMutation = vi.fn(async () => undefined);

        expect(await dispatchProviderRecoveryAction({
            error: createProviderErrorV1('provider_connection_changed', { connectionId: 'pc_work' }),
            router: { push },
            retry: staleMutation,
        })).toBe(true);

        expect(push).toHaveBeenCalledWith('/(app)/settings/providers/pc_work');
        expect(staleMutation).not.toHaveBeenCalled();
    });

    it('lets the owning surface review an invalid draft before falling back to a persisted connection route', async () => {
        const push = vi.fn();
        const reviewConnection = vi.fn(async () => undefined);

        expect(await dispatchProviderRecoveryAction({
            error: createProviderErrorV1('provider_connection_invalid', { connectionId: 'pc_unsaved_draft' }),
            router: { push },
            reviewConnection,
        })).toBe(true);

        expect(reviewConnection).toHaveBeenCalledOnce();
        expect(push).not.toHaveBeenCalled();
    });

    it('lets a connection detail surface enable its selected machine while retaining route recovery elsewhere', async () => {
        const enableOnMachine = vi.fn(async () => undefined);
        const owningPush = vi.fn();
        const fallbackPush = vi.fn();
        const error = createProviderErrorV1('provider_not_enabled_on_machine', {
            connectionId: 'pc_work',
            machineId: 'machine-a',
        });

        expect(await dispatchProviderRecoveryAction({
            error,
            router: { push: owningPush },
            enableOnMachine,
        })).toBe(true);
        expect(enableOnMachine).toHaveBeenCalledOnce();
        expect(owningPush).not.toHaveBeenCalled();

        expect(await dispatchProviderRecoveryAction({
            error,
            router: { push: fallbackPush },
        })).toBe(true);
        expect(fallbackPush).toHaveBeenCalledWith('/(app)/settings/providers/pc_work');
    });

    it('does not let draft review intercept authoritative current-state recovery', async () => {
        const push = vi.fn();
        const reviewConnection = vi.fn(async () => undefined);

        expect(await dispatchProviderRecoveryAction({
            error: createProviderErrorV1('provider_rpc_mutation_outcome_unknown', {
                connectionId: 'pc_ambiguous_create', machineId: 'machine-a',
            }),
            router: { push },
            reviewConnection,
        })).toBe(true);

        expect(push).toHaveBeenCalledWith('/(app)/settings/providers/pc_ambiguous_create');
        expect(reviewConnection).not.toHaveBeenCalled();
    });

    it('reviews the most specific current state without replaying an unknown mutation', async () => {
        const retry = vi.fn(async () => undefined);
        const connectionPush = vi.fn();
        const profilePush = vi.fn();

        expect(await dispatchProviderRecoveryAction({
            error: createProviderErrorV1('provider_rpc_mutation_outcome_unknown', {
                connectionId: 'pc_work', machineId: 'machine-a',
            }),
            router: { push: connectionPush },
            retry,
        })).toBe(true);
        expect(connectionPush).toHaveBeenCalledWith('/(app)/settings/providers/pc_work');

        expect(await dispatchProviderRecoveryAction({
            error: createProviderErrorV1('provider_rpc_mutation_outcome_unknown', {
                sourceProfileId: 'legacy-a', machineId: 'machine-a',
            }),
            router: { push: profilePush },
            retry,
        })).toBe(true);
        expect(profilePush).toHaveBeenCalledWith('/(app)/settings/profiles');

        expect(retry).not.toHaveBeenCalled();
    });

    it('uses an owning current-state callback for contextless mutations and never guesses a route', async () => {
        const push = vi.fn();
        const retry = vi.fn(async () => undefined);
        const reviewCurrentState = vi.fn(async () => undefined);
        const error = createProviderErrorV1('provider_rpc_mutation_outcome_unknown', { machineId: 'machine-a' });

        expect(await dispatchProviderRecoveryAction({
            error,
            router: { push },
            retry,
            reviewCurrentState,
        })).toBe(true);
        expect(reviewCurrentState).toHaveBeenCalledOnce();
        expect(retry).not.toHaveBeenCalled();
        expect(push).not.toHaveBeenCalled();

        expect(await dispatchProviderRecoveryAction({ error, router: { push } })).toBe(false);
        expect(push).not.toHaveBeenCalled();
    });
});
