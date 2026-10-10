

export const en = {
    invocationLogs: {
        title: 'Invocation logs',
        footer: 'Plugin activity on this machine. Sensitive details are removed.',
        correlationFilter: 'Invocation ID',
        correlationFilterAll: 'All invocations for this plugin',
        correlationPromptTitle: 'Find an invocation',
        correlationPromptBody: 'Enter an invocation ID to see its activity, or leave this empty to see all activity.',
        correlationPromptPlaceholder: 'Invocation ID',
        refresh: 'Refresh logs',
        follow: 'Follow logs',
        stopFollowing: 'Stop following',
        loadMore: 'Load next records',
        loadingTitle: 'Loading invocation logs',
        loadingSubtitle: 'Reading plugin activity from this machine.',
        idleTitle: 'Ready to read invocation logs',
        idleSubtitle: 'Refresh to see plugin activity on this machine.',
        emptyTitle: 'No invocation logs',
        emptySubtitle: 'No matching redacted records are available on this selected machine.',
        unavailableTitle: 'Invocation logs unavailable',
        unavailableSubtitle: 'This machine is no longer available. Choose another machine or try again.',
        readerUnavailableSubtitle: 'The selected plugin machine cannot provide invocation logs right now.',
        selectionRequiredTitle: 'Select a plugin machine',
        selectionRequiredSubtitle: 'Choose a machine above to read its plugin activity.',
        conflictTitle: 'Resolve the selected plugin machine',
        conflictSubtitle: 'Choose a machine above to read its plugin activity.',
        errorTitle: 'Could not load invocation logs',
        errorSubtitle: 'The log read did not complete. Retry after the selected machine is available.',
        noMessage: 'Plugin log event',
        level: {
            debug: 'Debug',
            info: 'Info',
            warn: 'Warning',
            error: 'Error',
            diagnostic: 'Diagnostic',
        },
    },
} as const;


export const pluginInvocationLogTranslationsEnglish = { en } as const;
