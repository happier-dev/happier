import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSessionFixture, renderScreen, standardCleanup } from '@/dev/testkit';
import type { Session } from '@/sync/domains/state/storageTypes';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const navigation = vi.hoisted(() => ({ push: vi.fn() }));
const execute = vi.hoisted(() => vi.fn());
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ router: navigation }).module;
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock().module;
});
// Session navigation is the app-shell boundary (it needs the auth provider); no test here opens a Session.
vi.mock('@/hooks/session/useNavigateToSession', () => ({ useNavigateToSession: () => async () => {} }));
// The Action executor is the outward write boundary; the layer projection beneath the section is real.
vi.mock('@/sync/ops/actions/defaultActionExecutor', () => ({
    createDefaultActionExecutor: () => ({ execute }),
}));

afterEach(() => {
    standardCleanup();
    navigation.push.mockClear();
    execute.mockReset();
});

const { SessionContextSection } = await import('./SessionContextSection');
const { SessionMemorySection } = await import('../memory/SessionMemorySection');

const entry = (id: string, artifactId: string, enabled = true) => ({
    id, ref: { kind: 'doc', artifactId, serverId: 'home-a' }, enabled, placement: 'system_append',
});
function sessionWith(work: Record<string, unknown>, overrides: Partial<Session> = {}): Session {
    const base = createSessionFixture({ id: 's1', metadataVersion: 9, ...overrides });
    return { ...base, metadata: { ...base.metadata, work } as Session['metadata'] };
}

describe('Work › Context', () => {
    it('lists what was added here with its switch, and leaves Instructions and Memory to their own sections', async () => {
        execute.mockResolvedValue({ ok: true, result: { ok: true } });
        const screen = await renderScreen(<SessionContextSection
            serverId="home-a"
            session={sessionWith({ promptStack: [
                entry('session.instructions', 'instructions-doc'),
                entry('session.memory', 'memory-doc'),
                entry('session.notes', 'notes-doc'),
            ] })}
        />);
        expect(screen.findByTestId('session-work-context.entry.session.session.notes')).toBeTruthy();
        expect(screen.findByTestId('session-work-context.entry.session.session.instructions')).toBeNull();
        expect(screen.findByTestId('session-work-context.entry.session.session.memory')).toBeNull();
        const toggle = screen.findByTestId('session-work-context.entry.session.notes.switch');
        expect(toggle?.props.value).toBe(true);
        await React.act(async () => { toggle?.props.onValueChange(false); });
        expect(execute).toHaveBeenCalledWith('session.context.update', {
            sessionId: 's1', serverId: 'home-a', expectedMetadataRevision: 9,
            intent: { kind: 'set_enabled', entryId: 'session.notes', enabled: false },
        }, expect.objectContaining({ surface: 'ui', serverId: 'home-a' }));
    });

    it('is withheld from a shared viewer', async () => {
        const screen = await renderScreen(<SessionContextSection
            serverId="home-a"
            session={sessionWith({ promptStack: [entry('session.notes', 'notes-doc')] }, { accessLevel: 'view' })}
        />);
        expect(screen.findByTestId('session-work-context')).toBeNull();
    });
});

describe('Work › Memory', () => {
    it('an ordinary session starts with memory off and the switch saves the Session choice', async () => {
        execute.mockResolvedValue({ ok: true, result: { ok: true } });
        const screen = await renderScreen(<SessionMemorySection serverId="home-a" session={sessionWith({})} />);
        const toggle = screen.findByTestId('session-work-memory.enabled.switch');
        expect(toggle?.props.value).toBe(false);
        // Off: nothing is read and there is nothing to search or add.
        expect(screen.findByTestId('session-work-memory.search')).toBeNull();
        expect(screen.findByTestId('session-work-memory.doc.none')).toBeNull();
        await React.act(async () => { toggle?.props.onValueChange(true); });
        expect(execute).toHaveBeenCalledWith('session.memory.set', {
            sessionId: 's1', serverId: 'home-a', expectedMetadataRevision: 9, enabled: true,
        }, expect.objectContaining({ surface: 'ui' }));
    });

    it('with memory on and nothing remembered yet, it invites the first fact', async () => {
        const screen = await renderScreen(<SessionMemorySection serverId="home-a" session={sessionWith({ memoryEnabled: true })} />);
        expect(screen.findByTestId('session-work-memory.enabled.switch')?.props.value).toBe(true);
        expect(screen.findByTestId('session-work-memory.doc.none')).toBeTruthy();
        expect(screen.findByTestId('session-work-memory.remember')).toBeTruthy();
    });
});
