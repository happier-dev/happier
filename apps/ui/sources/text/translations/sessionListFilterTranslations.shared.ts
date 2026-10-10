

export function translated(value: typeof en): typeof en { return value; }



export const en = {
    filtersTitle: 'Session filters', filtersSearch: 'Search filters…', filtersShow: 'Show',
    filtersScope: 'Scope', filtersShowSessions: 'Sessions', filtersShowRuns: 'Runs', filtersShowBoth: 'Both',
    filtersShowBothSummary: 'Sessions and runs', filtersStartedByNone: 'No starters selected',
    filtersStartedBy: 'Started by', filtersStartedByYou: 'You', filtersStartedByTriggers: 'Triggers', filtersStartedByAgents: 'Agents',
    filtersRunsNeedingYouAlwaysShow: 'Runs that need you always show',
    filtersMyWork: 'My work', filtersLegacyOwnerDirect: 'My work', filtersAssignedToMe: 'Assigned to me', filtersFollowing: 'Following',
    filtersInvolvingMe: 'Involving me', filtersAllAccessible: 'All accessible', filtersAttention: 'Attention',
    filtersAttentionAny: 'Any', filtersAttentionNeedsMe: 'Only sessions that need me', filtersScopeNeedsMe: 'Needs me',
    filtersInactive: 'Inactive sessions', filtersInactiveShow: 'Show', filtersInactiveHide: 'Hide',
    filtersHomes: 'Homes', filtersSharedWith: 'Shared with', filtersOutsideTeams: 'Personal & direct',
    filtersTags: 'Tags', filtersSource: 'Source', filtersSourceAll: 'All',
    filtersSourceDirect: 'External',
    filtersNoOptions: 'No filters available', filtersClear: 'Clear filters', filtersDone: 'Done', filtersArchived: 'Archived',
    filtersNeedsMeOnly: 'Needs me only', filtersNeedsMeOnlyDescription: 'Sessions waiting on you', filtersSourceHappier: 'Happier',
    filtersMoreTags: ({ count }: { count: number }) => `+ ${count} more`,
    filtersResultCount: ({ count }: { count: number }) => count === 1 ? `1 item` : `${count} items`,
    queryInitialLoadingTitle: 'Loading sessions…', queryUpdatingTitle: 'Updating sessions…',
    querySomeHomesUnavailableTitle: 'Some Homes are unavailable', querySomeHomesUnavailableDescription: 'Showing what Happier can reach. Retry when those Homes are back online.',
    queryRefreshFailedTitle: "Couldn't refresh", queryRefreshFailedRetainedDescription: 'Your loaded sessions are still here. Retry to check for updates.', queryRefreshFailedEmptyDescription: "Happier couldn't load sessions from the selected Homes. Retry when they are reachable.",
    queryNoMatchesLoadedTitle: 'No matches in loaded sessions', queryNoMatchesLoadedDescription: 'More matching sessions may be available on an older page.', querySearchOlder: 'Search older sessions',
    queryMoreAvailableTitle: 'More sessions may be available', queryMoreAvailableDescription: 'This view includes loaded sessions. Search older sessions to continue.',
    queryNoMatchesTitle: 'No sessions match', queryNoMatchesDescription: 'Try changing the active filters.',
    queryTeamEmptyTitle: 'This Team has no sessions', queryTeamEmptyDescription: 'Sessions shared with this Team will appear here.',
    queryMyWorkEmptyTitle: 'Nothing in My work', queryScopeEmptyDescription: 'Try a broader scope or check back later.', queryBrowseAllAccessible: 'Show all sessions',
    queryAssignedEmptyTitle: 'No sessions are assigned to you', queryFollowingEmptyTitle: 'No followed sessions', queryInvolvingEmptyTitle: 'No sessions involving you',
    queryAttentionEmptyTitle: 'No sessions need your attention', queryReachableEmptyTitle: 'No sessions available', queryReachableEmptyDescription: 'No sessions match this view in the reachable Homes.',
    queryHistoricalSharesWithheldTitle: 'Some shared sessions are hidden', queryHistoricalSharesWithheldDescription: 'Sessions shared with you from an earlier version of Happier stay hidden until their owner updates them in Happier.',
    partialHomeNotMountedTitle: ({ home }: { home: string }) => `${home} isn't in this Sessions view`,
    partialHomeNotMountedDescription: "Add this Home to a visible Home group to show the Team's sessions without changing focus.",
    partialShowFromHome: ({ home }: { home: string }) => `Show sessions from ${home}`,
    teamListingUnavailableTitle: 'Team session listing is unavailable on this Home',
    teamListingUnavailableDescription: 'This Home cannot list Team sessions yet. Update or reconfigure the Home, then try again.',
    teamListingLoadingTitle: ({ team }: { team: string }) => `Loading ${team} sessions…`,
    teamListingLoadingDescription: 'Happier is checking what this Home can list.',
    teamListingProbeFailedTitle: "Couldn't reach this Home",
    teamListingProbeFailedDescription: 'Happier could not check this Home for Team sessions. Retry when it is reachable.',
};


export const sessionListFilterTranslationsEnglish = { en };
