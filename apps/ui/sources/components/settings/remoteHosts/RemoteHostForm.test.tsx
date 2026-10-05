import { createManualSystemTaskRunner } from '@/dev/testkit/harness/manualSystemTaskRunner';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderScreen } from '@/dev/testkit';
import type { SystemTaskRunState, SystemTaskRunner } from '@/components/systemTasks/types';
import type { SystemTaskEvent, SystemTaskResult, SystemTaskSpec } from '@happier-dev/protocol';

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

vi.mock('@happier-dev/protocol', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@happier-dev/protocol')>();
    return {
        ...actual,
    buildSshTarget: ({ username, host }: { username: string; host: string }) =>
        (username ? `${username}@${host}` : host),
    parseSshTarget: (value: string) => {
        const text = String(value ?? '').trim();
        const atIndex = text.lastIndexOf('@');
        return atIndex > 0
            ? { username: text.slice(0, atIndex), host: text.slice(atIndex + 1) }
            : { username: '', host: text };
    },
    };
});

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

vi.mock('@/sync/sync', () => ({
    sync: {
        encryptSecretValue: () => ({ _isSecretValue: true, value: 'enc' }),
    },
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
