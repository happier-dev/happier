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
vi.mock('@/sync/store/settingsReadHooks', () => ({ useLocalSetting: () => settings.fontScale }));

afterEach(() => {
    settings.fontScale = 1.3;
    vi.unstubAllGlobals();
    standardCleanup();
    vi.resetModules();
});

async function renderTextHosts(platform: 'web' | 'ios', disabled = false, variant?: 'body') {
    const { Platform } = await import('react-native');
    Object.defineProperty(Platform, 'OS', { configurable: true, value: platform });
    const { Text, TextInput } = await import('./Text');
    return renderScreen(<>
        <Text testID="text" disableUiFontScaling={disabled} style={{ fontSize: 14, lineHeight: 20 }}>Label</Text>
        <TextInput testID="input" disableUiFontScaling={disabled} variant={variant} style={variant ? undefined : { fontSize: 14, lineHeight: 20 }} value="Value" />
    </>);
}

describe('Text metric scaling ownership', () => {
    it.each(['web', 'ios'] as const)('resolves session-list density chrome through the owned %s type column', async (platform) => {
        settings.fontScale = 1;
        const { Platform } = await import('react-native');
        Object.defineProperty(Platform, 'OS', { configurable: true, value: platform });
        const { CollectionRowTitle, CollectionRowLine } = await import('@/components/ui/lists/collection/CollectionRowContent');
        const { resolveHappierTypeScale } = await import('@happier-dev/plugin-ui/presentation/typeScale');
        const cases = [
            { density: 'detailed', title: 'label', subtitle: 'meta' },
            { density: 'comfortable', title: 'label', subtitle: 'micro' },
            // The compact row's title is the navigation rows' body step (lab `clflat`).
            { density: 'compact', title: 'body', subtitle: 'micro' },
            { density: 'compact', touchCompact: true, title: 'heading', subtitle: 'meta' },
        ] as const;
        for (const entry of cases) {
            const touchCompact = 'touchCompact' in entry;
            const screen = await renderScreen(<>
                <CollectionRowTitle testID="session-title" density={entry.density} touchCompact={touchCompact}>Session</CollectionRowTitle>
                <CollectionRowLine testID="session-subtitle" density={entry.density} touchCompact={touchCompact}>Status</CollectionRowLine>
            </>);
            for (const [id, role] of [['session-title', entry.title], ['session-subtitle', entry.subtitle]] as const) {
                const { weight: _weight, ...expected } = resolveHappierTypeScale(role, platform);
                expect(flattenTestStyle(screen.findByTestId(id)!.props.style)).toMatchObject(expected);
            }
        }
    });
    it.each(['web', 'ios'] as const)('resolves every type role through Text and the plugin host projection on %s', async (platform) => {
        settings.fontScale = 1;
        const { Platform } = await import('react-native');
        Object.defineProperty(Platform, 'OS', { configurable: true, value: platform });
        const { Text, TextInput } = await import('./Text');
        const { projectPluginUiTheme, readPluginUiHostTypography } = await import('@/components/plugins/surfaces/pluginUiThemeProjection');
        const { HAPPIER_TYPE_SCALE, resolveHappierTypeScale } = await import('@happier-dev/plugin-ui/presentation/typeScale');
        const roles = ['display', 'title', 'heading', 'label', 'reading', 'body', 'meta', 'micro'] as const;
        const screen = await renderScreen(<>{roles.map(role => <Text key={role} testID={role} variant={role}>{role}</Text>)}
            <TextInput testID="role-input" variant="body" emphasis="semiBold" />
        </>);
        const projected = readPluginUiHostTypography();
        const { lightTheme } = await import('@/theme');
        const snapshot = projectPluginUiTheme(lightTheme);
        for (const role of roles) {
            const style = flattenTestStyle(screen.findByTestId(role)!.props.style);
            expect(style.fontSize, role).toBeGreaterThan(0);
            const { weight: _weight, ...expected } = resolveHappierTypeScale(role, platform);
            expect(style).toMatchObject(expected);
            expect(style).toMatchObject(projected[role]);
            expect(style.fontFamily).toContain({ regular: 'Inter-Regular', medium: 'Inter-Medium', semiBold: 'Inter-SemiBold' }[HAPPIER_TYPE_SCALE[role].weight]);
        }
        for (const [key, role] of [['title', 'heading'], ['label', 'label'], ['body', 'body'], ['reading', 'reading'], ['caption', 'micro']] as const) {
            const expected = resolveHappierTypeScale(role, platform);
            expect(snapshot.typography[key]).toMatchObject({ fontSize: expected.fontSize, lineHeight: expected.lineHeight });
        }
        expect(flattenTestStyle(screen.findByTestId('role-input')!.props.style).fontFamily).toContain('Inter-SemiBold');
        if (platform === 'ios') {
            settings.fontScale = 1.3;
            const scaled = await renderScreen(<><Text testID="scaled-role" variant="body">Body</Text><TextInput testID="scaled-role-input" variant="body" /></>);
            for (const id of ['scaled-role', 'scaled-role-input']) {
                const style = flattenTestStyle(scaled.findByTestId(id)!.props.style);
                expect(style.fontSize).toBeCloseTo(resolveHappierTypeScale('body', platform).fontSize * settings.fontScale);
                expect(style.lineHeight).toBeCloseTo(resolveHappierTypeScale('body', platform).lineHeight * settings.fontScale);
            }
        }
    });
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
        const screen = await renderTextHosts('web', false, 'body');
        // A role's metrics reach the floor before the web CSS owner applies 0.8.
        expect(flattenTestStyle(screen.findByTestId('input')!.props.style).fontSize).toBe(20);
    });
});
