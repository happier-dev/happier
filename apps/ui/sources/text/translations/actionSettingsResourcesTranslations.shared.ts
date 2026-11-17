/** Settings → Actions audience status and machine resource family copy. */
export const actionSettingsResourcesTranslations = {
    en: {
        status: {
            humanAllowed: ({ partial }: { partial: boolean }): string => partial ? "Some app controls can run it" : "You can run it",
            humanAskFirst: ({ partial }: { partial: boolean }): string => partial ? "Some app controls ask you first" : "Asks you first in the app",
            humanOff: ({ partial }: { partial: boolean }): string => partial ? "Off in some app controls" : "Off in the app",
            agentAllowed: ({ partial }: { partial: boolean }): string => partial ? "Some agent tools can run it" : "Agents can run it",
            agentAskFirst: ({ partial }: { partial: boolean }): string => partial ? "Some agent tools ask you first" : "Asks you first when an agent runs it",
            agentOff: ({ partial }: { partial: boolean }): string => partial ? "Off for some agent tools" : "Off for agents",
            integrationAllowed: ({ partial }: { partial: boolean }): string => partial ? "Some integrations can run it" : "Integrations can run it",
            integrationAskFirst: ({ partial }: { partial: boolean }): string => partial ? "Some integrations ask you first" : "Asks you first when an integration runs it",
            integrationOff: ({ partial }: { partial: boolean }): string => partial ? "Off for some integrations" : "Off for integrations",
            allOff: "Off",
            destructive: "Can’t be undone",
            external: "Changes things outside Happier",
        },
        family: {
            title: 'Resources',
            reading: { title: 'Resources · reading', description: 'Looking never changes anything, so these are allowed by default.' },
            changing: { title: 'Resources · changing', description: 'Anything that stops or removes something asks you first by default. Stopping sessions and removing worktrees have their own Actions.' },
            related: 'Its own Action · opens its settings',
        },
        facts: {
            automationsSection: 'Workflows',
            alwaysTrueSection: 'Always true',
            automations: { title: 'Scheduled reviews', subtitle: 'Scheduled reviews use the Agents setting above.' },
            forbidden: { title: 'Forbidden locations', subtitle: 'Happier refuses to move or delete them.' },
            trashFirst: { title: 'Trash and permanent deletion', subtitle: 'Moves go to Happier’s Trash first. Delete now asks by default.' },
        },
    },
} as const;
