import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import type { LocalSettings } from '@/sync/domains/settings/localSettings';

const reducedMotionState = vi.hoisted(() => ({ current: false }));
const localSettingValues = vi.hoisted(() => ({}) as Partial<Record<string, unknown>>);

vi.mock('@/hooks/ui/useReducedMotionPreference', () => ({
    useReducedMotionPreference: () => reducedMotionState.current,
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        View: 'View',
        ActivityIndicator: 'ActivityIndicator',
        Platform: {
            OS: 'web',
            select: (options: Record<string, unknown>) => options.web ?? options.default,
        },
    });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
        theme: {
            colors: {
                text: {
                    secondary: 'theme-secondary-text',
                },
                accent: { indigo: 'accent-indigo', purple: 'accent-purple', orange: 'accent-orange' },
            },
        },
    });
});

vi.mock('@/sync/store/hooks', async () => {
    const { createUseLocalSettingMock } = await import('@/dev/testkit/mocks/storage');
    return { useLocalSetting: createUseLocalSettingMock({ values: localSettingValues as Partial<LocalSettings> }) };
});

/** The page's `<style>` sink is the one DOM boundary the web spinner writes to outside React. */
type InjectedStyle = { id: string; textContent: string };
let injectedStyles: InjectedStyle[] = [];

beforeEach(() => {
    vi.resetModules();
    injectedStyles = [];
    reducedMotionState.current = false;
    for (const key of Object.keys(localSettingValues)) delete localSettingValues[key];
    vi.stubGlobal('document', {
        getElementById: (id: string) => injectedStyles.find((style) => style.id === id) ?? null,
        createElement: () => ({ id: '', textContent: '' }),
        head: { appendChild: (style: InjectedStyle) => { injectedStyles.push(style); } },
    });
});

afterEach(() => {
    vi.unstubAllGlobals();
});

function flattenStyle(style: unknown): Record<string, unknown> {
    if (!style) return {};
    if (Array.isArray(style)) {
        return style.reduce((acc, item) => Object.assign(acc, flattenStyle(item)), {} as Record<string, unknown>);
    }
    if (typeof style === 'object') return style as Record<string, unknown>;
    return {};
}

async function renderSpinner(props: Record<string, unknown>) {
    const { ActivitySpinner } = await import('./ActivitySpinner');
    const screen = await renderScreen(<ActivitySpinner testID="spinner" {...props} />);
    const spinner = screen.findByTestId('spinner');
    if (!spinner) throw new Error('Expected the spinner to render');
    const strips = screen.findAllByType('span' as never);
    return { screen, spinner, strip: strips[0] as { props: Record<string, unknown> } | undefined };
}

