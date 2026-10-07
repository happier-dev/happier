

export type HomeDeviceApprovalTranslation = Readonly<{
    title: string;
    deviceFallback: string;
    homeLabel: (params: Readonly<{ home: string }>) => string;
    expiresLabel: (params: Readonly<{ expiry: string }>) => string;
    requestDetails: string;
    requestDetailsHint: string;
    fingerprintLabel: string;
    requestDetailsHelp: string;
    approve: string;
    reject: string;
    loadError: string;
    /** Why the load failed, when one or more Homes did not answer: `homes` is their names. */
    loadErrorUnreachable: (params: Readonly<{ homes: string }>) => string;
    /** Why the load failed, when one or more Homes answered with an error. */
    loadErrorFailed: (params: Readonly<{ homes: string }>) => string;
    decisionError: string;
    decisionRecovery: string;
    approved: string;
    rejected: string;
    expired: string;
    stopWaiting: string;
}>;


export const homeDeviceApprovalTranslationsEnglish = { en: {
        title: 'Device approvals', deviceFallback: 'New device',
        homeLabel: ({ home }) => `Home: ${home}`, expiresLabel: ({ expiry }) => `Expires: ${expiry}`,
        requestDetails: 'Request details', requestDetailsHint: 'Show the request key identifier',
        fingerprintLabel: 'Request-key fingerprint', requestDetailsHelp: 'This identifies the request key. It is not a code you need to compare.',
        approve: 'Approve', reject: 'Reject', loadError: "Couldn't load device approvals.",
        loadErrorUnreachable: ({ homes }) => `${homes} didn’t answer.`, loadErrorFailed: ({ homes }) => `${homes} answered with an error.`,
        decisionError: "Couldn't update this request.", decisionRecovery: 'Choose Approve or Reject to try again.',
        approved: 'Device approved', rejected: 'Device rejected', expired: 'Expired', stopWaiting: 'Stop waiting',
    } } as const satisfies Pick<Record<string, HomeDeviceApprovalTranslation>, "en">;