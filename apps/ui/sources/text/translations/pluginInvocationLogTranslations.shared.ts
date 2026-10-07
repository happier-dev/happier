

export const en = {
    invocationLogs: {
        title: 'Invocation logs',
        footer: 'Bounded, redacted records from the selected plugin machine.',
        correlationFilter: 'Correlation ID filter',
        correlationFilterAll: 'All invocations for this plugin',
        correlationPromptTitle: 'Filter by correlation ID',
        correlationPromptBody: 'Show only records from one exact plugin invocation. Leave this empty to show all records.',
        correlationPromptPlaceholder: 'Correlation ID',
        refresh: 'Refresh logs',
        follow: 'Follow logs',
        stopFollowing: 'Stop following',
        loadMore: 'Load next records',
        loadingTitle: 'Loading invocation logs',
        loadingSubtitle: 'Reading bounded, redacted records from the selected machine.',
        idleTitle: 'Ready to read invocation logs',
        idleSubtitle: 'Refresh to read bounded, redacted records from the selected machine.',
        emptyTitle: 'No invocation logs',
        emptySubtitle: 'No matching redacted records are available on this selected machine.',
        unavailableTitle: 'Invocation logs unavailable',
        unavailableSubtitle: 'The selected plugin machine is unavailable or is no longer current.',
        readerUnavailableSubtitle: 'The selected plugin machine cannot provide invocation logs right now.',
        selectionRequiredTitle: 'Select a plugin machine',
        selectionRequiredSubtitle: 'Choose one compatible plugin materialization above before reading its logs.',
        conflictTitle: 'Resolve the selected plugin machine',
        conflictSubtitle: 'Choose one compatible plugin materialization above before reading its logs.',
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