import { getThemeSurfacePaintMap, type SurfaceAddress, type ThemeSurfacePaintDescriptor,
    type ThemeSurfacePaintRole } from '@happier-dev/plugin-sdk/ui';

import { resolveSidebarPaint } from '@/components/navigation/shell/appRail/sidebarPaint';
import { resolveComposerMaterialPaint, isGlassComposerSurface, type ComposerSurfaceStyle,
    type GlassSurfaceCompositionContext } from '@/components/sessions/agentInput/composerSurfaceStyle';
import { resolveSessionRowPaint } from '@/components/sessions/shell/row/sessionRowPaint';
import { resolveSessionHeaderPaint } from '@/components/sessions/shell/view/sessionHeaderPaint';
import { resolveTranscriptPaint } from '@/components/sessions/transcript/transcriptPaint';
import { resolveToolRowPaint } from '@/components/tools/shell/views/toolRowPaint';
import { resolveAppSwitchPaint } from '@/components/ui/forms/switchPaint';
import { resolveTabBarPaint } from '@/components/ui/navigation/tabBarPaint';
import { resolveTooltipPaint } from '@/components/ui/overlays/tooltipPaint';
import { resolveSelectionListPaint } from '@/components/ui/selectionList/selectionListPaint';
import { resolveThemeProfileWithPaint, type ResolvedThemeProfile } from '../profiles/resolveThemeProfile';
import type { ThemePaintFacets } from '../profiles/themePaint';
import type { ThemeProfileDocument, ThemeProfileMode } from '../profiles/themeProfileTypes';
import { themeSurfaceLabel } from './themeSurfaceLabels';

export type ThemeSurfacePaintContext = Readonly<{
    composerSurfaceStyle?: ComposerSurfaceStyle;
    composerMaterial?: GlassSurfaceCompositionContext;
}>;

function roles(paints: ThemePaintFacets): readonly ThemeSurfacePaintRole[] {
    return Object.entries(paints).map(([facet, paint]) => ({
        facet: facet as ThemeSurfacePaintRole['facet'], source: paint.source,
    }));
}

// A caller-owned visible paint has no universal editable input. Do not invent a
// color for it: this projection publishes provenance, rather than a rendered color.
function fixedRoles(...facets: readonly ThemeSurfacePaintRole['facet'][]): readonly ThemeSurfacePaintRole[] {
    return facets.map(facet => ({ facet, source: { kind: 'fixed' } }));
}

function resolvePaintRoles(address: SurfaceAddress, resolved: ResolvedThemeProfile,
    context: ThemeSurfacePaintContext): readonly ThemeSurfacePaintRole[] {
    const { theme, paint } = resolved;
    switch (address.surface) {
        case 'sidebar': return roles(resolveSidebarPaint(theme, address.part));
        case 'session-row': return roles(resolveSessionRowPaint(theme, address.part, address.state));
        case 'chat-header': return roles(resolveSessionHeaderPaint(theme, address.part));
        case 'user-bubble':
            // Both Markdown renderers allow textStyle to replace the base ink.
            if (address.part === 'text') return fixedRoles('foreground');
            return roles(resolveTranscriptPaint(theme, address.surface, address.part));
        case 'assistant-text': return roles(resolveTranscriptPaint(theme, address.surface, 'root'));
        case 'tool-row': return roles(resolveToolRowPaint(theme, address.part));
        case 'tab-bar': return roles(resolveTabBarPaint(theme, address.part, address.state));
        case 'model-picker':
        case 'project-picker': return roles(resolveSelectionListPaint(theme, address.part, address.state));
        case 'composer': {
            if (address.part === 'root') return roles({ background: resolveComposerMaterialPaint({
                theme, glass: isGlassComposerSurface({ setting: context.composerSurfaceStyle }),
                embedded: false, glassPaint: paint.glassComposer, material: context.composerMaterial,
            }) });
            // AgentInput addresses both editable inputs and read-only content;
            // its submit owner also switches between send, stop and voice controls.
            if (address.part === 'input') return fixedRoles('foreground');
            return address.part === 'toolbar' ? fixedRoles('background') : fixedRoles('background', 'foreground');
        }
        case 'code-block':
            // Markdown's diff wrapper and CodeBlockViewFrame share these addresses.
            // Frame fill/border and optional language ink belong only to the frame;
            // header/body wrappers also contain caller-supplied code and controls.
            return address.part === 'root' ? fixedRoles('background', 'border') : fixedRoles('background');
        case 'switch': {
            if (address.part === 'root') return fixedRoles('background');
            const control = resolveAppSwitchPaint(theme);
            if (address.part === 'thumb') return roles({ background: control.thumb });
            // Disabled wins the emitted state even for a checked switch, so that
            // address cannot identify which value selected the track paint.
            return address.state === 'disabled' ? fixedRoles('background')
                : roles({ background: address.state === 'checked' ? control.trackOn : control.trackOff });
        }
        case 'tooltip':
            // FloatingOverlay owns the material fill and suppresses the tooltip
            // border; the tooltip's own text ink is invariant across those coats.
            return address.part === 'text' ? roles({ foreground: resolveTooltipPaint(theme).foreground })
                : fixedRoles('background', 'border');
        case 'button':
            // RoundButton display and plugin Button chrome are caller-selected;
            // semantic state alone does not select primary/secondary/destructive.
            return address.part === 'root' ? fixedRoles('background', 'border') : fixedRoles('foreground');
        case 'input':
            // Fields accepts caller fieldColors and ordinary input style overrides.
            return address.part === 'root' ? fixedRoles('background', 'border') : fixedRoles('foreground');
        case 'dialog':
            // RetainedModalFrame supplies material; ModalHeader/ModalCardFooterActions
            // accept custom text/content, while their anatomy wrappers are clear.
            return address.part === 'root' ? fixedRoles('background', 'border') : fixedRoles('background');
        case 'menu':
            // SelectableRow and plugin Menu accept selection, destructive and custom
            // content paints; FloatingOverlay owns their surrounding material.
            return address.part === 'row' ? fixedRoles('background', 'foreground') : fixedRoles('background');
        case 'inline-code':
            // The shared InlineCode primitive receives ink/fill from its host:
            // app Markdown and plugin snapshots intentionally choose different fills.
            return fixedRoles('background', 'foreground');
    }
    const unhandled: never = address;
    throw new Error(`Unresolved theme surface paint: ${JSON.stringify(unhandled)}`);
}

/** Registry addresses and owning paint selectors project the requested profile. */
export function projectThemeSurfacePaintMap({ profile }: Pick<ThemeProfileDocument, 'profile'>, mode: ThemeProfileMode,
    context: ThemeSurfacePaintContext = {}): readonly ThemeSurfacePaintDescriptor[] {
    const resolved = resolveThemeProfileWithPaint({ profile, mode });
    return getThemeSurfacePaintMap(address => ({
        label: `${themeSurfaceLabel(address.surface)} · ${address.part}`,
        paintRoles: resolvePaintRoles(address, resolved, context),
    }));
}
