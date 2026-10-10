import { createManualSystemTaskRunner } from '@/dev/testkit/harness/manualSystemTaskRunner';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderScreen, renderHook } from '@/dev/testkit';
import type { SystemTaskRunState, SystemTaskRunner } from '@/components/systemTasks/types';
import type { SystemTaskEvent, SystemTaskResult, SystemTaskSpec } from '@happier-dev/protocol';
import type { RemoteHost } from '@/sync/domains/remoteHosts/remoteHostModel';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
        theme: {
            margins: { sm: 4, lg: 16 },
            colors: {
                textSecondary: '#666',
            },
        },
    });
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('ItemList', props, props.children),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('ItemGroup', props, props.children),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: Record<string, unknown>) => React.createElement('Item', props),
}));

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: Record<string, unknown>) => {
        const trigger = typeof props.trigger === 'function'
            ? props.trigger({
                toggle: () => (props.onOpenChange as (open: boolean) => void)?.(!props.open),
                selectedItem: null,
            })
            : null;
        return React.createElement('DropdownMenu', props, trigger);
    },
}));

vi.mock('@/components/ui/lists/SelectableRow', () => ({
    SelectableRow: (props: Record<string, unknown>) => React.createElement('SelectableRow', props),
}));

function createDiscoveryRunner(): SystemTaskRunner {
    const snapshots = new Map<string, SystemTaskRunState | null>();
    const subscribers = new Map<string, Set<() => void>>();
    const publish = (taskId: string, snapshot: SystemTaskRunState | null) => {
        snapshots.set(taskId, snapshot);
        subscribers.get(taskId)?.forEach((notify) => notify());
    };
    function subscribe(taskId: string, listener: () => void): () => void;
    function subscribe(taskId: string, onEvent?: (event: SystemTaskEvent) => void, onResult?: (result: SystemTaskResult) => void): () => void;
    function subscribe(taskId: string, listenerOrOnEvent?: (() => void) | ((event: SystemTaskEvent) => void)): () => void {
        if (!listenerOrOnEvent) return () => {};
        const listener = listenerOrOnEvent as () => void;
        const listeners = subscribers.get(taskId) ?? new Set<() => void>();
        listeners.add(listener);
        subscribers.set(taskId, listeners);
        return () => {
            listeners.delete(listener);
        };
    }
    return {
        ...createManualSystemTaskRunner().runner,
        mode: 'tauri',
        start: vi.fn(async (spec: SystemTaskSpec) => {
            expect(spec.kind).toBe('local.ssh.discoverConfiguredHosts.v1');
            const taskId = 'discover-task';
            publish(taskId, {
                taskId,
                status: 'succeeded',
                currentStepId: null,
                latestMessage: null,
                awaitingInput: false,
                cancelRequested: false,
                events: [],
                result: {
                    protocolVersion: 1,
                    taskId,
                    ok: true,
                    data: [
                        {
                            id: 'ssh-config:devbox',
                            alias: 'devbox',
                            hostname: '10.0.0.5',
                            port: 2222,
                            username: 'ubuntu',
                            source: 'ssh-config',
                            sourcePath: '/Users/test/.ssh/config',
                        },
                    ],
                },
            } as SystemTaskRunState);
            return taskId;
        }),
        cancel: vi.fn(async () => undefined),
        respond: vi.fn(async () => undefined),
        getSnapshot: (taskId) => snapshots.get(taskId) ?? null,
        subscribe,
    };
}

async function renderEditor(runner: SystemTaskRunner) {
    const { RemoteHostEditorSections, useRemoteHostEditor } = await import('./RemoteHostForm');
    const editorSpy: { current: ReturnType<typeof useRemoteHostEditor> | null } = { current: null };
    function Harness() {
        const editor = useRemoteHostEditor({ remoteHost: null, localOverrides: null, secretMaterialAllowed: false });
        editorSpy.current = editor;
        return React.createElement(RemoteHostEditorSections, {
            editor,
            remoteHost: null,
            savedRemoteHosts: [],
            systemTaskRunner: runner,
            secretMaterialAllowed: false,
        });
    }
    const screen = await renderScreen(React.createElement(Harness));
    return { screen, editorSpy };
}

