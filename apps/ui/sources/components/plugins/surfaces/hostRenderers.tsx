import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { isRenderableHostRendererId } from '@happier-dev/protocol/plugins/ui';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

import { resolvePluginDisplayString } from './resolvePluginDisplayString';

/**
 * Phase 1.4 (Seam 2, UI side): the SINGLE `rendererId → React component` dispatch
 * table for `{kind:'host'}` surface placements. The set of renderable ids is
 * owned by the PURE protocol predicate `isRenderableHostRendererId` (no React) —
 * which, after Phase 1.4, unifies the generic `descriptorPanel` with the 8 richer
 * `sessionSurface` renderer ids into ONE host-placement universe. This module owns
 * ONLY the components and is keyed off that same set. A host renderer-id component
 * renders descriptor-DECLARED content only — it never receives raw
 * store/transport/CDP/media handles.
 */

export type PluginHostRendererDescriptorDisplay = Readonly<{
    titleKey?: string;
    descriptionKey?: string;
    labelKey?: string;
    developerFallback?: string;
}>;

export type PluginHostRendererProps = Readonly<{
    surfaceId: string;
    display?: PluginHostRendererDescriptorDisplay | null;
    resolveDisplayKey?: (key: string) => string | null | undefined;
    testID: string;
}>;

function resolveDeclaredTitle(props: Pick<PluginHostRendererProps, 'display' | 'resolveDisplayKey'>): string | null {
    // UX-1: `labelKey`/`titleKey` are translation KEYS — resolve via the catalog and never
    // render an unresolved key. The plugin-author `developerFallback` literal wins.
    return resolvePluginDisplayString({
        developerFallback: props.display?.developerFallback,
        keys: [props.display?.labelKey, props.display?.titleKey],
        resolveKey: props.resolveDisplayKey,
    });
}

function resolveDeclaredDescription(props: Pick<PluginHostRendererProps, 'display' | 'resolveDisplayKey'>): string | null {
    return resolvePluginDisplayString({
        keys: [props.display?.descriptionKey],
        resolveKey: props.resolveDisplayKey,
    });
}

/**
 * Shared descriptor-declared panel chrome. Every native-host renderer renders
 * the plugin descriptor's declared display title/description (plugin-authored
 * strings, the same precedence the right-sidebar plugin-tab resolver uses) inside
 * themed chrome. Host-authored chrome strings go through `t(...)`. The `accent`
 * variant gives the richer session-surface renderers a left rule so they read as
 * distinct surfaces while sharing one safe descriptor-only render path.
 */
function PluginHostDescriptorPanel(
    props: PluginHostRendererProps & { variant?: 'plain' | 'accent' },
): React.ReactElement {
    const { theme, rt } = useUnistyles();
    const title = resolveDeclaredTitle(props);
    const description = resolveDeclaredDescription(props);
    const accent = props.variant === 'accent';
    const hostAccessibilityLabel = t('pluginSurfaces.hostRenderer.descriptorPanel.accessibilityLabel');
    return (
        <View
            testID={props.testID}
            accessible
            accessibilityRole="summary"
            accessibilityLabel={[hostAccessibilityLabel, title, description].filter(Boolean).join(': ')}
            style={{
                flex: 1,
                padding: 16,
                gap: 6,
                ...(accent
                    ? rt.rtl
                        ? { borderRightWidth: 2, borderRightColor: theme.colors.text.secondary, paddingRight: 14 }
                        : { borderLeftWidth: 2, borderLeftColor: theme.colors.text.secondary, paddingLeft: 14 }
                    : {}),
            }}
        >
            <Text style={{ color: theme.colors.text.primary, fontSize: 15, ...Typography.default('semiBold') }}>
                {title ?? t('pluginSurfaces.hostRenderer.descriptorPanel.untitled')}
            </Text>
            {description ? (
                <Text style={{ color: theme.colors.text.secondary, fontSize: 13, ...Typography.default() }}>
                    {description}
                </Text>
            ) : null}
        </View>
    );
}

type PluginHostRendererComponent = (props: PluginHostRendererProps) => React.ReactElement;

function descriptorRenderer(variant: 'plain' | 'accent'): PluginHostRendererComponent {
    return (props: PluginHostRendererProps) => (
        <PluginHostDescriptorPanel {...props} variant={variant} />
    );
}

/**
 * The ONE host-renderer dispatch table (Phase 1.4). Keyed by the same renderer
 * ids the protocol set recognizes: the generic `descriptorPanel` plus the 8
 * unified `sessionSurface` ids. Each renders descriptor-declared content only.
 */
const PLUGIN_HOST_RENDERERS: Readonly<Record<string, PluginHostRendererComponent>> = Object.freeze({
    descriptorPanel: descriptorRenderer('plain'),
    // Unified session-surface renderer ids (previously stranded in a separate enum).
    actionPanel: descriptorRenderer('accent'),
    emptyState: descriptorRenderer('plain'),
    fileReference: descriptorRenderer('accent'),
    markdownDetails: descriptorRenderer('plain'),
    previewPlaceholder: descriptorRenderer('plain'),
    resourceSummary: descriptorRenderer('accent'),
    statusTimeline: descriptorRenderer('accent'),
    terminalReference: descriptorRenderer('accent'),
});

/**
 * Resolve the React component for a host renderer id, keyed off the pure protocol
 * set. Returns null for any id that is not renderable (fail-closed default), so the
 * host renders its generic fallback instead.
 */
export function resolvePluginHostRendererComponent(
    rendererId: string | null | undefined,
): PluginHostRendererComponent | null {
    if (!isRenderableHostRendererId(rendererId)) {
        return null;
    }
    return PLUGIN_HOST_RENDERERS[rendererId] ?? null;
}
