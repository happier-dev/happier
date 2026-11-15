import type { SpawnSessionOptions } from '@/session/shared/spawnSessionContract';

/**
 * Facts that belong to one launch only: admission hooks and contexts that close over that
 * operation's requester (retired when it settles), single-use handles (held-Agent token,
 * takeover admission, credential file), and one-shot birth/delivery intents. Durable tracked
 * spawn options (replayed by crash, auth and planned respawns) never carry them; each later
 * launch re-admits and supplies its own. The one owner of this list.
 */
export function omitLaunchScopedSpawnOptions(options: SpawnSessionOptions): SpawnSessionOptions {
    const {
        initialTranscriptAfterSeq: _initialTranscriptAfterSeq,
        pendingFirstInput: _pendingFirstInput,
        initialGoal: _initialGoal,
        initialAccess: _initialAccess,
        manager: _manager,
        initialSessionRolesV1: _initialSessionRolesV1,
        authoringOrigin: _authoringOrigin,
        freshSessionCreation: _freshSessionCreation,
        managedDirectorySeed: _managedDirectorySeed,
        primaryTeamId: _primaryTeamId,
        persistedTakeoverAdmission: _persistedTakeoverAdmission,
        creationAuthorization: _creationAuthorization,
        callerInputConstraints: _callerInputConstraints,
        verifyRequesterMachineAdmissionCurrent: _verifyRequesterMachineAdmissionCurrent,
        beforeSessionRunnerLaunch: _beforeSessionRunnerLaunch,
        resumeActionContext: _resumeActionContext,
        spawnActionContext: _spawnActionContext,
        projectSetupOperation: _projectSetupOperation,
        requesterSessionCredentialFile: _requesterSessionCredentialFile,
        requesterSessionBootstrap: _requesterSessionBootstrap,
        requesterSessionRuntimeContext: _requesterSessionRuntimeContext,
        // Single-use: a launch consumes the held Agent; a later respawn gets its own token.
        adoptSessionHolder: _adoptSessionHolder,
        providerBindingSecurityChangeConfirmationV1: _providerBindingSecurityChangeConfirmationV1,
        ...durable
    } = options;
    return durable;
}
