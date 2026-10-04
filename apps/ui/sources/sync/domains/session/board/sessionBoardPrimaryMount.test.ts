import { describe, expect, it } from 'vitest';

import type { SessionSurfaceItemV1 } from '@happier-dev/protocol/sessions/board';

import type { SessionBoardItemState } from './sessionBoardItemState';
import {
    resolveSessionBoardMountMode,
    resolveSessionBoardPrimaryMountHost,
} from './sessionBoardPrimaryMount';

function readyState(kind: SessionSurfaceItemV1['source']['kind']): SessionBoardItemState {
    return {
        kind: 'ready',
        item: {
            v: 1,
            title: 'Widget',
            frame: 'card',
            height: { mode: 'auto', fallback: 'regular' },
            source: kind === 'declarative'
                ? { kind: 'declarative', document: { version: 1, root: { kind: 'stack', children: [] } } }
                : { kind: 'installedSurface', surface: { pluginId: 'acme', localId: 'panel' } },
        } as unknown as SessionSurfaceItemV1,
    };
}

describe('resolveSessionBoardPrimaryMountHost', () => {
    it('prefers focused Details over every other visible host', () => {
        expect(resolveSessionBoardPrimaryMountHost({
            foreground: true,
            visibleHosts: ['sidebar', 'details', 'focusedDetails'],
        })).toBe('focusedDetails');
    });

    it('lets an explicitly focused visible host win over plain precedence', () => {
        expect(resolveSessionBoardPrimaryMountHost({
            foreground: true,
            visibleHosts: ['details', 'sidebar'],
            focusedHost: 'sidebar',
        })).toBe('sidebar');
    });

    it('ignores a focused host that is not currently visible', () => {
        expect(resolveSessionBoardPrimaryMountHost({
            foreground: true,
            visibleHosts: ['details'],
            focusedHost: 'companion',
        })).toBe('details');
    });

    it('keeps Details ahead of the Companion when both are visible', () => {
        expect(resolveSessionBoardPrimaryMountHost({
            foreground: true,
            visibleHosts: ['details', 'companion'],
        })).toBe('details');
    });

    it('drives no executable mount while the window is backgrounded', () => {
        expect(resolveSessionBoardPrimaryMountHost({
            foreground: false,
            visibleHosts: ['details'],
        })).toBeNull();
    });

    it('returns null when nothing is showing the item', () => {
        expect(resolveSessionBoardPrimaryMountHost({ foreground: true, visibleHosts: [] })).toBeNull();
    });
});
describe('resolveSessionBoardMountMode', () => {
    it('keeps the host walkthrough projection readable without executable plugin custody', () => {
        const state: SessionBoardItemState = { kind: 'ready', item: {
            v: 1, title: 'Walkthrough', frame: 'card', height: { mode: 'auto', fallback: 'compact' },
            source: { kind: 'walkthrough', comparison: 'session' },
        } };
        expect(resolveSessionBoardMountMode({ host: 'sidebar', primaryHost: null, state })).toBe('executable');
    });
    it('renders declarative content live in every visible placement', () => {
        const state = readyState('declarative');
        expect(resolveSessionBoardMountMode({ host: 'sidebar', primaryHost: 'details', state })).toBe('executable');
        expect(resolveSessionBoardMountMode({ host: 'details', primaryHost: 'details', state })).toBe('executable');
    });

    it('gives an executable source exactly one interactive placement and previews the rest', () => {
        const state = readyState('installedSurface');
        expect(resolveSessionBoardMountMode({ host: 'details', primaryHost: 'details', state })).toBe('executable');
        expect(resolveSessionBoardMountMode({ host: 'sidebar', primaryHost: 'details', state })).toBe('preview');
        expect(resolveSessionBoardMountMode({ host: 'details', primaryHost: null, state })).toBe('preview');
    });

    it('is inert for any item whose record is not readable', () => {
        expect(resolveSessionBoardMountMode({
            host: 'details',
            primaryHost: 'details',
            state: { kind: 'locked' },
        })).toBe('inert');
    });
});
