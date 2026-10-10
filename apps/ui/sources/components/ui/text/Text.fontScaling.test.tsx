import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { flattenTestStyle, renderScreen, standardCleanup } from '@/dev/testkit';

const settings = vi.hoisted(() => ({ fontScale: 1.3 }));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

// The in-app font preference is device-local storage, outside the text owner.
vi.mock('@/sync/store/hooks', () => ({ useLocalSetting: () => settings.fontScale }));

afterEach(() => {
    settings.fontScale = 1.3;
    vi.unstubAllGlobals();
    standardCleanup();
    vi.resetModules();
});

async function renderTextHosts(platform: 'web' | 'ios', disabled = false) {
    const { Platform } = await import('react-native');
    Object.defineProperty(Platform, 'OS', { configurable: true, value: platform });
    const { Text, TextInput } = await import('./Text');
    return renderScreen(<>
        <Text testID="text" disableUiFontScaling={disabled} style={{ fontSize: 14, lineHeight: 20 }}>Label</Text>
        <TextInput testID="input" disableUiFontScaling={disabled} style={{ fontSize: 14, lineHeight: 20 }} value="Value" />
    </>);
}

describe('Text metric scaling ownership', () => {
    it('retains the compiled field paint when the material resolver keeps authored paint unchanged', async () => {
        const { Platform } = await import('react-native');
        Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' });
        const { HappierMaterialRoleProvider } = await import('@happier-dev/plugin-ui/presentation');
        const { TextInput } = await import('./Text');
        // An enumerable inline variable would override Unistyles' compiled themed class.
        const fieldStyle = Object.defineProperty({ padding: 12, fontSize: 14 }, 'backgroundColor', { value: 'var(--colors-input-background)', enumerable: false });
        const screen = await renderScreen(<HappierMaterialRoleProvider role="content" resolveMaterialColor={({ color }) => color}>
            <TextInput testID="solid-field" value="Exact" style={fieldStyle} />
        </HappierMaterialRoleProvider>);
        expect(flattenTestStyle(screen.findByTestId('solid-field')!.props.style).backgroundColor).toBeUndefined();
        expect(screen.findByTestId('solid-field')!.props.value).toBe('Exact');
    });
    it('resolves the hidden authored paint exposed by the real Unistyles boundary', async () => {
        const { Platform } = await import('react-native');
        Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' });
        const { HappierMaterialRoleProvider } = await import('@happier-dev/plugin-ui/presentation');
        const { TextInput } = await import('./Text');
        // Unistyles exposes semantic style values non-enumerably on web.
        const fieldStyle = Object.defineProperty({ padding: 12, fontSize: 14 }, 'backgroundColor', { value: '#112233', enumerable: false });
        const screen = await renderScreen(<HappierMaterialRoleProvider role="content" resolveMaterialColor={() => 'rgba(235, 230, 225, 0.1)'}>
            <TextInput testID="hidden-field" value="Exact" style={fieldStyle} />
        </HappierMaterialRoleProvider>);
        expect(flattenTestStyle(screen.findByTestId('hidden-field')!.props.style)).toMatchObject({ backgroundColor: 'rgba(235, 230, 225, 0.1)', padding: 12, fontSize: 14 });
        expect(screen.findByTestId('hidden-field')!.props.value).toBe('Exact');
    });
    it('changes only an authored field coat inside glass while keeping editing and geometry', async () => {
        const { Platform } = await import('react-native');
        Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' });
        const { HappierMaterialRoleProvider } = await import('@happier-dev/plugin-ui/presentation');
        const { TextInput } = await import('./Text');
        function Field() {
            const [value, setValue] = React.useState('Before');
            return <TextInput testID="glass-field" value={value} onChangeText={setValue} style={{ backgroundColor: '#112233', color: '#445566', padding: 12, fontSize: 14 }} />;
        }
        const screen = await renderScreen(<HappierMaterialRoleProvider role="floating" resolveMaterialColor={() => 'rgba(235, 230, 225, 0.1)'}>
            <Field />
            <TextInput testID="bare-field" value="Bare" />
        </HappierMaterialRoleProvider>);
        expect(flattenTestStyle(screen.findByTestId('glass-field')!.props.style)).toMatchObject({ backgroundColor: 'rgba(235, 230, 225, 0.1)', color: '#445566', padding: 12, fontSize: 14 });
        expect(flattenTestStyle(screen.findByTestId('bare-field')!.props.style).backgroundColor).toBeUndefined();
        await act(async () => screen.findByTestId('glass-field')!.props.onChangeText('After'));
        expect(screen.findByTestId('glass-field')!.props.value).toBe('After');
    });
    it('lets web CSS scale text and field metrics once', async () => {
        const screen = await renderTextHosts('web');
        for (const id of ['text', 'input']) {
            expect(flattenTestStyle(screen.findByTestId(id)!.props.style)).toMatchObject({ fontSize: 14, lineHeight: 20 });
        }
    });

    it('scales native text and fields in the adapter while preserving Dynamic Type', async () => {
        const screen = await renderTextHosts('ios');
        for (const id of ['text', 'input']) {
            expect(flattenTestStyle(screen.findByTestId(id)!.props.style)).toMatchObject({ fontSize: 18.2, lineHeight: 26 });
        }
        expect(screen.findByTestId('text')!.props.allowFontScaling).toBe(true);
    });

    it('opts special web text and fields out of the global CSS scale', async () => {
        const screen = await renderTextHosts('web', true);
        for (const id of ['text', 'input']) {
            const host = screen.findByTestId(id)!;
            expect(host.props['data-happier-ui-font-scaling']).toBe('disabled');
            expect(flattenTestStyle(host.props.style)).toMatchObject({ fontSize: 14, lineHeight: 20 });
        }
    });

    it('keeps the iOS web field at a 16px effective minimum even with small text', async () => {
        settings.fontScale = 0.8;
        vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)' });
        const screen = await renderTextHosts('web');
        // The web CSS owner applies 0.8 after Unistyles compiles this base value.
        expect(flattenTestStyle(screen.findByTestId('input')!.props.style).fontSize).toBe(20);
    });
});
