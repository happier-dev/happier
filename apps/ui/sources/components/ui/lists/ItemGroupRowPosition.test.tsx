import * as React from 'react';
import { afterEach, expect, it } from 'vitest';
import { act } from 'react-test-renderer';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { ItemGroupRowPositionProvider, useItemGroupRowPosition } from './ItemGroupRowPosition';

afterEach(standardCleanup);

it('keeps unchanged row geometry from redrawing context consumers, while publishing changed corners', async () => {
    let renders = 0;
    let position: ReturnType<typeof useItemGroupRowPosition>;
    function Row() {
        renders++;
        position = useItemGroupRowPosition();
        return React.createElement('Row');
    }
    const row = <Row />;
    const screen = await renderScreen(<ItemGroupRowPositionProvider value={{ isFirst: true, isLast: false }}>{row}</ItemGroupRowPositionProvider>);
    const initial = renders;
    await act(async () => { screen.update(<ItemGroupRowPositionProvider value={{ isFirst: true, isLast: false }}>{row}</ItemGroupRowPositionProvider>); });
    expect(renders).toBe(initial);
    await act(async () => { screen.update(<ItemGroupRowPositionProvider value={{ isFirst: true, isLast: true }}>{row}</ItemGroupRowPositionProvider>); });
    expect(renders).toBe(initial + 1);
    expect(position!).toEqual({ isFirst: true, isLast: true });
    await act(async () => { screen.update(<ItemGroupRowPositionProvider value={null}>{row}</ItemGroupRowPositionProvider>); });
    expect(position!).toBeNull();
    const atBoundary = renders;
    await act(async () => { screen.update(<ItemGroupRowPositionProvider value={null}>{row}</ItemGroupRowPositionProvider>); });
    expect(renders).toBe(atBoundary);
});
