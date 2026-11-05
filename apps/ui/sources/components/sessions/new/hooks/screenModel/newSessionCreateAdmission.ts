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

type NewSessionTargetReasonKey = 'newSession.noMachineSelected' | 'newSession.machineUnavailableStatus';

/**
 * Where the session runs: a target (machine or cloud machine), then a folder, then a machine that can start it.
 * With no machine on the Home yet (58d AF1) the "Run on…" chip is the ask, so the status line stays empty. A missing
 * folder is the folder chip's own resolving state, so it stays empty too: loading must not read as an error.
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
        : input.needsFolder ? null : input.translate('newSession.machineUnavailableStatus');
    return { ready: input.ready, reason };
}

/** The Account's credential defaults: still arriving is not a problem to report, only a settled failure is. */
export function resolveNewSessionCredentialDefaultsRequirement(input: Readonly<{
    status: 'loading' | 'ready' | 'unavailable';
    unavailableReason: string;
}>): NewSessionCreateRequirement {
    return { ready: input.status === 'ready', reason: input.status === 'unavailable' ? input.unavailableReason : null };
}
