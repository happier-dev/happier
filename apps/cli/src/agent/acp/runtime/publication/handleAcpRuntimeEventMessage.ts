import { normalizeAvailableCommands, publishSlashCommandsToMetadata } from '@/agent/acp/commands/publishSlashCommands';
import type { AcpRuntimeSessionClient } from '@/agent/acp/sessionClient';
import type { AgentMessage } from '@/agent';
import { updateMetadataBestEffort } from '@/api/session/sessionWritesBestEffort';
import type { SendAgentSessionMediaCommittedRequest } from '@/api/session/client/transcript/sessionMediaBridge';

type EventAgentMessage = Extract<AgentMessage, { type: 'event' }>;

function asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
}

function isSessionMediaCommittedRequest(value: unknown): value is SendAgentSessionMediaCommittedRequest {
    const record = asRecord(value);
    if (!record) return false;
    return typeof record.localId === 'string'
        && (record.role === 'input' || record.role === 'output')
        && (record.category === 'attachment' || record.category === 'generated' || record.category === 'tool-artifact')
        && Array.isArray(record.media);
}

type NormalizedConfigOptionValue = string | number | boolean | null;

type NormalizedConfigOption = {
    id: string;
    name: string;
    description?: string;
    type: string;
    currentValue: NormalizedConfigOptionValue;
    options?: Array<{
        value: NormalizedConfigOptionValue;
        name: string;
        description?: string;
    }>;
};

function normalizeConfigOptionsArray(raw: unknown): NormalizedConfigOption[] {
    if (!Array.isArray(raw)) return [];

    const out: NormalizedConfigOption[] = [];
    for (const entry of raw) {
        const o = asRecord(entry);
        const id = typeof o?.id === 'string' ? String(o.id).trim() : '';
        const name = typeof o?.name === 'string' ? String(o.name).trim() : '';
        const type = typeof o?.type === 'string' ? String(o.type).trim() : '';
        if (!id || !name || !type) continue;

        const description = typeof o?.description === 'string' ? String(o.description).trim() : '';
        const currentValueRaw = o?.currentValue;
        const currentValue =
            typeof currentValueRaw === 'string' ? currentValueRaw
            : typeof currentValueRaw === 'number' && Number.isFinite(currentValueRaw) ? currentValueRaw
            : typeof currentValueRaw === 'boolean' ? currentValueRaw
            : null;

        const optionsRaw = o?.options;
        const options = Array.isArray(optionsRaw)
            ? (optionsRaw as unknown[])
                .map((choice) => {
                    const c = asRecord(choice);
                    if (!c) return null;
                    const valueRaw = c.value;
                    const value =
                        typeof valueRaw === 'string' ? valueRaw
                        : typeof valueRaw === 'number' && Number.isFinite(valueRaw) ? valueRaw
                        : typeof valueRaw === 'boolean' ? valueRaw
                        : null;
                    const choiceName = typeof c.name === 'string' ? String(c.name).trim() : '';
                    if (!choiceName) return null;
                    const choiceDescription = typeof c.description === 'string' ? String(c.description).trim() : '';
                    return {
                        value,
                        name: choiceName,
                        ...(choiceDescription ? { description: choiceDescription } : {}),
                    };
                })
                .filter((v): v is NonNullable<typeof v> => v !== null)
            : [];

        out.push({
            id,
            name,
            type,
            currentValue,
            ...(description ? { description } : {}),
            ...(options.length > 0 ? { options } : {}),
        });
    }

    return out;
}

