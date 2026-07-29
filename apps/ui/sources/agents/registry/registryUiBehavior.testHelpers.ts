import { settingsDefaults } from '@/sync/domains/settings/settings';
import type { CapabilityDetectResult, CapabilityId } from '@/sync/api/capabilities/capabilitiesProtocol';

export function makeSettings(
    overrides: Readonly<Record<string, unknown>> = {},
): typeof settingsDefaults & Readonly<Record<string, unknown>> {
    return { ...settingsDefaults, ...overrides };
}

export type CapabilityResults = Partial<Record<CapabilityId, CapabilityDetectResult>>;

export function okCapability(data: unknown, checkedAt = 1): CapabilityDetectResult {
    return { ok: true, checkedAt, data };
}

export function makeResults(overrides: CapabilityResults): CapabilityResults {
    return { ...overrides };
}
