export type NewSessionCreateRequirement = Readonly<{
    ready: boolean;
    reason: string;
}>;

/** The screen's ordered admission requirements, including their user-visible reason. */
export function resolveNewSessionCreateAdmission(requirements: ReadonlyArray<NewSessionCreateRequirement>): Readonly<{
    canCreate: boolean;
    disabledReason: string | null;
}> {
    const blocker = requirements.find(requirement => !requirement.ready);
    return blocker
        ? { canCreate: false, disabledReason: blocker.reason }
        : { canCreate: true, disabledReason: null };
}
