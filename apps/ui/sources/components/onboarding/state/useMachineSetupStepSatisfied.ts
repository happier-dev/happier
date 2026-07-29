import { useAllMachines } from '@/sync/store/hooks';

/**
 * Canonical predicate for the post-auth machine-setup step (journey S3 / wizard machine step).
 *
 * Binding product decision: the machine-setup step auto-displays ONLY while the account has
 * ZERO machines. Once ANY machine exists — online OR offline — the step is satisfied and must
 * never auto-display again. `useAllMachines()` is the canonical visible-machines selector for
 * the active server (revoked machines already excluded, offline machines included), so a
 * non-empty list means the account already has a machine and every automatic post-auth display
 * gate must treat the machine-setup step as already done.
 *
 * This intentionally gates only the AUTOMATIC post-auth display (route re-latch to the journey
 * setup act, and the in-shell SetupWizardSurface auto-open). Explicit, user-invoked entry points
 * — journey replay deep-link, the sessions empty-state "open setup" affordance, settings
 * machine-add — are NOT gated by this predicate.
 */
export function useMachineSetupStepSatisfied(): boolean {
    return useAllMachines().length > 0;
}
