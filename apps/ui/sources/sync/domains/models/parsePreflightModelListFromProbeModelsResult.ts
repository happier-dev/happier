import type { AcpConfigOption } from '@/sync/domains/sessionControl/configOptionsControl';
import type { PreflightModelList } from '@/sync/domains/models/modelOptions';
import { ProviderModelDescriptorV1Schema } from '@happier-dev/protocol';

export function parsePreflightModelListFromProbeModelsResult(raw: unknown): PreflightModelList | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const rec = raw as Record<string, unknown>;
    const modelsRaw = rec.availableModels;
    const supportsFreeformRaw = rec.supportsFreeform;
    const sourceRaw = typeof rec.source === 'string' ? rec.source : null;
    if (!Array.isArray(modelsRaw)) return null;

    const parsed: PreflightModelList = {
        availableModels: modelsRaw
            .filter((m): m is Record<string, unknown> => Boolean(m) && typeof m === 'object' && typeof m.id === 'string' && typeof m.name === 'string')
            .flatMap((m) => {
                const descriptor = ProviderModelDescriptorV1Schema.safeParse({ id: m.id, name: m.name, capabilities: m.capabilities });
                if (!descriptor.success) return [];
                return [{
                id: String(m.id),
                name: String(m.name),
                ...(typeof m.description === 'string' ? { description: m.description } : {}),
                ...(typeof m.extendedContextModelId === 'string' && m.extendedContextModelId.trim().length > 0
                    ? { extendedContextModelId: m.extendedContextModelId.trim() }
                    : {}),
                ...(Array.isArray(m.modelOptions) && m.modelOptions.length > 0
                    ? { modelOptions: m.modelOptions as readonly AcpConfigOption[] }
                    : {}),
                ...(descriptor.data.capabilities ? { capabilities: descriptor.data.capabilities } : {}),
                }];
            }),
        supportsFreeform: Boolean(supportsFreeformRaw),
        ...(sourceRaw === 'unavailable' ? { unavailable: true } : {}),
    };

    if (
        modelsRaw.length > 0
        && parsed.availableModels.length === 0
        && parsed.supportsFreeform !== true
        && parsed.unavailable !== true
    ) {
        return null;
    }
    return parsed;
}
