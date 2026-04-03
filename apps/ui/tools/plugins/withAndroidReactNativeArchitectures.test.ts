import { describe, expect, it } from 'vitest';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const plugin = require('../../plugins/withAndroidReactNativeArchitectures.js');

describe('withAndroidReactNativeArchitectures', () => {
    it('is a function (config plugin)', () => {
        expect(typeof plugin).toBe('function');
    });

    it('upserts reactNativeArchitectures into gradle properties', () => {
        const apply = plugin.applyReactNativeArchitecturesToGradleProperties as (props: any[], archs: string[]) => any[];
        const props: any[] = [];

        apply(props, ['arm64-v8a']);
        expect(props).toEqual([{ type: 'property', key: 'reactNativeArchitectures', value: 'arm64-v8a' }]);
    });

    it('overwrites existing reactNativeArchitectures property', () => {
        const apply = plugin.applyReactNativeArchitecturesToGradleProperties as (props: any[], archs: string[]) => any[];
        const props: any[] = [
            { type: 'property', key: 'reactNativeArchitectures', value: 'arm64-v8a,x86_64' },
        ];

        apply(props, ['arm64-v8a']);
        expect(props).toEqual([{ type: 'property', key: 'reactNativeArchitectures', value: 'arm64-v8a' }]);
    });
});

