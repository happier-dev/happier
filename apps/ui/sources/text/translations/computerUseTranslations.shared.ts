

export type MachineParams = Readonly<{ machine: string }>;



export type ComputerUseTranslations = Readonly<{
    approval: Readonly<{
        /** The approval page section that says what happens on the computer. */
        sectionTitle: string;
        act: Readonly<{
            list: string;
            see: string;
            read: string;
            click: string;
            press: string;
            type: string;
            share: string;
        }>;
        windowOn: (params: MachineParams) => string;
        screenOf: (params: MachineParams) => string;
        windowsOn: (params: MachineParams) => string;
        window: string;
        screen: string;
        windows: string;
        typedLabel: string;
        keyLabel: string;
        listConsequence: string;
        seeConsequence: string;
        useConsequence: string;
        targetOn: (params: Readonly<{ machine: string; target: string }>) => string;
        chooseFirst: string;
        cropA11y: (params: Readonly<{ target: string }>) => string;
        suggestsWindow: (params: Readonly<{ agent: string; target: string }>) => string;
    }>;
    request: Readonly<{
        title: (params: Readonly<{ agent: string; machine: string }>) => string;
        body: string;
        choose: string;
        change: string;
        shared: (params: Readonly<{ target: string }>) => string;
        watch: string;
    }>;
    picker: Readonly<{
        title: (params: Readonly<{ agent: string }>) => string;
        description: (params: Readonly<{ agent: string }>) => string;
        windows: string;
        screens: string;
        untitledWindow: string;
        screenLabel: (params: Readonly<{ index: string }>) => string;
        share: string;
        shareScreen: string;
        shareApp: (params: Readonly<{ app: string }>) => string;
        stopSharing: string;
        loadingTitle: (params: Readonly<{ machine: string }>) => string;
        noScreenTitle: (params: Readonly<{ machine: string }>) => string;
        noScreenBody: string;
        unsupportedTitle: (params: Readonly<{ machine: string }>) => string;
        unsupportedBody: string;
        failedTitle: (params: Readonly<{ machine: string }>) => string;
        failedBody: string;
        emptyTitle: (params: Readonly<{ machine: string }>) => string;
        emptyBody: string;
        tryAgain: string;
        inUse: string;
        closed: string;
        selectFailed: string;
        otherMachineTitle: (params: Readonly<{ machine: string }>) => string;
        otherMachineBody: string;
        purpose: (params: Readonly<{ session: string }>) => string;
        purposeIn: (params: Readonly<{ project: string; session: string }>) => string;
        access: (params: Readonly<{ agent: string }>) => string;
        accessValue: string;
        accessSee: string;
        displayUnavailable: string;
        /** What sharing a whole display exposes, said before it is shared. */
        wholeDisplayBody: (params: Readonly<{ display: string }>) => string;
        policyBoth: (params: Readonly<{ agent: string }>) => string;
        policyInput: (params: Readonly<{ agent: string }>) => string;
        policyCapture: (params: Readonly<{ agent: string }>) => string;
        policyNone: (params: Readonly<{ agent: string }>) => string;
        policyChange: string;
        suggests: (params: Readonly<{ agent: string }>) => string;
        usingIt: string;
        displayShared: string;
        refresh: string;
        footnote: string;
        wholeDisplayTitle: string;
        allowSee: string;
        allowUse: string;
        allowUseHint: (params: Readonly<{ agent: string }>) => string;
        shareDisplay: string;
    }>;
    permission: Readonly<{
        input: string;
        denied: string;
        opened: (params: Readonly<{ machine: string }>) => string;
        openFailed: string;
        checkAgain: string;
        captureTitle: (params: Readonly<{ machine: string }>) => string;
        inputTitle: (params: Readonly<{ machine: string }>) => string;
        unknownTitle: (params: Readonly<{ machine: string }>) => string;
        separateBody: (params: Readonly<{ machine: string }>) => string;
        onMachineBody: (params: Readonly<{ machine: string }>) => string;
        openPrivacy: (params: Readonly<{ machine: string }>) => string;
    }>;
    viewer: Readonly<{
        agentUsing: (params: Readonly<{ agent: string; target: string }>) => string;
        agentCanUse: (params: Readonly<{ agent: string; target: string }>) => string;
        agentCanSee: (params: Readonly<{ agent: string; target: string }>) => string;
        onMachine: (params: Readonly<{ machine: string }>) => string;
        connectingTitle: (params: Readonly<{ target: string }>) => string;
        unavailableTitle: string;
        unavailableBody: (params: Readonly<{ agent: string }>) => string;
        endedTitle: (params: Readonly<{ target: string }>) => string;
        endedBody: (params: Readonly<{ agent: string }>) => string;
        stalled: string;
        inputA11y: (params: Readonly<{ target: string }>) => string;
        notSharedTitle: string;
        notSharedBody: (params: Readonly<{ agent: string }>) => string;
        moreA11y: string;
        tabFallback: string;
        sourceComputer: string;
        sourceBrowser: string;
        sourceA11y: string;
        watchingA11y: (params: Readonly<{ source: string; machine: string }>) => string;
        expandView: string;
        restoreView: string;
        dockView: string;
        closeView: string;
        moveView: string;
        resizeView: string;
        moveTopLeft: string;
        moveTopRight: string;
        moveBottomLeft: string;
        moveBottomRight: string;
        larger: string;
        smaller: string;
        viewOptions: string;
        presentedElsewhereTitle: string;
        presentedElsewhereBody: string;
        closeHint: string;
        agentWorkingOn: (params: Readonly<{ agent: string; machine: string }>) => string;
        watchingSourceA11y: (params: Readonly<{ source: string }>) => string;
        controlNotAllowed: string;
        paused: (params: Readonly<{ time: string }>) => string;
        offlineTitle: (params: Readonly<{ machine: string }>) => string;
        offlineBody: string;
        openingTitle: (params: Readonly<{ target: string; machine: string }>) => string;
    }>;
    strip: Readonly<{
        using: (params: Readonly<{ target: string }>) => string;
        on: (params: Readonly<{ machine: string }>) => string;
        stop: string;
        paused: (params: Readonly<{ agent: string }>) => string;
        pausedDetail: (params: Readonly<{ target: string }>) => string;
    }>;
    tool: Readonly<{
        capture: string;
        captureRunning: string;
        query: string;
        queryRunning: string;
        click: string;
        clickRunning: string;
        clickTarget: (params: Readonly<{ target: string }>) => string;
        type: string;
        typeRunning: string;
        typeTarget: (params: Readonly<{ target: string }>) => string;
        pressKey: (params: Readonly<{ key: string }>) => string;
        press: string;
        pressRunning: string;
        mayHaveLanded: string;
        failed: string;
    }>;
}>;


