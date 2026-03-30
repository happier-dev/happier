import type { ImageSourcePropType } from 'react-native';
import type { UnistylesThemes } from 'react-native-unistyles';

import type { AgentId } from './registryCore';

import { CLAUDE_UI } from '@/agents/providers/claude/ui';
import { CODEX_UI } from '@/agents/providers/codex/ui';
import { OPENCODE_UI } from '@/agents/providers/opencode/ui';
import { GEMINI_UI } from '@/agents/providers/gemini/ui';
import { AUGGIE_UI } from '@/agents/providers/auggie/ui';
import { QWEN_UI } from '@/agents/providers/qwen/ui';
import { KIMI_UI } from '@/agents/providers/kimi/ui';
import { KILO_UI } from '@/agents/providers/kilo/ui';
import { KIRO_UI } from '@/agents/providers/kiro/ui';
import { CUSTOM_ACP_UI } from '@/agents/providers/customAcp/ui';
import { PI_UI } from '@/agents/providers/pi/ui';
import { COPILOT_UI } from '@/agents/providers/copilot/ui';

export type AgentIconSvgXmlResolver = (
    theme: UnistylesThemes[keyof UnistylesThemes],
) => string;

export type AgentUiConfig = Readonly<{
    id: AgentId;
    icon: ImageSourcePropType | null;
    svgIconXml: AgentIconSvgXmlResolver | null;
    /**
     * Visual scaling for small list/picker icons (for example backend picker rows).
     * Some marks have more inherent whitespace than others; this keeps them visually consistent.
     */
    pickerIconScale?: number;
    /**
     * Optional tint for the icon (Codex icon is monochrome and should match text color).
     */
    tintColor: ((theme: UnistylesThemes[keyof UnistylesThemes]) => string) | null;
    /**
     * Avatar overlay sizing tweaks.
     */
    avatarOverlay: Readonly<{
        circleScale: number; // relative to avatar size
        iconScale: (params: { size: number }) => number; // absolute px derived from avatar size
    }>;
    /**
     * Text glyph used in compact CLI/profile compatibility indicators.
     */
    cliGlyph: string;
}>;

export const AGENTS_UI: Readonly<Record<AgentId, AgentUiConfig>> = Object.freeze({
    claude: CLAUDE_UI,
    codex: CODEX_UI,
    opencode: OPENCODE_UI,
    gemini: GEMINI_UI,
    auggie: AUGGIE_UI,
    qwen: QWEN_UI,
    kimi: KIMI_UI,
    kilo: KILO_UI,
    kiro: KIRO_UI,
    customAcp: CUSTOM_ACP_UI,
    pi: PI_UI,
    copilot: COPILOT_UI,
});

export function getAgentIconSource(agentId: AgentId): ImageSourcePropType | null {
    return AGENTS_UI[agentId].icon;
}

export function getAgentIconSvgXml(
    agentId: AgentId,
    theme: UnistylesThemes[keyof UnistylesThemes],
): string | null {
    const resolveSvgXml = AGENTS_UI[agentId].svgIconXml;
    return resolveSvgXml ? resolveSvgXml(theme) : null;
}

export function getAgentIconTintColor(agentId: AgentId, theme: UnistylesThemes[keyof UnistylesThemes]): string | undefined {
    const tint = AGENTS_UI[agentId].tintColor;
    if (!tint) return undefined;
    return tint(theme);
}

export function getAgentPickerIconScale(agentId: AgentId): number {
    const cfg = AGENTS_UI[agentId];
    if (!cfg) return 1;
    return cfg.pickerIconScale ?? 1;
}

export function getAgentAvatarOverlaySizes(agentId: AgentId, size: number): { circleSize: number; iconSize: number } {
    const cfg = AGENTS_UI[agentId];
    const circleSize = Math.round(size * cfg.avatarOverlay.circleScale);
    const iconSize = cfg.avatarOverlay.iconScale({ size });
    return { circleSize, iconSize };
}

export function getAgentCliGlyph(agentId: AgentId): string {
    return AGENTS_UI[agentId].cliGlyph;
}
