import { describe, expect, it } from 'vitest';

import { getMachineAvatarInitial } from './machineAvatarInitial';

function machine(input: Readonly<{
    displayName?: string | null;
    host?: string | null;
    id?: string;
}> = {}) {
    return {
        id: input.id ?? 'machine-1',
        metadata: {
            displayName: input.displayName ?? null,
            host: input.host ?? null,
        },
    };
}

describe('getMachineAvatarInitial', () => {
    it('uppercases the first character of a latin host when no alias exists', () => {
        expect(getMachineAvatarInitial(machine({ host: 'mac-studio.local' }))).toBe('M');
    });

    it('prefers the alias over the host', () => {
        expect(getMachineAvatarInitial(machine({ displayName: 'dev box', host: 'jd-cloud.local' }))).toBe('D');
    });

    it('keeps a CJK leading character as-is', () => {
        expect(getMachineAvatarInitial(machine({ displayName: '京东云主机' }))).toBe('京');
    });

    it('falls back to the host when the alias is blank', () => {
        expect(getMachineAvatarInitial(machine({ displayName: '   ', host: 'jd-cloud.local' }))).toBe('J');
    });

    it('falls back to the machine id when host and alias are missing', () => {
        expect(getMachineAvatarInitial(machine({ id: 'm-42' }))).toBe('M');
    });

    it('returns a question mark when nothing can be derived', () => {
        expect(getMachineAvatarInitial(machine({ id: '' }))).toBe('?');
        expect(getMachineAvatarInitial(null)).toBe('?');
    });
});
