import { describe, expect, it } from 'vitest';

import { LOCAL_SETTING_DEFINITIONS } from './localSettingDefinitions';

describe('LOCAL_SETTING_DEFINITIONS appPaneScopesV1', () => {
    it('drops an invalid selected destination without resetting valid sibling pane state', () => {
        const schema = LOCAL_SETTING_DEFINITIONS.appPaneScopesV1.schema;

        const parsed = schema.parse({
            'session:one': {
                right: {
                    isOpen: true,
                    activeTabId: 'git',
                    selectedDestination: {
                        kind: 'plugin',
                        destination: { pluginId: 42, localId: 'review' },
                    },
                    tabState: { git: { branch: 'main' } },
                },
                details: {
                    isOpen: true,
                    tabs: [{
                        key: 'file:/repo/src/a.ts',
                        kind: 'file',
                        title: 'a.ts',
                        resource: { kind: 'file', path: '/repo/src/a.ts' },
                        isPreview: false,
                        isPinned: true,
                    }],
                    activeTabKey: 'file:/repo/src/a.ts',
                    tabState: { 'file:/repo/src/a.ts': { draft: 'keep me' } },
                },
                bottom: {
                    isOpen: true,
                    activeTabId: 'terminal',
                    selectedDestination: { kind: 'builtin', id: 'terminal' },
                    tabState: { terminal: { cwd: '/repo' } },
                },
            },
        });

        expect(parsed['session:one']).toEqual({
            right: {
                isOpen: true,
                activeTabId: 'git',
                selectedDestination: null,
                tabState: { git: { branch: 'main' } },
            },
            details: expect.objectContaining({
                isOpen: true,
                activeTabKey: 'file:/repo/src/a.ts',
                tabState: { 'file:/repo/src/a.ts': { draft: 'keep me' } },
            }),
            bottom: {
                isOpen: true,
                activeTabId: 'terminal',
                selectedDestination: { kind: 'builtin', id: 'terminal' },
                tabState: { terminal: { cwd: '/repo' } },
            },
        });
    });

    it('retains the raw details overlay for the canonical workspace migration to validate', () => {
        const schema = LOCAL_SETTING_DEFINITIONS.appPaneScopesV1.schema;

        const parsed = schema.parse({
            'session:one': {
                right: { isOpen: false, activeTabId: null, tabState: {} },
                details: {
                    isOpen: true,
                    tabState: {},
                    tabsByKey: {},
                    groupsById: {},
                    root: null,
                    focusedGroupId: null,
                    maximizedGroupId: null,
                    nextGroupOrdinal: 1,
                    overlay: {
                        destination: { pluginId: 'com.example.viewer', localId: 'activity-log' },
                        instanceKey: 'activity:run-1',
                        returnFocusedGroupId: null,
                        returnMaximizedGroupId: null,
                        returnIsOpen: false,
                    },
                },
                bottom: { isOpen: false, activeTabId: null, tabState: {} },
            },
        });

        expect(parsed['session:one']?.details).toMatchObject({
            overlay: {
                destination: { pluginId: 'com.example.viewer', localId: 'activity-log' },
                instanceKey: 'activity:run-1',
                returnFocusedGroupId: null,
                returnMaximizedGroupId: null,
                returnIsOpen: false,
            },
        });
    });

    it('round-trips exact own prototype-named right and bottom tab-state keys', () => {
        const schema = LOCAL_SETTING_DEFINITIONS.appPaneScopesV1.schema;
        const rightTabState = Object.fromEntries([
            ['__proto__', { scrollY: 12 }],
            ['constructor', { branch: 'main' }],
        ]);
        const bottomTabState = Object.fromEntries([
            ['prototype', { cwd: '/repo' }],
        ]);

        const parsed = schema.parse({
            'session:one': {
                right: { isOpen: true, activeTabId: '__proto__', tabState: rightTabState },
                details: { isOpen: false, tabs: [], activeTabKey: null, tabState: {} },
                bottom: { isOpen: true, activeTabId: 'prototype', tabState: bottomTabState },
            },
        });

        expect(Object.entries(parsed['session:one']?.right.tabState ?? {})).toEqual(Object.entries(rightTabState));
        expect(Object.entries(parsed['session:one']?.bottom.tabState ?? {})).toEqual(Object.entries(bottomTabState));
        expect(Object.prototype.hasOwnProperty.call(parsed['session:one']?.right.tabState, '__proto__')).toBe(true);
        expect(Object.prototype.hasOwnProperty.call(parsed['session:one']?.right.tabState, 'constructor')).toBe(true);
    });
});
