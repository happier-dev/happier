import type {
    PluginApiScmBackendRegistration,
} from './types';

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function isPluginApiScmBackendRegistration(
    value: unknown,
): value is PluginApiScmBackendRegistration {
    if (!isRecord(value) || typeof value.id !== 'string' || value.id.trim().length === 0) {
        return false;
    }
    if (!isRecord(value.handlers)) {
        return false;
    }
    const detection = value.handlers.detection;
    if (detection !== undefined && !isRecord(detection)) {
        return false;
    }
    if (isRecord(detection) && detection.detectRepo !== undefined && typeof detection.detectRepo !== 'function') {
        return false;
    }
    const read = value.handlers.read;
    if (read !== undefined && !isRecord(read)) {
        return false;
    }
    if (isRecord(read) && read.statusSnapshot !== undefined && typeof read.statusSnapshot !== 'function') {
        return false;
    }
    if (isRecord(read) && read.diffFile !== undefined && typeof read.diffFile !== 'function') {
        return false;
    }
    return true;
}
