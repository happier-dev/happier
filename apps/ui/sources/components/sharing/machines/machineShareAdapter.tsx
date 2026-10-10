import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';
import { Typography } from '@/constants/Typography';
import type { SelectionListOption, SelectionListSectionDescriptor } from '@/components/ui/selectionList';
import { Text } from '@/components/ui/text/Text';
import { SurfaceStateCard, type SurfaceStateKind } from '@/components/ui/surfaces/SurfaceStateCard';
import { t } from '@/text';
import { ShareGrantRow, ShareLevelControl, ShareRowAction } from '../ShareGrantRow';
import type { ShareSheetAdapter } from '../shareSheetTypes';
import type { MachineShareGrantRow, useMachineShareController } from './useMachineShareController';
import { MachineShareTrustDisclosure } from './MachineShareTrustDisclosure';

/** Domain meaning only. ShareSheet retains list, picker, focus, Back and removal anatomy. */
export function createMachineShareAdapter(input: Readonly<{
    machineName: string; online: boolean; controller: ReturnType<typeof useMachineShareController>;
    openApproval?: (artifactId: string) => void;
}>): ShareSheetAdapter<MachineShareGrantRow> {
    const { machineName: machine, controller } = input;
    const adapter: ShareSheetAdapter<MachineShareGrantRow> = {
        namespace: 'machine-share', title: t('machines.sharing.title'),
        showLeadingOnDirectorySteps: true,
        // The level meanings live once, inside the trust disclosure: Can use is the section's own
        // description, so only what Manage adds is said there (lab m-share legend).
        levels: {
            view: { label: t('machines.sharing.use') },
            admin: { label: t('machines.sharing.manage') },
        },
        principalTags: (principal, row) => [
            ...(principal.ref.kind === 'account' ? [] : [t('machines.sharing.allMembers')]),
            ...(row?.canPrepareKeys ? [t('machines.destinations.pendingKey')] : []),
            ...(row && row.readiness !== 'ready' && !row.canPrepareKeys
                && !row.audience.some(member => member.reason === 'recipient_encryption_incompatible')
                ? [t('machines.sharing.unavailable', { machine })] : []),
        ],
        showsLevelLock: row => row.level.kind === 'locked',
        removalLabels: row => row.viewer ? { request: t('machines.sharing.leave'), confirm: t('machines.sharing.leave') }
            : row.readiness === 'key_pending' ? { request: t('common.cancel'), confirm: t('shareSheet.confirmRemove') } : undefined,
        renderGrantDetails: (row, context) => <View style={styles.details}>
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
            const leading: SelectionListSectionDescriptor[] = [{ kind: 'static', id: 'machine-trust', options: [{
                id: 'machine-trust', label: t('machines.sharing.description', { machine }), disabled: true,
                content: <MachineShareTrustDisclosure idPrefix={context.idPrefix}
                    lead={t('machines.sharing.trustedOsLead', { machine })}
                    detail={t('machines.sharing.trustedOsDetail', { machine })}
                    legend={[{ label: t('machines.sharing.manage'), text: t('machines.sharing.manageHelp', { machine }) }]}
                    notes={controller.response?.access.resourceMode === 'plain' ? [t('machines.sharing.plain')] : []} />,
            }] }];
            const own = controller.viewerRow;
            if (own && !context.directoryKind) leading.push({ kind: 'static', id: 'machine-own-access', title: t('machines.sharing.yourAccess'), options: [{
                id: 'machine-viewer-access', testID: `${context.idPrefix}machine-share-your-access`, label: own.principal.displayName,
                subtitle: t('machines.sharing.ownHistory', { machine }), onSelect: () => context.onExpand('machine-viewer-access'),
                rightAccessoryOutsidePressable: true,
                rightAccessory: () => <ShareLevelControl row={own} adapter={adapter} actions={controller.actions}
                    onExpand={() => context.onExpand('machine-viewer-access')} editable={false}
                    testID={`${context.idPrefix}machine-share-own-level`} />,
                expandedContentInset: 'row',
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
            if (controller.issue) notices.push(notice('read-error', 'error', controller.issue.message,
                controller.issue.retryable ? { label: t('common.retry'), onPress: () => { void controller.retryContent(); } } : undefined));
            if (!input.online) notices.push(notice('offline', 'unavailable', t('machines.sharing.offline', { machine })));
            if (controller.notice) notices.push(notice('notice', 'warning', controller.notice.message));
            if (controller.response?.canManage && !controller.model.grants.length) notices.push(notice('empty', 'empty', t('machines.sharing.empty', { machine })));
            if (controller.approvalId && input.openApproval) {
                const id = controller.approvalId;
                notices.push({ id: 'approval', label: t('approvals.title'), subtitle: t('approvals.status.open'), onSelect: () => input.openApproval?.(id) });
            }
            return { leading, ...(notices.length ? { trailing: [{ kind: 'static', id: 'machine-status', options: notices }] } : {}) };
        },
    };
    return adapter;
}

// Grant details read as row descriptions (pending keys, incompatible members, inherited access).
const styles = StyleSheet.create((theme) => ({
    details: { gap: 4 },
    detail: {
        ...Typography.default(),
        ...happierPageTextMetrics('rowDescription'),
        color: theme.colors.text.secondary,
    },
}));
