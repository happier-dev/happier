

export type RolesTranslations = Readonly<{
    rail: Readonly<{
        label: string;
        title: string;
        searchPlaceholder: string;
        empty: string;
        footer: string;
        manage: string;
        engineAppliesOnStart: string;
        defaultEngine: string;
        activeAccessibilityLabel: string;
    }>;
    settings: Readonly<{
        description: string;
        count: (params: Readonly<{ count: number }>) => string;
        newRole: string;
        groupBuiltIn: string;
        groupYours: string;
        groupShared: string;
        groupPlugins: string;
        edited: string;
        sourceBuiltIn: string;
        sourceYours: string;
        sourceShared: string;
        sourcePlugin: (params: Readonly<{ plugin: string }>) => string;
        migrated: string;
        migratedNote: string;
        nameTitle: string;
        newRoleName: string;
        instructionsTitle: string;
        instructionsDescription: string;
        resetToDefault: string;
        readOnlyNote: string;
        howItRunsTitle: string;
        engineTitle: string;
        engineDescription: string;
        engineFollowsDefault: string;
        engineUnavailable: string;
        runsAsTitle: string;
        runsAsSession: string;
        runsAsBackgroundRun: string;
        runsAsSessionDescription: string;
        runsAsBackgroundDescription: string;
        handsOffTitle: string;
        handsOffDescription: string;
        secondOpinionTitle: string;
        secondOpinionDescription: string;
        secondOpinionOff: string;
        secondOpinionEncouraged: string;
        enabledTitle: string;
        enabledDescription: string;
        advancedTitle: string;
        launchProfileTitle: string;
        launchProfileDescription: string;
        launchProfileNone: string;
        profileUnavailable: string;
        previewTitle: string;
        previewDescription: string;
        deleteRole: string;
        deleteConfirmTitle: string;
        deleteConfirmBody: (params: Readonly<{ name: string }>) => string;
        share: string;
        sendCopyFailed: string;
        saveFailed: string;
        loadFailed: string;
        emptyDetailTitle: string;
        emptyDetailBody: string;
    }>;
    delegation: Readonly<{
        approvalReviewer: string;
        approvalReviewerDescription: string;
        approvedByReviewer: string;
        title: string;
        description: string;
        depthTitle: string;
        depthDescription: string;
        depthSetting: string;
        depthSettingDescription: (params: Readonly<{ count: number }>) => string;
        ladderRoot: string;
        ladderRootDetail: string;
        ladderLevel: (params: Readonly<{ level: number }>) => string;
        ladderLevelDetail: string;
        ladderRefused: string;
        ladderRefusedDetail: (params: Readonly<{ level: number }>) => string;
    }>;
    session: Readonly<{
        useDefaults: string;
        crossOwnerNote: string;
        addRole: string;
        addRoleConfirm: string;
        namePlaceholder: string;
        instructionsPlaceholder: string;
        notesTitle: string;
        notesPlaceholder: string;
        applyToReports: string;
        handsOffTitle: string;
        handsOffDescription: string;
        saveFailed: string;
        sectionTitle: string;
        allRoles: string;
        inUse: (params: Readonly<{ count: number }>) => string;
        changed: string;
        thisSession: string;
        reset: string;
        newRoleForSession: string;
        changeForSession: string;
        editNotes: string;
        more: string;
        info: string;
        countChanged: (params: Readonly<{ count: number }>) => string;
        countAdded: (params: Readonly<{ count: number }>) => string;
        addNotes: string;
    }>;
    profiles: Readonly<{
        sharedWithYouTitle: string;
        sharedWithYouDescription: string;
        share: string;
        shareFailedTitle: string;
        shareNeedsSavedSecrets: string;
        shareAwaitingApproval: string;
    }>;
}>;


