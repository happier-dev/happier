export type MachineSharingCopy = Readonly<{
    title: string; description: string; recipientDescription: string; trustedOsLead: string; trustedOsDetail: string;
    recipientTrustLead: string; recipientTrustDetail: string; manageHelp: string; recipientEncryptionIncompatible: string;
    loading: string; readError: string; offline: string; offlineRecipient: string; approvalPending: string; denied: string; use: string; manage: string;
    allMembers: string; pending: string; incompatible: string; incompatibleHelp: string; plain: string;
    saved: string; yourAccess: string; ownHistory: string; through: string; leave: string; inherited: string; unavailable: string; saveFailed: string;
    effectiveLoss: string; overlap: string; custodianProtected: string; revoked: string;
    unpublished: string; custodianOnly: string; upgradeRequired: string; unpublishedTag: string; unpublishedMember: string;
    destinations: Readonly<{ yours: string; created: string; shared: string; sharedWithoutOwner: string; owner: string; ownerOnly: string; pendingKey: string; sharedPurposeUnsupported: string }>;
    terminals: Readonly<{ projectEmpty: string; opening: string; sharedOsLead: string; sharedOsDetail: string; denied: string;
        rootDenied: string; offline: string; openUnknown: string; unavailable: string; failed: string }>;
}>;

/** Locale-owned templates retain the typed interpolation contract. */
export function createMachineSharingTranslations(copy: MachineSharingCopy) {
    const format = (value: string, parameters: Readonly<Record<string, string>>) =>
        value.replace(/\{(machine|person|audience|team|owner|platform|draft|current)\}/g, (match, name: string) => parameters[name] ?? match);
    const machine = (value: string) => (parameters: Readonly<{ machine: string }>) => format(value, parameters);
    return { machines: { sharing: {
        title: copy.title, description: machine(copy.description), recipientDescription: machine(copy.recipientDescription),
        trustedOsLead: machine(copy.trustedOsLead), trustedOsDetail: machine(copy.trustedOsDetail),
        recipientTrustLead: machine(copy.recipientTrustLead), recipientTrustDetail: machine(copy.recipientTrustDetail),
        manageHelp: machine(copy.manageHelp), loading: machine(copy.loading),
        readError: machine(copy.readError), offline: machine(copy.offline), offlineRecipient: machine(copy.offlineRecipient), approvalPending: copy.approvalPending, denied: machine(copy.denied),
        use: copy.use, manage: copy.manage, allMembers: copy.allMembers, pending: machine(copy.pending),
        incompatible: (parameters: Readonly<{ machine: string; person: string }>) => format(copy.incompatible, parameters),
        incompatibleHelp: (parameters: Readonly<{ person: string }>) => format(copy.incompatibleHelp, parameters),
        plain: copy.plain, saved: copy.saved, yourAccess: copy.yourAccess, ownHistory: machine(copy.ownHistory),
        through: (parameters: Readonly<{ audience: string }>) => format(copy.through, parameters),
        leave: copy.leave, inherited: (parameters: Readonly<{ audience: string }>) => format(copy.inherited, parameters),
        unavailable: machine(copy.unavailable),
        saveFailed: (parameters: Readonly<{ person: string; draft: string; current: string }>) => format(copy.saveFailed, parameters), effectiveLoss: copy.effectiveLoss, overlap: copy.overlap,
        revoked: (parameters: Readonly<{ owner: string; machine: string }>) => format(copy.revoked, parameters),
        custodianProtected: copy.custodianProtected,
        unpublished: machine(copy.unpublished), custodianOnly: machine(copy.custodianOnly), upgradeRequired: machine(copy.upgradeRequired),
        unpublishedTag: copy.unpublishedTag,
        unpublishedMember: (parameters: Readonly<{ machine: string; person: string }>) => format(copy.unpublishedMember, parameters),
    }, destinations: {
        recipientEncryptionIncompatible: copy.recipientEncryptionIncompatible,
        yours: copy.destinations.yours, created: copy.destinations.created,
        shared: (parameters: Readonly<{ team: string }>) => format(copy.destinations.shared, parameters),
        sharedWithoutOwner: copy.destinations.sharedWithoutOwner,
        owner: (parameters: Readonly<{ owner: string; platform: string }>) => format(copy.destinations.owner, parameters),
        ownerOnly: (parameters: Readonly<{ owner: string }>) => format(copy.destinations.ownerOnly, parameters),
        pendingKey: copy.destinations.pendingKey, sharedPurposeUnsupported: copy.destinations.sharedPurposeUnsupported,
    }, terminals: {
        projectEmpty: copy.terminals.projectEmpty, opening: copy.terminals.opening, sharedOsLead: machine(copy.terminals.sharedOsLead), sharedOsDetail: machine(copy.terminals.sharedOsDetail),
        denied: copy.terminals.denied, rootDenied: copy.terminals.rootDenied, offline: copy.terminals.offline,
        openUnknown: copy.terminals.openUnknown, unavailable: copy.terminals.unavailable, failed: copy.terminals.failed,
    } } };
}
