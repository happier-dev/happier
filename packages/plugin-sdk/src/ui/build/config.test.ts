import { describe, expect, it } from 'vitest';

import {
    BUILD_CONFIG_BASENAMES,
    defineBuildConfig,
} from './config.js';

describe('plugin UI build config projections', () => {
    it('owns the approved config names directly', () => {
        expect(Object.isFrozen(BUILD_CONFIG_BASENAMES)).toBe(true);
        expect(BUILD_CONFIG_BASENAMES).toContain('happier-plugin-ui.config.mjs');
        expect(defineBuildConfig({ targets: [] })).toEqual({ targets: [] });
    });

    it('discriminates portable hosted-web targets from platform-declared native targets', () => {
        const hosted = defineBuildConfig({
            targets: [{
                rendererId: 'portable-panel',
                entry: 'ui/panel.tsx',
                kind: 'hostedWeb',
            }],
        });
        const reactNative = defineBuildConfig({
            targets: [{
                rendererId: 'native-panel',
                entry: 'ui/panel.native.tsx',
                kind: 'reactNative',
                platforms: ['ios', 'android'],
                module: {
                    containerName: 'native_panel',
                    modulePath: './Panel',
                    exportName: 'Panel',
                },
            }],
        });

        expect(hosted.targets[0]?.kind).toBe('hostedWeb');
        expect(reactNative.targets[0]?.platforms).toEqual(['ios', 'android']);

        defineBuildConfig({
            /* @sdk-negative-type-case:src-ui-build-config-test-ts-hosted-web-platforms:SG9zdGVkIHdlYiBoYXMgb25lIHBvcnRhYmxlIGdyYXBoLCBub3QgYXV0aG9yLW93bmVkIHBsYXRmb3JtIGNlbGxzLg:dGFyZ2V0czogW3sKICAgICAgICAgICAgICAgIHJlbmRlcmVySWQ6ICdsZWdhY3ktaG9zdGVkLXBhbmVsJywKICAgICAgICAgICAgICAgIGVudHJ5OiAndWkvcGFuZWwudHN4JywKICAgICAgICAgICAgICAgIGtpbmQ6ICdob3N0ZWRXZWInLAogICAgICAgICAgICAgICAgcGxhdGZvcm1zOiBbJ3dlYiddLAogICAgICAgICAgICB9XSw */
            targets: [], /* @sdk-negative-type-case-end */
        });
    });
});
