import { describe, expect, it } from 'vitest';

import {
    buildServerSettingsGroupEditorHref,
    parseServerSettingsRouteParams,
} from './serverSettingsRouteParams';

describe('parseServerSettingsRouteParams', () => {
    it('returns null url when missing', () => {
        expect(parseServerSettingsRouteParams({})).toEqual({
            url: null,
            auto: false,
            source: null,
            groupEditor: false,
            initialGroupServerIds: [],
            recovery: null,
        });
    });

    it('parses url and auto=1', () => {
        expect(parseServerSettingsRouteParams({ url: 'https://stack.example.test', auto: '1' })).toEqual({
            url: 'https://stack.example.test',
            auto: true,
            source: null,
            groupEditor: false,
            initialGroupServerIds: [],
            recovery: null,
        });
    });

    it('trims and normalizes values', () => {
        expect(parseServerSettingsRouteParams({ url: ' https://stack.example.test ', auto: 'true' })).toEqual({
            url: 'https://stack.example.test',
            auto: true,
            source: null,
            groupEditor: false,
            initialGroupServerIds: [],
            recovery: null,
        });
    });

    it('parses source=notification', () => {
        expect(parseServerSettingsRouteParams({ url: 'https://stack.example.test', source: 'notification' })).toEqual({
            url: 'https://stack.example.test',
            auto: false,
            source: 'notification',
            groupEditor: false,
            initialGroupServerIds: [],
            recovery: null,
        });
    });

    it('retains an exact Home recovery target and only an internal invoking path', () => {
        const input: Parameters<typeof parseServerSettingsRouteParams>[0] & Readonly<{
            recoveryProfile: string;
            recoveryReturnTo: string;
        }> = {
            recoveryProfile: ' home-selected ',
            recoveryReturnTo: ' /session/abc ',
        };

        expect(parseServerSettingsRouteParams(input)).toEqual({
            url: null,
            auto: false,
            source: null,
            groupEditor: false,
            initialGroupServerIds: [],
            recovery: {
                profileRef: 'home-selected',
                returnTo: '/session/abc',
            },
        });
    });

    it('keeps recovery on the Home route when a supplied return destination is not internal', () => {
        expect(parseServerSettingsRouteParams({
            recoveryProfile: 'home-selected',
            recoveryReturnTo: 'https://outside.example.test/after-sign-in',
        }).recovery).toEqual({
            profileRef: 'home-selected',
            returnTo: '/server',
        });
    });

    it('parses a visible Home-group editor seed without keeping duplicates or blanks', () => {
        const input: Parameters<typeof parseServerSettingsRouteParams>[0] & Readonly<{
            groupEditor: string;
            groupServerIds: string;
        }> = {
            groupEditor: '1',
            groupServerIds: JSON.stringify([' home-a ', 'home-b', 'home-a', '']),
        };

        expect(parseServerSettingsRouteParams(input)).toEqual({
            url: null,
            auto: false,
            source: null,
            groupEditor: true,
            initialGroupServerIds: ['home-a', 'home-b'],
            recovery: null,
        });
    });

    it('builds the canonical visible group-editor route with a normalized seed', () => {
        expect(buildServerSettingsGroupEditorHref({
            initialGroupServerIds: [' home-a ', 'home-b', 'home-a'],
        })).toEqual({
            pathname: '/settings/server/groups/new',
            params: {
                groupServerIds: JSON.stringify(['home-a', 'home-b']),
            },
        });
    });
});
