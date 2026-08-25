import { describe, expect, it } from 'vitest';

import { resolveLocalServiceActionEligibility } from './policy';
import {
    normalizeLocalServiceScan,
    type NormalizedLocalServiceInventoryEntry,
} from '../inventory/scanner';

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

    // The previous version of this suite hand-built a `low` confidence *with* populated
    // provenance — a combination the scanner cannot emit — so it would have passed against an
    // implementation that deleted the ownership check outright. These cases drive the real
    // scanner so the entry/confidence pairs are provably reachable.
    it('refuses termination for scanner-produced rows the daemon cannot establish ownership of', () => {
        const scanned = (processOwnership: 'self' | 'other' | undefined) => normalizeLocalServiceScan({
            machineId: 'machine-a',
            now: 1_000,
            previous: null,
            listeners: [{ address: '127.0.0.1', port: 5173, protocol: 'tcp', pid: 400 }],
            processes: new Map([[400, {
                pid: 400,
                command: 'node ./node_modules/vite/bin/vite.js',
                cwd: '/repo/web',
                ...(processOwnership ? { processOwnership } : {}),
            }]]),
            workspaces: [{ path: '/repo' }],
        }).entries[0] as NormalizedLocalServiceInventoryEntry;

        const decisionFor = (processOwnership: 'self' | 'other' | undefined) =>
            resolveLocalServiceActionEligibility({
                action: 'terminate_detected',
                target: { kind: 'inventory_entry', entry: scanned(processOwnership) },
                terminateEnabled: true,
            });

        // Same OS user: the daemon owns it and may terminate it.
        expect(decisionFor('self')).toMatchObject({ enabled: true });
        // Another user's process (the cross-user case Linux/Windows machine-wide scans expose).
        expect(decisionFor('other')).toMatchObject({
            enabled: false,
            reasonCode: 'ownership_not_established',
        });
        // Ownership unproven: fail closed rather than repeat the old "has a pid" gate. A
        // workspace association alone must not rescue it.
        expect(scanned(undefined).workspaceAssociationConfidence).toBe('high');
        expect(decisionFor(undefined)).toMatchObject({
            enabled: false,
            reasonCode: 'ownership_not_established',
        });
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

    // Lane B3 removed the managed local-service runtime (DEC-6); the published action kinds
    // survive in the catalog with no target kind to resolve, so both are flat denials.
    it('denies the surviving managed action kinds now that no managed target exists', () => {
        for (const action of ['stop_managed', 'restart_managed'] as const) {
            expect(resolveLocalServiceActionEligibility({
                action,
                target: { kind: 'inventory_entry', entry: entry() },
                terminateEnabled: false,
            })).toMatchObject({ enabled: false, reasonCode: 'wrong_target_kind' });
        }
    });
});
