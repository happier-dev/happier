import { describe, expect, it } from 'vitest';

import type { Metadata } from '../storageTypes';
import {
    computeAcpPlanModeControl,
    computeAcpSessionModePickerControl,
    supportsAcpAgentModeOverrides,
} from './sessionModeControl';

function createMetadata(overrides: Partial<Metadata> = {}): Metadata {
    return {
        path: '/tmp',
        host: 'h',
        ...overrides,
    } as Metadata;
}

describe('computeAcpPlanModeControl', () => {
    it('gates agent-mode overrides based on catalog', () => {
        expect(supportsAcpAgentModeOverrides('opencode')).toBe(true);
        expect(supportsAcpAgentModeOverrides('codex')).toBe(false);
    });

    it('returns null when ACP session modes are missing', () => {
        expect(computeAcpPlanModeControl(null)).toBeNull();
        expect(computeAcpPlanModeControl(createMetadata())).toBeNull();
    });

    it('returns planOn when current mode is plan', () => {
        const metadata = createMetadata({
            acpSessionModesV1: {
                v: 1,
                provider: 'opencode',
                updatedAt: 1,
                currentModeId: 'plan',
                availableModes: [{ id: 'plan', name: 'Plan' }, { id: 'build', name: 'Build' }],
            },
        });

        const res = computeAcpPlanModeControl(metadata);
        expect(res?.planOn).toBe(true);
        expect(res?.offModeId).toBe('build');
        expect(res?.isPending).toBe(false);
    });

    it('marks pending when override differs from current mode', () => {
        const metadata = createMetadata({
            acpSessionModesV1: {
                v: 1,
                provider: 'opencode',
                updatedAt: 1,
                currentModeId: 'build',
                availableModes: [{ id: 'plan', name: 'Plan' }, { id: 'build', name: 'Build' }],
            },
            acpSessionModeOverrideV1: {
                v: 1,
                updatedAt: 2,
                modeId: 'plan',
            },
        });

        const res = computeAcpPlanModeControl(metadata);
        expect(res?.planOn).toBe(true);
        expect(res?.isPending).toBe(true);
        expect(res?.currentModeName).toBe('Build');
        expect(res?.requestedModeName).toBe('Plan');
    });

    it('returns offModeId null when only plan mode exists', () => {
        const metadata = createMetadata({
            acpSessionModesV1: {
                v: 1,
                provider: 'opencode',
                updatedAt: 1,
                currentModeId: 'plan',
                availableModes: [{ id: 'plan', name: 'Plan' }],
            },
        });

        const res = computeAcpPlanModeControl(metadata);
        expect(res?.planOn).toBe(true);
        expect(res?.offModeId).toBeNull();
    });
});

describe('computeAcpSessionModePickerControl', () => {
    it('returns null for agents that do not support ACP agent-mode overrides', () => {
        const metadata = createMetadata({
            acpSessionModesV1: {
                v: 1,
                provider: 'codex',
                updatedAt: 1,
                currentModeId: 'untrusted',
                availableModes: [{ id: 'untrusted', name: 'Untrusted' }],
            },
        });

        expect(computeAcpSessionModePickerControl({ agentId: 'codex', metadata })).toBeNull();
    });

    it('returns available ACP agent modes and effective selection', () => {
        const metadata = createMetadata({
            acpSessionModesV1: {
                v: 1,
                provider: 'opencode',
                updatedAt: 1,
                currentModeId: 'build',
                availableModes: [
                    { id: 'build', name: 'Build', description: 'Do the work' },
                    { id: 'plan', name: 'Plan', description: 'Think first' },
                ],
            },
        });

        const res = computeAcpSessionModePickerControl({ agentId: 'opencode', metadata });
        expect(res).not.toBeNull();
        expect(res?.currentModeId).toBe('build');
        expect(res?.effectiveModeId).toBe('build');
        expect(res?.options.map((option) => option.id)).toEqual(['build', 'plan']);
    });

    it('marks pending when requested override differs from current', () => {
        const metadata = createMetadata({
            acpSessionModesV1: {
                v: 1,
                provider: 'opencode',
                updatedAt: 1,
                currentModeId: 'build',
                availableModes: [{ id: 'build', name: 'Build' }, { id: 'plan', name: 'Plan' }],
            },
            acpSessionModeOverrideV1: { v: 1, updatedAt: 2, modeId: 'plan' },
        });

        const res = computeAcpSessionModePickerControl({ agentId: 'opencode', metadata });
        expect(res?.effectiveModeId).toBe('plan');
        expect(res?.isPending).toBe(true);
        expect(res?.requestedModeId).toBe('plan');
    });

    it('keeps pending false when override modeId is missing/invalid', () => {
        const metadata = createMetadata({
            acpSessionModesV1: {
                v: 1,
                provider: 'opencode',
                updatedAt: 1,
                currentModeId: 'build',
                availableModes: [{ id: 'build', name: 'Build' }, { id: 'plan', name: 'Plan' }],
            },
            acpSessionModeOverrideV1: { v: 1, updatedAt: 2, modeId: '   ' } as unknown as Metadata['acpSessionModeOverrideV1'],
        });

        const res = computeAcpSessionModePickerControl({ agentId: 'opencode', metadata });
        expect(res?.effectiveModeId).toBe('build');
        expect(res?.requestedModeId).toBeNull();
        expect(res?.isPending).toBe(false);
    });

    it('falls back to requested mode id text when requested mode is not in available modes', () => {
        const metadata = createMetadata({
            acpSessionModesV1: {
                v: 1,
                provider: 'opencode',
                updatedAt: 1,
                currentModeId: 'build',
                availableModes: [{ id: 'build', name: 'Build' }],
            },
            acpSessionModeOverrideV1: { v: 1, updatedAt: 2, modeId: 'unknown-mode' },
        });

        const res = computeAcpSessionModePickerControl({ agentId: 'opencode', metadata });
        expect(res?.requestedModeId).toBe('unknown-mode');
        expect(res?.requestedModeName).toBe('unknown-mode');
        expect(res?.effectiveModeName).toBe('unknown-mode');
        expect(res?.isPending).toBe(true);
    });
});