export const rolesTranslationsEnglish = { en: {
        rail: {
            label: 'Roles',
            title: 'Role',
            searchPlaceholder: 'Search roles…',
            empty: 'No roles match.',
            footer: 'A role brings its own instructions, engine and how it runs, so workflows stay portable.',
            manage: 'Manage roles',
            engineAppliesOnStart: 'Engine applies when starting this role',
            defaultEngine: 'Default agent',
            activeAccessibilityLabel: 'Roles, a role is in use',
        },
        settings: {
            description: 'Who does each kind of work. Workflows and orchestrators ask for a role; the role says how to run it.',
            count: ({ count }) => (count === 1 ? '1 role' : `${count} roles`),
            newRole: 'New role',
            groupBuiltIn: 'Built-in',
            groupYours: 'Yours',
            groupShared: 'Shared with you',
            groupPlugins: 'From plugins',
            edited: 'Edited',
            sourceBuiltIn: 'Built-in',
            sourceYours: 'Yours',
            sourceShared: 'Shared with you',
            sourcePlugin: ({ plugin }) => `From ${plugin}`,
            migrated: 'from 0.2 sub-agents',
            migratedNote: 'Roles marked "from 0.2 sub-agents" came from your sub-agents guidance: its description is now the instructions, its agent and model the engine.',
            nameTitle: 'Name',
            newRoleName: 'Untitled role',
            instructionsTitle: 'Instructions',
            instructionsDescription: 'What it does, when to use it and how to report. Agents read this when they hand out work.',
            resetToDefault: 'Reset to default',
            readOnlyNote: 'Shared with you to view. Your engine and profile choices stay yours.',
            howItRunsTitle: 'How it runs',
            engineTitle: 'Engine',
            engineDescription: 'Agent, model and effort.',
            engineFollowsDefault: 'Follows your default agent.',
            engineUnavailable: 'Unavailable here. Choose an engine.',
            runsAsTitle: 'Runs in',
            runsAsSession: 'Session',
            runsAsBackgroundRun: 'Background run',
            runsAsSessionDescription: 'A session you can open and steer.',
            runsAsBackgroundDescription: 'Runs in the background and reports back; there is no session to steer.',
            handsOffTitle: 'Hands-off',
            handsOffDescription: 'Plans and delegates; it doesn’t edit files itself.',
            secondOpinionTitle: 'Second opinion',
            secondOpinionDescription: 'Encouraged asks it to consider a second opinion before a pull request or before calling work done.',
            secondOpinionOff: 'Off',
            secondOpinionEncouraged: 'Encouraged',
            enabledTitle: 'Available',
            enabledDescription: 'Offered in the Roles rail and to orchestrators.',
            advancedTitle: 'Advanced',
            launchProfileTitle: 'Launch profile',
            launchProfileDescription: 'Env, permissions, machine',
            launchProfileNone: 'None',
            profileUnavailable: 'Profile unavailable',
            previewTitle: 'What agents read',
            previewDescription: 'The block sent with each turn, exactly.',
            deleteRole: 'Delete role',
            deleteConfirmTitle: 'Delete this role?',
            deleteConfirmBody: ({ name }) => `${name} is removed for you and everyone it is shared with. Sessions that already use it keep their copy.`,
            share: 'Share…',
            sendCopyFailed: 'Couldn’t send a copy.',
            saveFailed: 'Couldn’t save the role.',
            loadFailed: 'Couldn’t load your roles.',
            emptyDetailTitle: 'Choose a role',
            emptyDetailBody: 'Pick a role to see its instructions and how it runs.',
        },
        delegation: {
            title: 'Delegation',
            description: 'How agents hand work to other agents.',
            depthTitle: 'Work depth',
            approvalReviewer: 'Approval reviewer',
            approvalReviewerDescription: 'Review low-risk requests automatically, once only. Sensitive actions still need you. Applies in Default and Accept edits modes.',
            approvedByReviewer: 'Allowed once by Approval reviewer',
            depthDescription: 'Sessions, background runs and workflows that agents start can start more. This limit stops runaway chains. Anything you start yourself is never limited.',
            depthSetting: 'How far agents can hand off work',
            depthSettingDescription: ({ count }) => (count === 1
                ? 'One level. Past that, the agent is told to do the work itself.'
                : `${count} levels. Past that, the agent is told to do the work itself.`),
            ladderRoot: 'Work you start',
            ladderRootDetail: 'You started this · never limited',
            ladderLevel: ({ level }) => `Level ${level}`,
            ladderLevelDetail: 'Started by an agent',
            ladderRefused: 'One more hand-off',
            ladderRefusedDetail: ({ level }) => `Level ${level} · refused; the agent does it itself`,
        },
        session: {
            useDefaults: 'Use defaults',
            crossOwnerNote: 'Roles were copied when it started.',
            addRole: 'Add a role for this session',
            addRoleConfirm: 'Add role',
            namePlaceholder: 'Role name',
            instructionsPlaceholder: 'What this role does and when to use it',
            notesTitle: 'Notes',
            notesPlaceholder: 'Anything every session under this one should know',
            applyToReports: 'Apply to sessions under it',
            handsOffTitle: 'Hands-off',
            handsOffDescription: 'Plans and delegates; doesn’t edit files.',
            saveFailed: 'Couldn’t save this change.',
            sectionTitle: 'Roles',
            allRoles: 'All roles',
            inUse: ({ count }) => `${count} in use`,
            changed: 'changed',
            thisSession: 'this session',
            reset: 'Reset',
            newRoleForSession: 'New role for this session',
            changeForSession: 'Change for this session',
            editNotes: 'Edit notes',
            more: 'More',
            info: 'Roles apply to this session and the sessions under it.',
            countChanged: ({ count }) => `${count} changed`,
            countAdded: ({ count }) => `${count} added`,
            addNotes: 'Add notes for how this session should orchestrate',
        },
        profiles: {
            sharedWithYouTitle: 'Shared with you',
            sharedWithYouDescription: 'Profiles people and Teams share with you. Secret values stay with their owners.',
            share: 'Share…',
            shareFailedTitle: 'Couldn’t share this profile',
            shareNeedsSavedSecrets: 'Secret values never travel. Move each value in this profile into a Saved Secret and link it, then share again.',
            shareAwaitingApproval: 'Publishing this profile is waiting for approval. Once it’s approved, choose Share… again.',
        },
    } } as const satisfies Pick<Record<string, RolesTranslations>, "en">;