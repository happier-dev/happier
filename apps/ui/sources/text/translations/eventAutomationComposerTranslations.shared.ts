

export const english = {
    eventAutomationComposer: {
        payloadSample: 'Sample payload',
        technicalDetails: 'Technical details',
        addFilterClause: 'Filter',
        filterField: 'Filter field',
        filterOperator: 'Filter operator',
        filterEquals: 'Equals',
        filterOneOf: 'Is one of',
        filterContains: 'Contains',
        filterValue: 'Filter value',
        filterValuePlaceholder: '"value" or ["value"]',
        storedContentUnavailableTitle: 'Stored workflow content unavailable',
        storedContentUnavailableBody: 'This Event workflow cannot be saved because its stored content is unavailable.',
        historyGapRecoveryTitle: 'This workflow missed some events',
        historyGapRecoverySubtitle: 'New events won’t start it until it catches up.',
        historyGapRecoveryAction: 'Catch up',
        historyGapRecoveryUnavailable: 'New events won’t start it until it catches up, and the Machine that watches for them isn’t answering.',
        historyGapRecoveryFailureTitle: 'Couldn’t catch up',
        historyGapRecoveryFailureBody: 'New events still won’t start this workflow.',
        sourceStatusTitle: 'Observation source',
        sourceStatusState: {
            uninitialized: 'Not started',
            baselined: 'Baseline ready',
            observing: 'Observing',
            backingOff: 'Waiting to retry',
            attention: 'Needs attention',
        },
        sourceStatusCode: {
            credentialMissing: 'Credential required',
            credentialRevoked: 'Credential revoked',
            rateLimited: 'Rate limited',
            historyGap: 'History gap',
            capacityBlocked: 'Capacity blocked',
            definitionStale: 'Definition changed',
            sourceContractIncompatible: 'Source needs updating',
            admissionUnavailable: 'Admission unavailable',
        },
        sourceStatusNextRetry: ({ time }: { time: string }) => `Next retry: ${time}`,
        sourceStatusObservedCount: ({ count }: { count: number }) => `Events observed: ${count}`,
        sourceStatusAdmittedCount: ({ count }: { count: number }) => `Events admitted: ${count}`,
        sourceStatusSkippedCount: ({ count }: { count: number }) => `Events skipped: ${count}`,
        sourceStatusLastObserved: ({ time }: { time: string }) => `Last observed: ${time}`,
        sourceCatalogStatusTitle: 'Catalog reconciliation',
        sourceCatalogStatusState: {
            current: 'Current',
            reconciling: 'Reconciling',
        },
        sourceCatalogStatusObservedRevision: ({ revision }: { revision: string }) => `Observed revision: ${revision}`,
        sourceCatalogStatusAdoptedRevision: ({ revision }: { revision: string }) => `Adopted revision: ${revision}`,
        sourceCatalogStatusNoAdoptedRevision: 'No revision adopted yet',
        sourceCatalogStatusScanStarted: ({ time }: { time: string }) => `Scan started: ${time}`,
    },
} as const;


export const eventAutomationComposerTranslationsEnglish = { en: english } as const;
