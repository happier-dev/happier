export type NewSessionCreateRequirement = Readonly<{
    ready: boolean;
    /** Why it blocks, for the composer's status line; `null` when a control on the card already asks. */
    reason: string | null;
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

type NewSessionTargetReasonKey = 'newSession.noMachineSelected' | 'newSession.noPathSelected' | 'newSession.machineUnavailableStatus';

/**
 * Where the session runs: a target (machine or cloud machine), then a folder, then a machine that can start it.
 * With no machine on the Home yet (58d AF1) the "Run on…" chip is the ask, so the status line stays empty.
 */
export function resolveNewSessionTargetRequirement(input: Readonly<{
    ready: boolean;
    hasTarget: boolean;
    /** The getting-started owner's "this Home has a machine" fact; `null` while unknown. */
    hasMachine: boolean | null;
    needsFolder: boolean;
    translate: (key: NewSessionTargetReasonKey) => string;
}>): NewSessionCreateRequirement {
    const reason = !input.hasTarget
        ? input.hasMachine === false ? null : input.translate('newSession.noMachineSelected')
        : input.needsFolder
            ? input.translate('newSession.noPathSelected')
            : input.translate('newSession.machineUnavailableStatus');
    return { ready: input.ready, reason };
}
