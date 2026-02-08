import React from 'react';
import { View, Text, Pressable, ActivityIndicator } from 'react-native';

export function FriendsGateCentered(props: { title: string; body?: string; children: React.ReactNode }) {
    return (
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24 }}>
            <Text style={{ fontSize: 20, fontWeight: '600', marginBottom: 8 }}>
                {props.title}
            </Text>
            {props.body ? (
                <Text style={{ textAlign: 'center', opacity: 0.7, marginBottom: 16 }}>
                    {props.body}
                </Text>
            ) : null}
            {props.children}
        </View>
    );
}

export function FriendsProviderConnectControls(props: {
    onConnect?: () => void;
    connecting?: boolean;
    connectDisabled?: boolean;
    connectLabel: string;
    notAvailableLabel: string;
    unavailableReason?: string;
    connectButtonColor?: string;
    connectButtonMarginBottom?: number;
    notAvailableMarginTop?: number;
}) {
    const [showHint, setShowHint] = React.useState(false);

    return (
        <>
            <Pressable
                accessibilityRole="button"
                accessibilityLabel={props.connectLabel}
                onPress={props.onConnect}
                disabled={props.connecting === true || props.connectDisabled === true}
                style={{
                    paddingHorizontal: 16,
                    paddingVertical: 12,
                    borderRadius: 10,
                    backgroundColor: props.connectButtonColor ?? '#111827',
                    minWidth: 180,
                    alignItems: 'center',
                    marginBottom: props.connectButtonMarginBottom ?? 12,
                    opacity: props.connectDisabled === true ? 0.5 : 1,
                }}
            >
                {props.connecting ? (
                    <ActivityIndicator size="small" color="#ffffff" />
                ) : (
                    <Text style={{ color: '#ffffff', fontWeight: '600' }}>
                        {props.connectLabel}
                    </Text>
                )}
            </Pressable>

            <Pressable
                accessibilityRole="button"
                accessibilityLabel={props.notAvailableLabel}
                onPress={() => setShowHint((v) => !v)}
                style={{
                    paddingVertical: 8,
                    paddingHorizontal: 12,
                    marginTop: props.notAvailableMarginTop ?? 0,
                }}
            >
                <Text style={{ opacity: 0.8 }}>
                    {props.notAvailableLabel}
                </Text>
            </Pressable>

            {showHint && props.unavailableReason ? (
                <Text style={{ textAlign: 'center', marginTop: 8, opacity: 0.7 }}>
                    {props.unavailableReason}
                </Text>
            ) : null}
        </>
    );
}

export function FriendsProviderGate(props: {
    isConnected: boolean;
    title: string;
    body: string;
    connectLabel: string;
    notAvailableLabel: string;
    unavailableReason?: string;
    connectButtonColor?: string;
    onConnect: () => void;
    connecting?: boolean;
    connectDisabled?: boolean;
    connectButtonMarginBottom?: number;
    notAvailableMarginTop?: number;
    children: React.ReactNode;
}) {
    if (props.isConnected) {
        return <>{props.children}</>;
    }

    return (
        <FriendsGateCentered title={props.title} body={props.body}>
            <FriendsProviderConnectControls
                onConnect={props.onConnect}
                connecting={props.connecting}
                connectDisabled={props.connectDisabled}
                unavailableReason={props.unavailableReason}
                connectLabel={props.connectLabel}
                notAvailableLabel={props.notAvailableLabel}
                connectButtonColor={props.connectButtonColor}
                connectButtonMarginBottom={props.connectButtonMarginBottom}
                notAvailableMarginTop={props.notAvailableMarginTop}
            />
        </FriendsGateCentered>
    );
}
