import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { createElement } from 'react';
import { act, create } from 'react-test-renderer';

import type { PluginUiEphemeralSharedScope } from '@happier-dev/plugin-ui/hostApi';

import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';

import {
    getPluginUiEphemeralSharedScope,
    retireIdlePluginUiEphemeralSharedValuesExcept,
    usePluginUiEphemeralSharedScopeBinding,
} from './pluginUiEphemeralSharedScope';

type TestAccountLifetime = ActiveServerAccountScopeLifetime & Readonly<{
    retire(): void;
}>;

function createAccountLifetime(accountId = 'account-a'): TestAccountLifetime {
    let current = true;
    const listeners = new Set<() => void>();
    const lifetime = Object.freeze({
        scope: Object.freeze({ serverId: 'server-a', accountId }),
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
    onTestFinished(() => lifetime.retire());
    return lifetime;
}

function executionOrigin(machineId: string) {
    return Object.freeze({
        serverIdentityId: 'server-identity-a',
        materializationRef: Object.freeze({
            pluginId: 'acme.triage',
            machineId,
            materializationId: `materialization-${machineId}`,
        }),
    });
}

describe('plugin UI ephemeral shared scope', () => {
    it('presents the retained row after the last reader unmounts while its Account owner stays current', () => {
        const accountLifetime = createAccountLifetime('reopened-reader-account');
        const firstReader = Object.freeze({ ...createAccountLifetime('reopened-reader-account'), accountLifetime });
        const identity = { pluginId: 'acme.triage', pluginGenerationId: 'same-release', isCurrent: () => true };
        const firstScope = getPluginUiEphemeralSharedScope({ ...identity, accountLifetime: firstReader })!;
        const dispose = vi.fn();
        const original = firstScope.acquire('window', () => ({ value: { rows: ['retained-row'] }, retainWhenIdle: true, dispose }))!;
        original.release();
        firstReader.retire();

        const nextReader = Object.freeze({ ...createAccountLifetime('reopened-reader-account'), accountLifetime });
        const reopenedScope = getPluginUiEphemeralSharedScope({ ...identity, accountLifetime: nextReader })!;
        const reopened = reopenedScope.acquire('window', () => ({ value: { rows: [] as string[] }, dispose() {} }))!;
        expect(reopened.value.rows).toEqual(['retained-row']);
        expect(dispose).not.toHaveBeenCalled();
        expect(firstScope.acquire('late', () => { throw new Error('Retired reader cannot acquire'); })).toBeNull();
        accountLifetime.retire();
        expect(dispose).toHaveBeenCalledOnce();
        expect(reopenedScope.acquire('late', () => { throw new Error('Retired Account cannot acquire'); })).toBeNull();
        reopened.release();
    });

    it('shares across independent credential readers and retires only after their last Account binding', () => {
        const firstAccount = createAccountLifetime();
        const secondAccount = createAccountLifetime();
        const input = { pluginId: 'acme.triage', occurrenceId: 'occurrence-a', isCurrent: () => true };
        const firstScope = getPluginUiEphemeralSharedScope({ ...input, accountLifetime: firstAccount });
        const secondScope = getPluginUiEphemeralSharedScope({ ...input, accountLifetime: secondAccount });
        const dispose = vi.fn();
        const first = firstScope!.acquire('window', () => ({ value: { rows: ['current'] }, dispose }));
        const second = secondScope!.acquire('window', () => { throw new Error('Account readers must share'); });
        expect(second!.value).toBe(first!.value);
        firstAccount.retire();
        expect(firstScope!.acquire('late', () => { throw new Error('Retired reader must refuse'); })).toBeNull();
        expect(dispose).not.toHaveBeenCalled();
        const surviving = secondScope!.acquire('window', () => { throw new Error('Live reader must retain the value'); });
        expect(surviving!.value).toBe(first!.value);
        secondAccount.retire();
        expect(dispose).toHaveBeenCalledOnce();
        const replacement = getPluginUiEphemeralSharedScope({ ...input, accountLifetime: createAccountLifetime() });
        const renewed = replacement!.acquire('window', () => ({ value: { rows: ['renewed'] }, dispose() {} }));
        expect(renewed!.value).not.toBe(first!.value);
        first!.release();
        second!.release();
        surviving!.release();
        renewed!.release();
    });

    it('binds admitted presentation bytes without a Machine occurrence and retires values when those bytes change', () => {
        const accountLifetime = createAccountLifetime();
        const mountLifetime = Object.freeze({ isCurrent: () => true });
        let observedScope: PluginUiEphemeralSharedScope | null = null;
        function Probe(props: Readonly<{ artifactDigest: `sha256:${string}` }>) {
            observedScope = usePluginUiEphemeralSharedScopeBinding({
                accountLifetime,
                pluginId: 'acme.triage',
                artifactDigest: props.artifactDigest,
                mountLifetime,
            });
            return null;
        }
        let mounted: ReturnType<typeof create> | undefined;
        const dispose = vi.fn();
        try {
            act(() => { mounted = create(createElement(Probe, { artifactDigest: `sha256:${'a'.repeat(64)}` })); });
            const first = observedScope as PluginUiEphemeralSharedScope | null;
            expect(first).not.toBeNull();
            const lease = first?.acquire('window', () => ({ value: { rows: [] }, dispose }));
            expect(lease).not.toBeNull();
            act(() => { mounted?.update(createElement(Probe, { artifactDigest: `sha256:${'b'.repeat(64)}` })); });
            expect(dispose).toHaveBeenCalledOnce();
            expect(first?.acquire('window', () => ({ value: {}, dispose() {} }))).toBeNull();
            const second = observedScope as PluginUiEphemeralSharedScope | null;
            expect(second?.acquire('window', () => ({ value: { ready: true }, dispose() {} }))?.value).toEqual({ ready: true });
        } finally {
            act(() => { mounted?.unmount(); });
            accountLifetime.retire();
        }
    });

    it('shares one value within an Account, plugin, and process occurrence until the final lease releases', () => {
        const accountLifetime = createAccountLifetime();
        const scopeA = getPluginUiEphemeralSharedScope({
            accountLifetime,
            pluginId: 'acme.triage',
            occurrenceId: 'occurrence-a',
            isCurrent: () => true,
        });
        const scopeB = getPluginUiEphemeralSharedScope({
            accountLifetime,
            pluginId: 'acme.triage',
            occurrenceId: 'occurrence-a',
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

    it('retains an opted-in value after idle and retires it with its Account', () => {
        const accountLifetime = createAccountLifetime();
        const scope = getPluginUiEphemeralSharedScope({
            accountLifetime,
            pluginId: 'acme.triage',
            occurrenceId: 'occurrence-a',
            isCurrent: () => true,
        });
        const onIdle = vi.fn();
        const dispose = vi.fn();
        const create = vi.fn(() => Object.freeze({
            value: { rows: ['warm'] }, retainWhenIdle: true as const, onIdle, dispose,
        }));
        const first = scope?.acquire('window', create);
        first?.release();
        expect(onIdle).toHaveBeenCalledTimes(1);
        expect(dispose).not.toHaveBeenCalled();
        const second = scope?.acquire('window', create);
        expect(second?.value).toBe(first?.value);
        expect(create).toHaveBeenCalledTimes(1);
        second?.release();
        expect(onIdle).toHaveBeenCalledTimes(2);
        accountLifetime.retire();
        expect(dispose).toHaveBeenCalledTimes(1);
    });

    it('disposes an idle retained value when its occurrence retires', () => {
        const accountLifetime = createAccountLifetime();
        const previous = getPluginUiEphemeralSharedScope({
            accountLifetime, pluginId: 'acme.triage', occurrenceId: 'occurrence-a', isCurrent: () => true,
        });
        const dispose = vi.fn();
        const retained = Object.freeze({
            value: { token: 'retained' }, retainWhenIdle: true as const, onIdle: vi.fn(), dispose,
        });
        previous?.acquire('window', () => retained)?.release();
        expect(dispose).not.toHaveBeenCalled();
        getPluginUiEphemeralSharedScope({
            accountLifetime, pluginId: 'acme.triage', occurrenceId: 'occurrence-b', isCurrent: () => true,
        });
        expect(dispose).toHaveBeenCalledTimes(1);
    });

    it('disposes a disabled plugin\'s idle retained values, never a value in use or another plugin\'s', () => {
        const accountLifetime = createAccountLifetime();
        const scopeFor = (pluginId: string) => getPluginUiEphemeralSharedScope({
            accountLifetime, pluginId, occurrenceId: `${pluginId}#1`, isCurrent: () => true,
        });
        const retainedValue = (key: string) => {
            const dispose = vi.fn();
            const create = () => Object.freeze({ value: { key }, retainWhenIdle: true as const, onIdle: vi.fn(), dispose });
            return { dispose, create };
        };
        const idle = retainedValue('window');
        scopeFor('acme.triage')?.acquire('window', idle.create)?.release();
        const inUse = retainedValue('picker');
        const lease = scopeFor('acme.triage')?.acquire('picker', inUse.create);
        const enabled = retainedValue('window');
        scopeFor('acme.ci')?.acquire('window', enabled.create)?.release();

        retireIdlePluginUiEphemeralSharedValuesExcept(accountLifetime, new Set(['acme.ci']));

        expect(idle.dispose).toHaveBeenCalledTimes(1);
        expect(inUse.dispose).not.toHaveBeenCalled();
        expect(enabled.dispose).not.toHaveBeenCalled();
        // Enabling it again starts cold rather than handing back a disposed value.
        const create = vi.fn(() => Object.freeze({ value: { fresh: true }, dispose: vi.fn() }));
        expect(scopeFor('acme.triage')?.acquire('window', create)?.value).toEqual({ fresh: true });
        expect(create).toHaveBeenCalledTimes(1);
        lease?.release();
    });

    it('shares one occurrence value across execution origins and notifies only when its active origin changes', () => {
        const accountLifetime = createAccountLifetime();
        const scopeA1 = getPluginUiEphemeralSharedScope({
            accountLifetime,
            pluginId: 'acme.triage',
            occurrenceId: 'occurrence-a',
            executionOrigin: executionOrigin('machine-a'),
            isCurrent: () => true,
        });
        const scopeA2 = getPluginUiEphemeralSharedScope({
            accountLifetime,
            pluginId: 'acme.triage',
            occurrenceId: 'occurrence-a',
            executionOrigin: executionOrigin('machine-a'),
            isCurrent: () => true,
        });
        const scopeB = getPluginUiEphemeralSharedScope({
            accountLifetime,
            pluginId: 'acme.triage',
            occurrenceId: 'occurrence-a',
            executionOrigin: executionOrigin('machine-b'),
            isCurrent: () => true,
        });
        const dispose = vi.fn();
        const onExecutionOriginChange = vi.fn();
        const createShared = vi.fn(() => Object.freeze({
            value: { window: 'shared' },
            dispose,
            onExecutionOriginChange,
        }));

        const leaseA1 = scopeA1?.acquire('mounted-window', createShared);
        const leaseA2 = scopeA2?.acquire('mounted-window', createShared);
        const leaseB = scopeB?.acquire('mounted-window', createShared);

        expect(leaseA1?.value).toBe(leaseA2?.value);
        expect(leaseA1?.value).toBe(leaseB?.value);
        expect(createShared).toHaveBeenCalledTimes(1);

        leaseA1?.release();
        expect(onExecutionOriginChange).not.toHaveBeenCalled();
        leaseA2?.release();
        expect(onExecutionOriginChange).toHaveBeenCalledTimes(1);
        expect(dispose).not.toHaveBeenCalled();

        leaseB?.release();
        expect(dispose).toHaveBeenCalledTimes(1);
    });

    it('gives unqualified and materialized mounts equal access to the same occurrence value', () => {
        const accountLifetime = createAccountLifetime();
        const local = getPluginUiEphemeralSharedScope({
            accountLifetime,
            pluginId: 'acme.triage',
            occurrenceId: 'occurrence-a',
            isCurrent: () => true,
        });
        const materialized = getPluginUiEphemeralSharedScope({
            accountLifetime,
            pluginId: 'acme.triage',
            occurrenceId: 'occurrence-a',
            executionOrigin: executionOrigin('machine-a'),
            isCurrent: () => true,
        });
        const createShared = vi.fn(() => Object.freeze({
            value: { window: 'shared' },
            dispose(): void {},
        }));

        const localLease = local?.acquire('mounted-window', createShared);
        const materializedLease = materialized?.acquire('mounted-window', createShared);

        expect(materializedLease?.value).toBe(localLease?.value);
        expect(createShared).toHaveBeenCalledTimes(1);
        localLease?.release();
        materializedLease?.release();
    });

    it('retires an older occurrence and refuses a stale overlapping request after the successor exists', () => {
        const accountLifetime = createAccountLifetime();
        let currentOccurrence = 'occurrence-a';
        const occurrenceA = getPluginUiEphemeralSharedScope({
            accountLifetime,
            pluginId: 'acme.triage',
            occurrenceId: 'occurrence-a',
            isCurrent: () => currentOccurrence === 'occurrence-a',
        });
        const disposeA = vi.fn();
        const leaseA = occurrenceA?.acquire(
            'mounted-window',
            () => Object.freeze({ value: { occurrence: 'a' }, dispose: disposeA }),
        );

        currentOccurrence = 'occurrence-b';
        const occurrenceB = getPluginUiEphemeralSharedScope({
            accountLifetime,
            pluginId: 'acme.triage',
            occurrenceId: 'occurrence-b',
            isCurrent: () => currentOccurrence === 'occurrence-b',
        });
        expect(occurrenceB).not.toBeNull();
        expect(disposeA).toHaveBeenCalledTimes(1);
        expect(occurrenceA?.acquire(
            'mounted-window',
            () => Object.freeze({ value: { occurrence: 'revived-a' }, dispose(): void {} }),
        )).toBeNull();

        expect(getPluginUiEphemeralSharedScope({
            accountLifetime,
            pluginId: 'acme.triage',
            occurrenceId: 'occurrence-a',
            isCurrent: () => currentOccurrence === 'occurrence-a',
        })).toBeNull();
        expect(occurrenceB?.acquire(
            'mounted-window',
            () => Object.freeze({ value: { occurrence: 'b' }, dispose(): void {} }),
        )?.value).toEqual({ occurrence: 'b' });
        leaseA?.release();
        expect(disposeA).toHaveBeenCalledTimes(1);

        currentOccurrence = 'occurrence-a';
        expect(getPluginUiEphemeralSharedScope({
            accountLifetime,
            pluginId: 'acme.triage',
            occurrenceId: 'occurrence-a',
            isCurrent: () => currentOccurrence === 'occurrence-a',
        })).not.toBeNull();
    });

    it('keeps independently current materialization origins alive for one Account and plugin', () => {
        const accountLifetime = createAccountLifetime();
        const disposeA = vi.fn();
        const disposeB = vi.fn();
        const scopeA = getPluginUiEphemeralSharedScope({
            accountLifetime,
            pluginId: 'acme.triage',
            occurrenceId: 'occurrence-a',
            executionOrigin: executionOrigin('machine-a'),
            isCurrent: () => true,
        });
        scopeA?.acquire('mounted-window', () => Object.freeze({ value: 'a', dispose: disposeA }));
        const scopeB = getPluginUiEphemeralSharedScope({
            accountLifetime,
            pluginId: 'acme.triage',
            occurrenceId: 'occurrence-b',
            executionOrigin: executionOrigin('machine-b'),
            isCurrent: () => true,
        });
        const leaseB = scopeB?.acquire('mounted-window', () => Object.freeze({ value: 'b', dispose: disposeB }));

        expect(leaseB?.value).toBe('b');
        expect(disposeA).not.toHaveBeenCalled();
        const replacementA = getPluginUiEphemeralSharedScope({
            accountLifetime,
            pluginId: 'acme.triage',
            occurrenceId: 'occurrence-a-next',
            executionOrigin: executionOrigin('machine-a'),
            isCurrent: () => true,
        });
        expect(replacementA).not.toBeNull();
        expect(disposeA).toHaveBeenCalledTimes(1);
        expect(disposeB).not.toHaveBeenCalled();
        expect(scopeB?.acquire('mounted-window', () => Object.freeze({ value: 'b2', dispose(): void {} }))?.value).toBe('b');
        accountLifetime.retire();
        expect(disposeA).toHaveBeenCalledTimes(1);
        expect(disposeB).toHaveBeenCalledTimes(1);
    });

    it('fences acquisition and disposes every value when the Account retires', () => {
        const accountLifetime = createAccountLifetime();
        const scope = getPluginUiEphemeralSharedScope({
            accountLifetime,
            pluginId: 'acme.triage',
            occurrenceId: 'occurrence-a',
            isCurrent: () => true,
        });
        const dispose = vi.fn();
        scope?.acquire('mounted-window', () => Object.freeze({ value: {}, dispose }));

        accountLifetime.retire();

        expect(dispose).toHaveBeenCalledTimes(1);
        expect(scope?.acquire('mounted-window', () => Object.freeze({ value: {}, dispose(): void {} }))).toBeNull();
        expect(getPluginUiEphemeralSharedScope({
            accountLifetime,
            pluginId: 'acme.triage',
            occurrenceId: 'occurrence-a',
            isCurrent: () => true,
        })).toBeNull();
    });

    it('does not issue a scope for a stale mount or absent Account lifetime', () => {
        const accountLifetime = createAccountLifetime();
        expect(getPluginUiEphemeralSharedScope({
            accountLifetime: null,
            pluginId: 'acme.triage',
            occurrenceId: 'occurrence-a',
            isCurrent: () => true,
        })).toBeNull();
        expect(getPluginUiEphemeralSharedScope({
            accountLifetime,
            pluginId: 'acme.triage',
            occurrenceId: 'occurrence-a',
            isCurrent: () => false,
        })).toBeNull();
    });

    it('isolates opaque values by Account and plugin', () => {
        const accountA = createAccountLifetime();
        const accountB = createAccountLifetime('account-b');
        const scope = (accountLifetime: TestAccountLifetime, pluginId: string) => (
            getPluginUiEphemeralSharedScope({
                accountLifetime,
                pluginId,
                occurrenceId: 'occurrence-a',
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
            occurrenceId: 'occurrence-a',
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
            occurrenceId: 'occurrence-a',
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

    it('does not retire the committed occurrence from an abandoned successor render', () => {
        const accountLifetime = createAccountLifetime();
        let currentOccurrence = 'occurrence-a';
        let observedScope: ReturnType<typeof usePluginUiEphemeralSharedScopeBinding> = null;
        const mountLifetimes = Object.freeze({
            'occurrence-a': Object.freeze({ isCurrent: () => currentOccurrence === 'occurrence-a' }),
            'occurrence-b': Object.freeze({ isCurrent: () => currentOccurrence === 'occurrence-b' }),
        });
        function Probe(props: Readonly<{ occurrence: keyof typeof mountLifetimes; fail?: boolean }>) {
            observedScope = usePluginUiEphemeralSharedScopeBinding({
                accountLifetime,
                pluginId: 'acme.triage',
                occurrenceId: props.occurrence,
                mountLifetime: mountLifetimes[props.occurrence],
            });
            if (props.fail) throw new Error('abandoned render');
            return null;
        }

        let committed: ReturnType<typeof create> | undefined;
        act(() => {
            committed = create(createElement(Probe, { occurrence: 'occurrence-a' }));
        });
        const scopeA = observedScope as PluginUiEphemeralSharedScope | null;
        const disposeA = vi.fn();
        scopeA?.acquire('window', () => Object.freeze({ value: {}, dispose: disposeA }));

        currentOccurrence = 'occurrence-b';
        expect(() => act(() => {
            create(createElement(Probe, { occurrence: 'occurrence-b', fail: true }));
        })).toThrow('abandoned render');
        expect(disposeA).not.toHaveBeenCalled();

        act(() => {
            committed?.update(createElement(Probe, { occurrence: 'occurrence-b' }));
        });
        expect(disposeA).toHaveBeenCalledTimes(1);
        act(() => {
            committed?.unmount();
        });
    });
});