describe('RemoteHostEditorSections', () => {
    it('keeps the exact unsaved host identity across manual retry while a new editor owns a different identity', async () => {
        const { useRemoteHostEditor } = await import('./RemoteHostForm');
        const first = await renderHook(({ host }: { host: RemoteHost | null }) => useRemoteHostEditor({ remoteHost: host,
            localOverrides: null, secretMaterialAllowed: false }), { initialProps: { host: null } });
        await act(async () => first.getCurrent().setState(current => ({ ...current, name: 'Retry host',
            sshDraft: { ...current.sshDraft, username: 'root', host: 'example.test' } })));
        const firstSubmission = first.getCurrent().buildSavePayload();
        expect(firstSubmission).not.toBeNull();
        if (!firstSubmission) throw new Error('Expected a ready draft');
        await act(async () => first.getCurrent().setState(current => ({ ...current, name: 'Edited before manual retry' })));
        expect(first.getCurrent().buildSavePayload()?.remoteHost.id).toBe(firstSubmission?.remoteHost.id);
        const second = await renderHook(() => useRemoteHostEditor({ remoteHost: null, localOverrides: null, secretMaterialAllowed: false }));
        await act(async () => second.getCurrent().setState(current => ({ ...current, name: 'Different draft',
            sshDraft: { ...current.sshDraft, username: 'root', host: 'example.test' } })));
        expect(second.getCurrent().buildSavePayload()?.remoteHost.id).not.toBe(firstSubmission?.remoteHost.id);
        await first.rerender({ host: { ...firstSubmission.remoteHost, id: 'persisted-host' } });
        expect(first.getCurrent().buildSavePayload()?.remoteHost.id).toBe('persisted-host');
        await first.rerender({ host: null });
        expect(first.getCurrent().buildSavePayload()?.remoteHost.id).not.toBe(firstSubmission.remoteHost.id);
    });

    it('keeps newly typed credentials out of the durable host and passes them separately to the atomic save owner', async () => {
        const { useRemoteHostEditor } = await import('./RemoteHostForm');
        const hook = await renderHook(() => useRemoteHostEditor({ remoteHost: null, localOverrides: null, secretMaterialAllowed: true }));
        await act(async () => hook.getCurrent().setState(current => ({ ...current, name: 'Saved host', savePassword: true,
            sshDraft: { ...current.sshDraft, username: 'root', host: 'example.test', authMode: 'password', password: 'private-password' } })));
        const payload = hook.getCurrent().buildSavePayload();
        expect(payload).toMatchObject({ credentialChanges: { password: { kind: 'new', value: 'private-password' } } });
        expect(payload?.remoteHost.ssh).not.toHaveProperty('passwordEnc');
        expect(JSON.stringify(payload?.remoteHost)).not.toContain('private-password');
    });

    it('retains captured references while credentials are unavailable and emits clear only for an explicit credential edit', async () => {
        const { useRemoteHostEditor } = await import('./RemoteHostForm');
        const remoteHost = { id: 'host-a', name: 'Host', ssh: { target: 'root@example.test', authMode: 'password' as const,
            passwordSecretRef: 'happier:shared-secret:v1:ssh-password' }, createdAt: 1, updatedAt: 1, lastUsedAt: null };
        const hook = await renderHook(({ allowed }: { allowed: boolean }) => useRemoteHostEditor({ remoteHost, localOverrides: null,
            secretMaterialAllowed: allowed }), { initialProps: { allowed: false } });
        expect(hook.getCurrent().buildSavePayload()).toMatchObject({ remoteHost: { ssh: { passwordSecretRef: remoteHost.ssh.passwordSecretRef } } });
        expect(hook.getCurrent().buildSavePayload()).not.toHaveProperty('credentialChanges');
        await hook.rerender({ allowed: true });
        await act(async () => hook.getCurrent().setState(current => ({ ...current, savePassword: false })));
        expect(hook.getCurrent().buildSavePayload()).toMatchObject({ credentialChanges: { password: { kind: 'clear' } } });
    });

    it('prefills SSH credential fields from a configured-host suggestion as an unsaved change', async () => {
        const { screen, editorSpy } = await renderEditor(createDiscoveryRunner());

        await flushHookEffects({ cycles: 3, turns: 3 });

        const menu = screen.findByType('DropdownMenu' as never) as unknown as {
            props: { onSelect: (id: string) => void };
        };
        await act(async () => {
            menu.props.onSelect('ssh-config:devbox');
        });

        expect(screen.findByTestId('remote-host-form-ssh-sshUsernameInput')?.props.value).toBe('ubuntu');
        expect(screen.findByTestId('remote-host-form-ssh-sshHostInput')?.props.value).toBe('devbox');
        expect(screen.findByTestId('remote-host-form-ssh-sshPortInput')?.props.value).toBe('2222');
        // Picking a suggestion fills the draft; nothing is saved until the page's Save.
        expect(editorSpy.current?.dirty).toBe(true);
    });
});
