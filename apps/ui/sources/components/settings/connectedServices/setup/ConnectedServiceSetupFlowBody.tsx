import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { t } from '@/text';

export type ConnectedServiceSetupMethod = Readonly<{
    id: string;
    title: string;
    recommended: boolean;
}>;

/**
 * The inside of a setup panel for one service: the ways to sign in (the recommended one first and
 * already running), then the running flow itself — the code to enter, the steps to paste back, or the
 * key to paste — with its waiting, failure and recovery states from the controller.
 */
export function ConnectedServiceSetupFlowBody(props: Readonly<{
    state: 'ready' | 'preparing' | 'chooseMachine' | 'unknownService';
    methods?: readonly ConnectedServiceSetupMethod[];
    activeMethodId?: string | null;
    methodsDisabled?: boolean;
    onSelectMethod?: (methodId: string) => void;
    flow?: React.ReactNode;
}>) {
    const styles = stylesheet;
    if (props.state === 'chooseMachine') {
        return (
            <SurfaceStateCard
                testID="connected-service-setup:choose-machine"
                size="line"
                kind="unavailable"
                title={t('connectedServicesSettings.setupChooseMachine')}
            />
        );
    }
    if (props.state === 'unknownService') {
        return (
            <SurfaceStateCard
                testID="connected-service-setup:unknown-service"
                size="line"
                kind="unavailable"
                title={t('connectedServices.detail.unknownService')}
            />
        );
    }
    const methods = props.methods ?? [];
    const activeMethodId = props.activeMethodId && methods.some((method) => method.id === props.activeMethodId)
        ? props.activeMethodId
        : methods[0]?.id ?? null;
    return (
        <View style={styles.body} testID="connected-service-setup:flow">
            {methods.length > 1 && activeMethodId ? (
                <View style={styles.methods}>
                    <SegmentedTabBar
                        role="radiogroup"
                        testIDPrefix="connected-service-setup:method"
                        accessibilityLabel={t('connectedServicesSettings.setupHowToSignIn')}
                        segmentSizing="content"
                        tabs={methods.map((method) => ({
                            id: method.id,
                            label: method.title,
                            badge: method.recommended ? t('connectedServicesSettings.methodRecommended') : undefined,
                        }))}
                        activeTabId={activeMethodId}
                        disabled={props.methodsDisabled}
                        onSelectTab={(id) => props.onSelectMethod?.(id)}
                    />
                </View>
            ) : null}
            {props.state === 'preparing' || !props.flow ? (
                <SurfaceStateCard
                    testID="connected-service-setup:preparing"
                    size="line"
                    kind="loading"
                    title={t('connectedServices.deviceAuth.preparing')}
                />
            ) : props.flow}
        </View>
    );
}

const stylesheet = StyleSheet.create(() => ({
    body: {
        gap: 12,
    },
    methods: {
        alignItems: 'flex-start',
    },
}));

export type ConnectedServiceSetupFlowAction = Readonly<{
    testID: string;
    label: string;
    onPress: () => void;
    disabled?: boolean;
    loading?: boolean;
}>;

/**
 * A sign-in flow's footer in a setup panel: secondary Cancel (local: the panel steps back at once)
 * beside the step's one primary action, right-aligned under the flow.
 */
export function ConnectedServiceSetupFlowActions(props: Readonly<{
    onCancel?: () => void;
    primary?: ConnectedServiceSetupFlowAction;
}>) {
    return (
        <View style={flowActionStyles.row}>
            {props.onCancel ? (
                <RoundButton
                    testID="connected-account-setup:cancel"
                    size="small"
                    display="inverted"
                    title={t('common.cancel')}
                    onPress={props.onCancel}
                />
            ) : null}
            {props.primary ? (
                <RoundButton
                    testID={props.primary.testID}
                    size="small"
                    title={props.primary.label}
                    disabled={props.primary.disabled}
                    loading={props.primary.loading}
                    onPress={props.primary.onPress}
                />
            ) : null}
        </View>
    );
}

const flowActionStyles = StyleSheet.create(() => ({
    row: {
        flexDirection: 'row',
        justifyContent: 'flex-end',
        alignItems: 'center',
        gap: 8,
    },
}));
