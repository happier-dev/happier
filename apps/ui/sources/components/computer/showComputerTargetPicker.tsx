import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { ComputerAccessV1, ComputerSelectedTargetResponseV1 } from '@happier-dev/protocol';

import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import type { CustomModalChromeConfig, CustomModalInjectedProps } from '@/modal/types';
import {
    type ComputerActionExecute,
    type ComputerSessionScope,
} from '@/sync/domains/computer/computerControlClient';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { isActionApprovalRequiredInState } from '@/sync/domains/settings/actionsSettings';
import { getStorage } from '@/sync/domains/state/storage';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { useSessionViewerSourceAccountLifetime } from '@/components/sessions/viewer/SessionViewerSourceAccountScope';
import { t } from '@/text';
import { useDeviceType } from '@/utils/platform/responsive';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';

import {
    ComputerTargetPicker,
    type ComputerTargetEntry,
} from './ComputerTargetPicker';
import { useComputerTargetPicker } from './useComputerTargetPicker';

const stylesheet = StyleSheet.create((theme) => ({
    machine: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingHorizontal: 10,
        paddingVertical: 5,
        borderRadius: 999,
        backgroundColor: theme.colors.surface.inset,
    },
    machineText: {
        ...Typography.rowMeta(),
        color: theme.colors.text.primary,
    },
}));

/** The machine the request names, as identity (not a switch: the Session's request fixes the machine). */
function MachineIdentity(props: Readonly<{ name: string }>): React.ReactElement {
    const { theme } = useUnistyles();
    return (
        <View style={stylesheet.machine} accessibilityLabel={props.name} testID="computer-target-picker-machine">
            <Icon name="laptop" size={ICON_SIZE.sm} color={theme.colors.text.secondary} />
            <Text style={stylesheet.machineText} numberOfLines={1}>{props.name}</Text>
        </View>
    );
}

/** The picker's card: the act as title, the promise as subtitle, the machine as identity. */
export function computerTargetPickerChrome(params: Readonly<{ agentName: string; machineName: string; purpose?: string | null }>): CustomModalChromeConfig {
    const promise = t('computerUse.picker.description', { agent: params.agentName });
    return {
        kind: 'card',
        testID: 'computer-target-picker-modal',
        title: t('computerUse.picker.title', { agent: params.agentName }),
        // For which Session (and where), then the promise (lab TP).
        subtitle: params.purpose ? `${params.purpose} ${promise}` : promise,
        actions: <MachineIdentity name={params.machineName} />,
        dimensions: { width: 560, maxHeightRatio: 0.9, size: 'md' },
        // A phone gets the lab's bottom sheet, in thumb reach.
        phonePresentation: 'sheet',
    };
}

export type PickerModalProps = CustomModalInjectedProps & Readonly<{
    scope: ComputerSessionScope;
    accountLifetime?: ServerAccountScopeLifetime | null;
    agentName: string;
    machineName: string;
    currentTargetKey: string | null;
    access?: ComputerAccessV1;
    /** The agent's suggestion while approving its `computer.target.select` (W15 `requestedTarget`). */
    requestedTarget?: string | null;
    /**
     * Approval mode: the pick goes back to the approval (W15 `approval.request.decide.computerTarget`)
     * instead of being shared directly; approving is what shares it, with the agent's provenance.
     */
    onChosen?: (entry: ComputerTargetEntry, access: ComputerAccessV1) => void;
    /** The request cannot be served here (another machine than the Session's): show why, list nothing. */
    refusalCode?: string;
    execute?: ComputerActionExecute;
    onSelected: (selection: ComputerSelectedTargetResponseV1) => void;
    onStoppedSharing?: () => void;
    /** `switcher`: anchored to the viewer's source switch, where a row is the action. */
    density?: 'form' | 'switcher';
}>;

let frontDoorExecute: ComputerActionExecute | null = null;

