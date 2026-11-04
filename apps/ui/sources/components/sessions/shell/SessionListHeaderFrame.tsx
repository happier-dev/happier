import React from 'react';
import { View, type LayoutChangeEvent } from 'react-native';

import type { TreeDropMeasurableRef } from '@/components/ui/treeDragDrop';

export type RegisterSessionListTreeRowBounds = (rowId: string, ref: TreeDropMeasurableRef | null) => void;
export type UnregisterSessionListTreeRowBounds = (rowId: string) => void;

export const SessionListHeaderFrame = React.memo(function SessionListHeaderFrame(props: Readonly<{
    children: React.ReactNode;
    treeRowId: string;
    onRegisterTreeRowBounds: RegisterSessionListTreeRowBounds;
    onUnregisterTreeRowBounds: UnregisterSessionListTreeRowBounds;
    onLayout?: (event: LayoutChangeEvent) => void;
}>) {
    const wrapperRef = React.useRef<View>(null);
    React.useEffect(() => {
        return () => {
            props.onUnregisterTreeRowBounds(props.treeRowId);
        };
    }, [props.onUnregisterTreeRowBounds, props.treeRowId]);
    return (
        <View
            ref={wrapperRef}
            collapsable={false}
            style={{ position: 'relative' }}
            onLayout={(event) => {
                props.onRegisterTreeRowBounds(props.treeRowId, wrapperRef.current);
                props.onLayout?.(event);
            }}
        >
            {props.children}
        </View>
    );
});
