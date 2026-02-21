import { Ionicons } from '@expo/vector-icons';
import { providers } from '@happier-dev/agents';
import * as React from 'react';
import { Pressable } from 'react-native';

import { hapticsLight } from '@/components/ui/theme/haptics';
import type { AgentInputExtraActionChip } from '@/components/sessions/agentInput';
import { t } from '@/text';
import { Text } from '@/components/ui/text/Text';


const THINKING_LEVELS: ReadonlyArray<string> = ['', ...providers.pi.PI_THINKING_LEVELS];

function nextThinkingLevel(current: string): string {
    const idx = THINKING_LEVELS.indexOf(current);
    const next = idx >= 0 ? THINKING_LEVELS[(idx + 1) % THINKING_LEVELS.length] : THINKING_LEVELS[0];
    return next ?? '';
}

function formatThinkingLabel(level: string): string {
    const prefix = t('sessionInfo.thinkingLevel');
    const normalized = level.trim().toLowerCase();
    // Reuse a stable existing "Default" label. (Avoids introducing a new i18n key just for this chip.)
    if (!normalized) return `${prefix}: ${t('agentInput.permissionMode.default')}`;
    const title = normalized.length > 0 ? `${normalized[0].toUpperCase()}${normalized.slice(1)}` : normalized;
    return `${prefix}: ${title}`;
}

export function createPiThinkingLevelChip(opts: Readonly<{
    thinkingLevel: string;
    setThinkingLevel: (next: string) => void;
}>): AgentInputExtraActionChip {
    return {
        key: 'pi-thinking-level',
        render: ({ chipStyle, showLabel, iconColor, textStyle }) => (
            <Pressable
                onPress={() => {
                    hapticsLight();
                    opts.setThinkingLevel(nextThinkingLevel(opts.thinkingLevel));
                }}
                hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
                style={(p) => chipStyle(p.pressed)}
            >
                <Ionicons name="sparkles-outline" size={16} color={iconColor} />
                {showLabel ? <Text style={textStyle}>{formatThinkingLabel(opts.thinkingLevel)}</Text> : null}
            </Pressable>
        ),
    };
}