export const computerUseTranslationsEnglish = { en: {
        approval: {
            sectionTitle: 'On the computer',
            act: {
                list: 'See which windows are open',
                see: 'Take a screenshot',
                read: 'Read the text and controls',
                click: 'Click',
                press: 'Press a key',
                type: 'Type',
                share: 'Share a window',
            },
            windowOn: ({ machine }) => `A window on ${machine}`,
            screenOf: ({ machine }) => `The whole screen of ${machine}`,
            windowsOn: ({ machine }) => `The open windows on ${machine}`,
            window: 'A window',
            screen: 'The whole screen',
            windows: 'The open windows',
            typedLabel: 'Text',
            keyLabel: 'Key',
            listConsequence: 'Only the names of the open windows are shared, not what is in them.',
            seeConsequence: 'Screenshots are shared with this session. No clicking or typing.',
            useConsequence: 'Input that reaches the machine can’t be undone. You can stop it at any time.',
            targetOn: ({ machine, target }) => `${target} on ${machine}`,
            chooseFirst: 'Choose the window first',
            cropA11y: ({ target }) => `The latest picture of ${target}`,
            suggestsWindow: ({ agent, target }) => `${agent} suggests “${target}”`,
        },
        request: {
            title: ({ agent, machine }) => `${agent} wants to use a window on ${machine}`,
            body: 'You choose the window. Nothing is shared until you do.',
            choose: 'Choose a window',
            change: 'Change window',
            shared: ({ target }) => `Shared ${target}`,
            watch: 'Watch',
        },
        picker: {
            title: ({ agent }) => `Let ${agent} use a window`,
            description: ({ agent }) => `You choose what to share with ${agent}.`,
            windows: 'Windows',
            screens: 'Whole display',
            untitledWindow: 'Untitled window',
            screenLabel: ({ index }) => `Screen ${index}`,
            share: 'Share window',
            shareScreen: 'Share screen',
            shareApp: ({ app }) => `Share ${app} window`,
            stopSharing: 'Stop sharing',
            loadingTitle: ({ machine }) => `Looking for windows on ${machine}`,
            noScreenTitle: ({ machine }) => `${machine} has no screen to share`,
            noScreenBody: 'It runs without a desktop Happier can see. Use a machine with a screen.',
            unsupportedTitle: ({ machine }) => `Happier can’t use the screen of ${machine} yet`,
            unsupportedBody: 'Sharing a window works on Linux desktops for now.',
            failedTitle: ({ machine }) => `Couldn’t list the windows on ${machine}`,
            failedBody: 'Check that Happier is running there, then try again.',
            emptyTitle: ({ machine }) => `No windows are open on ${machine}`,
            emptyBody: 'Open the window you want to share, then check again.',
            tryAgain: 'Try again',
            inUse: 'Another session is using this window. Choose another one.',
            closed: 'That window closed. Choose another one.',
            selectFailed: 'Couldn’t share that window. Try again.',
            otherMachineTitle: ({ machine }) => `${machine} isn’t this session’s machine`,
            otherMachineBody: 'Windows can be shared only on the machine this session runs on.',
            purpose: ({ session }) => `For “${session}”.`,
            purposeIn: ({ project, session }) => `For “${session}” in ${project}.`,
            access: ({ agent }) => `${agent} can`,
            accessValue: 'See and use it',
            accessSee: 'See it',
            displayUnavailable: 'Whole-display sharing is unavailable on this machine.',
            wholeDisplayBody: ({ display }) => `Everything visible on ${display} can be seen, including other apps and notifications.`,
            policyBoth: ({ agent }) => `${agent} asks before each screenshot, click and keystroke.`,
            policyInput: ({ agent }) => `${agent} asks before each click and keystroke.`,
            policyCapture: ({ agent }) => `${agent} asks before each screenshot.`,
            policyNone: ({ agent }) => `${agent} doesn’t ask before screenshots, clicks or keystrokes.`,
            policyChange: 'Change',
            suggests: ({ agent }) => `${agent} suggests`,
            usingIt: 'the agent is using it',
            displayShared: 'everything on it is shared',
            refresh: 'Refresh sources',
            footnote: 'Listing windows asks you first; sharing a whole display asks again.',
            wholeDisplayTitle: 'Share the whole display?',
            allowSee: 'Allow viewing',
            allowUse: 'Allow mouse and keyboard',
            allowUseHint: ({ agent }) => `${agent} can use this display. You can take control back any time.`,
            shareDisplay: 'Share display',
        },
        permission: {
            input: 'Accessibility',
            denied: 'Not allowed',
            opened: ({ machine }) => `Opened on ${machine}. Allow Happier there, then check again.`,
            openFailed: 'Couldn’t open System Settings there. Open it on that computer.',
            checkAgain: 'Check again',
            captureTitle: ({ machine }) => `Allow Screen Recording on ${machine} to watch its windows or display.`,
            inputTitle: ({ machine }) => `Allow Accessibility on ${machine} to use its mouse and keyboard.`,
            unknownTitle: ({ machine }) => `Couldn’t check screen permissions on ${machine}. Check again before sharing.`,
            separateBody: ({ machine }) => `Accessibility is separate: it lets you use the mouse and keyboard there. Each is granted on ${machine}, not on this device.`,
            onMachineBody: ({ machine }) => `It is granted on ${machine}, not on this device.`,
            openPrivacy: ({ machine }) => `Open privacy settings on ${machine}`,
        },
        viewer: {
            agentUsing: ({ agent, target }) => `${agent} is using ${target}`,
            agentCanUse: ({ agent, target }) => `${agent} can use ${target}`,
            agentCanSee: ({ agent, target }) => `${agent} can see ${target}`,
            onMachine: ({ machine }) => `On ${machine}`,
            connectingTitle: ({ target }) => `Connecting to ${target}`,
            unavailableTitle: 'Can’t show this window right now',
            unavailableBody: ({ agent }) => `You can still stop ${agent} here.`,
            endedTitle: ({ target }) => `${target} closed`,
            endedBody: ({ agent }) => `${agent} can’t see or use it any more. Choose another window to continue.`,
            stalled: 'Showing the last picture · reconnecting',
            inputA11y: ({ target }) => `${target}, live. Click or type to take control.`,
            notSharedTitle: 'No window is shared',
            notSharedBody: ({ agent }) => `Choose a window for ${agent} to use.`,
            moreA11y: 'Window options',
            tabFallback: 'Computer',
            sourceComputer: 'Computer',
            sourceBrowser: 'Browser',
            sourceA11y: 'Source',
            watchingA11y: ({ source, machine }) => `Watching ${source} on ${machine}`,
            expandView: 'Expand view',
            restoreView: 'Restore view',
            dockView: 'Dock view',
            closeView: 'Close view',
            moveView: 'Move view',
            resizeView: 'Resize view',
            moveTopLeft: 'Move to top left',
            moveTopRight: 'Move to top right',
            moveBottomLeft: 'Move to bottom left',
            moveBottomRight: 'Move to bottom right',
            larger: 'Larger',
            smaller: 'Smaller',
            viewOptions: 'View options',
            presentedElsewhereTitle: 'Showing in the floating view',
            presentedElsewhereBody: 'Dock it here to keep it beside your work.',
            closeHint: 'Closes this viewer. The session keeps running.',
            agentWorkingOn: ({ agent, machine }) => `${agent} is working on ${machine}`,
            watchingSourceA11y: ({ source }) => `Watching ${source}`,
            controlNotAllowed: 'Mouse and keyboard control aren’t allowed',
            paused: ({ time }) => `Stream paused · last frame ${time}`,
            offlineTitle: ({ machine }) => `${machine} isn’t answering`,
            offlineBody: 'Reconnect to watch it. Watching doesn’t start it.',
            openingTitle: ({ target, machine }) => `Opening ${target} on ${machine}…`,
        },
        strip: {
            using: ({ target }) => `Using ${target}`,
            on: ({ machine }) => `on ${machine}`,
            stop: 'Stop',
            paused: ({ agent }) => `${agent} is paused`,
            pausedDetail: ({ target }) => `You have control of ${target}`,
        },
        tool: {
            capture: 'Took a screenshot',
            captureRunning: 'Taking a screenshot',
            query: 'Read the window’s text and controls',
            queryRunning: 'Reading the window',
            click: 'Clicked in the window',
            clickRunning: 'Clicking in the window',
            clickTarget: ({ target }) => `Clicked “${target}”`,
            type: 'Typed into the window',
            typeRunning: 'Typing into the window',
            typeTarget: ({ target }) => `Typed into “${target}”`,
            pressKey: ({ key }) => `Pressed ${key}`,
            press: 'Pressed a key',
            pressRunning: 'Pressing a key',
            mayHaveLanded: 'may have landed',
            failed: 'Didn’t go through',
        },
    } } satisfies Pick<Record<string, ComputerUseTranslations>, "en">;