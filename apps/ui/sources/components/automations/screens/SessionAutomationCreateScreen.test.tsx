import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const syncSpies = vi.hoisted(() => ({
    createAutomation: vi.fn(async (_input: unknown) => ({})),
    refreshAutomations: vi.fn(async () => {}),
    getSessionEncryptionKeyBase64ForResume: vi.fn((_sessionId: string) => 'dek-base64'),
    getCredentials: vi.fn(() => ({ token: 't' })),
    encryption: {
        encryptAutomationTemplateRaw: vi.fn(async (_value: unknown) => 'ciphertext-base64'),
    },
}));

const sessionState = vi.hoisted(() => ({
    session: null as any,
}));

const settingsState = vi.hoisted(() => ({
    settings: {},
}));

const routerReplaceSpy = vi.hoisted(() => vi.fn());
const modalAlertSpy = vi.hoisted(() => vi.fn(async () => {}));

const serverFetchSpy = vi.fn(async (..._args: unknown[]) => ({
    ok: true,
    status: 200,
    json: async () => ({ mode: 'e2ee', updatedAt: 1 }),
}));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            colors: {
                groupped: { background: '#fff' },
                text: '#111',
                textSecondary: '#777',
                input: { background: '#eee', placeholder: '#999' },
                divider: '#ddd',
                surfaceHighest: '#eee',
                warningCritical: '#f00',
                success: '#0a0',
            },
        },
    }),
    StyleSheet: {
        create: (factory: any) =>
            factory({
                colors: {
                    groupped: { background: '#fff' },
                    text: '#111',
                    textSecondary: '#777',
                    input: { background: '#eee', placeholder: '#999' },
                    divider: '#ddd',
                    surfaceHighest: '#eee',
                    warningCritical: '#f00',
                    success: '#0a0',
                },
            }),
    },
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('expo-router', () => ({
    useRouter: () => ({ replace: routerReplaceSpy }),
}));

vi.mock('@/modal', () => ({
    Modal: {
        alert: modalAlertSpy,
        confirm: vi.fn(),
        prompt: vi.fn(),
    },
}));

vi.mock('@/sync/domains/state/storage', () => ({
    useSession: () => sessionState.session,
    useSettings: () => settingsState.settings,
}));

vi.mock('@/sync/sync', () => ({
    sync: syncSpies,
}));

vi.mock('@/sync/http/client', () => ({
    serverFetch: (...args: unknown[]) => serverFetchSpy(...args),
}));

vi.mock('@/components/ui/forms/Switch', () => ({
    Switch: (props: any) => React.createElement('Switch', props),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: any) => React.createElement('Item', props, props.children),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: (props: any) => React.createElement('ItemGroup', props, props.children),
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: any) => React.createElement('Text', props, props.children),
    TextInput: (props: any) => React.createElement('TextInput', props),
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

async function flushRender(): Promise<void> {
    await act(async () => {
        await Promise.resolve();
    });
}

function findTextInput(tree: renderer.ReactTestRenderer, placeholder: string) {
    return tree.root.find((node) => (node.type as any) === 'TextInput' && node.props.placeholder === placeholder);
}

function findPressableByText(tree: renderer.ReactTestRenderer, text: string) {
    const textNode = tree.root.find((node) => {
        if ((node.type as unknown) !== 'Text') return false;
        const children = node.props.children;
        if (typeof children === 'string') return children === text;
        if (Array.isArray(children)) return children.includes(text);
        return false;
    });
    let current: any = textNode;
    while (current && (current.type as unknown) !== 'Pressable') {
        current = current.parent;
    }
    if (!current) throw new Error(`Pressable with text "${text}" not found`);
    return current;
}

describe('SessionAutomationCreateScreen', () => {
    beforeEach(() => {
        sessionState.session = {
            id: 's1',
            encryptionMode: 'e2ee',
            metadata: {
                flavor: 'codex',
                machineId: 'm1',
                path: '/tmp/project',
                homeDir: '/tmp',
                host: 'qa-host',
                displayName: 'QA Host',
                profileId: 'profile-1',
            },
        };
        settingsState.settings = {};
        syncSpies.createAutomation.mockClear();
        syncSpies.refreshAutomations.mockClear();
        syncSpies.getSessionEncryptionKeyBase64ForResume.mockClear();
        syncSpies.getCredentials.mockClear();
        syncSpies.encryption.encryptAutomationTemplateRaw.mockClear();
        routerReplaceSpy.mockReset();
        modalAlertSpy.mockReset();
        serverFetchSpy.mockClear();
    });

    it('creates an existing-session automation with an envelope that includes existingSessionId', async () => {
        serverFetchSpy.mockResolvedValueOnce({
            ok: true,
            status: 200,
            json: async () => ({ mode: 'e2ee', updatedAt: 1 }),
        });

        const { SessionAutomationCreateScreen } = await import('./SessionAutomationCreateScreen');

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<SessionAutomationCreateScreen sessionId="s1" />);
        });
        await flushRender();

        const message = findTextInput(tree!, 'automations.edit.messagePlaceholder');
        await act(async () => {
            message.props.onChangeText('Do the thing');
        });

        const create = findPressableByText(tree!, 'automations.create.createButtonTitle');
        await act(async () => {
            create.props.onPress();
        });

        expect(syncSpies.createAutomation).toHaveBeenCalledTimes(1);
        const input = syncSpies.createAutomation.mock.calls[0][0] as Record<string, unknown>;
        expect(input.targetType).toBe('existing_session');
        expect(input.assignments).toEqual([{ machineId: 'm1', enabled: true, priority: 100 }]);

        const envelope = JSON.parse(String(input.templateCiphertext));
        expect(envelope.kind).toBe('happier_automation_template_encrypted_v1');
        expect(envelope.existingSessionId).toBe('s1');
        expect(routerReplaceSpy).toHaveBeenCalledWith('/session/s1/automations');
    });

    it('creates a plaintext existing-session automation without requiring a resume key', async () => {
        sessionState.session = {
            id: 's_plain',
            encryptionMode: 'plain',
            metadata: {
                flavor: 'codex',
                machineId: 'm1',
                path: '/tmp/project',
                homeDir: '/tmp',
            },
        };
        syncSpies.getSessionEncryptionKeyBase64ForResume.mockImplementationOnce(() => null);
        serverFetchSpy.mockResolvedValueOnce({
            ok: true,
            status: 200,
            json: async () => ({ mode: 'plain', updatedAt: 1 }),
        });

        const { SessionAutomationCreateScreen } = await import('./SessionAutomationCreateScreen');

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<SessionAutomationCreateScreen sessionId="s_plain" />);
        });
        await flushRender();

        const message = findTextInput(tree!, 'automations.edit.messagePlaceholder');
        await act(async () => {
            message.props.onChangeText('Hello');
        });

        const create = findPressableByText(tree!, 'automations.create.createButtonTitle');
        await act(async () => {
            create.props.onPress();
        });

        expect(syncSpies.createAutomation).toHaveBeenCalledTimes(1);
        const input = syncSpies.createAutomation.mock.calls[0][0] as Record<string, unknown>;
        const envelope = JSON.parse(String(input.templateCiphertext));
        expect(envelope.kind).toBe('happier_automation_template_plain_v1');
        expect(envelope.existingSessionId).toBe('s_plain');
        expect(syncSpies.encryption.encryptAutomationTemplateRaw).not.toHaveBeenCalled();
    });
});
