import { expect, it } from 'vitest';
import { entityHostedPointerToWindow } from '../../geometry/entityDragCoordinateSpace';

it('uses current hosted viewport position/scale and refuses unusable geometry', () => {
    const viewport = { bounds: { x: 100, y: 200, width: 400, height: 300 }, localWidth: 200, localHeight: 150 };
    expect(entityHostedPointerToWindow({ x: 20, y: 30 }, viewport)).toEqual({ x: 140, y: 260 });
    expect(entityHostedPointerToWindow({ x: 20, y: 30 }, { ...viewport, bounds: { ...viewport.bounds, y: 300 } })).toEqual({ x: 140, y: 360 });
    expect(entityHostedPointerToWindow({ x: NaN, y: 30 }, viewport)).toBeNull();
    expect(entityHostedPointerToWindow({ x: 20, y: 30 }, { ...viewport, localWidth: 0 })).toBeNull();
});
