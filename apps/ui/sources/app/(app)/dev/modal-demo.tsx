import React from 'react';
import { View, Text, ScrollView, Platform } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { Modal } from '@/modal';
import { Typography } from '@/constants/Typography';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { confirmActionReview } from '@/components/approvals/ActionConfirmationReview';
import { presentActionApproval } from '@/components/approvals/actionApprovalPresentation';
import { MACHINE_REMOVE_ACTION_ID_V1 } from '@happier-dev/protocol/actions/specs/machineConnectionActionIdsV1';

/** A Machine's carried Restart review (its approval builder's preview): the exact child it would start. */
const RESTART_WORKSPACE = { serverId: 'home', machineId: 'devbox', workspaceId: 'checkout', rootPath: '/src/storefront' };
const RESTART_START = { machineId: 'devbox', targetId: 'web', workspace: RESTART_WORKSPACE,
    declaration: { workspaceRefId: 'checkout', selection: { kind: 'manifest', name: 'web' } }, expectedEffectDigest: 'a'.repeat(64) };
const RESTART_REVIEW = {
    actionId: 'localServices.actions.restartManaged',
    actionArgs: { requestId: 'restart', action: 'restart_managed', target: { kind: 'managed_service', machineId: 'devbox', managedServiceId: 'web-1' } },
    preview: {
        hostReviewedChildren: { children: [{ action: 'localServices.launcher.start', role: 'service.restart.start', input: RESTART_START }] },
        hostReviewedContent: { serviceStartReview: { request: RESTART_START, target: RESTART_WORKSPACE, reviewedEffectDigest: 'a'.repeat(64),
            setup: { required: false, project: { serverId: 'home', projectId: 'storefront' }, reviewedEffectDigest: 'b'.repeat(64), reviewedEffect: {} },
            reviewedEffect: { command: { source: { kind: 'command', command: 'serve web --port 4173' } } } } },
    },
} as const;

// Example custom modal component
function CustomContentModal({ onClose, title, message }: { onClose: () => void; title: string; message: string }) {
    return (
        <View style={styles.customModal}>
            <Text style={[styles.customModalTitle, Typography.default('semiBold')]}>{title}</Text>
            <Text style={[styles.customModalMessage, Typography.default()]}>{message}</Text>
            <View style={styles.customModalButtons}>
                <RoundButton
                    title="Close"
                    onPress={onClose}
                    size="normal"
                />
            </View>
        </View>
    );
}

