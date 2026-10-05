import { describe, expect, it } from 'vitest';

import { buildSessionTerminalNewMenuItems, buildSessionTerminalTabMenuItems } from './sessionTerminalMenus';

describe('terminal script menu', () => {
    it('offers Find only for the actual mounted searchable renderer, including a native xterm fallback', () => {
        const tab = { tabId: 'tab', title: 'Shell', mark: { kind: 'shell' as const }, status: null, members: [] };
        const input = { tab, terminalId: 'leaf', canSplit: true, canOpenInDetails: false, hasOtherTabs: false };
        const mounted = { copySelection: false, paste: true, clear: true, restart: true };
        expect(buildSessionTerminalTabMenuItems({ ...input, mounted: { ...mounted, find: false } }, () => null).some((item) => item.id === 'find')).toBe(false);
        expect(buildSessionTerminalTabMenuItems({ ...input, mounted: { ...mounted, find: true } }, () => null).some((item) => item.id === 'find')).toBe(true);
    });
    it('offers the full script inventory after the runnable scripts', () => {
        const items = buildSessionTerminalNewMenuItems({
            folder: 'happier', machineName: 'MacBook Pro', agent: null, machines: [],
            scripts: [{ id: 'dev', title: 'dev', command: 'yarn dev' }],
        }, () => null, () => null);
        expect(items.findIndex((item) => item.id === 'allScripts')).toBeGreaterThan(items.findIndex((item) => item.id === 'script:dev'));
        expect(items.find((item) => item.id === 'allScripts')?.disabled).not.toBe(true);
    });
});
