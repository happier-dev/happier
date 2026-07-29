import * as React from 'react';

import type { TranscriptListRendererProps } from '../types';

/** Chronological re-projection: newest-first frames reverse into Legend's standard space. */
export function toLegendData<TItem>(
    data: readonly TItem[],
    dataOrder: TranscriptListRendererProps<TItem>['frame']['dataOrder'],
): readonly TItem[] {
    if (dataOrder === 'newest-first') {
        return [...data].reverse();
    }
    return data;
}

export function shouldProjectChronologicalIndex<TItem>(props: TranscriptListRendererProps<TItem>): boolean {
    return props.frame.dataOrder === 'newest-first';
}

export function toLegendIndex(sourceIndex: number, dataLength: number, projectChronologicalIndex: boolean): number {
    if (!projectChronologicalIndex) return sourceIndex;
    return Math.max(0, dataLength - 1 - sourceIndex);
}

export function toSourceIndex(legendIndex: number, dataLength: number, projectChronologicalIndex: boolean): number {
    if (!projectChronologicalIndex) return legendIndex;
    return Math.max(0, dataLength - 1 - legendIndex);
}

export function toSourceViewabilityTokens<TItem, TToken extends Readonly<{ index: number; item: TItem }>>(
    tokens: readonly TToken[],
    sourceData: readonly TItem[],
    projectChronologicalIndex: boolean,
): TToken[] {
    return tokens.map((token) => {
        const sourceIndex = toSourceIndex(token.index, sourceData.length, projectChronologicalIndex);
        const sourceItem = sourceData[sourceIndex];
        return {
            ...token,
            index: sourceIndex,
            item: sourceItem === undefined ? token.item : sourceItem,
        };
    });
}

export function readDataVersion(extraData: unknown): React.Key | undefined {
    return typeof extraData === 'string' || typeof extraData === 'number' ? extraData : undefined;
}

export function readWheelDeltaY(event: unknown): number | null {
    if (!event || typeof event !== 'object') return null;
    const direct = (event as { deltaY?: unknown }).deltaY;
    if (typeof direct === 'number' && Number.isFinite(direct)) return direct;
    const nativeEvent = (event as { nativeEvent?: unknown }).nativeEvent;
    if (!nativeEvent || typeof nativeEvent !== 'object') return null;
    const nested = (nativeEvent as { deltaY?: unknown }).deltaY;
    return typeof nested === 'number' && Number.isFinite(nested) ? nested : null;
}

export type TouchVerticalCoordinate = Readonly<{
    axis: 'client' | 'page';
    value: number;
}>;

export function readTouchVerticalCoordinate(event: unknown): TouchVerticalCoordinate | null {
    const direct = event && typeof event === 'object'
        ? event as Record<string, unknown>
        : null;
    const nativeEvent = direct?.nativeEvent && typeof direct.nativeEvent === 'object'
        ? direct.nativeEvent as Record<string, unknown>
        : null;
    const firstTouch = (value: unknown): Record<string, unknown> | null => {
        if (!value || typeof value !== 'object') return null;
        const touch = (value as { 0?: unknown })[0];
        return touch && typeof touch === 'object' ? touch as Record<string, unknown> : null;
    };
    const candidates = [
        direct,
        nativeEvent,
        firstTouch(direct?.touches),
        firstTouch(nativeEvent?.touches),
        firstTouch(direct?.changedTouches),
        firstTouch(nativeEvent?.changedTouches),
    ];
    for (const candidate of candidates) {
        const clientY = candidate?.clientY;
        if (typeof clientY === 'number' && Number.isFinite(clientY)) {
            return { axis: 'client', value: clientY };
        }
    }
    for (const candidate of candidates) {
        const pageY = candidate?.pageY;
        if (typeof pageY === 'number' && Number.isFinite(pageY)) {
            return { axis: 'page', value: pageY };
        }
    }
    return null;
}

export function toLegendSlot(node: React.ReactNode): React.ReactElement | null {
    return React.isValidElement(node) ? node : null;
}
