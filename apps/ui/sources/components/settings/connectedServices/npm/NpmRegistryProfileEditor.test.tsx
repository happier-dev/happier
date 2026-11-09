import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { pressTestInstanceAsync, renderScreen } from '@/dev/testkit';
import { ModalCardFrame } from '@/modal/components/card/ModalCardFrame';
import { installSettingsViewCommonModuleMocks } from '../../settingsViewTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installSettingsViewCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: 'View',
            ScrollView: 'ScrollView',
            Pressable: 'Pressable',
            TextInput: 'TextInput',
            Text: 'Text',
            Platform: { OS: 'web', select: (options: any) => options?.default },
            useWindowDimensions: () => ({ width: 1200, height: 800, scale: 1, fontScale: 1 }),
        });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
});

type EditorModule = typeof import('./NpmRegistryProfileEditor');

function NpmRegistryProfileEditorHarness(props: Readonly<{
    component: React.ComponentType<any>;
    mode: 'create' | 'edit';
    subject?: Parameters<EditorModule['showNpmRegistryProfileEditor']>[0]['subject'];
    onResolve: (profile: unknown) => void;
    onClose: () => void;
}>) {
    const [chrome, setChrome] = React.useState<any>(null);
    const card = chrome && chrome.kind === 'card' ? chrome : null;
    return (
        <ModalCardFrame
            title={card?.title}
            footer={card?.footer}
            dimensions={card?.dimensions}
        >
            <props.component
                mode={props.mode}
                subject={props.subject}
                onResolve={props.onResolve}
                onClose={props.onClose}
                setChrome={setChrome}
            />
        </ModalCardFrame>
    );
}

async function renderEditor(params: Readonly<{
    mode: 'create' | 'edit';
    subject?: Parameters<EditorModule['showNpmRegistryProfileEditor']>[0]['subject'];
}>) {
    const onResolve = vi.fn();
    const onClose = vi.fn();
    const { NpmRegistryProfileEditorModal } = await import('./NpmRegistryProfileEditor');
    const screen = await renderScreen(
        <NpmRegistryProfileEditorHarness
            component={NpmRegistryProfileEditorModal as any}
            mode={params.mode}
            subject={params.subject}
            onResolve={onResolve}
            onClose={onClose}
        />,
    );
    const setField = async (testID: string, value: string) => {
        await act(async () => {
            screen.findByTestId(testID)?.props.onChangeText(value);
        });
    };
    const toggle = async (testID: string) => {
        await act(async () => {
            screen.findByTestId(testID)?.props.onPress();
        });
    };
    // The outermost instance carrying a testID is the real component this
    // editor rendered (Item, RoundButton), so its props are what the editor
    // handed it rather than those of the inner pressable.
    const control = (testID: string) => screen.findAllByTestId(testID)[0] ?? null;
    const saveButton = () => control('settings.plugins.registries.editor.save');
    return { screen, onResolve, onClose, setField, toggle, control, saveButton };
}

describe('NpmRegistryProfileEditorModal', () => {
    it('reviews origin, name, scopes, routing and network policy together before sending one profile', async () => {
        const editor = await renderEditor({ mode: 'create' });

        await editor.setField('settings.plugins.registries.editor.origin', 'https://registry.acme.test');
        await editor.setField('settings.plugins.registries.editor.displayName', 'Acme');
        await editor.setField('settings.plugins.registries.editor.scopes', '@acme, @team');
        await editor.toggle('settings.plugins.registries.editor.useAsDefault');

        expect(editor.control('settings.plugins.registries.editor.useAsDefault')?.props.rightElementOutsidePressable)
            .toBe(true);
        expect(editor.control('settings.plugins.registries.editor.allowPrivateNetwork')?.props.rightElementOutsidePressable)
            .toBe(true);

        expect(editor.saveButton()?.props.disabled).toBe(false);
        await pressTestInstanceAsync(editor.saveButton(), 'save');

        expect(editor.onResolve).toHaveBeenCalledWith({
            displayName: 'Acme',
            origin: 'https://registry.acme.test',
            scopes: ['@acme', '@team'],
            useAsDefault: true,
            allowPrivateNetwork: false,
        });
        expect(editor.onClose).toHaveBeenCalled();
    });

    it('refuses to send a profile whose origin is not a credential-free HTTPS origin', async () => {
        const editor = await renderEditor({ mode: 'create' });

        await editor.setField('settings.plugins.registries.editor.displayName', 'Acme');
        await editor.setField('settings.plugins.registries.editor.origin', 'http://registry.acme.test/path');

        expect(editor.saveButton()?.props.disabled).toBe(true);
        expect(editor.screen.findByTestId('settings.plugins.registries.editor.origin')?.props.accessibilityState)
            .toMatchObject({ invalid: true });

        await pressTestInstanceAsync(editor.saveButton(), 'save');
        expect(editor.onResolve).not.toHaveBeenCalled();
        expect(editor.onClose).not.toHaveBeenCalled();
    });

    it('keeps a rejected profile open and marks the field the reader must fix', async () => {
        const editor = await renderEditor({ mode: 'create' });

        await editor.setField('settings.plugins.registries.editor.origin', 'https://registry.acme.test');
        await editor.setField('settings.plugins.registries.editor.displayName', 'Acme');
        await editor.setField('settings.plugins.registries.editor.scopes', 'acme');

        await pressTestInstanceAsync(editor.saveButton(), 'save');

        expect(editor.onResolve).not.toHaveBeenCalled();
        expect(editor.onClose).not.toHaveBeenCalled();
        expect(editor.screen.findByTestId('settings.plugins.registries.editor.scopes')?.props.accessibilityState)
            .toMatchObject({ invalid: true });
    });

    it('shows an existing profile whole and keeps its origin as the identity it edits', async () => {
        const editor = await renderEditor({
            mode: 'edit',
            subject: {
                displayName: 'Acme',
                origin: 'https://registry.acme.test',
                scopes: ['@acme'],
                useAsDefault: true,
                allowPrivateNetwork: false,
            },
        });

        const originField = editor.screen.findByTestId('settings.plugins.registries.editor.origin');
        expect(originField?.props.value).toBe('https://registry.acme.test');
        expect(originField?.props.editable).toBe(false);
        expect(editor.screen.findByTestId('settings.plugins.registries.editor.scopes')?.props.value).toBe('@acme');

        await editor.setField('settings.plugins.registries.editor.displayName', 'Acme updated');
        await editor.toggle('settings.plugins.registries.editor.allowPrivateNetwork');
        await pressTestInstanceAsync(editor.saveButton(), 'save');

        expect(editor.onResolve).toHaveBeenCalledWith({
            displayName: 'Acme updated',
            origin: 'https://registry.acme.test',
            scopes: ['@acme'],
            useAsDefault: true,
            allowPrivateNetwork: true,
        });
    });

    it('abandons the profile when the form is cancelled', async () => {
        const editor = await renderEditor({ mode: 'create' });

        await editor.setField('settings.plugins.registries.editor.origin', 'https://registry.acme.test');
        await editor.setField('settings.plugins.registries.editor.displayName', 'Acme');
        await pressTestInstanceAsync(
            editor.control('settings.plugins.registries.editor.cancel'),
            'cancel',
        );

        expect(editor.onResolve).toHaveBeenCalledWith(null);
        expect(editor.onClose).toHaveBeenCalled();
    });
});
