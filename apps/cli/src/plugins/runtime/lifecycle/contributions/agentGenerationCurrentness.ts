/**
 * Currentness predicate shared by every generation-bound Agent registration
 * contribution.
 *
 * The host tracks two independent facts on an Agent runtime registration: the
 * registered generation is still the published one (`isCurrent`), and its
 * retirement signal has not fired. A contribution captured from that
 * registration stays usable only while both hold.
 */
export type AgentRuntimeGenerationBinding = Readonly<{
    isCurrent(): boolean;
    retirementSignal: AbortSignal;
}>;

export function isAgentRuntimeGenerationCurrent(
    binding: AgentRuntimeGenerationBinding,
): boolean {
    return binding.isCurrent() && !binding.retirementSignal.aborted;
}
