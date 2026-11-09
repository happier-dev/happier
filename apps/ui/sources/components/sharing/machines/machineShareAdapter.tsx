import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';
import { Typography } from '@/constants/Typography';
import type { SelectionListOption, SelectionListSectionDescriptor } from '@/components/ui/selectionList';
import { Text } from '@/components/ui/text/Text';
import { SurfaceStateCard, type SurfaceStateKind } from '@/components/ui/surfaces/SurfaceStateCard';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { t } from '@/text';
import { ShareGrantRow, ShareLevelControl, ShareRowAction } from '../ShareGrantRow';
import { SharePrincipalVisual } from '../buildShareSheetSelectionStep';
import type { ShareSheetAdapter } from '../shareSheetTypes';
import type { MachineShareGrantRow, useMachineShareController } from './useMachineShareController';
import { MachineShareTrustDisclosure } from './MachineShareTrustDisclosure';
import { MachineSeparateUsersOffer } from './MachineSeparateUsersOffer';
import { describeMachineShareTrust } from './machineShareTrust';

/** Domain meaning only. ShareSheet retains list, picker, focus, Back and removal anatomy. */
export function createMachineShareAdapter(input: Readonly<{
    machineName: string; online: boolean | null; controller: ReturnType<typeof useMachineShareController>;
    openApproval?: (artifactId: string) => void;
    /** The machine is shared with the viewer: says so before, or without, a readable access census. */
    shared?: boolean;
}>): ShareSheetAdapter<MachineShareGrantRow> {
    const { machineName: machine, controller } = input;
    // The trust fact is said to whoever reads it: the owner learns what sharing exposes of their
    // operating-system user; someone it is shared with learns whose user their work runs as.
    const own = controller.viewerRow;
    const recipient = own !== null || (controller.response === null && input.shared === true);
    const guest = controller.guestExecution;
    const trust = describeMachineShareTrust(guest.placement, recipient, machine, guest.isolation);
    const adapter: ShareSheetAdapter<MachineShareGrantRow> = {
        namespace: 'machine-share', title: t('machines.sharing.title'),
        showLeadingOnDirectorySteps: true,
        // The sheet leads with the trust fact in one line; Details explains it once: what Manage adds (only to
        // someone who can give it; Can use is the section's own description), why to trust, a plain machine's readability.
        levels: {
            view: { label: t('machines.sharing.use') },
            admin: { label: t('machines.sharing.manage'),
                ...(controller.response?.canManage ? { help: t('machines.sharing.manageHelp', { machine }) } : {}) },
        },
        notes: [trust.detail,
            ...(controller.response?.access.resourceMode === 'plain' ? [t('machines.sharing.plain')] : [])],
        principalTags: (principal, row) => [
            ...(principal.ref.kind === 'account' ? [] : [t('machines.sharing.allMembers')]),
            ...(row?.canPrepareKeys ? [t('machines.destinations.pendingKey')] : []),
            ...(row && row.readiness !== 'ready' && !row.canPrepareKeys
                && !row.audience.some(member => member.reason === 'recipient_encryption_incompatible')
                ? [row.audience.some(member => member.reason === 'content_unpublished')
                    ? t('machines.sharing.unpublishedTag') : t('machines.sharing.unavailable', { machine })] : []),
        ],
        showsLevelLock: row => row.level.kind === 'locked',
        removalLabels: row => row.viewer ? { request: t('machines.sharing.leave'), confirm: t('machines.sharing.leave') }
            : row.readiness === 'key_pending' ? { request: t('common.cancel'), confirm: t('shareSheet.confirmRemove') } : undefined,
        renderGrantDetails: (row, context) => <View style={styles.details}>
            {/* Why the tag says so leads; what Remove would do is said in the row's review. */}
            {row.audience.filter(member => member.reason === 'content_unpublished').map(member => <Text key={member.accountId} style={styles.detail}
                testID={`${context.idPrefix}machine-share-unpublished:${row.principal.key}:${member.accountId}`}>
                {t('machines.sharing.unpublishedMember', { machine, person: member.displayName || t('shareSheet.person') })}
            </Text>)}
            {row.canPrepareKeys ? <>
                <Text style={styles.detail} testID={`${context.idPrefix}machine-share-key-pending:${row.principal.key}`} accessibilityLiveRegion="polite">
                    {t('machines.sharing.pending', { machine })}
                </Text>
                {controller.model.editable ? <ShareRowAction label={t('common.retry')}
                    testID={`${context.idPrefix}machine-share-key-retry:${row.principal.key}`}
                    disabled={row.operation.kind === 'saving' || row.operation.kind === 'removing'}
                    onPress={() => controller.prepareKeys(row.grant)} /> : null}
            </> : null}
            {row.audience.filter(member => member.reason === 'recipient_encryption_incompatible').map(member => <View key={member.accountId}>
                <Text style={styles.detail} testID={`${context.idPrefix}machine-share-incompatible:${row.principal.key}:${member.accountId}`}>
                    {t('machines.sharing.incompatible', { machine, person: member.displayName || t('shareSheet.person') })}
                </Text>
                <Text style={styles.detail}>{t('machines.sharing.incompatibleHelp', { person: member.displayName || t('shareSheet.person') })}</Text>
            </View>)}
            {row.operation.kind === 'error'
                && ['recipient_encryption_incompatible', 'recipient_incompatible'].includes(row.operation.error.code)
                && !row.audience.some(member => member.reason === 'recipient_encryption_incompatible') ? <Text style={styles.detail}>
                {t('machines.sharing.incompatibleHelp', { person: row.principal.displayName })}
            </Text> : null}
            {row.viewer && row.removal.kind !== 'blocked' ? controller.inherited.map(source => <Text style={styles.detail} key={JSON.stringify(source.principal)}>
                {t('machines.sharing.inherited', { audience: source.displayName
                    ?? t(source.principal.kind === 'group' ? 'shareSheet.group' : 'shareSheet.team') })}
            </Text>) : null}
        </View>,
        sections: context => {
            // When sharing itself is refused for a cause someone else must fix, that cause is the sheet's message:
            // it leads, says who can fix it, and the trust explainer about sharing steps aside.
            const refusal = controller.issue && refusedKind(controller.issue.code);
            const leading: SelectionListSectionDescriptor[] = refusal ? [{ kind: 'static', id: 'machine-refused', options: [{
                id: 'machine-refused', label: controller.issue!.message, disabled: true,
                content: <SectionContentRow showDivider={false}><SurfaceStateCard testID={`${context.idPrefix}machine-share-refused`}
                    kind={refusal} layout="inline" title={controller.issue!.message} /></SectionContentRow>,
            }] }] : [{ kind: 'static', id: 'machine-trust', options: [{
                id: 'machine-trust', label: trust.lead, disabled: true,
                // The block sits at the rows' inset, so its edge lines up with the people under it in the
                // page section and in the sheet alike (lab m-share A/S), never flush with the sheet's edge.
                content: <SectionContentRow showDivider={false}><MachineShareTrustDisclosure idPrefix={context.idPrefix}
                    lead={trust.lead}>
                    {!recipient && guest.canEnableSeparateUsers ? <MachineSeparateUsersOffer machine={machine} guestExecution={guest}
                        idPrefix={context.idPrefix} /> : null}
                </MachineShareTrustDisclosure></SectionContentRow>,
            }] }];
            // Access that comes through a Team or Group names it; direct access needs no line.
            const through = own ? controller.inherited[0] : undefined;
            if (own && !context.directoryKind) leading.push({ kind: 'static', id: 'machine-own-access', title: t('machines.sharing.yourAccess'), options: [{
                id: 'machine-viewer-access', testID: `${context.idPrefix}machine-share-your-access`, label: own.principal.displayName,
                // The same person mark as the rows under it, so the card keeps one leading edge.
                icon: () => <SharePrincipalVisual principal={own.principal} testID={`${context.idPrefix}machine-share-your-access-visual`} />,
                ...(through ? { subtitle: t('machines.sharing.through', { audience: through.displayName
                    ?? t(through.principal.kind === 'group' ? 'shareSheet.group' : 'shareSheet.team') }) } : {}),
                onSelect: () => context.onExpand('machine-viewer-access'),
                rightAccessoryOutsidePressable: true,
                rightAccessory: () => <ShareLevelControl row={own} adapter={adapter} actions={controller.actions}
                    onExpand={() => context.onExpand('machine-viewer-access')} editable={false}
                    testID={`${context.idPrefix}machine-share-own-level`} />,
                expandedContentInset: 'text',
                expandedContent: () => <ShareGrantRow row={own} adapter={adapter} actions={controller.actions}
                    context={{ ...context, editable: controller.canLeave }} />,
            }] });
            // Status lines sit on the grant rows' edge as one quiet state each, with their own next step.
            const notices: SelectionListOption[] = [];
            const notice = (id: string, kind: SurfaceStateKind, title: string, action?: Readonly<{ label: string; onPress: () => void }>): SelectionListOption => ({
                id, label: title, disabled: true,
                content: <SurfaceStateCard testID={`${context.idPrefix}machine-share-${id}`} kind={kind} size="line" title={title}
                    {...(action ? { action } : {})} />,
            });
            if (controller.loading) notices.push(notice('loading', 'loading', t('machines.sharing.loading', { machine })));
            if (controller.issue && !refusal) notices.push(notice('read-error', 'error', controller.issue.message,
                controller.issue.retryable ? { label: t('common.retry'), onPress: () => { void controller.retryContent(); } } : undefined));
            // Only someone who can change access is told that changes are saved while it is offline.
            if (input.online === false) notices.push(notice('offline', 'unavailable', t(controller.response?.canManage === false
                ? 'machines.sharing.offlineRecipient' : 'machines.sharing.offline', { machine })));
            if (controller.notice) notices.push(notice('notice', 'warning', controller.notice.message));
            if (controller.approvalId && input.openApproval) {
                const id = controller.approvalId;
                // Waiting on the owner's own approval is the one line here that needs them; it leads to the approval.
                notices.push(notice('approval', 'warning', t('machines.sharing.approvalPending'),
                    { label: t('approvals.details'), onPress: () => input.openApproval?.(id) }));
            }
            return { leading, ...(notices.length ? { trailing: [{ kind: 'static', id: 'machine-status', options: notices }] } : {}) };
        },
    };
    return adapter;
}

/** A cause someone else must fix is not a failure: reserved to the owner reads as denied, waiting on the owner as unavailable. */
function refusedKind(code: string): SurfaceStateKind | null {
    if (code === 'custodian_only') return 'denied';
    return code === 'content_unpublished' || code === 'daemon_upgrade_required' ? 'unavailable' : null;
}

// Grant details read as row descriptions (pending keys, incompatible members, inherited access).
const styles = StyleSheet.create((theme) => ({
    details: { gap: theme.space.s4 },
    detail: {
        ...Typography.default(),
        ...happierPageTextMetrics('rowDescription'),
        color: theme.colors.text.secondary,
    },
}));
