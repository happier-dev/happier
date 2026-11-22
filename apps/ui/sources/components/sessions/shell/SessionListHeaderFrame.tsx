import React from 'react';
import { View, type LayoutChangeEvent } from 'react-native';

import type { TreeDropMeasurableRef } from '@/components/ui/treeDragDrop';
import { useSessionListTreeRowRegistration } from './useSessionListTreeRowRegistration';

export type RegisterSessionListTreeRowBounds = (rowId: string, ref: TreeDropMeasurableRef | null) => void;
export type UnregisterSessionListTreeRowBounds = (rowId: string) => void;

export const SessionListHeaderFrame = React.memo(function SessionListHeaderFrame(props: Readonly<{
    children: React.ReactNode;
    treeRowId: string;
    onRegisterTreeRowBounds: RegisterSessionListTreeRowBounds;
    onUnregisterTreeRowBounds: UnregisterSessionListTreeRowBounds;
    onLayout?: (event: LayoutChangeEvent) => void;
}>) {
    const { setWrapperRef, handleLayout } = useSessionListTreeRowRegistration(
        props.treeRowId, props.onRegisterTreeRowBounds, props.onUnregisterTreeRowBounds,
    );
    return (
        <View
            ref={setWrapperRef}
            collapsable={false}
            style={{ position: 'relative' }}
            onLayout={(event) => {
                handleLayout();
                props.onLayout?.(event);
            }}
        >
            {props.children}
        </View>
    );
});
