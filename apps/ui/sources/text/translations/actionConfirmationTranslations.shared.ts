

export type ActionConfirmationTranslations = Readonly<{
    governance: Readonly<{
        homeLayout: Readonly<Record<Exclude<import('@happier-dev/protocol/actions/specs/homeHub').HomeLayoutApprovalEffect['kind'], 'groupCreate'>, string>
            & { groupCreateTitle: string; groupCreate: (params: Readonly<{ group: string; widgets: string }>) => string }>;
        teamArchive: string;
        teamPolicyInherit: string;
        teamPolicyInheritMayExpand: string;
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
            homeLayout: {
                move: "Moves an item on Home.",
                moveIntoGroup: "Moves an item into a group.",
                moveOutOfGroup: "Moves an item to the top level of Home.",
                reorder: "Changes the order of items on Home.",
                hide: "Hides an item on Home.",
                show: "Shows an item on Home.",
                frame: "Changes the frame style.",
                defaultFrame: "Restores the default frame style.",
                hideSetup: "Hides a setup step.",
                showSetup: "Shows a setup step.",
                restoreSetup: "Shows all setup steps again.",
                reset: "Restores the default Home layout.",
                addWidget: "Adds a widget to Home.",
                removeWidget: "Removes a widget from Home.",
                rename: "Changes the name.",
                defaultName: "Restores the default name.",
                inputs: "Changes what a widget uses.",
                resetInputs: "Resets what a widget uses.",
                size: "Changes a widget’s size.",
                addGroup: "Adds a group to Home.",
                ungroup: "Ungroups the widgets and keeps them on Home.",
                groupAppearance: "Changes a group’s appearance.",
                groupInputs: "Changes the group’s shared inputs.",
                removeItem: "Removes the selected item from Home, including its widgets if it’s a group.",
                groupWidth: "Changes a group’s width.",
                network: "Changes a widget’s network access.",
                groupCreateTitle: "Add a group to Home",
                groupCreate: ({ group, widgets }) => `Adds the group “${group}” with ${widgets}.`,
            },
            teamArchive: "Waiting invitations are permanently revoked. Restoring the Team does not restore them.",
            teamPolicyInherit: "Use the Home’s sign-in policy.",
            teamPolicyInheritMayExpand: "Use the Home’s sign-in policy. This may allow more sign-in methods.",
            teamPolicyClearTeam: "Clear the Team member defaults and all Group overrides.",
            teamPolicyClearGroup: "Clear the Group member defaults.",
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