export function handleAcpRuntimeEventMessage(params: Readonly<{
    provider: string;
    session: AcpRuntimeSessionClient;
    streamedTranscriptWriter: Readonly<{
        appendThinkingDelta: (text: string) => void;
    }>;
    msg: EventAgentMessage;
}>): void {
    const name = params.msg.name;

    if (name === 'session_media') {
        if (!isSessionMediaCommittedRequest(params.msg.payload)) return;
        void params.session.sendAgentSessionMediaCommitted?.(
            params.provider,
            params.msg.payload,
        );
        return;
    }

    if (name === 'available_commands_update') {
        const payload = params.msg.payload;
        const payloadRecord = asRecord(payload);
        const details = normalizeAvailableCommands(payloadRecord?.availableCommands ?? payload);
        publishSlashCommandsToMetadata({ session: params.session, details });
    }

    if (name === 'session_modes_state') {
        const payloadRecord = asRecord(params.msg.payload);
        const currentModeIdRaw = payloadRecord?.currentModeId;
        const currentModeId = typeof currentModeIdRaw === 'string' ? currentModeIdRaw : '';
        const availableModesRaw = payloadRecord?.availableModes;
        const availableModes = Array.isArray(availableModesRaw)
            ? availableModesRaw
                .filter((m: any) => m && typeof m.id === 'string' && typeof m.name === 'string')
                .map((m: any) => ({
                    id: String(m.id),
                    name: String(m.name),
                    ...(typeof m.description === 'string' ? { description: String(m.description) } : {}),
                }))
            : [];
        if (currentModeId && availableModes.length > 0) {
            updateMetadataBestEffort(
                params.session,
                (metadata) => {
                    const sessionModes = {
                        v: 1 as const,
                        provider: params.provider,
                        updatedAt: Date.now(),
                        currentModeId,
                        availableModes,
                    };
                    return {
                        ...metadata,
                        sessionModesV1: sessionModes,
                        acpSessionModesV1: sessionModes,
                    };
                },
                `[${params.provider}]`,
                'session_modes_state',
            );
        }
    }

    if (name === 'session_models_state') {
        const payloadRecord = asRecord(params.msg.payload);
        const currentModelIdRaw = payloadRecord?.currentModelId;
        const currentModelId = typeof currentModelIdRaw === 'string' ? currentModelIdRaw : '';
        const availableModelsRaw = payloadRecord?.availableModels;
        const availableModels = Array.isArray(availableModelsRaw)
            ? availableModelsRaw
                .filter((m: any) => m && (typeof m.id === 'string' || typeof m.modelId === 'string') && typeof m.name === 'string')
                .map((m: any) => {
                    const modelOptions = normalizeConfigOptionsArray(m?.modelOptions ?? m?.model_options);
                    return {
                        id: String(m.id ?? m.modelId),
                        name: String(m.name),
                        ...(typeof m.description === 'string' ? { description: String(m.description) } : {}),
                        ...(modelOptions.length > 0 ? { modelOptions } : {}),
                    };
                })
            : [];
        if (currentModelId && availableModels.length > 0) {
            updateMetadataBestEffort(
                params.session,
                (metadata) => ({
                    ...metadata,
                    acpSessionModelsV1: {
                        v: 1,
                        provider: params.provider,
                        updatedAt: Date.now(),
                        currentModelId,
                        availableModels,
                    },
                }),
                `[${params.provider}]`,
                'session_models_state',
            );
        }
    }

    if (name === 'config_options_state' || name === 'config_options_update') {
        const payloadRecord = asRecord(params.msg.payload);
        const configOptions = normalizeConfigOptionsArray(payloadRecord?.configOptions);
        const derivedModels = (() => {
            const findModelOpt = (o: any) => {
                const id = typeof o?.id === 'string' ? o.id.trim().toLowerCase() : '';
                const name = typeof o?.name === 'string' ? o.name.trim().toLowerCase() : '';
                return id === 'model' || name === 'model';
            };
            const modelOpt = configOptions.find(findModelOpt) as any;
            if (!modelOpt || !Array.isArray(modelOpt.options) || modelOpt.options.length === 0) return null;

            const currentValue = modelOpt.currentValue;
            const currentModelId =
                typeof currentValue === 'string'
                    ? currentValue
                    : (typeof currentValue === 'number' && Number.isFinite(currentValue) ? String(currentValue) : (typeof currentValue === 'boolean' ? (currentValue ? 'true' : 'false') : ''));
            if (!currentModelId) return null;

            const availableModels = modelOpt.options
                .filter((opt: any) => opt && opt.value !== undefined && typeof opt.name === 'string')
                .map((opt: any) => ({
                    id: String(opt.value),
                    name: String(opt.name),
                    ...(typeof opt.description === 'string' ? { description: String(opt.description) } : {}),
                }))
                .filter((m: any) => m.id && m.name);
            if (availableModels.length === 0) return null;

            return { currentModelId, availableModels };
        })();

        updateMetadataBestEffort(
            params.session,
            (metadata) => {
                const now = Date.now();
                const next: any = {
                    ...metadata,
                    acpConfigOptionsV1: {
                        v: 1,
                        provider: params.provider,
                        updatedAt: now,
                        configOptions,
                    },
                };

                if (derivedModels) {
                    next.acpSessionModelsV1 = {
                        v: 1,
                        provider: params.provider,
                        updatedAt: now,
                        currentModelId: derivedModels.currentModelId,
                        availableModels: derivedModels.availableModels,
                    };
                }

                return next as any;
            },
            `[${params.provider}]`,
            'config_options_state',
        );
    }

    if (name === 'current_mode_update') {
        const payloadRecord = asRecord(params.msg.payload);
        const currentModeIdRaw = payloadRecord?.currentModeId;
        const currentModeId = typeof currentModeIdRaw === 'string' ? currentModeIdRaw : '';
        if (currentModeId) {
            updateMetadataBestEffort(
                params.session,
                (metadata) => {
                    const prev = (metadata as any).sessionModesV1 ?? (metadata as any).acpSessionModesV1;
                    const availableModes = Array.isArray(prev?.availableModes) ? prev.availableModes : [];
                    const sessionModes = {
                        v: 1 as const,
                        provider: params.provider,
                        updatedAt: Date.now(),
                        currentModeId,
                        availableModes,
                    };
                    return {
                        ...metadata,
                        sessionModesV1: sessionModes,
                        acpSessionModesV1: sessionModes,
                    };
                },
                `[${params.provider}]`,
                'current_mode_update',
            );
        }
    }

    if (name === 'current_model_update') {
        const payloadRecord = asRecord(params.msg.payload);
        const currentModelIdRaw = payloadRecord?.currentModelId;
        const currentModelId = typeof currentModelIdRaw === 'string' ? currentModelIdRaw : '';
        if (currentModelId) {
            updateMetadataBestEffort(
                params.session,
                (metadata) => {
                    const prev = (metadata as any).acpSessionModelsV1 as any;
                    const availableModels = Array.isArray(prev?.availableModels) ? prev.availableModels : [];
                    return {
                        ...metadata,
                        acpSessionModelsV1: {
                            v: 1,
                            provider: params.provider,
                            updatedAt: Date.now(),
                            currentModelId,
                            availableModels,
                        },
                    };
                },
                `[${params.provider}]`,
                'current_model_update',
            );
        }
    }

    if (name === 'thinking') {
        const payloadRecord = asRecord(params.msg.payload);
        const textRaw = payloadRecord?.text;
        const text = typeof textRaw === 'string' ? textRaw : '';
        if (text) {
            params.streamedTranscriptWriter.appendThinkingDelta(text);
        }
    }
}
