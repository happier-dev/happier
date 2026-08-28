import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { act, create } from 'react-test-renderer';

import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';

import {
    getPluginUiEphemeralSharedScope,
    usePluginUiEphemeralSharedScopeBinding,
} from './pluginUiEphemeralSharedScope';

type TestAccountLifetime = ActiveServerAccountScopeLifetime & Readonly<{
    retire(): void;
}>;

function createAccountLifetime(): TestAccountLifetime {
    let current = true;
    const listeners = new Set<() => void>();
    return Object.freeze({
        scope: Object.freeze({ serverId: 'server-a', accountId: 'account-a' }),
        isCurrent: () => current,
        onRetire(listener: () => void) {
            if (!current) {
                listener();
                return Object.freeze({ dispose(): void {} });
            }
            listeners.add(listener);
            return Object.freeze({ dispose: () => { listeners.delete(listener); } });
        },
        retire(): void {
            if (!current) return;
            current = false;
            for (const listener of [...listeners]) listener();
            listeners.clear();
        },
    });
}

describe('plugin UI ephemeral shared scope', () => {
    it('shares one value within an Account, plugin, and immutable generation until the final lease releases', () => {
        const accountLifetime = createAccountLifetime();
        const scopeA = getPluginUiEphemeralSharedScope({
            accountLifetime,
            pluginId: 'acme.triage',
            immutableGenerationId: 'generation-a',
            isCurrent: () => true,
        });
        const scopeB = getPluginUiEphemeralSharedScope({
            accountLifetime,
            pluginId: 'acme.triage',
            immutableGenerationId: 'generation-a',
            isCurrent: () => true,
        });
        const dispose = vi.fn();
        const create = vi.fn(() => Object.freeze({ value: { rows: ['one'] }, dispose }));

        const first = scopeA?.acquire('mounted-window', create);
        const second = scopeB?.acquire('mounted-window', create);
        expect(first?.value).toBe(second?.value);
        expect(create).toHaveBeenCalledTimes(1);

        first?.release();
        expect(dispose).not.toHaveBeenCalled();
        second?.release();
        second?.release();
        expect(dispose).toHaveBeenCalledTimes(1);
        expect(scopeA?.acquire('mounted-window', create)?.value).not.toBe(first?.value);
        expect(create).toHaveBeenCalledTimes(2);
    });

    it('retires an older generation and refuses a stale overlapping request after the successor exists', () => {
        const accountLifetime = createAccountLifetime();
        let currentGeneration = 'generation-a';
        const generationA = getPluginUiEphemeralSharedScope({
            accountLifetime,
            pluginId: 'acme.triage',
            immutableGenerationId: 'generation-a',
            isCurrent: () => currentGeneration === 'generation-a',
        });
        const disposeA = vi.fn();
        const leaseA = generationA?.acquire(
            'mounted-window',
            () => Object.freeze({ value: { generation: 'a' }, dispose: disposeA }),
        );

        currentGeneration = 'generation-b';
        const generationB = getPluginUiEphemeralSharedScope({
            accountLifetime,
            pluginId: 'acme.triage',
            immutableGenerationId: 'generation-b',
            isCurrent: () => currentGeneration === 'generation-b',
        });
        expect(generationB).not.toBeNull();
        expect(disposeA).toHaveBeenCalledTimes(1);
        expect(generationA?.acquire(
            'mounted-window',
            () => Object.freeze({ value: { generation: 'revived-a' }, dispose: vi.fn() }),
        )).toBeNull();

        expect(getPluginUiEphemeralSharedScope({
            accountLifetime,
            pluginId: 'acme.triage',
            immutableGenerationId: 'generation-a',
            isCurrent: () => currentGeneration === 'generation-a',
        })).toBeNull();
        expect(generationB?.acquire(
            'mounted-window',
            () => Object.freeze({ value: { generation: 'b' }, dispose: vi.fn() }),
        )?.value).toEqual({ generation: 'b' });
        leaseA?.release();
        expect(disposeA).toHaveBeenCalledTimes(1);

        currentGeneration = 'generation-a';
        expect(getPluginUiEphemeralSharedScope({
            accountLifetime,
            pluginId: 'acme.triage',
            immutableGenerationId: 'generation-a',
            isCurrent: () => currentGeneration === 'generation-a',
        })).not.toBeNull();
    });

    it('fences acquisition and disposes every value when the Account retires', () => {
        const accountLifetime = createAccountLifetime();
        const scope = getPluginUiEphemeralSharedScope({
            accountLifetime,
            pluginId: 'acme.triage',
            immutableGenerationId: 'generation-a',
            isCurrent: () => true,
        });
        const dispose = vi.fn();
        scope?.acquire('mounted-window', () => Object.freeze({ value: {}, dispose }));

        accountLifetime.retire();

        expect(dispose).toHaveBeenCalledTimes(1);
        expect(scope?.acquire('mounted-window', () => Object.freeze({ value: {}, dispose: vi.fn() }))).toBeNull();
        expect(getPluginUiEphemeralSharedScope({
            accountLifetime,
            pluginId: 'acme.triage',
            immutableGenerationId: 'generation-a',
            isCurrent: () => true,
        })).toBeNull();
    });

    it('does not issue a scope for a stale mount or absent Account lifetime', () => {
        const accountLifetime = createAccountLifetime();
        expect(getPluginUiEphemeralSharedScope({
            accountLifetime: null,
            pluginId: 'acme.triage',
            immutableGenerationId: 'generation-a',
            isCurrent: () => true,
        })).toBeNull();
        expect(getPluginUiEphemeralSharedScope({
            accountLifetime,
            pluginId: 'acme.triage',
            immutableGenerationId: 'generation-a',
            isCurrent: () => false,
        })).toBeNull();
    });

    it('isolates opaque values by Account and plugin', () => {
        const accountA = createAccountLifetime();
        const accountB = createAccountLifetime();
        const scope = (accountLifetime: TestAccountLifetime, pluginId: string) => (
            getPluginUiEphemeralSharedScope({
                accountLifetime,
                pluginId,
                immutableGenerationId: 'generation-a',
                isCurrent: () => true,
            })!
        );
        const create = (id: string) => () => Object.freeze({ value: { id }, dispose: vi.fn() });

        const accountAPluginA = scope(accountA, 'acme.a').acquire('window', create('account-a-plugin-a'));
        const accountAPluginB = scope(accountA, 'acme.b').acquire('window', create('account-a-plugin-b'));
        const accountBPluginA = scope(accountB, 'acme.a').acquire('window', create('account-b-plugin-a'));

        expect(accountAPluginA?.value).toEqual({ id: 'account-a-plugin-a' });
        expect(accountAPluginB?.value).toEqual({ id: 'account-a-plugin-b' });
        expect(accountBPluginA?.value).toEqual({ id: 'account-b-plugin-a' });
        expect(accountAPluginA?.value).not.toBe(accountAPluginB?.value);
        expect(accountAPluginA?.value).not.toBe(accountBPluginA?.value);
    });

    it('disposes but never publishes a value whose create callback retires the Account', () => {
        const accountLifetime = createAccountLifetime();
        const scope = getPluginUiEphemeralSharedScope({
            accountLifetime,
            pluginId: 'acme.triage',
            immutableGenerationId: 'generation-a',
            isCurrent: () => true,
        });
        const dispose = vi.fn();

        expect(scope?.acquire('window', () => {
            accountLifetime.retire();
            return Object.freeze({ value: { stale: true }, dispose });
        })).toBeNull();
        expect(dispose).toHaveBeenCalledTimes(1);
    });

    it('isolates a throwing disposer so every value still retires', () => {
        const accountLifetime = createAccountLifetime();
        const scope = getPluginUiEphemeralSharedScope({
            accountLifetime,
            pluginId: 'acme.triage',
            immutableGenerationId: 'generation-a',
            isCurrent: () => true,
        });
        const laterDispose = vi.fn();
        scope?.acquire('throws', () => Object.freeze({
            value: {},
            dispose: () => { throw new Error('dispose failed'); },
        }));
        scope?.acquire('later', () => Object.freeze({ value: {}, dispose: laterDispose }));

        expect(() => accountLifetime.retire()).not.toThrow();
        expect(laterDispose).toHaveBeenCalledTimes(1);
    });

    it('does not retire the committed generation from an abandoned successor render', () => {
        const accountLifetime = createAccountLifetime();
        let currentGeneration = 'generation-a';
        let observedScope: ReturnType<typeof usePluginUiEphemeralSharedScopeBinding> = null;
        const mountLifetimes = Object.freeze({
            'generation-a': Object.freeze({ isCurrent: () => currentGeneration === 'generation-a' }),
            'generation-b': Object.freeze({ isCurrent: () => currentGeneration === 'generation-b' }),
        });
        function Probe(props: Readonly<{ generation: keyof typeof mountLifetimes; fail?: boolean }>) {
            observedScope = usePluginUiEphemeralSharedScopeBinding({
                accountLifetime,
                pluginId: 'acme.triage',
                immutableGenerationId: props.generation,
                mountLifetime: mountLifetimes[props.generation],
            });
            if (props.fail) throw new Error('abandoned render');
            return null;
        }

        let committed: ReturnType<typeof create> | undefined;
        act(() => {
            committed = create(createElement(Probe, { generation: 'generation-a' }));
        });
        const scopeA = observedScope;
        const disposeA = vi.fn();
        scopeA?.acquire('window', () => Object.freeze({ value: {}, dispose: disposeA }));

        currentGeneration = 'generation-b';
        expect(() => act(() => {
            create(createElement(Probe, { generation: 'generation-b', fail: true }));
        })).toThrow('abandoned render');
        expect(disposeA).not.toHaveBeenCalled();

        act(() => {
            committed?.update(createElement(Probe, { generation: 'generation-b' }));
        });
        expect(disposeA).toHaveBeenCalledTimes(1);
        act(() => {
            committed?.unmount();
        });
    });
});
