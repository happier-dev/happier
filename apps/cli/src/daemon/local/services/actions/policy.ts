import type {
    LocalServiceActionDecisionV1,
    LocalServiceActionKindV1,
} from '@happier-dev/protocol';

import type { NormalizedLocalServiceInventoryEntry } from '../inventory/scanner';
import type { ResolvedLocalServiceActionTarget } from './executor';

type ActionTarget = ResolvedLocalServiceActionTarget;

export type ResolveLocalServiceActionEligibilityInput = Readonly<{
    action: LocalServiceActionKindV1;
    target: ActionTarget;
    terminateEnabled: boolean;
    restartAdmitted?: boolean;
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

/** Services eligibility projects the canonical ownership level (proven, or same-principal likely). */
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
    if (input.target.kind === 'managed_service') {
        if (input.target.handle.kind === 'environment'
            && (input.action === 'stop_managed' || input.action === 'restart_managed')) {
            return deniedDecision(input.action, 'use_machines_services_control');
        }
        const snapshot = input.target.handle.snapshot();
        if (input.action === 'stop_managed') return snapshot.state === 'stopped'
            ? enabledDecision(input.action)
            : enabledDecision(input.action, { requiresConfirmation: true, auditRequired: true });
        // Exact retained resource cleanup is independent of serving/new-effect authority.
        if (!input.target.handle.isCurrent()) return deniedDecision(input.action, 'managed_service_not_current');
        if (input.action === 'forget') return enabledDecision(input.action, { auditRequired: true });
        if (input.action === 'restart_managed') return input.restartAdmitted
            ? enabledDecision(input.action, { requiresConfirmation: true, auditRequired: true })
            : deniedDecision(input.action, 'managed_service_restart_admission_required');
        if (input.action === 'copy_url' || input.action === 'open_preview') return snapshot.baseUrl
            ? enabledDecision(input.action) : deniedDecision(input.action, 'managed_service_no_endpoint');
        return deniedDecision(input.action, 'wrong_target_kind');
    }
    switch (input.action) {
        case 'copy_url':
        case 'open_preview':
            return enabledDecision(input.action);
        case 'forget':
            return enabledDecision('forget', { auditRequired: true });
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
