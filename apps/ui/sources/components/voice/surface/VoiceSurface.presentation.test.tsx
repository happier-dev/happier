import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const surfaceModelCalls = vi.hoisted(() => ({ count: 0 }));

vi.mock('./useVoiceSurfaceModel', () => ({
    useVoiceSurfaceModel: () => {
        surfaceModelCalls.count += 1;
        React.useState(0);
        React.useState(0);
        return { marker: 'model' };
    },
}));

vi.mock('./VoiceSurfaceView', () => ({
    VoiceSurfaceView: () => React.createElement('VoiceSurfaceView'),
}));

import { VoiceSurface } from './VoiceSurface';

describe('VoiceSurface retained presentation', () => {
    beforeEach(() => {
        surfaceModelCalls.count = 0;
    });

    it('unmounts the runtime model across presented → hidden → presented', () => {
        let tree: renderer.ReactTestRenderer;
        act(() => {
            tree = renderer.create(<VoiceSurface variant="sidebar" isPresented />);
        });

        expect(surfaceModelCalls.count).toBe(1);
        expect(tree!.root.findByType('VoiceSurfaceView')).toBeTruthy();

        act(() => {
            tree!.update(<VoiceSurface variant="sidebar" isPresented={false} />);
        });

        expect(surfaceModelCalls.count).toBe(1);
        expect(tree!.toJSON()).toBeNull();

        act(() => {
            tree!.update(<VoiceSurface variant="sidebar" isPresented />);
        });

        expect(surfaceModelCalls.count).toBe(2);
        expect(tree!.root.findByType('VoiceSurfaceView')).toBeTruthy();

        act(() => tree!.unmount());
    });
});
