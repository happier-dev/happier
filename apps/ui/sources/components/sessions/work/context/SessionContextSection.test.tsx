import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSessionFixture, renderScreen, standardCleanup } from '@/dev/testkit';
import type { Session } from '@/sync/domains/state/storageTypes';
import { createPlainArtifactHomeFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { applyPromptLibraryCatalogSnapshot, resetPromptLibraryCatalogSnapshotsForTests } from '@/sync/store/settings/promptLibraryCatalogSnapshot';
import { resetPromptLibraryCatalogEngineForTests } from '@/sync/engine/settings/promptLibraryCatalogEngine';

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

const { storage } = await import('@/sync/domains/state/storage');
let home: Awaited<ReturnType<typeof createPlainArtifactHomeFixture>>;
let serverId: string;
beforeEach(async () => {
    home = await createPlainArtifactHomeFixture('https://work-context.test');
    serverId = home.home.id;
    storage.setState({ isDataReady: true });
    storage.getState().applyArtifacts(['instructions-doc', 'memory-doc', 'notes-doc'].map(id => ({
        id, title: id, ownerAccountId: 'artifact-account', access: 'owner' as const,
        header: { kind: id === 'memory-doc' ? 'memory_doc.v1' : 'prompt_doc.v2', title: id },
        body: null, headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1, isDecrypted: true,
    })));
    applyPromptLibraryCatalogSnapshot({ serverId, accountId: 'artifact-account' }, {
        catalog: { status: 'ready', rows: [], tombstones: [], diagnostics: [] }, rawSettings: {},
        sourceSettingsVersion: storage.getState().settingsVersion,
    }, true);
});
afterEach(() => {
    standardCleanup();
    resetPromptLibraryCatalogEngineForTests();
    resetPromptLibraryCatalogSnapshotsForTests();
    home?.dispose();
    vi.restoreAllMocks();
    navigation.push.mockClear();
    execute.mockReset();
});

const { SessionContextSection } = await import('./SessionContextSection');
const { SessionMemorySection } = await import('../memory/SessionMemorySection');

const entry = (id: string, artifactId: string, enabled = true) => ({
    id, ref: { kind: 'doc', artifactId, serverId }, enabled, placement: 'system_append',
});
function sessionWith(work: Record<string, unknown>, overrides: Partial<Session> = {}): Session {
    const base = createSessionFixture({ id: 's1', metadataVersion: 9, ...overrides });
    return { ...base, metadata: { ...base.metadata, work } as Session['metadata'] };
}

describe('Work › Context', () => {
    it('lists what was added here with its switch, and leaves Instructions and Memory to their own sections', async () => {
        execute.mockResolvedValue({ ok: true, result: { ok: true } });
        const screen = await renderScreen(<SessionContextSection
            serverId={serverId}
            session={sessionWith({ promptStack: [
                entry('session.instructions', 'instructions-doc'),
                entry('session.memory', 'memory-doc'),
                entry('session.notes', 'notes-doc'),
            ] })}
        />);
        expect(screen.findByTestId('session-work-context.entry.session.session.notes')).toBeTruthy();
        expect(screen.findByTestId('session-work-context.entry.session.session.instructions')).toBeNull();
        expect(screen.findByTestId('session-work-context.entry.session.session.memory')).toBeNull();
        const toggle = screen.findByTestId('session-work-context.entry.session.session.notes.enabled');
        expect(toggle?.props.value).toBe(true);
        await React.act(async () => { toggle?.props.onValueChange(false); });
        expect(execute).toHaveBeenCalledWith('session.context.update', {
            sessionId: 's1', serverId, expectedMetadataRevision: 9,
            intent: { kind: 'set_enabled', entryId: 'session.notes', enabled: false },
        }, expect.objectContaining({ surface: 'ui', serverId }));
    });

    it('is withheld from a shared viewer', async () => {
        const screen = await renderScreen(<SessionContextSection
            serverId={serverId}
            session={sessionWith({ promptStack: [entry('session.notes', 'notes-doc')] }, { accessLevel: 'view' })}
        />);
        expect(screen.findByTestId('session-work-context')).toBeNull();
    });

    it('does not claim empty Context while the Account catalog is unavailable', async () => {
        applyPromptLibraryCatalogSnapshot({ serverId, accountId: 'artifact-account' }, {
            catalog: { status: 'unavailable', reason: 'forbidden' }, rawSettings: {},
            sourceSettingsVersion: storage.getState().settingsVersion,
        }, true);
        const screen = await renderScreen(<SessionContextSection serverId={serverId} session={sessionWith({})} />);
        expect(screen.findByTestId('session-work-context.layersUnavailable')).toBeTruthy();
        expect(screen.findByTestId('session-work-context.empty')).toBeNull();
    });

    it('keeps an unresolved document off and without an editor link', async () => {
        const screen = await renderScreen(<SessionContextSection serverId={serverId}
            session={sessionWith({ promptStack: [entry('session.unknown', 'missing')] })} />);
        const toggle = screen.findByTestId('session-work-context.entry.session.session.unknown.enabled');
        expect(toggle?.props.value).toBe(false);
        expect(toggle?.props.disabled).toBe(true);
        expect(screen.findAllByTestId('session-work-context.entry.session.session.unknown')
            .some(node => typeof node.props.onPress === 'function')).toBe(false);
        expect(navigation.push).not.toHaveBeenCalled();
    });
});

describe('Work › Memory', () => {
    it('an ordinary session starts with memory off and the switch saves the Session choice', async () => {
        execute.mockResolvedValue({ ok: true, result: { ok: true } });
        const screen = await renderScreen(<SessionMemorySection serverId={serverId} session={sessionWith({})} />);
        const toggle = screen.findByTestId('session-work-memory.enabled.switch');
        expect(toggle?.props.value).toBe(false);
        // Off: nothing is read and there is nothing to search or add.
        expect(screen.findByTestId('session-work-memory.search')).toBeNull();
        expect(screen.findByTestId('session-work-memory.doc.none')).toBeNull();
        await React.act(async () => { toggle?.props.onValueChange(true); });
        expect(execute).toHaveBeenCalledWith('session.memory.set', {
            sessionId: 's1', serverId, expectedMetadataRevision: 9, enabled: true,
        }, expect.objectContaining({ surface: 'ui' }));
    });

    it('says a refused switch in the section, beside the switch it did not move, and opens no dialog', async () => {
        execute.mockResolvedValue({ ok: false, errorCode: 'forbidden', error: 'forbidden' });
        const { Modal } = await import('@/modal');
        const screen = await renderScreen(<SessionMemorySection serverId={serverId} session={sessionWith({})} />);
        expect(screen.findByTestId('session-work-memory.refused')).toBeNull();
        await React.act(async () => { screen.findByTestId('session-work-memory.enabled.switch')?.props.onValueChange(true); });
        expect(screen.findByTestId('session-work-memory.refused')).toBeTruthy();
        expect(screen.findByTestId('session-work-memory.enabled.switch')?.props.value).toBe(false);
        expect(Modal.alert).not.toHaveBeenCalled();
    });

    it('with memory on and nothing remembered yet, it invites the first fact', async () => {
        const screen = await renderScreen(<SessionMemorySection serverId={serverId} session={sessionWith({ memoryEnabled: true })} />);
        expect(screen.findByTestId('session-work-memory.enabled.switch')?.props.value).toBe(true);
        expect(screen.findByTestId('session-work-memory.doc.none')).toBeTruthy();
        expect(screen.findByTestId('session-work-memory.remember')).toBeTruthy();
    });
});
