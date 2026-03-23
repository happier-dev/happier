import { Ionicons } from '@expo/vector-icons';
import { providers } from '@happier-dev/agents';
import * as React from 'react';
import { Pressable, View } from 'react-native';

import { hapticsLight } from '@/components/ui/theme/haptics';
import type {
    AgentInputExtraActionChip,
    AgentInputExtraActionChipRenderContext,
} from '@/components/sessions/agentInput';
import { AgentInputSimpleOptionsPopover } from '@/components/sessions/agentInput/components/AgentInputSimpleOptionsPopover';
import { DEFAULT_OPTION_CHIP_CYCLE_MAX_OPTIONS, resolveChipOptionInteraction } from '@/components/sessions/agentInput/chipOptionInteraction';
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

function formatThinkingOptionLabel(level: string): string {
    const normalized = level.trim().toLowerCase();
    if (!normalized) return t('common.default');
    return normalized.length > 0 ? `${normalized[0].toUpperCase()}${normalized.slice(1)}` : normalized;
}

export function createPiThinkingLevelChip(opts: Readonly<{
    thinkingLevel: string;
    setThinkingLevel: (next: string) => void;
}>): AgentInputExtraActionChip {
    const interaction = resolveChipOptionInteraction({
        currentOptionId: opts.thinkingLevel,
        selectableOptionIds: THINKING_LEVELS,
        cycleMaxOptions: DEFAULT_OPTION_CHIP_CYCLE_MAX_OPTIONS,
    });
    const options = interaction.kind === 'picker'
        ? interaction.selectableOptionIds.map((id) => ({
            id,
            label: formatThinkingOptionLabel(id),
        }))
        : [];

    return {
        key: 'pi-thinking-level',
        controlId: 'providerOption',
        collapsedOptionsPopover: options.length > 0 ? {
            title: t('sessionInfo.thinkingLevel'),
            label: formatThinkingLabel(opts.thinkingLevel),
            icon: (tint) => <Ionicons name="sparkles-outline" size={16} color={tint} />,
            options,
            selectedOptionId: opts.thinkingLevel,
            onSelect: (selectedId) => {
                opts.setThinkingLevel(selectedId);
            },
            maxHeightCap: 360,
        } : undefined,
        render: (ctx) => <PiThinkingLevelChipButton opts={opts} ctx={ctx} />,
    };
}

function PiThinkingLevelChipButton(props: Readonly<{
    opts: {
        thinkingLevel: string;
        setThinkingLevel: (next: string) => void;
    };
    ctx: AgentInputExtraActionChipRenderContext;
}>) {
    const [open, setOpen] = React.useState(false);
    const anchorRef = React.useRef<React.ElementRef<typeof View> | null>(null);

    const interaction = React.useMemo(() => resolveChipOptionInteraction({
        currentOptionId: props.opts.thinkingLevel,
        selectableOptionIds: THINKING_LEVELS,
        cycleMaxOptions: DEFAULT_OPTION_CHIP_CYCLE_MAX_OPTIONS,
    }), [props.opts.thinkingLevel]);

    const options = React.useMemo(() => interaction.kind === 'picker'
        ? interaction.selectableOptionIds.map((id) => ({
            id,
            label: formatThinkingOptionLabel(id),
        }))
        : [], [interaction]);

    return (
        <>
            <View ref={anchorRef} collapsable={false} style={{ alignSelf: 'flex-start' }}>
                <Pressable
                    onPress={() => {
                        hapticsLight();
                        if (interaction.kind === 'cycle') {
                            props.opts.setThinkingLevel(interaction.nextOptionId);
                            return;
                        }
                        if (interaction.kind === 'picker') {
                            setOpen((current) => !current);
                            return;
                        }
                        props.opts.setThinkingLevel(nextThinkingLevel(props.opts.thinkingLevel));
                    }}
                    hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
                    style={(p) => props.ctx.chipStyle(p.pressed)}
                >
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                        <Ionicons name="sparkles-outline" size={16} color={props.ctx.iconColor} />
                        {props.ctx.showLabel ? (
                            <Text style={props.ctx.textStyle}>{formatThinkingLabel(props.opts.thinkingLevel)}</Text>
                        ) : null}
                    </View>
                </Pressable>
            </View>

            {interaction.kind === 'picker' ? (
                <AgentInputSimpleOptionsPopover
                    open={open}
                    anchorRef={anchorRef}
                    title={t('sessionInfo.thinkingLevel')}
                    options={options}
                    selectedOptionId={props.opts.thinkingLevel}
                    onSelect={(selectedId) => {
                        props.opts.setThinkingLevel(selectedId);
                        setOpen(false);
                    }}
                    onRequestClose={() => setOpen(false)}
                    maxHeightCap={360}
                />
            ) : null}
        </>
    );
}
