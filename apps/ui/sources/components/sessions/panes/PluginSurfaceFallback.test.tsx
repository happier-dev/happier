import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { FindHighlightedText } from '@/components/ui/text/FindHighlightedText';
import { resolvePluginSurfaceStatePresentation } from '@/sync/domains/surfaces/copy';
import { t } from '@/text';

import { PluginSurfaceFallback, projectPluginSurfaceFallbackFindText } from './PluginSurfaceFallback';

describe('PluginSurfaceFallback', () => {
    it('decorates the displayed fallback glyphs while retaining human accessibility copy', async () => {
        const reasonCode = 'hosted_web_bridge_timeout';
        const card = resolvePluginSurfaceStatePresentation({ state: 'unavailable', reasonCode }).card!;
        const screen = await renderScreen(
            <PluginSurfaceFallback
                testID="structured-unavailable"
                reasonCode={reasonCode}
                renderText={(field, text) => (
                    <FindHighlightedText
                        text={text}
                        ranges={[{ start: 0, end: text.length, current: field === 'title' }]}
                    />
                )}
            />,
        );

        expect(screen.findByTestId('find-match-current')?.children.join('')).toBe(card.title);
        expect(screen.findByTestId('find-match-all')?.children.join('')).toBe(card.reason);
        expect(screen.getTextContent()).toContain(card.title);
        expect(screen.getTextContent()).toContain(card.reason);
        expect(screen.getTextContent()).not.toContain(reasonCode);
    });

    it('projects exactly the displayed unavailable title and reason, excluding raw diagnostics and skeleton copy', async () => {
        const reasonCode = 'hosted_web_bridge_timeout';
        const screen = await renderScreen(<PluginSurfaceFallback testID="structured-unavailable" reasonCode={reasonCode} />);
        const fields = projectPluginSurfaceFallbackFindText({ reasonCode });

        expect(fields).toEqual([
            { id: 'structured-unavailable-title', text: screen.findByTestId('structured-unavailable-title')?.children.join(''), format: 'plain' },
            { id: 'structured-unavailable-reason', text: screen.findByTestId('structured-unavailable-reason')?.children.join(''), format: 'plain' },
        ]);
        expect(fields.map((field) => field.text).join('\n')).not.toContain(reasonCode);
        expect(projectPluginSurfaceFallbackFindText({ state: 'loading', reasonCode })).toEqual([]);
    });

    it('draws a destination-shaped skeleton while loading, with no alarming copy or action', async () => {
        const onRetry = vi.fn();
        const onManage = vi.fn();
        const screen = await renderScreen(
            <PluginSurfaceFallback
                testID="plugin-surface-unavailable"
                state="loading"
                reasonCode="targeted_contributions_loading"
                action={{ label: t('settingsPlugins.managePlugin'), onPress: onManage }}
                onRetry={onRetry}
            />,
        );

        const skeleton = screen.findByTestId('plugin-surface-unavailable-loading-skeleton');
        expect(skeleton).toBeTruthy();
        expect(skeleton?.props.accessibilityLabel).toBe(t('pluginSurfaces.state.loading.title'));
        expect(screen.findByTestId('plugin-surface-unavailable-action')).toBeNull();
        expect(screen.findByTestId('plugin-surface-unavailable-secondary-action')).toBeNull();
        expect(screen.findByTestId('plugin-surface-unavailable-details-toggle')).toBeNull();
        expect(screen.getTextContent()).not.toContain(t('common.unavailable'));
        expect(screen.getTextContent()).not.toContain(t('settingsPlugins.managePlugin'));
        expect(screen.getTextContent()).not.toContain('targeted_contributions_loading');
        expect(screen.findByTestId(
            'plugin-surface-unavailable-diagnostic-targeted_contributions_loading',
        )).toBeTruthy();
    });

    it('makes Retry the single action for a transient failure and wires it to the host retry', async () => {
        const onRetry = vi.fn();
        const onManage = vi.fn();
        const screen = await renderScreen(
            <PluginSurfaceFallback
                testID="plugin-surface-unavailable"
                reasonCode="targeted_contributions_error"
                action={{ label: t('settingsPlugins.managePlugin'), onPress: onManage }}
                onRetry={onRetry}
            />,
        );

        expect(screen.findByTestId('plugin-surface-unavailable-action')?.props.accessibilityLabel)
            .toBe(t('common.retry'));
        expect(screen.findByTestId('plugin-surface-unavailable-secondary-action')).toBeNull();
        expect(screen.getTextContent()).not.toContain(t('settingsPlugins.managePlugin'));
        await act(async () => {
            screen.pressByTestId('plugin-surface-unavailable-action');
        });
        expect(onRetry).toHaveBeenCalledOnce();
        expect(onManage).not.toHaveBeenCalled();
    });

    it('offers no action for a transient failure when the host has no retry path', async () => {
        const screen = await renderScreen(
            <PluginSurfaceFallback
                testID="plugin-surface-unavailable"
                reasonCode="targeted_contributions_error"
                action={{ label: t('settingsPlugins.managePlugin'), onPress: vi.fn() }}
            />,
        );

        expect(screen.findByTestId('plugin-surface-unavailable-action')).toBeNull();
    });

    it('keeps the raw reason behind a quiet Details disclosure', async () => {
        const screen = await renderScreen(
            <PluginSurfaceFallback
                testID="plugin-surface-unavailable"
                reasonCode="targeted_contributions_error"
            />,
        );

        expect(screen.getTextContent()).not.toContain('targeted_contributions_error');
        await act(async () => {
            screen.pressByTestId('plugin-surface-unavailable-details-toggle');
        });
        expect(screen.findByTestId('plugin-surface-unavailable-details-code')).toBeTruthy();
        expect(screen.getTextContent()).toContain('targeted_contributions_error');
    });

    it('routes a configuration failure to the caller-owned Manage plugin recovery, never Retry', async () => {
        const onPress = vi.fn();
        const onRetry = vi.fn();
        const screen = await renderScreen(
            <PluginSurfaceFallback
                testID="plugin-surface-unavailable"
                reasonCode="required_permission_missing"
                action={{ label: t('settingsPlugins.managePlugin'), onPress }}
                onRetry={onRetry}
            />,
        );

        expect(screen.findByTestId('plugin-surface-unavailable-action')?.props.accessibilityLabel)
            .toBe(t('settingsPlugins.managePlugin'));
        await act(async () => {
            screen.pressByTestId('plugin-surface-unavailable-action');
        });

        expect(onPress).toHaveBeenCalledTimes(1);
        expect(onRetry).not.toHaveBeenCalled();
    });

    it('projects incompatible mounts through the existing route callback with Update semantics', async () => {
        const onPress = vi.fn();
        const screen = await renderScreen(
            <PluginSurfaceFallback
                testID="plugin-surface-unavailable"
                reasonCode="artifact_incompatible"
                action={{ label: t('settingsPlugins.managePlugin'), onPress }}
            />,
        );

        expect(screen.findByTestId('plugin-surface-unavailable-action')?.props.accessibilityLabel).toBe(t('common.update'));
        await act(async () => {
            screen.pressByTestId('plugin-surface-unavailable-action');
        });
        expect(onPress).toHaveBeenCalledOnce();
    });

    it('owns diagnostic-to-copy presentation without exposing the raw host reason', async () => {
        const props = {
            testID: 'plugin-surface-unavailable',
            reasonCode: 'hosted_web_bridge_timeout',
        } as React.ComponentProps<typeof PluginSurfaceFallback> & Readonly<{
            reasonCode: string;
        }>;
        const screen = await renderScreen(<PluginSurfaceFallback {...props} />);

        expect(screen.getTextContent()).toContain(t('pluginRuntime.hostedWebBridgeTimeout'));
        expect(screen.getTextContent()).not.toContain('hosted_web_bridge_timeout');
        expect(screen.findByTestId(
            'plugin-surface-unavailable-diagnostic-hosted_web_bridge_timeout',
        )).toBeTruthy();
    });
});
