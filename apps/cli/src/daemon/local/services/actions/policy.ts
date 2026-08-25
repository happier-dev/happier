import type {
    LocalServiceActionDecisionV1,
    LocalServiceActionKindV1,
} from '@happier-dev/protocol';

import type { NormalizedLocalServiceInventoryEntry } from '../inventory/scanner';

type ActionTarget = Readonly<{ kind: 'inventory_entry'; entry: NormalizedLocalServiceInventoryEntry }>;

export type ResolveLocalServiceActionEligibilityInput = Readonly<{
    action: LocalServiceActionKindV1;
    target: ActionTarget;
    terminateEnabled: boolean;
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

export function resolveLocalServiceActionEligibility(
    input: ResolveLocalServiceActionEligibilityInput,
): LocalServiceActionDecisionV1 {
    switch (input.action) {
        case 'copy_url':
        case 'open_preview':
            return enabledDecision(input.action);
        case 'forget':
            return enabledDecision('forget', { auditRequired: true });
        // `stop_managed` / `restart_managed` survive in the published action catalog
        // (`packages/protocol/src/actions/specs/localServices.ts`, projected into the plugin
        // SDK) but the managed local-service runtime they addressed was removed with its
        // producerless registry (RU2 surfaces finalization, DEC-6). There is no managed target
        // kind to resolve, so the only honest answer is a denial. Removal condition: delete
        // both kinds — and this arm — in the next plugin-SDK contraction window.
        case 'stop_managed':
        case 'restart_managed':
            return deniedDecision(input.action, 'wrong_target_kind', {
                requiresConfirmation: true,
                auditRequired: true,
            });
        case 'terminate_detected':
            return resolveTerminateDetectedDecision(input.target.entry, input.terminateEnabled);
    }
}
