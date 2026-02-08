import { settingsDefaults } from '@/sync/settings';
import type { CapabilityDetectResult, CapabilityId } from '@/sync/capabilitiesProtocol';

export function makeSettings(overrides: Partial<typeof settingsDefaults> = {}) {
    return { ...settingsDefaults, ...overrides };
}

export type CapabilityResults = Partial<Record<CapabilityId, CapabilityDetectResult>>;

export function okCapability(data: unknown, checkedAt = 1): CapabilityDetectResult {
    return { ok: true, checkedAt, data };
}

export function makeResults(overrides: CapabilityResults): CapabilityResults {
    return { ...overrides };
}
