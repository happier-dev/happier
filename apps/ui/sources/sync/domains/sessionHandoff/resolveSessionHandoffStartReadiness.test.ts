import { describe, expect, it } from 'vitest';

import {
    resolveSessionHandoffStartBlockedTranslationKey,
    resolveSessionHandoffStartReadiness,
} from './resolveSessionHandoffStartReadiness';

const READY = {
    phase: 'ready', errorCode: null, carrierPhase: 'ready', carrierErrorCode: null,
} as const;

function input(overrides: Partial<Parameters<typeof resolveSessionHandoffStartReadiness>[0]> = {}) {
    return {
        targetMachineSelected: true,
        targetMachineAttemptable: true,
        relationshipRequested: false,
        relationshipResolved: false,
        workspaceActionResolved: true,
        workspaceEngineRequired: true,
        machineCarrierRequired: true,
        sourcePathAllowed: true,
        targetPathAllowed: true,
        sourceEngineReadiness: READY,
        targetEngineReadiness: READY,
        ...overrides,
    } as const;
}

describe('resolveSessionHandoffStartReadiness', () => {
    it('allows the handoff when the destination, folders and both engines are ready', () => {
        expect(resolveSessionHandoffStartReadiness(input())).toEqual({ canStart: true });
    });

    it('asks for a destination computer before anything else', () => {
        expect(resolveSessionHandoffStartReadiness(input({
            targetMachineSelected: false,
            targetPathAllowed: false,
            sourceEngineReadiness: { ...READY, phase: 'unavailable', errorCode: 'engine_unavailable' },
        }))).toEqual({ canStart: false, reason: 'target_machine_not_selected' });
    });

    it('reports an unreachable destination computer', () => {
        expect(resolveSessionHandoffStartReadiness(input({ targetMachineAttemptable: false })))
            .toEqual({ canStart: false, reason: 'target_machine_unavailable' });
    });

    it('refuses a chosen relationship that no longer resolves for these endpoints', () => {
        expect(resolveSessionHandoffStartReadiness(input({
            relationshipRequested: true,
            relationshipResolved: false,
        }))).toEqual({ canStart: false, reason: 'relationship_unavailable' });
    });

    it('reports the exact daemon engine failure for the computer that owns it', () => {
        expect(resolveSessionHandoffStartReadiness(input({
            targetEngineReadiness: { ...READY, phase: 'unavailable', errorCode: 'engine_unavailable' },
        }))).toEqual({
            canStart: false,
            reason: 'workspace_engine_unavailable',
            engineErrorCode: 'engine_unavailable',
        });
        expect(resolveSessionHandoffStartReadiness(input({
            sourceEngineReadiness: {
                ...READY,
                carrierPhase: 'unavailable',
                carrierErrorCode: 'machine_carrier_unavailable',
            },
        }))).toEqual({
            canStart: false,
            reason: 'workspace_engine_unavailable',
            engineErrorCode: 'machine_carrier_unavailable',
        });
    });

    it('does not hide local-only workspace actions when the remote machine carrier is unavailable', () => {
        expect(resolveSessionHandoffStartReadiness(input({
            machineCarrierRequired: false,
            sourceEngineReadiness: {
                ...READY,
                carrierPhase: 'unavailable',
                carrierErrorCode: 'machine_carrier_unavailable',
            },
            targetEngineReadiness: {
                ...READY,
                carrierPhase: 'unavailable',
                carrierErrorCode: 'machine_carrier_unavailable',
            },
        }))).toEqual({ canStart: true });
    });

    it('keeps Start disabled while authoritative daemon readiness is absent or starting', () => {
        expect(resolveSessionHandoffStartReadiness(input({
            sourceEngineReadiness: { ...READY, phase: 'idle' },
            targetEngineReadiness: { ...READY, phase: 'probing' },
        }))).toEqual({ canStart: false, reason: 'workspace_engine_readiness_pending' });
    });

    it('ignores engine readiness entirely when no workspace action needs the engine', () => {
        expect(resolveSessionHandoffStartReadiness(input({
            workspaceEngineRequired: false,
            sourcePathAllowed: false,
            targetPathAllowed: true,
            sourceEngineReadiness: { ...READY, phase: 'unavailable', errorCode: 'engine_unavailable' },
            targetEngineReadiness: { ...READY, phase: 'unavailable', errorCode: 'engine_unavailable' },
        }))).toEqual({ canStart: true });
    });

    it('requires an admissible destination even when no workspace action needs the engine', () => {
        expect(resolveSessionHandoffStartReadiness(input({
            workspaceEngineRequired: false,
            targetPathAllowed: false,
        }))).toEqual({ canStart: false, reason: 'target_path_unsafe' });
    });

    it('names the unsafe folder side instead of a generic failure', () => {
        expect(resolveSessionHandoffStartReadiness(input({ sourcePathAllowed: false })))
            .toEqual({ canStart: false, reason: 'source_path_unsafe' });
        expect(resolveSessionHandoffStartReadiness(input({ targetPathAllowed: false })))
            .toEqual({ canStart: false, reason: 'target_path_unsafe' });
    });

    it('reports incomplete workspace options last, after every actionable prerequisite', () => {
        expect(resolveSessionHandoffStartReadiness(input({ workspaceActionResolved: false })))
            .toEqual({ canStart: false, reason: 'workspace_action_incomplete' });
    });

    it('maps every blocked reason to actionable copy and reuses the workspace error owner for engine codes', () => {
        expect(resolveSessionHandoffStartBlockedTranslationKey({
            canStart: false,
            reason: 'target_machine_not_selected',
        })).toBe('workspaceSync.start.blocked.targetMachine');
        expect(resolveSessionHandoffStartBlockedTranslationKey({
            canStart: false,
            reason: 'target_machine_unavailable',
        })).toBe('workspaceSync.start.blocked.targetMachineOffline');
        expect(resolveSessionHandoffStartBlockedTranslationKey({
            canStart: false,
            reason: 'relationship_unavailable',
        })).toBe('workspaceSync.start.blocked.relationshipUnavailable');
        expect(resolveSessionHandoffStartBlockedTranslationKey({
            canStart: false,
            reason: 'source_path_unsafe',
        })).toBe('workspaceSync.start.blocked.sourceFolder');
        expect(resolveSessionHandoffStartBlockedTranslationKey({
            canStart: false,
            reason: 'target_path_unsafe',
        })).toBe('workspaceSync.start.blocked.destinationFolder');
        expect(resolveSessionHandoffStartBlockedTranslationKey({
            canStart: false,
            reason: 'workspace_action_incomplete',
        })).toBe('workspaceSync.start.blocked.workspaceOptions');
        expect(resolveSessionHandoffStartBlockedTranslationKey({
            canStart: false,
            reason: 'workspace_engine_readiness_pending',
        })).toBe('workspaceSync.engine.checking');
        expect(resolveSessionHandoffStartBlockedTranslationKey({
            canStart: false,
            reason: 'workspace_engine_unavailable',
            engineErrorCode: 'engine_unavailable',
        })).toBe('workspaceSync.error.componentUnavailable');
        expect(resolveSessionHandoffStartBlockedTranslationKey({
            canStart: false,
            reason: 'workspace_engine_unavailable',
            engineErrorCode: 'target_bootstrap_required',
        })).toBe('workspaceSync.error.destinationNeedsPreparation');
    });

    it('has no blocked copy for a startable handoff', () => {
        expect(resolveSessionHandoffStartBlockedTranslationKey({ canStart: true })).toBeNull();
    });
});
