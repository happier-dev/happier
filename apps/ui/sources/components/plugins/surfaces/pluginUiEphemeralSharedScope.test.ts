import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { createElement } from 'react';
import { act, create } from 'react-test-renderer';

import type { PluginUiEphemeralSharedScope } from '@happier-dev/plugin-ui/hostApi';

import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import type { PluginUiAccountExecutableOrigin } from '@/sync/domains/plugins/ui/projectionOrigins';

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

function accountExecutionOrigin(custodyId: string): PluginUiAccountExecutableOrigin {
    return { serverId: 'server-a', accountId: 'account-a', custodyId,
        sourceCustody: { kind: 'bundled_first_party', packagedRuntime: {
            kind: 'source_declaration', packageName: '@happier-dev/plugins-triage',
        } } };
}

describe('plugin UI ephemeral shared scope', () => {
    it.each([
        { realm: 'Machine', origin: executionOrigin('machine-a'), accountOrigin: null },
        { realm: 'Account', origin: null, accountOrigin: accountExecutionOrigin('installed-generation') },
        { realm: 'Account with Machine placement', origin: executionOrigin('machine-a'), accountOrigin: accountExecutionOrigin('installed-generation') },
    ])(
        'keeps a mounted callback reachable across renderer and client occurrences of one admitted $realm plugin generation', async ({ origin, accountOrigin }) => {
        const accountLifetime = createAccountLifetime();
        const identity = { accountLifetime, pluginId: 'acme.external', pluginGenerationId: 'installed-generation',
            executionOrigin: origin, accountExecutionOrigin: accountOrigin, isCurrent: () => true };
        const page = getPluginUiEphemeralSharedScope({ ...identity, occurrenceId: 'renderer-occurrence', artifactDigest: `sha256:${'a'.repeat(64)}` });
        const invoke = vi.fn(async () => ({ status: 'applied' }));
        const mounted = page!.acquireExecutionBound!('mounted:page-1', () => ({ value: { invoke }, dispose() {} }));
        const presentation = page!.acquire('window', () => ({ value: {}, dispose() {} }));
        const action = getPluginUiEphemeralSharedScope({ ...identity, executionOrigin: accountOrigin ? null : origin,
            occurrenceId: 'machine-action-occurrence', artifactDigest: `sha256:${'b'.repeat(64)}` });
        const addressed = action!.acquireExecutionBound!<{ invoke: typeof invoke | null }>(
            'mounted:page-1', () => ({ value: { invoke: null }, dispose() {} }));
        expect(addressed?.value.invoke).toBe(invoke);
        expect(await addressed?.value.invoke?.()).toEqual({ status: 'applied' });
        expect(page!.acquire('window', () => { throw new Error('Mounted page must remain current'); })?.value).toBe(presentation?.value);
        addressed?.release();
        mounted?.release();
        presentation?.release();
    });
    it.each([{ realm: 'Machine', origin: executionOrigin('machine-a') }, { realm: 'Account', origin: null }])(
        'retires $realm executable callbacks when the admitted generation changes even if the raw occurrence and bytes do not', ({ origin }) => {
        const accountLifetime = createAccountLifetime();
        const input = { accountLifetime, pluginId: 'acme.external', occurrenceId: 'same-occurrence',
            artifactDigest: `sha256:${'a'.repeat(64)}` as const, executionOrigin: origin, isCurrent: () => true };
        const first = getPluginUiEphemeralSharedScope({ ...input, pluginGenerationId: 'release-a' })!;
        const dispose = vi.fn();
        const original = first.acquireExecutionBound!('mounted', () => ({ value: {}, dispose }))!;
        const next = getPluginUiEphemeralSharedScope({ ...input, pluginGenerationId: 'release-b' })!;
        const replacement = next.acquireExecutionBound!('mounted', () => ({ value: {}, dispose() {} }))!;
        expect(replacement.value).not.toBe(original.value);
        expect(dispose).toHaveBeenCalledOnce();
        expect(first.acquireExecutionBound!('mounted', () => { throw new Error('Retired package'); })).toBeNull();
        original.release(); replacement.release();
    });
    it('retires executable callbacks on occurrence replacement without withdrawing the same presentation bytes', () => {
        const accountLifetime = createAccountLifetime();
        const identity = { accountLifetime, pluginId: 'acme.external', artifactDigest: `sha256:${'a'.repeat(64)}` as const,
            executionOrigin: executionOrigin('machine-a'), isCurrent: () => true };
        const mountLifetime = { isCurrent: () => true };
        let observed: PluginUiEphemeralSharedScope | null = null;
        function Probe({ occurrenceId }: Readonly<{ occurrenceId: string }>) {
            observed = usePluginUiEphemeralSharedScopeBinding({ ...identity, occurrenceId, mountLifetime });
            return null;
        }
        let mounted: ReturnType<typeof create> | undefined;
        act(() => { mounted = create(createElement(Probe, { occurrenceId: 'generation-a' })); });
        onTestFinished(() => { act(() => mounted?.unmount()); });
        const first = observed as PluginUiEphemeralSharedScope | null;
        if (!first) throw new Error('Missing first committed scope');
        const dispose = vi.fn();
        const callback = first.acquireExecutionBound!('mounted', () => ({ value: {}, dispose }));
        const presentation = first.acquire('window', () => ({ value: {}, dispose() {} }));
        act(() => { mounted?.update(createElement(Probe, { occurrenceId: 'generation-b' })); });
        const replacement = observed as PluginUiEphemeralSharedScope | null;
        if (!replacement) throw new Error('Missing replacement committed scope');
        const next = replacement.acquireExecutionBound!('mounted', () => ({ value: {}, dispose() {} }));
        expect(next?.value).not.toBe(callback?.value);
        expect(dispose).toHaveBeenCalledOnce();
        expect(first.acquireExecutionBound!('mounted', () => { throw new Error('Retired generation'); })).toBeNull();
        expect(first.acquire('window', () => { throw new Error('Presentation bytes did not change'); })?.value).toBe(presentation?.value);
    });
    it('retires an exact retained value for all borrowers without evicting its replacement or another purpose', () => {
        const accountLifetime = createAccountLifetime();
        const scope = getPluginUiEphemeralSharedScope({ accountLifetime, pluginId: 'acme.external',
            occurrenceId: 'authority-test', executionOrigin: executionOrigin('machine-a'), isCurrent: () => true })!;
        const disposed = vi.fn();
        const createValue = () => ({ value: {}, dispose: disposed, retainWhenIdle: true as const });
        const first = scope.acquireExecutionBound!('ci/github', createValue)!;
        const peer = scope.acquireExecutionBound!('ci/github', createValue)!;
        const other = scope.acquireExecutionBound!('ci/other-purpose', createValue)!;
        expect(peer.value).toBe(first.value);
        expect(first.retire).toBeTypeOf('function');
        first.retire!();
        expect(disposed).toHaveBeenCalledTimes(1);
        const replacement = scope.acquireExecutionBound!('ci/github', createValue)!;
        expect(replacement.value).not.toBe(first.value);
        peer.retire!();
        peer.release(); first.release();
        expect(disposed).toHaveBeenCalledTimes(1);
        expect(scope.acquireExecutionBound!('ci/github', createValue)!.value).toBe(replacement.value);
        expect(scope.acquireExecutionBound!('ci/other-purpose', createValue)!.value).toBe(other.value);
    });
    it('partitions execution-bound values by the full admitted origin while preserving same-origin sharing', () => {
        const account = createAccountLifetime();
        const foreign = createAccountLifetime('account-b');
        const originA = executionOrigin('machine-a');
        const originB = executionOrigin('machine-b');
        const replacement = { ...originA, materializationRef: { ...originA.materializationRef, materializationId: 'materialization-replacement' as const } };
        const scope = (accountLifetime: TestAccountLifetime, origin: typeof originA) => getPluginUiEphemeralSharedScope({
            accountLifetime, pluginId: 'acme.triage', occurrenceId: 'same-admitted-artifact', executionOrigin: origin, isCurrent: () => true,
        })!;
        const first = scope(account, originA).acquireExecutionBound?.('reads', () => ({ value: {}, dispose() {} }))!;
        expect(first).toBeDefined();
        const peer = scope(account, originA).acquireExecutionBound?.('reads', () => { throw new Error('Same authority must share'); })!;
        const other = scope(account, originB).acquireExecutionBound?.('reads', () => ({ value: {}, dispose() {} }))!;
        const replaced = scope(account, replacement).acquireExecutionBound?.('reads', () => ({ value: {}, dispose() {} }))!;
        const otherAccount = scope(foreign, originA).acquireExecutionBound?.('reads', () => ({ value: {}, dispose() {} }))!;
        expect(peer.value).toBe(first.value);
        expect(other.value).not.toBe(first.value);
        expect(replaced.value).not.toBe(first.value);
        expect(otherAccount.value).not.toBe(first.value);
        const unqualified = getPluginUiEphemeralSharedScope({ accountLifetime: account, pluginId: 'acme.triage',
            occurrenceId: 'same-admitted-artifact', isCurrent: () => true })!;
        expect(unqualified.acquireExecutionBound?.('reads', () => { throw new Error('Unqualified execution must refuse'); })).toBeNull();
        first.release(); peer.release();
        const surviving = scope(account, originB).acquireExecutionBound?.('reads', () => { throw new Error('Other origin must remain usable'); })!;
        expect(surviving.value).toBe(other.value);
        const reopened = scope(account, originA).acquireExecutionBound?.('reads', () => ({ value: {}, dispose() {} }))!;
        expect(reopened.value).not.toBe(first.value);
        other.release(); surviving.release(); reopened.release(); replaced.release(); otherAccount.release();
    });

    // TL-C (READY159): a Session Details mount held its callback under Machine 3ca2 while its Action, named from the
    // Account catalog, looked in the Account slot, so a published Refresh settled `unavailable`.
    it('resolves a Machine-placed mount and its Account-custody Action to one slot within an admitted generation', () => {
        const account = createAccountLifetime();
        const generation = 'admitted-generation';
        const origin = executionOrigin('machine-a');
        const mount = getPluginUiEphemeralSharedScope({ accountLifetime: account, pluginId: 'acme.triage', occurrenceId: 'renderer-occurrence',
            pluginGenerationId: generation, accountExecutionOrigin: null, executionOrigin: origin, isCurrent: () => true })!;
        const callback = mount.acquireExecutionBound?.('mounted-ui:mount-1', () => ({ value: { invoke: 'bound' }, dispose() {} }))!;
        expect(callback).toBeDefined();
        const borrow = (input: Partial<Parameters<typeof getPluginUiEphemeralSharedScope>[0]>) => getPluginUiEphemeralSharedScope({
            accountLifetime: account, pluginId: 'acme.triage', occurrenceId: generation, isCurrent: () => true, ...input,
        })!.acquireExecutionBound?.('mounted-ui:mount-1', () => { throw new Error('The mounted callback must already be shared'); })!;
        // The agent's command or direct Action, resolved from the Account catalog.
        const accountAction = borrow({ pluginGenerationId: generation, executionOrigin: null,
            accountExecutionOrigin: accountExecutionOrigin(generation) });
        // The person's control, through the mount's own Machine-qualified Action.
        const mountAction = borrow({ pluginGenerationId: generation, accountExecutionOrigin: null, executionOrigin: origin });
        expect(accountAction.value).toBe(callback.value);
        expect(mountAction.value).toBe(callback.value);
        // Without an admitted generation, the exact origin still isolates.
        const unadmitted = (machine: string) => getPluginUiEphemeralSharedScope({ accountLifetime: account, pluginId: 'acme.triage',
            occurrenceId: 'machine-only', executionOrigin: executionOrigin(machine), isCurrent: () => true })!
            .acquireExecutionBound?.('reads', () => ({ value: {}, dispose() {} }))!;
        const machineA = unadmitted('machine-a');
        const machineB = unadmitted('machine-b');
        expect(machineB.value).not.toBe(machineA.value);
        for (const lease of [callback, accountAction, mountAction, machineA, machineB]) lease.release();
    });

    it('shares a Triage page corpus across sibling artifacts of one admitted plugin generation and isolates another Account', () => {
        const accountLifetime = createAccountLifetime('account-a');
        const foreignAccountLifetime = createAccountLifetime('account-b');
        // A renderer digest identifies one entry point, not the plugin: the
        // list page, picker and client Actions are independently compiled.
        const generation = { pluginGenerationId: 'triage-admitted-package-generation' };
        const artifactDigest = `sha256:${'c'.repeat(64)}` as const;
        const mountLifetime = Object.freeze({ isCurrent: () => true });
        const scopes: Record<'page' | 'picker' | 'foreignPicker', PluginUiEphemeralSharedScope | null> = {
            page: null, picker: null, foreignPicker: null,
        };

        function Probe(props: Readonly<{
            account: ActiveServerAccountScopeLifetime;
            occurrenceId: string;
            role: 'page' | 'picker' | 'foreignPicker';
        }>) {
            const scope = usePluginUiEphemeralSharedScopeBinding({
                accountLifetime: props.account,
                pluginId: 'happier.triage',
                occurrenceId: props.occurrenceId,
                ...generation,
                artifactDigest: props.role === 'page' ? artifactDigest : `sha256:${'d'.repeat(64)}`,
                mountLifetime,
            });
            scopes[props.role] = scope;
            return null;
        }

        let page: ReturnType<typeof create> | undefined;
        let picker: ReturnType<typeof create> | undefined;
        let foreignPicker: ReturnType<typeof create> | undefined;
        try {
            act(() => {
                page = create(createElement(Probe, {
                    account: accountLifetime,
                    occurrenceId: 'triage-page-occurrence',
                    role: 'page',
                }));
            });
            const pageCorpus = scopes.page?.acquire('triage-list-window-v1', () => Object.freeze({
                value: Object.freeze({ rows: Object.freeze(['entry-42']) }),
                dispose(): void {},
            }));
            expect(pageCorpus).not.toBeNull();

            act(() => {
                picker = create(createElement(Probe, {
                    account: accountLifetime,
                    occurrenceId: 'triage-composer-picker-occurrence',
                    role: 'picker',
                }));
                foreignPicker = create(createElement(Probe, {
                    account: foreignAccountLifetime,
                    occurrenceId: 'triage-composer-picker-occurrence',
                    role: 'foreignPicker',
                }));
            });
            const pickerCorpus = scopes.picker?.acquire('triage-list-window-v1', () => Object.freeze({
                value: Object.freeze({ rows: Object.freeze(['cold-picker']) }),
                dispose(): void {},
            }));
            const foreignCorpus = scopes.foreignPicker?.acquire('triage-list-window-v1', () => Object.freeze({
                value: Object.freeze({ rows: Object.freeze(['foreign-entry']) }),
                dispose(): void {},
            }));

            expect(pickerCorpus?.value).toBe(pageCorpus?.value);
            expect(foreignCorpus?.value).not.toBe(pageCorpus?.value);
            expect(foreignCorpus?.value.rows).toEqual(['foreign-entry']);

            const actionIdentity = { accountLifetime, pluginId: 'happier.triage',
                occurrenceId: 'triage-client-action-occurrence', ...generation,
                artifactDigest: `sha256:${'e'.repeat(64)}` as const, isCurrent: () => true };
            const actionScope = getPluginUiEphemeralSharedScope(actionIdentity);
            const actionCorpus = actionScope?.acquire('triage-list-window-v1', () => Object.freeze({
                value: Object.freeze({ rows: Object.freeze(['cold-action']) }),
                dispose(): void {},
            }));
            expect(actionCorpus?.value).toBe(pageCorpus?.value);
            const stillMountedCorpus = scopes.page?.acquire('triage-list-window-v1', () => Object.freeze({
                value: Object.freeze({ rows: Object.freeze(['unexpected-retired-page']) }),
                dispose(): void {},
            }));
            expect(stillMountedCorpus?.value).toBe(pageCorpus?.value);

            pageCorpus?.release();
            pickerCorpus?.release();
            foreignCorpus?.release();
            actionCorpus?.release();
            stillMountedCorpus?.release();
        } finally {
            act(() => {
                page?.unmount();
                picker?.unmount();
                foreignPicker?.unmount();
            });
        }
    });

    it('retires presentation state when the admitted plugin generation changes even if one renderer is unchanged', () => {
        const accountLifetime = createAccountLifetime();
        const input = { accountLifetime, pluginId: 'acme.triage',
            artifactDigest: `sha256:${'c'.repeat(64)}` as const, isCurrent: () => true };
        const first = getPluginUiEphemeralSharedScope({ ...input, pluginGenerationId: 'release-a' })!;
        const dispose = vi.fn();
        const initial = first.acquire('window.v1', () => ({ value: { rows: ['entry-42'] }, dispose }))!;
        const second = getPluginUiEphemeralSharedScope({ ...input, pluginGenerationId: 'release-b' })!;
        const replacement = second.acquire('window.v1', () => ({ value: { rows: ['entry-43'] }, dispose() {} }))!;
        expect(dispose).toHaveBeenCalledOnce();
        expect(first.acquire('window.v1', () => { throw new Error('Retired release'); })).toBeNull();
        expect(replacement.value).not.toBe(initial.value);
        expect(replacement.value.rows).toEqual(['entry-43']);
        initial.release(); replacement.release();
    });

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
