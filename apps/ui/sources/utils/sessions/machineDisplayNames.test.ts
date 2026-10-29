import { describe, expect, it } from 'vitest';

import { t } from '@/text';

import { describeMachineLockedReason, getMachineDisplayName, getMachineSentenceName, getSettledMachineDisplayName, getSessionMachineLabel, readMachineName, resolveMachineDisplayNames } from './machineDisplayNames';

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

    it('keeps a selected machine as distinguishable as its inventory row', () => {
        const machines = [m('2cd4-machine', 'NLDW4-5-40-40'), m('ae13-machine', 'NLDW4-5-40-40')];
        expect(getMachineDisplayName(machines[0]!, machines)).toBe('NLDW4-5-40-40 · 2cd4');
        expect(getMachineDisplayName(m('third-machine', 'Laptop'), machines)).toBe('Laptop');
        expect(getMachineDisplayName(null, machines)).toBeNull();
    });

    it('does not let readable inventory context override an unreadable or absent selected machine', () => {
        const inventory = [m('machine-1', 'Previously readable host')];
        expect(getMachineDisplayName({ id: 'machine-1', absence: 'removed' }, inventory))
            .toBe(t('machine.removedMachine'));
        expect(getMachineDisplayName({
            id: 'machine-1', metadata: null, availability: { kind: 'locked' },
        }, inventory)).toBe(t('machine.lockedMachine'));
        expect(getMachineDisplayName({ id: 'machine-1', metadata: null }, inventory))
            .toBe(t('common.loading'));
    });
});

describe('getSettledMachineDisplayName', () => {
    it('never offers the "Loading…" placeholder as a name: a machine that never hydrates has none', () => {
        expect(getSettledMachineDisplayName({ id: 'machine-a', metadata: null })).toBeNull();
        expect(getSettledMachineDisplayName(null)).toBeNull();
    });

    it('names every machine whose state is settled exactly as getMachineDisplayName does', () => {
        expect(getSettledMachineDisplayName(m('a-1', 'Studio'))).toBe('Studio');
        expect(getSettledMachineDisplayName({ id: 'a-1', metadata: null, availability: { kind: 'locked' } })).toBe(t('machine.lockedMachine'));
        expect(getSettledMachineDisplayName({ id: 'a-1', metadata: null, absence: 'removed' })).toBe(t('machine.removedMachine'));
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

    it('never gives machines still loading their names an id suffix, which would read as their identity', () => {
        const names = resolveMachineDisplayNames([{ id: 'd06f1111', metadata: null }, { id: '8b442222', metadata: null }, m('c-3', 'Laptop')]);
        expect(names.get('d06f1111')).toBe(t('common.loading'));
        expect(names.get('8b442222')).toBe(t('common.loading'));
        expect(names.get('c-3')).toBe('Laptop');
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

describe('getMachineSentenceName', () => {
    it('names a loaded machine as its display name', () => {
        expect(getMachineSentenceName(m('a-1', 'Studio Mac'))).toBe('Studio Mac');
    });

    it('never puts a placeholder title inside a sentence', () => {
        const generic = t('machine.thisMachineInSentence');
        expect(getMachineSentenceName({ id: 'a-1', metadata: null })).toBe(generic);
        expect(getMachineSentenceName({ id: 'a-1', metadata: null, availability: { kind: 'locked' } })).toBe(generic);
        expect(getMachineSentenceName(null)).toBe(generic);
    });

    it('keeps a removed machine named by what happened to it', () => {
        expect(getMachineSentenceName({ id: 'a-1', metadata: null, absence: 'removed' })).toBe(t('machine.removedMachine'));
    });

    it('lets a sentence wrap before a hyphenated host name, never inside it', () => {
        const name = getMachineSentenceName(m('a-1', undefined, 'NLDW3-5-36-33'));
        // The text stays the host name; a word joiner after each hyphen removes the browser's break opportunity.
        expect(name.replaceAll('\u2060', '')).toBe('NLDW3-5-36-33');
        expect(name).toBe('NLDW3-\u20605-\u206036-\u206033');
        expect(getMachineSentenceName(m('a-2', 'Studio Mac'))).toBe('Studio Mac');
    });
});

describe('getSessionMachineLabel', () => {
    const SESSION_MACHINE = '58f6e63a-cd69-4302-83f1-325d10da7ec3';

    it('names the machine from the inventory when it is listed', () => {
        expect(getSessionMachineLabel({
            machineId: SESSION_MACHINE, machine: m(SESSION_MACHINE, 'Studio', 'studio.local'),
            session: { machineId: SESSION_MACHINE, host: 'NLDW3' },
        })).toBe('Studio');
    });

    it('names a machine whose details are still locked or loading by the host its own session published', () => {
        const locked = { id: SESSION_MACHINE, metadata: null, availability: { kind: 'locked' } };
        const hydrating = { id: SESSION_MACHINE, metadata: null };
        const session = { machineId: SESSION_MACHINE, host: 'NLDW3-5-36-33' };
        expect(getSessionMachineLabel({ machineId: SESSION_MACHINE, machine: locked, session })).toBe('NLDW3-5-36-33');
        expect(getSessionMachineLabel({ machineId: SESSION_MACHINE, machine: hydrating, session })).toBe('NLDW3-5-36-33');
        // Without a published host the placeholder stays what it is.
        expect(getSessionMachineLabel({ machineId: SESSION_MACHINE, machine: locked, session: { machineId: SESSION_MACHINE } }))
            .toBe(t('machine.lockedMachine'));
    });

    it('reads the session\'s own host when its machine is not in the inventory, never the raw id', () => {
        const label = getSessionMachineLabel({
            machineId: SESSION_MACHINE, machine: null, session: { machineId: SESSION_MACHINE, host: 'NLDW3-5-36-33' },
        });
        expect(label).toBe('NLDW3-5-36-33');
    });

    it('does not borrow the session host for a different machine the session reaches', () => {
        const label = getSessionMachineLabel({
            machineId: 'other-machine', machine: null, session: { machineId: SESSION_MACHINE, host: 'NLDW3-5-36-33' },
        });
        expect(label).toBe(t('machine.unlistedMachine'));
        expect(label).not.toContain('other-machine');
    });

    it('calls an unlisted machine with no known host by what it is, not by its id', () => {
        expect(getSessionMachineLabel({ machineId: SESSION_MACHINE, machine: null, session: { machineId: SESSION_MACHINE, host: ' ' } }))
            .toBe(t('machine.unlistedMachine'));
    });
});
