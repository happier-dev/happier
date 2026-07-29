import { describe, expect, it } from 'vitest';

import { resolveLocalServiceActionEligibility } from './policy';
import type { NormalizedLocalServiceInventoryEntry } from '../inventory/scanner';
import type { ManagedLocalServiceRuntimeState } from '../managed/registry';

function entry(overrides: Partial<NormalizedLocalServiceInventoryEntry> = {}): NormalizedLocalServiceInventoryEntry {
    return {
        id: 'entry-a',
        machineId: 'machine-a',
        address: { kind: 'loopback', host: '127.0.0.1', family: 'ipv4' },
        port: 5173,
        protocol: 'tcp',
        detectedAt: 1_000,
        lastSeenAt: 2_000,
        state: 'listening',
        source: 'detected',
        labels: [],
        confidence: 'high',
        processOwnershipConfidence: 'high',
        workspaceAssociationConfidence: 'high',
        diagnostics: [],
        classification: { kind: 'vite', displayName: 'Vite', confidence: 'high', lowSignal: false, signals: ['vite'] },
        provenance: {
            process: {
                pid: 400,
                ppid: 300,
                lineagePids: [400, 300],
                command: 'npm run dev',
                cwd: '/repo/web',
                redacted: true,
            },
            workspace: {
                path: '/repo',
                association: 'cwd_containment',
            },
        },
        ...overrides,
    };
}

function managedService(overrides: Partial<ManagedLocalServiceRuntimeState> = {}): ManagedLocalServiceRuntimeState {
    return {
        id: 'plugin-a:web',
        owner: { kind: 'plugin', pluginId: 'plugin-a' },
        phase: 'running',
        launchMode: 'detectAfterLaunch',
        minimumConfidence: 'medium',
        process: { pid: 300, startedAt: 1_000 },
        routeName: 'plugin-a-web',
        diagnostics: [],
        ...overrides,
    };
}

describe('resolveLocalServiceActionEligibility', () => {
    it('allows safe actions without enabling dangerous terminate policy', () => {
        expect(resolveLocalServiceActionEligibility({
            action: 'copy_url',
            target: { kind: 'inventory_entry', entry: entry() },
            terminateEnabled: false,
        })).toMatchObject({
            kind: 'copy_url',
            enabled: true,
            auditRequired: false,
        });
    });

    it('denies detected termination for stale, low-signal, or unowned entries', () => {
        expect(resolveLocalServiceActionEligibility({
            action: 'terminate_detected',
            target: { kind: 'inventory_entry', entry: entry({ state: 'stale' }) },
            terminateEnabled: true,
        })).toMatchObject({ enabled: false, reasonCode: 'service_not_listening' });

        expect(resolveLocalServiceActionEligibility({
            action: 'terminate_detected',
            target: {
                kind: 'inventory_entry',
                entry: entry({
                    classification: { kind: 'chromium_helper', displayName: 'Chrome Helper', confidence: 'high', lowSignal: true, signals: ['chromium-helper'] },
                }),
            },
            terminateEnabled: true,
        })).toMatchObject({ enabled: false, reasonCode: 'low_signal_process' });

        expect(resolveLocalServiceActionEligibility({
            action: 'terminate_detected',
            target: { kind: 'inventory_entry', entry: entry({ processOwnershipConfidence: 'low', workspaceAssociationConfidence: 'low' }) },
            terminateEnabled: true,
        })).toMatchObject({ enabled: false, reasonCode: 'ownership_not_established' });
    });

    it('allows detected termination only with explicit terminate policy and current owned process facts', () => {
        expect(resolveLocalServiceActionEligibility({
            action: 'terminate_detected',
            target: { kind: 'inventory_entry', entry: entry() },
            terminateEnabled: false,
        })).toMatchObject({ enabled: false, reasonCode: 'terminate_feature_disabled' });

        expect(resolveLocalServiceActionEligibility({
            action: 'terminate_detected',
            target: { kind: 'inventory_entry', entry: entry() },
            terminateEnabled: true,
        })).toMatchObject({
            enabled: true,
            requiresConfirmation: true,
            requiresSecondConfirmation: true,
            auditRequired: true,
        });
    });

    it('denies managed stop/restart until execution hooks are explicitly available', () => {
        expect(resolveLocalServiceActionEligibility({
            action: 'stop_managed',
            target: {
                kind: 'managed_service',
                service: managedService(),
            },
            terminateEnabled: false,
        })).toMatchObject({
            enabled: false,
            reasonCode: 'managed_stop_unavailable',
            requiresConfirmation: true,
            auditRequired: true,
        });

        expect(resolveLocalServiceActionEligibility({
            action: 'restart_managed',
            target: {
                kind: 'managed_service',
                service: managedService(),
            },
            terminateEnabled: false,
        })).toMatchObject({
            enabled: false,
            reasonCode: 'managed_restart_unavailable',
            requiresConfirmation: true,
            auditRequired: true,
        });

        expect(resolveLocalServiceActionEligibility({
            action: 'stop_managed',
            target: { kind: 'inventory_entry', entry: entry() },
            terminateEnabled: false,
        })).toMatchObject({ enabled: false, reasonCode: 'wrong_target_kind' });
    });

    it('allows managed stop only when a managed stop executor is present', () => {
        expect(resolveLocalServiceActionEligibility({
            action: 'stop_managed',
            target: {
                kind: 'managed_service',
                service: managedService(),
            },
            terminateEnabled: false,
            managedStopEnabled: true,
        })).toMatchObject({
            enabled: true,
            requiresConfirmation: true,
            auditRequired: true,
        });
    });
});