function frameSheetFor(strip: { props: Record<string, unknown> } | undefined): string {
    const key = strip?.props['data-happier-activity-spinner'];
    if (typeof key !== 'string') throw new Error('Expected the strip to carry its frame-sheet key');
    const rule = injectedStyles.map((style) => style.textContent).find((css) => css.includes(`"${key}"`));
    if (!rule) throw new Error(`Expected a frame-sheet rule for ${key}`);
    const payload = rule.match(/data:image\/svg\+xml,([^")]+)/)?.[1];
    if (!payload) throw new Error('Expected the rule to embed its frame sheet');
    return decodeURIComponent(payload);
}

describe('ActivitySpinner (web)', () => {
    it.each(['wave', 'classicRing'] as const)('provides a localized accessible name for %s and preserves caller labels', async (variant) => {
        const { setPreferredLanguageFromSettings, t } = await import('@/text');
        setPreferredLanguageFromSettings('fr');
        try {
            const { ActivitySpinner } = await import('./ActivitySpinner');
            const { screen } = await renderSpinner({ variant });
            const host = screen.findHostByTestId('spinner')!;
            expect(host.props.accessibilityRole).toBe('progressbar');
            expect(host.props.accessibilityLabel).toBe(t('common.loading'));

            await screen.update(<ActivitySpinner testID="spinner" variant={variant} accessibilityLabel="Upload progress" />);
            expect(host.props.accessibilityLabel).toBe('Upload progress');
            await screen.update(<ActivitySpinner testID="spinner" variant={variant} accessibilityLabel="" />);
            expect(host.props.accessibilityLabel).toBe('');
        } finally {
            setPreferredLanguageFromSettings(null);
        }
    });

    it('draws the mark wave by default as a frame strip stepped by one transform animation', async () => {
        const { screen, spinner, strip } = await renderSpinner({ size: 12, color: 'red' });

        expect(screen.findAllByType('ActivityIndicator' as never)).toHaveLength(0);
        expect(spinner.props.accessibilityRole).toBe('progressbar');
        const box = flattenStyle(spinner.props.style);
        expect(box).toMatchObject({ width: 12, height: 12, alignSelf: 'center', overflow: 'hidden' });
        expect(box.borderTopColor).toBeUndefined();

        const stripStyle = flattenStyle(strip?.props.style);
        expect(stripStyle.animationName).toBe('happierActivitySpinnerFilmstrip');
        expect(stripStyle.animationDuration).toBe('1004ms');
        expect(frameSheetFor(strip)).toContain('fill="red"');
        expect(frameSheetFor(strip).match(/<circle /g)).toHaveLength(30 * 8);
    });

    it('draws the style chosen in settings, and a caller preview overrides it', async () => {
        localSettingValues.loadingIndicatorStyle = 'slowBreath';
        const chosen = await renderSpinner({ size: 16 });
        expect(flattenStyle(chosen.strip?.props.style).animationDuration).toBe('2400ms');

        const preview = await renderSpinner({ size: 16, variant: 'radar' });
        expect(flattenStyle(preview.strip?.props.style).animationDuration).toBe('1100ms');
    });

    it('falls back to the wave when the stored style is not one it knows', async () => {
        localSettingValues.loadingIndicatorStyle = 'retiredStyle';
        const { strip } = await renderSpinner({ size: 16 });

        expect(flattenStyle(strip?.props.style).animationDuration).toBe('1004ms');
    });

    it('plays at the speed and pause chosen in settings, and previews follow them', async () => {
        localSettingValues.loadingIndicatorSpeed = 'fast';
        localSettingValues.loadingIndicatorPause = 'long';
        const wave = await renderSpinner({ size: 16 });
        // 804 ms of motion at 1.5×, then the 500 ms pause.
        expect(flattenStyle(wave.strip?.props.style).animationDuration).toBe('1036ms');

        // A continuous style takes the speed but has no pause to lengthen.
        const radar = await renderSpinner({ size: 16, variant: 'radar' });
        expect(flattenStyle(radar.strip?.props.style).animationDuration).toBe('733ms');
    });

    it('plays unknown stored speeds and pauses at the defaults', async () => {
        localSettingValues.loadingIndicatorSpeed = 'warp';
        localSettingValues.loadingIndicatorPause = 'forever';
        const { strip } = await renderSpinner({ size: 16 });

        expect(flattenStyle(strip?.props.style).animationDuration).toBe('1004ms');
    });

    it.each(['aurora', 'hAurora'])('colors %s with the theme accents, but an explicit color wins so the mark stays legible on tinted buttons', async (styleId) => {
        localSettingValues.loadingIndicatorStyle = styleId;
        const themed = frameSheetFor((await renderSpinner({ size: 16 })).strip);
        expect(themed).toContain('fill="accent-indigo"');
        expect(themed).toContain('fill="accent-orange"');

        const explicit = frameSheetFor((await renderSpinner({ size: 16, color: 'white' })).strip);
        expect(explicit).toContain('fill="white"');
        expect(explicit).not.toContain('accent-indigo');
    });

    it('keeps the classic ring for people who choose it', async () => {
        localSettingValues.loadingIndicatorStyle = 'classicRing';
        const { spinner, strip } = await renderSpinner({ size: 12, color: 'red' });

        const style = flattenStyle(spinner.props.style);
        expect(strip).toBeUndefined();
        expect(style.animationName).toBe('happierActivitySpinnerSpin');
        expect(style.animationTimingFunction).toBe('steps(6, end)');
        expect(style.width).toBe(12);
        expect(style.borderColor).toBe('red');
    });

    it('uses the theme secondary text color when no color is provided', async () => {
        const { strip } = await renderSpinner({ size: 'small' });

        expect(frameSheetFor(strip)).toContain('fill="theme-secondary-text"');
    });

    it('holds a still, fully drawn H without scheduling any animation when ambient motion is paused', async () => {
        const { spinner, strip } = await renderSpinner({ size: 12, animationEnabled: false });

        expect(flattenStyle(spinner.props.style).animationName).toBeUndefined();
        expect(flattenStyle(strip?.props.style).animationName).toBeUndefined();
        expect(frameSheetFor(strip)).toContain('fill-opacity="0.85"');
    });

    it('drops every animation while the page is hidden, so an unseen tab never keeps a spinner moving', async () => {
        const hiddenDocument = (globalThis as unknown as { document: Record<string, unknown> }).document;
        hiddenDocument.visibilityState = 'hidden';

        const dots = await renderSpinner({ size: 12 });
        expect(flattenStyle(dots.strip?.props.style).animationName).toBeUndefined();
        expect(frameSheetFor(dots.strip)).toContain('fill-opacity="0.85"');

        reducedMotionState.current = true;
        const breathing = await renderSpinner({ size: 12 });
        expect(flattenStyle(breathing.strip?.props.style).animationName).toBeUndefined();

        localSettingValues.loadingIndicatorStyle = 'classicRing';
        const ring = await renderSpinner({ size: 12 });
        expect(flattenStyle(ring.spinner.props.style).animationName).toBeUndefined();
    });

    it('replaces the travelling light with a slow breath of the still H under reduced motion', async () => {
        reducedMotionState.current = true;
        const { strip } = await renderSpinner({ size: 12 });

        expect(flattenStyle(strip?.props.style).animationName).toBe('happierActivitySpinnerBreath');
        expect(frameSheetFor(strip)).toContain('fill-opacity="0.85"');
    });

    it('stops turning the classic ring under reduced motion but keeps it visible', async () => {
        reducedMotionState.current = true;
        localSettingValues.loadingIndicatorStyle = 'classicRing';
        const { spinner } = await renderSpinner({ size: 12 });

        const style = flattenStyle(spinner.props.style);
        expect(style.animationName).toBeUndefined();
        expect(style.opacity).toBe(1);
    });

    it('renders nothing when stopped and hidden, whatever the style', async () => {
        const { ActivitySpinner } = await import('./ActivitySpinner');
        const screen = await renderScreen(<ActivitySpinner testID="spinner" animating={false} />);

        expect(screen.findAllByType('View' as never)).toHaveLength(0);
        expect(screen.findAllByType('span' as never)).toHaveLength(0);
    });
});