export default function ModalDemoScreen() {
    const [lastResult, setLastResult] = React.useState<string>('No action taken yet');

    const showSimpleAlert = () => {
        Modal.alert('Simple Alert', 'This is a simple alert modal.');
        setLastResult('Showed simple alert');
    };

    const showAlertWithMessage = () => {
        Modal.alert(
            'Alert with Message',
            'This alert has a longer message that explains something in detail. It can span multiple lines if needed.'
        );
        setLastResult('Showed alert with message');
    };

    const showAlertWithButtons = () => {
        Modal.alert(
            'Multiple Actions',
            'Choose an action:',
            [
                { text: 'Cancel', style: 'cancel', onPress: () => setLastResult('Pressed Cancel') },
                { text: 'Option 1', onPress: () => setLastResult('Pressed Option 1') },
                { text: 'Option 2', onPress: () => setLastResult('Pressed Option 2') }
            ]
        );
    };

    const showConfirm = async () => {
        const result = await Modal.confirm(
            'Confirm Action',
            'Are you sure you want to proceed?'
        );
        setLastResult(`Confirm result: ${result ? 'Confirmed' : 'Cancelled'}`);
    };

    const showDestructiveConfirm = async () => {
        const result = await Modal.confirm(
            'Delete Item',
            'This action cannot be undone. Are you sure?',
            {
                confirmText: 'Delete',
                cancelText: 'Keep',
                destructive: true
            }
        );
        setLastResult(`Delete result: ${result ? 'Deleted' : 'Kept'}`);
    };

    const showCustomModal = () => {
        Modal.show({
            component: CustomContentModal,
            props: {
                title: 'Custom Modal',
                message: 'This is a completely custom modal component. You can put anything in here!'
            }
        });
        setLastResult('Showed custom modal');
    };

    const showMultipleModals = async () => {
        Modal.alert('First Modal', 'This is the first modal');
        
        setTimeout(() => {
            Modal.alert('Second Modal', 'This modal appeared after the first one');
        }, 1500);
        
        setLastResult('Showed multiple modals');
    };

    return (
        <ScrollView style={styles.container}>
            <View style={styles.header}>
                <Text style={[styles.title, Typography.default('semiBold')]}>Modal Demo</Text>
                <Text style={[styles.subtitle, Typography.default()]}>
                    Platform: {Platform.OS} ({Platform.OS === 'web' ? 'Custom modals' : 'Native alerts'})
                </Text>
            </View>

            <ItemList>
                <ItemGroup title="Alert Modals">
                    <Item
                        title="Simple Alert"
                        subtitle="Basic alert with title only"
                        onPress={showSimpleAlert}
                    />
                    <Item
                        title="Alert with Message"
                        subtitle="Alert with title and message"
                        onPress={showAlertWithMessage}
                    />
                    <Item
                        title="Alert with Multiple Buttons"
                        subtitle="Alert with custom buttons"
                        onPress={showAlertWithButtons}
                    />
                </ItemGroup>

                <ItemGroup title="Confirmation Modals">
                    <Item
                        title="Remove machine"
                        destructive
                        onPress={async () => {
                            const actionId = MACHINE_REMOVE_ACTION_ID_V1;
                            const actionArgs = { machineId: 'devbox' };
                            const review = presentActionApproval({ actionId, actionArgs, kind: 'confirmation', subject: 'devbox' });
                            const result = await confirmActionReview({ actionId, actionArgs,
                                title: review.title ?? 'Remove machine', summary: review.summary,
                                confirmLabel: review.confirmLabel ?? 'Remove', irreversible: true, destructive: true, serverId: null });
                            setLastResult(result ? 'Confirmed removal preview' : 'Cancelled removal preview');
                        }}
                    />
                    <Item
                        title="Basic Confirmation"
                        subtitle="Simple yes/no confirmation"
                        onPress={showConfirm}
                    />
                    <Item
                        title="Reviewed Confirmation"
                        subtitle="A Machine's carried Restart review"
                        onPress={async () => {
                            const result = await confirmActionReview({ ...RESTART_REVIEW, title: 'Restart web?',
                                summary: 'This restarts this service now. Anything using its address disconnects while it restarts.',
                                confirmLabel: 'Restart', irreversible: false, serverId: null });
                            setLastResult(`Reviewed result: ${result ? 'Confirmed' : 'Cancelled'}`);
                        }}
                    />
                    <Item
                        title="Destructive Confirmation"
                        subtitle="Confirmation with destructive action"
                        onPress={showDestructiveConfirm}
                        destructive
                    />
                </ItemGroup>

                <ItemGroup title="Custom Modals">
                    <Item
                        title="Custom Modal"
                        subtitle="Fully custom modal component"
                        onPress={showCustomModal}
                    />
                    <Item
                        title="Multiple Modals"
                        subtitle="Show multiple modals in sequence"
                        onPress={showMultipleModals}
                    />
                </ItemGroup>

                <ItemGroup title="Last Action Result">
                    <View style={styles.resultContainer}>
                        <Text style={[styles.resultText, Typography.default()]}>
                            {lastResult}
                        </Text>
                    </View>
                </ItemGroup>
            </ItemList>
        </ScrollView>
    );
}

const styles = StyleSheet.create(() => ({
    container: {
        flex: 1,
        backgroundColor: '#F2F2F7'
    },
    header: {
        padding: 20,
        backgroundColor: '#fff',
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: '#E5E5E7'
    },
    title: {
        fontSize: 24,
        marginBottom: 4
    },
    subtitle: {
        fontSize: 14,
        color: '#8E8E93'
    },
    resultContainer: {
        padding: 16,
        backgroundColor: '#fff'
    },
    resultText: {
        fontSize: 16,
        color: '#007AFF'
    },
    customModal: {
        backgroundColor: '#fff',
        borderRadius: 12,
        padding: 20,
        width: 300,
        alignItems: 'center'
    },
    customModalTitle: {
        fontSize: 20,
        marginBottom: 12
    },
    customModalMessage: {
        fontSize: 16,
        textAlign: 'center',
        marginBottom: 20,
        color: '#666'
    },
    customModalButtons: {
        width: '100%'
    }
}));
