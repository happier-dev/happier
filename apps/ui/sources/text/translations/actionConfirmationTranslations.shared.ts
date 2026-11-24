

export type ActionConfirmationTranslations = Readonly<{
    governance: Readonly<{
        status: Readonly<Record<'pending' | 'completed' | 'notApplied' | 'failed' | 'unknown', (params: Readonly<{ change: string }>) => string>>;
        change: Readonly<Record<'teamPolicy' | 'homeSettings' | 'homeSettingsDiscard' | 'teamArchive' | 'nativeCredentialDelivery'
            | 'machinePresetPrepare' | 'teamSetup' | 'sessionTeamSet' | 'sessionTeamClear', string>
            & { teamCreate: (params: Readonly<{ name: string }>) => string }>;
        sessionTeamGrantsStay: string;
        sessionTeamPolicyGrant: string;
        /** Action phrases used inside the status sentence, without sentence punctuation. */
        homeLayout: Readonly<Record<Exclude<import('@happier-dev/protocol/actions/specs/homeHub').HomeLayoutApprovalEffect['kind'], 'groupCreate'>, string>
            & { groupCreateTitle: string; groupCreate: (params: Readonly<{ group: string; widgets: string }>) => string }>;
        teamArchive: string;
        teamPolicyInherit: string;
        teamPolicyMayExpand: string;
        teamPolicyClearTeam: string;
        teamPolicyClearGroup: string;
        machinePresetPrepare: string;
        setupApply: string;
        setupAttach: string;
        setupWorktree: string;
        setupClone: string;
        setupSync: string;
        setupWorkspace: string;
        setupConnectedAccount: string;
        nativeCredentialDelivery: string;
    }>;
    requestedByAgent: string;
    homeTarget: (params: Readonly<{ serverId: string }>) => string;
    sessionTarget: (params: Readonly<{ sessionId: string }>) => string;
    oneShotConsequence: string;
    spawnWithoutTeamCredentialDefaults: string;
    spawnTeamCredentialSource: (params: Readonly<{ team: string; account: string }>) => string;
    homeUnavailable: string;
    /** The notice's title names the Action that is off (its catalog title). */
    turnedOffTitle: (params: Readonly<{ action: string }>) => string;
    turnedOffMessage: string;
    /** One line where no title names the Action (an inline failure message). */
    turnedOffUnnamedMessage: string;
    turnedOffReadMessage: string;
    openActionSettings: string;
}>;


export const actionConfirmationTranslationsEnglish = { en: {
        governance: {
            status: {
                pending: ({ change }) => `This will ${change}.`,
                completed: ({ change }) => `Completed the request to ${change}.`,
                notApplied: ({ change }) => `The change wasn’t made. The request was to ${change}. `,
                failed: ({ change }) => `It couldn’t be completed. The request was to ${change}. `,
                unknown: ({ change }) => `The outcome is unknown. The request was to ${change}. `,
            },
            change: {
                teamCreate: ({ name }) => `create the Team “${name}”`,
                teamPolicy: "update the Team policy",
                homeSettings: "update Home settings",
                homeSettingsDiscard: "discard the Home settings waiting for a restart",
                teamArchive: "archive the Team",
                nativeCredentialDelivery: "configure the Team credential for native delivery",
                machinePresetPrepare: "start preparing the image for this preset",
                teamSetup: "start Team setup",
                sessionTeamSet: "set the primary Team",
                sessionTeamClear: "clear the primary Team",
            },
            sessionTeamGrantsStay: "Existing grants stay in place.",
            sessionTeamPolicyGrant: "The selected Team gains access if its policy requires it.",
            homeLayout: {
                move: "move an item on Home",
                moveIntoGroup: "move an item into a group",
                moveOutOfGroup: "move an item to the top level of Home",
                reorder: "change the order of items on Home",
                hide: "hide an item on Home",
                show: "show an item on Home",
                frame: "change the frame style",
                defaultFrame: "restore the default frame style",
                hideSetup: "hide a setup step",
                showSetup: "show a setup step",
                restoreSetup: "show all setup steps again",
                reset: "restore the default Home layout",
                addWidget: "add a widget to Home",
                removeWidget: "remove a widget from Home",
                rename: "change the name",
                defaultName: "restore the default name",
                inputs: "change what a widget uses",
                resetInputs: "reset what a widget uses",
                size: "change a widget’s size",
                addGroup: "add a group to Home",
                ungroup: "ungroup the widgets and keep them on Home",
                groupAppearance: "change a group’s appearance",
                groupInputs: "change the group’s shared inputs",
                removeItem: "remove the selected item from Home, including its widgets if it’s a group",
                groupWidth: "change a group’s width",
                network: "change a widget’s network access",
                groupCreateTitle: "Add a group to Home",
                groupCreate: ({ group, widgets }) => `add the group “${group}” with ${widgets}`,
            },
            teamArchive: "Waiting invitations are permanently revoked. Restoring the Team does not restore them.",
            teamPolicyInherit: "use the Home’s sign-in policy",
            teamPolicyMayExpand: "This may allow more sign-in methods.",
            teamPolicyClearTeam: "clear the Team member defaults and all Group overrides",
            teamPolicyClearGroup: "clear the Group member defaults",
            machinePresetPrepare: "Build a prepared image for this preset. Provider build and artifact storage charges may apply.",
            setupApply: "Apply Machine setup",
            setupAttach: "Attach",
            setupWorktree: "Create worktree",
            setupClone: "Clone",
            setupSync: "Sync",
            setupWorkspace: "Workspace",
            setupConnectedAccount: "Use a connected account",
            nativeCredentialDelivery: "Native delivery may disclose the selected credential key to the vendor’s control plane, separate from the provisioning token. The source custodian and vendor remain trusted. Installed requests bypass Happier’s per-request authorization, body and model policy, and request, token or cost limits. Vendor matchers narrow key substitution. They do not inspect model JSON or deny unmatched requests. Configure budgets and key restrictions at the gateway or vendor. This review cannot verify that coverage. Installed rules may continue while the controller is offline, when changes and removal cannot be guaranteed. Rotate or revoke the upstream key to stop use independently. Previously disclosed keys cannot be recalled. Attribution is observational and does not authenticate member identity or support chargeback. Members sharing an OS user can read and reuse each other’s placeholders.",
        },
        requestedByAgent: 'Action requested by the session Agent',
        homeTarget: ({ serverId }) => `Home: ${serverId}`,
        sessionTarget: ({ sessionId }) => `Target session: ${sessionId}`,
        oneShotConsequence: 'Approval applies only to this request. It does not grant future Action or native permissions.',
        spawnWithoutTeamCredentialDefaults: 'Starts without your Team’s credential defaults.',
        spawnTeamCredentialSource: ({ team, account }) => `Uses ${team}’s shared ${account}.`,
        homeUnavailable: 'This approval belongs to a Home that is unavailable on this device. Reconnect that Home to decide it.',
        turnedOffTitle: ({ action }) => `${action} is turned off`,
        turnedOffMessage: 'Turn it back on in Settings → Actions to use it here.',
        turnedOffUnnamedMessage: 'This action is turned off. Turn it back on in Settings → Actions to use it here.',
        turnedOffReadMessage: 'This action is turned off, so nothing was loaded. You can turn it back on in Settings → Actions.',
        openActionSettings: 'Open setting',
    } } as const satisfies Pick<Record<string, ActionConfirmationTranslations>, "en">;