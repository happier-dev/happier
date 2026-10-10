import type { LocalNeuralExecution } from '@happier-dev/protocol';
import type { VoiceServiceMark } from '@happier-dev/plugin-sdk/voice';

import { isBundledAgentId } from '@/agents/catalog/catalog';
import { resolveAgentCatalogTitle } from '@/agents/backendCatalog/agentCatalogProjection';
import { t } from '@/text';
import type { VoiceSettings } from '@/sync/domains/settings/voiceSettings';
import { parseLocalVoiceSttSettings, parseLocalVoiceTtsSettings, resolveLocalVoiceAdapterSettings } from '@/voice/local/localVoiceSettings';
import { createDefaultVoiceProviderRegistry } from '@/voice/registry/defaultRegistry';
import type { VoiceProviderRegistry } from '@/voice/registry/providerRegistry';
import { projectVoiceProviderRequirements, type VoiceRoleReadiness } from '@/voice/registry/readiness';
import { resolveLocalNeuralExecutionPolicy } from '@/voice/runtime/daemonInference/daemonVoiceInferencePolicy';
import { getLocalSttProviderSpec } from '@/voice/settings/panels/localStt/providers/registry';
import { getLocalTtsProviderSpec } from '@/voice/settings/panels/localTts/providers/registry';
import {
    projectVoiceSettingsPipeline,
    type VoiceSettingsPipeline,
    type VoiceSettingsPipelineStep,
} from '@/voice/settings/projectVoiceSettingsPipeline';
import { resolveVoiceProviderId } from '@/voice/settings/resolveVoiceProviderId';
import type { LocalVoiceSpeechReadiness } from '@/voice/settings/projectLocalConversationReadinessFacts';

const defaultRegistry = createDefaultVoiceProviderRegistry();

type Placement = VoiceSettingsPipelineStep['placement'];

export type VoicePipelineMachine = Readonly<{ machineId: string | null; machineLabel: string | null }>;

function onMachine(machine: VoicePipelineMachine): Placement {
    return {
        kind: 'machine',
        ...(machine.machineId ? { machineId: machine.machineId } : {}),
        ...(machine.machineLabel ? { machineName: machine.machineLabel } : {}),
    };
}

/**
 * Where a speech engine runs, from its own declaration: the device's speech is this device; a
 * Happier speech model follows its execution policy; an engine whose contribution requires the
 * Voice computer runs there; anything else is called from this device.
 */
function speechPlacement(
    registry: VoiceProviderRegistry,
    providerId: string,
    localNeuralExecution: LocalNeuralExecution | null,
    machine: VoicePipelineMachine,
): Placement {
    if (providerId === 'local_neural') {
        return resolveLocalNeuralExecutionPolicy({ requestedExecution: localNeuralExecution }).preferredExecution === 'daemon'
            ? onMachine(machine)
            : { kind: 'this_device' };
    }
    const entry = registry.get(providerId);
    if (entry && projectVoiceProviderRequirements(entry, null)?.includes('execution_machine')) return onMachine(machine);
    return { kind: 'this_device' };
}

function agentTitle(agentId: string): string {
    return isBundledAgentId(agentId) ? resolveAgentCatalogTitle(agentId) : agentId;
}

/**
 * Local voice's Hear → Think → Speak steps from the selected adapter. The
 * caller supplies any established speech-role readiness from its existing owner.
 */
export function buildLocalVoiceConversationSteps(
    voice: VoiceSettings,
    machine: VoicePipelineMachine,
    registry: VoiceProviderRegistry = defaultRegistry,
    speechReadiness?: LocalVoiceSpeechReadiness | null,
): VoiceSettingsPipelineStep[] {
    const { config: cfg } = resolveLocalVoiceAdapterSettings({ voice });
    const stt = parseLocalVoiceSttSettings(cfg.stt);
    const tts = parseLocalVoiceTtsSettings(cfg.tts);
    const sttSpec = getLocalSttProviderSpec(stt.provider);
    const ttsSpec = getLocalTtsProviderSpec(tts.provider);
    const think: VoiceSettingsPipelineStep = cfg.conversationMode === 'agent'
        ? {
            roles: ['think'],
            engine: cfg.agent.agentSource === 'agent'
                ? { kind: 'agent', agentId: cfg.agent.agentId, title: agentTitle(cfg.agent.agentId) }
                : { kind: 'agent', title: t('settingsVoice.pages.pipeline.voiceAgentFollowsSession') },
            placement: onMachine(machine),
            readiness: null,
        }
        : {
            roles: ['think'],
            engine: { kind: 'session', title: t('settingsVoice.pages.pipeline.theSessionYoureIn') },
            placement: { kind: 'session' },
            readiness: null,
        };
    return [
        {
            roles: ['hear'],
            engine: { kind: 'speech', providerId: stt.provider, title: sttSpec?.title ?? stt.provider },
            placement: speechPlacement(registry, stt.provider, stt.localNeural?.execution ?? null, machine),
            readiness: speechReadiness?.hear ?? null,
        },
        think,
        {
            roles: ['speak'],
            engine: { kind: 'speech', providerId: tts.provider, title: ttsSpec?.title ?? tts.provider },
            placement: speechPlacement(registry, tts.provider, tts.localNeural?.execution ?? null, machine),
            readiness: speechReadiness?.speak ?? null,
        },
    ];
}

