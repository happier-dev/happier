import { readExtendedContextModelId } from './modelOptions';
import type { SessionConfigOption } from '@/sync/domains/sessionControl/configOptionsControl';
import type { PreflightModelList } from '@/sync/domains/models/modelOptions';

export function parsePreflightModelListFromProbeModelsResult(raw: unknown): PreflightModelList | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const rec = raw as Record<string, unknown>;
    const modelsRaw = (rec as any).availableModels;
    const supportsFreeformRaw = (rec as any).supportsFreeform;
    if (!Array.isArray(modelsRaw)) return null;

    const parsed: PreflightModelList = {
        availableModels: modelsRaw
            .filter((m: any) => m && typeof m.id === 'string' && typeof m.name === 'string')
            .map((m: any) => ({
                id: String(m.id),
                name: String(m.name),
                ...(typeof m.description === 'string' ? { description: m.description } : {}),
                ...(readExtendedContextModelId(m.extendedContextModelId)
                    ? { extendedContextModelId: readExtendedContextModelId(m.extendedContextModelId) }
                    : {}),
                ...(typeof m.contextWindowTokens === 'number' && Number.isFinite(m.contextWindowTokens) && m.contextWindowTokens > 0
                    ? { contextWindowTokens: Math.trunc(m.contextWindowTokens) }
                    : {}),
                ...(Array.isArray(m.modelOptions) && m.modelOptions.length > 0
                    ? { modelOptions: m.modelOptions as readonly SessionConfigOption[] }
                    : {}),
            })),
        supportsFreeform: Boolean(supportsFreeformRaw),
    };

    if (parsed.availableModels.length === 0 && parsed.supportsFreeform !== true) return null;
    return parsed;
}
