import * as React from 'react';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useUnistyles } from 'react-native-unistyles';

import { AgentIcon } from '@/agents/registry/AgentIcon';
import { VoiceServiceMark } from '@/voice/settings/panels/VoiceServiceGallery';
import { Icon, type IconName } from '@/components/ui/icons/Icon';
import type { VoiceRoleReadiness } from '@/voice/registry/readiness';
import type { VoiceSettingsPipeline, VoiceSettingsPipelineStep } from '@/voice/settings/projectVoiceSettingsPipeline';

import { VoicePipelineCard, type VoicePipelineStep } from './VoicePipelineCard';
import { presentVoicePipeline } from './presentVoicePipeline';
import { translateVoiceReadiness } from '../panels/voiceProviderReadinessPresentation';
import { recoverVoiceSettingsReadiness } from '../voiceSettingsRecovery';

const MARK_PX = 17;

const ENGINE_GLYPHS: Readonly<Record<VoiceSettingsPipelineStep['engine']['kind'], IconName>> = {
    service: 'microphone',
    speech: 'speaker-high',
    agent: 'robot',
    session: 'chat-circle',
    message: 'text-aa',
};

function EngineMark(props: Readonly<{ engine: VoiceSettingsPipelineStep['engine']; hear: boolean }>) {
    const { theme } = useUnistyles();
    if (props.engine.kind === 'agent' && props.engine.agentId) {
        return <AgentIcon agentId={props.engine.agentId} size={MARK_PX} />;
    }
    // A service is drawn with the same identity mark as its tile in the gallery below.
    if (props.engine.kind === 'service' && props.engine.mark) return <VoiceServiceMark identity={props.engine.mark} size={MARK_PX} />;
    const glyph = props.engine.kind === 'speech' && props.hear ? 'microphone' : ENGINE_GLYPHS[props.engine.kind];
    return <Icon name={glyph} size={MARK_PX} color={theme.colors.text.primary} />;
}

/**
 * A mode's pipeline card from the canonical pipeline projection: each step's engine, where it runs,
 * and the one recovery its own readiness names. `purpose` finishes the status line ("Ready · …").
 */
export const VoicePipelineView = React.memo(function VoicePipelineView(props: Readonly<{
    title: string;
    purpose?: string;
    pipeline: VoiceSettingsPipeline;
    /** The service's own readiness when no single step owns it (Local voice), said once under the steps. */
    cardReadiness?: VoiceRoleReadiness | null;
    onRecoveryAction?: (action: VoiceRoleReadiness['recoveryAction']) => void;
    onPress?: () => void;
    layout?: 'auto' | 'rows';
    testID?: string;
    /** The pipeline's own rows (its setup check and result), drawn inside the card under the steps. */
    children?: React.ReactNode;
}>) {
    const { onRecoveryAction } = props;
    const router = useRouter();
    const navigate = React.useCallback((href: unknown) => router.push(href as Parameters<typeof router.push>[0]), [router]);
    const presentation = React.useMemo(
        () => presentVoicePipeline(props.pipeline, translateVoiceReadiness, props.cardReadiness ?? null, props.title),
        [props.cardReadiness, props.pipeline, props.title],
    );
    const steps = React.useMemo((): VoicePipelineStep[] => presentation.steps.map((step) => ({
        key: step.key,
        roleLabel: step.roleLabel,
        mark: <EngineMark engine={step.engine} hear={step.roles.length === 1 && step.roles[0] === 'hear'} />,
        name: step.name,
        where: step.where,
        whereIcon: step.whereIcon,
        readiness: step.readiness
            ? {
                tone: step.readiness.tone,
                message: step.readiness.message,
                progress: step.readiness.progress,
                action: step.readiness.recoveryAction && step.readiness.actionLabel
                    && (step.readiness.recoveryAction === 'retry' || step.readiness.selectedAgent?.runtimeTarget || onRecoveryAction)
                    ? {
                        label: step.readiness.actionLabel,
                        onPress: () => recoverVoiceSettingsReadiness(step.readiness!.recoveryAction!, onRecoveryAction,
                            { selectedAgent: step.readiness!.selectedAgent, navigate }),
                        testID: `${props.testID ?? 'settings.voice.pipeline'}.${step.key}.recover`,
                    }
                    : undefined,
            }
            : null,
    })), [navigate, onRecoveryAction, presentation.steps, props.testID]);
    const card = presentation.card;
    const serviceReadiness = React.useMemo(() => (card ? {
        tone: card.tone,
        message: card.message,
        progress: card.progress,
        action: card.recoveryAction && card.actionLabel && (card.recoveryAction === 'retry' || card.selectedAgent?.runtimeTarget || onRecoveryAction)
            ? {
                label: card.actionLabel,
                onPress: () => recoverVoiceSettingsReadiness(card.recoveryAction!, onRecoveryAction,
                    { selectedAgent: card.selectedAgent, navigate }),
                testID: `${props.testID ?? 'settings.voice.pipeline'}.recover`,
            }
            : undefined,
    } : null), [card, navigate, onRecoveryAction, props.testID]);
    const statusText = props.purpose ? `${presentation.statusWord} · ${props.purpose}` : presentation.statusWord;
    return (
        <VoicePipelineCard
            title={props.title}
            status={{ tone: presentation.tone, text: statusText }}
            steps={steps}
            serviceReadiness={serviceReadiness}
            onPress={props.onPress}
            layout={props.layout}
            testID={props.testID}
        >
            {props.children}
        </VoicePipelineCard>
    );
});
