import type {
    LocalServiceActionDecisionV1,
    LocalServiceActionKindV1,
} from '@happier-dev/protocol';

import type { NormalizedLocalServiceInventoryEntry } from '../inventory/scanner';
import type { ManagedLocalServiceRuntimeState } from '../managed/registry';

type ActionTarget =
    | Readonly<{ kind: 'inventory_entry'; entry: NormalizedLocalServiceInventoryEntry }>
    | Readonly<{ kind: 'managed_service'; service: ManagedLocalServiceRuntimeState }>;

export type ResolveLocalServiceActionEligibilityInput = Readonly<{
    action: LocalServiceActionKindV1;
    target: ActionTarget;
    terminateEnabled: boolean;
    managedStopEnabled?: boolean;
    managedRestartEnabled?: boolean;
}>;

function enabledDecision(kind: LocalServiceActionKindV1, input?: Readonly<{
    requiresConfirmation?: boolean;
    requiresSecondConfirmation?: boolean;
    auditRequired?: boolean;
}>): LocalServiceActionDecisionV1 {
    return {
        kind,
        enabled: true,
        requiresConfirmation: input?.requiresConfirmation ?? false,
        requiresSecondConfirmation: input?.requiresSecondConfirmation ?? false,
        auditRequired: input?.auditRequired ?? false,
    };
}

function deniedDecision(kind: LocalServiceActionKindV1, reasonCode: string, input?: Readonly<{
    requiresConfirmation?: boolean;
    requiresSecondConfirmation?: boolean;
    auditRequired?: boolean;
}>): LocalServiceActionDecisionV1 {
    return {
        kind,
        enabled: false,
        requiresConfirmation: input?.requiresConfirmation ?? false,
        requiresSecondConfirmation: input?.requiresSecondConfirmation ?? false,
        reasonCode,
        auditRequired: input?.auditRequired ?? false,
    };
}

/**
 * `terminate_detected` is the only affordance that signals a process the daemon did not spawn,
 * so it requires established ownership, not merely a resolvable pid.
 *
 * The scanner (`inventory/scanner.ts#resolveProcessOwnershipConfidence`) is the single owner of
 * that judgement: `high` means a terminal-registry match or the daemon's own OS identity. The
 * previous `>= medium || workspaceAssociationConfidence >= high` disjunction was two
 * decision-makers for one question and both were satisfiable by "the listener has a pid"; the
 * workspace clause is also redundant now, because a workspace-associated listener is either
 * terminal-registered or same-user, and both already resolve to `high`.
 */
function hasCurrentOwnedProcess(entry: NormalizedLocalServiceInventoryEntry): boolean {
    if (!entry.provenance?.process) return false;
    return entry.processOwnershipConfidence === 'high';
}

function resolveTerminateDetectedDecision(
    entry: NormalizedLocalServiceInventoryEntry,
    terminateEnabled: boolean,
): LocalServiceActionDecisionV1 {
    const confirmation = {
        requiresConfirmation: true,
        requiresSecondConfirmation: true,
        auditRequired: true,
    };
    if (!terminateEnabled) {
        return deniedDecision('terminate_detected', 'terminate_feature_disabled', confirmation);
    }
    if (entry.state !== 'listening') {
        return deniedDecision('terminate_detected', 'service_not_listening', confirmation);
    }
    if (entry.classification?.lowSignal === true) {
        return deniedDecision('terminate_detected', 'low_signal_process', confirmation);
    }
    if (!hasCurrentOwnedProcess(entry)) {
        return deniedDecision('terminate_detected', 'ownership_not_established', confirmation);
    }
    return enabledDecision('terminate_detected', confirmation);
}

function resolveManagedActionDecision(
    action: LocalServiceActionKindV1,
    target: ActionTarget,
    input: Readonly<{
        managedStopEnabled?: boolean;
        managedRestartEnabled?: boolean;
    }>,
): LocalServiceActionDecisionV1 {
    if (target.kind !== 'managed_service') {
        return deniedDecision(action, 'wrong_target_kind', {
            requiresConfirmation: true,
            auditRequired: true,
        });
    }
    if (action === 'restart_managed') {
        if (input.managedRestartEnabled !== true) {
            return deniedDecision(action, 'managed_restart_unavailable', {
                requiresConfirmation: true,
                auditRequired: true,
            });
        }
    }
    if (action === 'stop_managed' && input.managedStopEnabled !== true) {
        return deniedDecision(action, 'managed_stop_unavailable', {
            requiresConfirmation: true,
            auditRequired: true,
        });
    }
    if (target.service.phase === 'stopped' || target.service.phase === 'failed') {
        return deniedDecision(action, 'managed_service_not_running', {
            requiresConfirmation: true,
            auditRequired: true,
        });
    }
    return enabledDecision(action, {
        requiresConfirmation: true,
        auditRequired: true,
    });
}

export function resolveLocalServiceActionEligibility(
    input: ResolveLocalServiceActionEligibilityInput,
): LocalServiceActionDecisionV1 {
    switch (input.action) {
        case 'copy_url':
        case 'open_preview':
            return enabledDecision(input.action);
        case 'forget':
            if (input.target.kind !== 'inventory_entry') {
                return deniedDecision('forget', 'wrong_target_kind', { auditRequired: true });
            }
            return enabledDecision('forget', { auditRequired: true });
        case 'stop_managed':
        case 'restart_managed':
            return resolveManagedActionDecision(input.action, input.target, input);
        case 'terminate_detected':
            if (input.target.kind !== 'inventory_entry') {
                return deniedDecision('terminate_detected', 'wrong_target_kind', {
                    requiresConfirmation: true,
                    requiresSecondConfirmation: true,
                    auditRequired: true,
                });
            }
            return resolveTerminateDetectedDecision(input.target.entry, input.terminateEnabled);
    }
}
