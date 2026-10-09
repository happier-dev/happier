import { describe, expect, it } from 'vitest';

import { t } from '@/text';

import { describeMachineLockedReason, getMachineDisplayName, readMachineName, resolveMachineDisplayNames } from './machineDisplayNames';

const m = (id: string, displayName?: string, host?: string) => ({ id, metadata: { displayName, host } });

describe('getMachineDisplayName', () => {
    it('names a machine by its display name, else its host', () => {
        expect(getMachineDisplayName(m('a-1', 'Studio', 'studio.local'))).toBe('Studio');
        expect(getMachineDisplayName(m('b-2', undefined, 'devbox'))).toBe('devbox');
    });

    it('calls a machine with neither a name nor a host "Unnamed machine", never its id', () => {
        const name = getMachineDisplayName(m('f98b860d-63e0-436e-ab81'));
        expect(name).toBe(t('machine.unnamedMachine'));
        expect(name).not.toContain('f98b');
    });

    it('has no name for a machine it was not given', () => {
        expect(getMachineDisplayName(null)).toBeNull();
        expect(getMachineDisplayName(undefined)).toBeNull();
    });
});

describe('readMachineName', () => {
    it('is the name a person gave the machine or its host, and null when it has neither', () => {
        expect(readMachineName(m('a-1', ' Studio '))).toBe('Studio');
        expect(readMachineName(m('b-2', '', 'devbox'))).toBe('devbox');
        expect(readMachineName(m('c-3'))).toBeNull();
    });
});

describe('resolveMachineDisplayNames', () => {
    it('names each machine by its display name, else its host, when names are distinct', () => {
        const names = resolveMachineDisplayNames([m('a-1', 'Studio', 'studio.local'), m('b-2', undefined, 'devbox')]);
        expect(names.get('a-1')).toBe('Studio');
        expect(names.get('b-2')).toBe('devbox');
    });

    it('tells same-named machines apart by a distinct host, else a short stable id suffix', () => {
        const byHost = resolveMachineDisplayNames([m('a-1', 'Build', 'mac.local'), m('b-2', 'Build', 'linux.local')]);
        expect(byHost.get('a-1')).toBe('Build · mac.local');
        expect(byHost.get('b-2')).toBe('Build · linux.local');

        const byId = resolveMachineDisplayNames([
            m('f98b860d-63e0-436e-ab81', 'lima-happier-fresh', 'lima-happier-fresh'),
            m('0c1d2e3f-9999-4000-8000', 'lima-happier-fresh', 'lima-happier-fresh'),
        ]);
        expect(byId.get('f98b860d-63e0-436e-ab81')).toMatch(/^lima-happier-fresh · f98b/);
        expect(byId.get('0c1d2e3f-9999-4000-8000')).toMatch(/^lima-happier-fresh · 0c1d/);
    });

    it('compares names regardless of case and leaves unique names untouched', () => {
        const names = resolveMachineDisplayNames([m('a-1', 'Studio'), m('b-2', 'studio'), m('c-3', 'Laptop')]);
        expect(names.get('a-1')).not.toBe('Studio');
        expect(names.get('b-2')).not.toBe('studio');
        expect(names.get('c-3')).toBe('Laptop');
    });

    it('shows the short id only as the part that tells unnamed machines apart', () => {
        const unnamed = t('machine.unnamedMachine');
        const alone = resolveMachineDisplayNames([m('f98b860d-63e0'), m('c-3', 'Laptop')]);
        expect(alone.get('f98b860d-63e0')).toBe(unnamed);

        const pair = resolveMachineDisplayNames([m('f98b860d-63e0'), m('0c1d2e3f-9999')]);
        expect(pair.get('f98b860d-63e0')).toBe(`${unnamed} · f98b`);
        expect(pair.get('0c1d2e3f-9999')).toBe(`${unnamed} · 0c1d`);
    });
});

describe('locked machines', () => {
    const locked = (id: string) => ({ id, metadata: null, availability: { kind: 'locked' } });

    it('calls a machine whose details cannot be read "Locked machine", not unnamed, and never its id', () => {
        expect(getMachineDisplayName(locked('f98b860d-63e0'))).toBe(t('machine.lockedMachine'));
        expect(getMachineDisplayName({ id: 'a-1', metadata: { displayName: 'Stale' }, availability: { kind: 'locked' } }))
            .toBe(t('machine.lockedMachine'));
        expect(readMachineName(locked('f98b860d-63e0'))).toBeNull();
    });

    it('adds the short id only to tell locked machines apart', () => {
        const lockedName = t('machine.lockedMachine');
        expect(resolveMachineDisplayNames([locked('f98b860d-63e0'), m('c-3', 'Laptop')]).get('f98b860d-63e0')).toBe(lockedName);
        const pair = resolveMachineDisplayNames([locked('f98b860d-63e0'), locked('0c1d2e3f-9999')]);
        expect(pair.get('f98b860d-63e0')).toBe(`${lockedName} · f98b`);
        expect(pair.get('0c1d2e3f-9999')).toBe(`${lockedName} · 0c1d`);
    });

    it('does not call a machine locked while its encrypted display metadata is still hydrating', () => {
        const hydrating = { id: 'machine-a', metadata: null };
        expect(getMachineDisplayName(hydrating)).toBe(t('common.loading'));
        expect(describeMachineLockedReason(hydrating)).toBeNull();
    });
});

describe('describeMachineLockedReason', () => {
    const lockedFor = (reason: string) => ({ id: 'a-1', metadata: null, availability: { kind: 'locked', reason } });

    it('says why a locked machine cannot be read, per the reason sync recorded', () => {
        expect(describeMachineLockedReason(lockedFor('encryption_material_unavailable'))).toBe(t('machine.lockedReason.missingKey'));
        expect(describeMachineLockedReason(lockedFor('decryption_failed'))).toBe(t('machine.lockedReason.unopenable'));
        expect(describeMachineLockedReason(lockedFor('content_unreadable'))).toBe(t('machine.lockedReason.unreadable'));
        expect(describeMachineLockedReason({ id: 'a-1', metadata: null, availability: { kind: 'locked' } })).toBe(t('machine.lockedReason.unreadable'));
    });

    it('has no reason for a readable machine', () => {
        expect(describeMachineLockedReason(m('a-1', 'Studio'))).toBeNull();
    });
});
