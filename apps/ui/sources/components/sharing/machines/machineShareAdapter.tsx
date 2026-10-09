import * as React from 'react';
import { View } from 'react-native';
import type { SelectionListOption, SelectionListSectionDescriptor } from '@/components/ui/selectionList';
import { Text } from '@/components/ui/text/Text';
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
        levels: {
            view: { label: t('machines.sharing.use'), help: t('machines.sharing.description', { machine }) },
            admin: { label: t('machines.sharing.manage'), help: t('machines.sharing.manageHelp', { machine }) },
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
        renderGrantDetails: (row, context) => <View>
            {row.canPrepareKeys ? <>
                <Text testID={`${context.idPrefix}machine-share-key-pending:${row.principal.key}`} accessibilityLiveRegion="polite">
                    {t('machines.sharing.pending', { machine })}
                </Text>
                {controller.model.editable ? <ShareRowAction label={t('common.retry')}
                    testID={`${context.idPrefix}machine-share-key-retry:${row.principal.key}`}
                    disabled={row.operation.kind === 'saving' || row.operation.kind === 'removing'}
                    onPress={() => controller.prepareKeys(row.grant)} /> : null}
            </> : null}
            {row.audience.filter(member => member.reason === 'recipient_encryption_incompatible').map(member => <View key={member.accountId}>
                <Text testID={`${context.idPrefix}machine-share-incompatible:${row.principal.key}:${member.accountId}`}>
                    {t('machines.sharing.incompatible', { machine, person: member.displayName || t('shareSheet.person') })}
                </Text>
                <Text>{t('machines.sharing.incompatibleHelp', { person: member.displayName || t('shareSheet.person') })}</Text>
            </View>)}
            {row.operation.kind === 'error'
                && ['recipient_encryption_incompatible', 'recipient_incompatible'].includes(row.operation.error.code)
                && !row.audience.some(member => member.reason === 'recipient_encryption_incompatible') ? <Text>
                {t('machines.sharing.incompatibleHelp', { person: row.principal.displayName })}
            </Text> : null}
            {row.viewer && row.removal.kind !== 'blocked' ? controller.inherited.map(source => <Text key={JSON.stringify(source.principal)}>
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
                    notes={[
                        t('machines.sharing.manageHelp', { machine }),
                        ...(controller.response?.access.resourceMode === 'plain' ? [t('machines.sharing.plain')] : []),
                    ]} />,
            }] }];
            const own = controller.viewerRow;
            if (own && !context.directoryKind) leading.push({ kind: 'static', id: 'machine-own-access', title: t('machines.sharing.yourAccess'), options: [{
                id: 'machine-viewer-access', testID: `${context.idPrefix}machine-share-your-access`, label: own.principal.displayName,
                subtitle: t('machines.sharing.ownHistory', { machine }), onSelect: () => context.onExpand('machine-viewer-access'),
                rightAccessoryOutsidePressable: true,
                rightAccessory: () => <ShareLevelControl row={own} adapter={adapter} actions={controller.actions}
                    onExpand={() => context.onExpand('machine-viewer-access')} editable={false}
                    testID={`${context.idPrefix}machine-share-own-level`} />,
                expandedContent: () => <ShareGrantRow row={own} adapter={adapter} actions={controller.actions}
                    context={{ ...context, editable: controller.canLeave }} />,
            }] });
            const notices: SelectionListOption[] = [];
            if (controller.loading) notices.push({ id: 'loading', label: t('machines.sharing.loading', { machine }), disabled: true, loading: true });
            if (controller.issue) notices.push({ id: 'read-error', label: controller.issue.message,
                ...(controller.issue.retryable ? { subtitle: t('common.retry'), onSelect: () => { void controller.retryContent(); } } : { disabled: true }) });
            if (!input.online) notices.push({ id: 'offline', label: t('machines.sharing.offline', { machine }), disabled: true });
            if (controller.notice) notices.push({ id: 'notice', label: controller.notice.message, disabled: true });
            if (controller.response?.canManage && !controller.model.grants.length) notices.push({ id: 'empty', label: t('machines.sharing.empty', { machine }), disabled: true });
            if (controller.approvalId && input.openApproval) {
                const id = controller.approvalId;
                notices.push({ id: 'approval', label: t('approvals.title'), subtitle: t('approvals.status.open'), onSelect: () => input.openApproval?.(id) });
            }
            return { leading, ...(notices.length ? { trailing: [{ kind: 'static', id: 'machine-status', options: notices }] } : {}) };
        },
    };
    return adapter;
}