/** A service that hears, thinks and speaks itself is one step; its readiness is exactly that service's. */
export function buildRealtimeServiceStep(input: Readonly<{
    providerId: string;
    title: string;
    mark?: VoiceServiceMark;
    requiresMachine: boolean;
    machine: VoicePipelineMachine;
    readiness: VoiceRoleReadiness | null;
}>): VoiceSettingsPipelineStep {
    return {
        roles: ['hear', 'think', 'speak'],
        engine: { kind: 'service', providerId: input.providerId, title: input.title, ...(input.mark ? { mark: input.mark } : {}) },
        placement: input.requiresMachine ? onMachine(input.machine) : { kind: 'cloud' },
        readiness: input.readiness,
    };
}

/**
 * Voice conversations' pipeline for the selected service, or null when conversations are off.
 * Local voice keeps the provider readiness at card level (`cardReadiness`); a realtime service's
 * single step carries it.
 */
export function buildVoiceConversationsPipeline(input: Readonly<{
    voice: VoiceSettings;
    serviceTitle: string | null;
    readiness: VoiceRoleReadiness | null;
    machine: VoicePipelineMachine;
    registry?: VoiceProviderRegistry;
    localSpeechReadiness?: LocalVoiceSpeechReadiness | null;
}>): Readonly<{ pipeline: VoiceSettingsPipeline; cardReadiness: VoiceRoleReadiness | null }> | null {
    const registry = input.registry ?? defaultRegistry;
    const providerId = resolveVoiceProviderId(input.voice.providerId);
    if (!providerId) return null;
    if (providerId === 'local_conversation' || providerId === 'local_direct') {
        const steps = buildLocalVoiceConversationSteps(input.voice, input.machine, registry, input.localSpeechReadiness);
        const ready = input.readiness?.status === 'ready';
        return {
            pipeline: projectVoiceSettingsPipeline({
                mode: 'conversations',
                providerId,
                steps: ready ? steps.map((step) => ({
                    ...step,
                    readiness: input.localSpeechReadiness !== undefined && step.roles.some((role) => role === 'hear' || role === 'speak')
                        ? step.readiness
                        : step.readiness ?? input.readiness,
                })) : steps,
            }),
            cardReadiness: ready ? null : input.readiness,
        };
    }
    const entry = registry.get(providerId);
    const requiresMachine = entry
        ? projectVoiceProviderRequirements(entry, null)?.includes('execution_machine') === true
        : false;
    return {
        pipeline: projectVoiceSettingsPipeline({
            mode: 'conversations',
            providerId,
            steps: [buildRealtimeServiceStep({
                providerId,
                title: input.serviceTitle ?? providerId,
                mark: entry?.mark,
                requiresMachine,
                machine: input.machine,
                readiness: input.readiness,
            })],
        }),
        cardReadiness: null,
    };
}

/** Dictation's Hear → Write pipeline: the recognizer's exact readiness, then your message. */
export function buildVoiceDictationPipeline(input: Readonly<{
    sttProviderId: string;
    sttTitle: string;
    localNeuralExecution: LocalNeuralExecution | null;
    readiness: VoiceRoleReadiness | null;
    machine: VoicePipelineMachine;
    /** Dictation's own language ("I dictate in"), null for automatic; omitted where the page sets it itself. */
    language?: string | null;
    registry?: VoiceProviderRegistry;
}>): VoiceSettingsPipeline {
    const registry = input.registry ?? defaultRegistry;
    return projectVoiceSettingsPipeline({
        mode: 'dictation',
        providerId: input.sttProviderId,
        steps: [
            {
                roles: ['hear'],
                engine: { kind: 'speech', providerId: input.sttProviderId, title: input.sttTitle },
                placement: speechPlacement(registry, input.sttProviderId, input.localNeuralExecution, input.machine),
                readiness: input.readiness,
            },
            {
                roles: ['write'],
                engine: { kind: 'message', title: t('settingsVoice.pages.pipeline.intoYourMessageTitle') },
                placement: { kind: 'message', language: input.language },
                readiness: null,
            },
        ],
    });
}
