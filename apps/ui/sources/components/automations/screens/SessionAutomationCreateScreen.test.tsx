import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const syncSpies = vi.hoisted(() => ({
    createAutomation: vi.fn(async (_input: any) => ({})),
    refreshAutomations: vi.fn(async () => {}),
    getSessionEncryptionKeyBase64ForResume: vi.fn((_sessionId: string) => 'dek-base64'),
    encryption: {
        encryptAutomationTemplateRaw: vi.fn(async (_value: unknown) => 'ciphertext-base64'),
    },
}));

const sessionState = vi.hoisted(() => ({
    session: null as any,
}));

const routerBackSpy = vi.hoisted(() => vi.fn());
const modalAlertSpy = vi.hoisted(() => vi.fn(async () => {}));

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
                },
            }),
    },
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('expo-router', () => ({
    useRouter: () => ({ back: routerBackSpy }),
}));

vi.mock('@/modal', () => ({
    Modal: {
        alert: modalAlertSpy,
        confirm: vi.fn(),
        prompt: vi.fn(),
    },
}));

vi.mock('@/components/ui/forms/Switch', () => ({
    Switch: (props: any) => React.createElement('Switch', props),
}));

vi.mock('@/sync/domains/state/storage', () => ({
    useSession: () => sessionState.session,
}));

vi.mock('@/sync/sync', () => ({
    sync: syncSpies,
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
            metadata: { machineId: 'm1', path: '/tmp/project', homeDir: '/tmp' },
        };
        syncSpies.createAutomation.mockClear();
        syncSpies.refreshAutomations.mockClear();
        syncSpies.getSessionEncryptionKeyBase64ForResume.mockClear();
        syncSpies.encryption.encryptAutomationTemplateRaw.mockClear();
        routerBackSpy.mockReset();
        modalAlertSpy.mockReset();
    });

    it('creates an existing-session automation with an envelope that includes existingSessionId', async () => {
        const { SessionAutomationCreateScreen } = await import('./SessionAutomationCreateScreen');

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<SessionAutomationCreateScreen sessionId="s1" />);
        });
        await flushRender();

        const message = findTextInput(tree!, 'Message to send');
        await act(async () => {
            message.props.onChangeText('Do the thing');
        });

        const name = findTextInput(tree!, 'Scheduled Session');
        await act(async () => {
            name.props.onChangeText('My automation');
        });

        const create = findPressableByText(tree!, 'Create automation');
        await act(async () => {
            create.props.onPress();
        });

        expect(syncSpies.createAutomation).toHaveBeenCalledTimes(1);
        const input = syncSpies.createAutomation.mock.calls[0][0];
        expect(input.targetType).toBe('existing_session');
        expect(input.assignments).toEqual([{ machineId: 'm1', enabled: true, priority: 100 }]);

        const envelope = JSON.parse(String(input.templateCiphertext));
        expect(envelope.kind).toBe('happier_automation_template_encrypted_v1');
        expect(envelope.existingSessionId).toBe('s1');
    });
});
