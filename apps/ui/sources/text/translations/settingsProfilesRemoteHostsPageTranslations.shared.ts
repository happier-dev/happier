

export function translated(value: typeof english): typeof english {
    return value;
}



export const english = {
    settingsProfilesPage: {
        pageDescription: 'Launch settings a new session can start with: the agent, model, environment variables and where it runs.',
        useProfilesSection: 'Profile selection',
        useProfilesSectionDescription: "Pick a profile when you start a session, or start every session with the machine's environment.",
        useProfiles: 'Use profiles',
        useProfilesOffDescription: "Off. New sessions use the machine's environment.",
        favoritesDescription: 'Shown first when you pick a profile.',
        customDescription: 'Profiles you made. Editing a built-in profile saves your own copy here.',
        builtInDescription: 'Ready-made profiles for each agent.',
    },
    settingsRemoteHostsPage: {
        pageDescription: 'SSH hosts this computer can set up as machines, connect to, or run a relay on.',
        savedHostsSection: 'Saved hosts',
        savedHostsDescription: "Most recently used first. Open a host to use or change it.",
        hostPageDescription: "An SSH host this computer can set up as a machine, connect to, or run a relay on.",
        newHostTitle: "New remote host",
        newHostDescription: "Name the host and say how to reach it over SSH.",
        useSection: "Use this host",
        useSectionDescription: "What this device can do with it.",
        maintenanceSection: "Happier on this host",
        maintenanceSectionDescription: "Install, update and run Happier's command line, background service and relay there.",
        discard: "Discard",
        accessTitle: "Keys and connections",
        accessRowSubtitle: "Trusted host keys and open tunnels",
        accessPageDescription: "Host keys this device trusts, and the tunnels and access routes open to your hosts.",
        hostNotFound: "This host is no longer saved.",
        unavailableDescription: 'Saved SSH hosts can be set up as machines or used as relays.',
        trustedHostKeysDescription: 'Keys this device accepted when connecting. Remove one to be asked again next time.',
        trustedHostKeysEmpty: 'No trusted host keys yet. Keys appear here once you accept one while connecting.',
        sshTunnelsDescription: 'Tunnels open from this device to a saved host.',
    },
};


export const settingsProfilesRemoteHostsPageTranslationsEnglish = { en: english };