/** The picker's data leaf: the machine's own list, the share, and the permission pane, all through W7's owner. */
export function ComputerTargetPickerModal(props: PickerModalProps): React.ReactElement {
    const borrowedLifetime = useSessionViewerSourceAccountLifetime();
    const accountLifetime = props.accountLifetime === undefined
        ? borrowedLifetime ?? (props.execute ? undefined : null) : props.accountLifetime;
    const execute = props.execute ?? (frontDoorExecute ??= createFrontDoorActionExecute());
    const picker = useComputerTargetPicker({ ...props, execute, accountLifetime });
    // The person's own Ask-first preferences for the agent (the existing Actions approval owner).
    const asksBeforeScreenshots = getStorage()((current) => isActionApprovalRequiredInState(current, 'computer.capture', { surface: 'agent' }));
    const asksBeforeInput = getStorage()((current) => isActionApprovalRequiredInState(current, 'computer.input', { surface: 'agent' }));
    const policy = React.useMemo(() => ({ asksBeforeScreenshots, asksBeforeInput }), [asksBeforeInput, asksBeforeScreenshots]);
    const router = useRouter();
    const compact = useDeviceType() === 'phone';
    const changePolicy = React.useCallback(() => {
        props.onClose();
        router.push('/settings/actions');
    }, [props, router]);
    return (
        <ComputerTargetPicker
            machineName={props.machineName}
            state={picker.state}
            selectedKey={picker.selectedKey}
            onSelect={picker.setSelectedKey}
            access={picker.access}
            onAccessChange={picker.setAccess}
            sharing={picker.sharing}
            noticeCode={picker.noticeCode}
            canStopSharing={props.currentTargetKey !== null}
            onShare={picker.share}
            onStopSharing={picker.stopSharing}
            onCancel={props.onClose}
            onRetry={picker.retry}
            onOpenSettings={picker.requestSettings}
            openSettings={picker.openSettings}
            agentName={props.agentName}
            policy={policy}
            onChangePolicy={changePolicy}
            compact={compact}
            suggestedKey={picker.suggestedKey}
            density={props.density}
            currentKey={props.currentTargetKey}
        />
    );
}

export type ComputerTargetPickerRequest = Readonly<{
    scope: ComputerSessionScope;
    accountLifetime?: ServerAccountScopeLifetime | null;
    agentName: string;
    machineName: string;
    /** "For “<session>” in <project>." */
    purpose?: string | null;
    currentTargetKey?: string | null;
    access?: ComputerAccessV1;
    refusalCode?: string;
    requestedTarget?: string | null;
    onChosen?: (entry: ComputerTargetEntry, access: ComputerAccessV1) => void;
    onSelected: (selection: ComputerSelectedTargetResponseV1) => void;
    onStoppedSharing?: () => void;
}>;

/** The picker leaf's props for a request (the modal and the anchored presentation draw the same leaf). */
export function computerTargetPickerProps(params: ComputerTargetPickerRequest): Omit<PickerModalProps, keyof CustomModalInjectedProps> {
    return {
        scope: params.scope,
        accountLifetime: params.accountLifetime,
        agentName: params.agentName,
        machineName: params.machineName,
        currentTargetKey: params.currentTargetKey ?? null,
        access: params.access,
        ...(params.refusalCode ? { refusalCode: params.refusalCode } : {}),
        ...(params.requestedTarget ? { requestedTarget: params.requestedTarget } : {}),
        ...(params.onChosen ? { onChosen: params.onChosen } : {}),
        onSelected: params.onSelected,
        ...(params.onStoppedSharing ? { onStoppedSharing: params.onStoppedSharing } : {}),
    };
}

/**
 * Open the one target picker (lab `computer` TP): from the first consent, from an agent's
 * `target_selection_required` result, or from the viewer's Change window.
 */
export function showComputerTargetPicker(params: ComputerTargetPickerRequest): void {
    Modal.show({
        component: ComputerTargetPickerModal,
        props: computerTargetPickerProps(params),
        chrome: computerTargetPickerChrome({ agentName: params.agentName, machineName: params.machineName, purpose: params.purpose }),
        closeOnBackdrop: true,
    });
}
