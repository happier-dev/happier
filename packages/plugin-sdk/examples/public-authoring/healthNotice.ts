import {
    ProtocolArtifactGetOutputV1Schema,
    ProtocolServiceHealthNoticeSourceV1Schema,
    ProtocolServiceHealthNoticePageV1Schema,
    ProtocolServiceHealthNoticeMachineV1Schema,
    ProtocolDeploymentEnvironmentGetResultV1Schema,
    readOwnedNoticeArtifactV1,
} from '@happier-dev/plugin-sdk/protocol';
import type { NotificationsService } from '@happier-dev/plugin-sdk/notifications';

/** Retain an already-admitted source entry as data. Opening Investigate still
 * re-admits the source and configured Action through the host handoff. */
export function sendProviderIssueNotice(
    notifications: Pick<NotificationsService, 'send'>,
    notice: Readonly<{ clientRequestId: string; categoryId: string; itemId: string; title: string }>,
    entry: Extract<NonNullable<Parameters<NotificationsService['send']>[0]['investigation']>, { kind: 'alertEntry' }>['entry'],
    signal: AbortSignal,
): ReturnType<NotificationsService['send']> {
    return notifications.send({
        ...notice, type: 'update', resolved: false, healthPhase: 'open',
        investigation: { kind: 'alertEntry', entry },
    }, { signal });
}

/** Development-source example: read private evidence, never operation authority. */
export function readServiceHealthEvidence(result: unknown, accountId: string) {
    const read = ProtocolArtifactGetOutputV1Schema.safeParse(result);
    if (!read.success || !read.data.artifact) return null;
    const notice = readOwnedNoticeArtifactV1(read.data.artifact, accountId);
    if (!notice) return null;
    const source = ProtocolServiceHealthNoticeSourceV1Schema.safeParse(notice.source);
    const page = ProtocolServiceHealthNoticePageV1Schema.safeParse(notice.page);
    return source.success && page.success ? { source: source.data, page: page.data, body: notice.body } : null;
}

/** Parse the current Environment read and an explicit choice; Triage still
 * re-admits their relationship, access and reachability before any handoff. */
export function readEnvironmentInvestigationSelection(result: unknown, selectedMachine: unknown) {
    const read = ProtocolDeploymentEnvironmentGetResultV1Schema.safeParse(result);
    const machine = ProtocolServiceHealthNoticeMachineV1Schema.safeParse(selectedMachine);
    return read.success && read.data.ok && machine.success
        ? { environment: read.data.environment, machine: machine.data } : null;
}
