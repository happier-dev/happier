/** Return a default only when the presented inventory has one eligible choice. */
export function findSoleEligibleOption<T>(options: readonly T[], eligible: (option: T) => boolean): T | undefined {
    const choices = options.filter(eligible);
    return choices.length === 1 ? choices[0] : undefined;
}
