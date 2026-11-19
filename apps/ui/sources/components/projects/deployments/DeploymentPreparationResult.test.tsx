// @vitest-environment jsdom
import * as React from 'react';
import { expect, it, vi } from 'vitest';
import { act, renderScreen } from '@/dev/testkit';
import { installSessionPaneRuntimeTestHarness } from '@/components/sessions/panes/sessionPaneRuntimeTestHarness';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { captureActiveServerAccountScopeLifetime, retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { storage } from '@/sync/domains/state/storage';
import { SessionWorkStateV1Schema } from '@happier-dev/protocol/sessions/work/state/sessionWorkStateV1';
import { DeploymentPreparationResult } from './DeploymentPreparationResult';
import { getScmUserFacingError } from '@/scm/scmUserFacingErrors';
import { t } from '@/text';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);

const reads: string[] = [];
const runtime = installSessionPaneRuntimeTestHarness({
    onHttpRequest: input => { reads.push(new URL(String(input)).pathname); },
});

function ownerSession(title: string, metadataVersion = 1) {
    const workState = SessionWorkStateV1Schema.parse({ v: 1, backendId: 'agent', updatedAt: 10,
        items: [{ id: 'actual-task', kind: 'task', origin: 'vendor', status: 'active', title, updatedAt: 10 }] });
    return createSessionFixture({ id: 's1', serverId: runtime.serverId, metadataVersion,
        metadata: { path: '/app', host: 'workspace', machineId: 'machine-1', sessionWorkStateV1: workState } });
}

it('shows the Session owner plan and updates locally without reading PRs for metadata or text arrivals', async () => {
    const lifetime = captureActiveServerAccountScopeLifetime();
    if (!lifetime) throw new Error('Expected the real Account lifetime');
    storage.getState().applySessions([ownerSession('Inspect the worker startup')]);
    const screen = await renderScreen(<DeploymentPreparationResult
        session={{ sessionId: 's1', serverId: runtime.serverId }} lifetime={lifetime} />, { wrapper: runtime.Wrapper });
    try {
        expect(screen.getTextContent()).toContain('Inspect the worker startup');
        const before = reads.length;
        await act(async () => {
            storage.getState().applySessions([ownerSession('Add the health endpoint', 2)]);
            storage.getState().applyMessages('s1', [{ id: 'prose', localId: null, seq: 2, createdAt: 20,
                role: 'agent', isSidechain: false, content: [{ type: 'text', text: 'PR opened; all checks passed',
                    uuid: 'prose', parentUUID: null }] }]);
        });
        expect(screen.getTextContent()).toContain('Add the health endpoint');
        expect(screen.getTextContent()).not.toContain('PR opened; all checks passed');
        expect(screen.findByTestId('project-deployments.prepare.result.unverified')).not.toBeNull();
        expect(reads.slice(before)).toEqual([]);
        await act(async () => {
            storage.getState().applyMessages('s1', [{ id: 'push-call', localId: null, seq: 3, createdAt: 30,
                role: 'agent', isSidechain: false, content: [{ type: 'tool-call', id: 'push',
                    name: 'mcp__happier__action_execute', input: { actionId: 'scm.remote.push', input: {} },
                    description: null, uuid: 'push-call', parentUUID: null }] },
            { id: 'push-result', localId: null, seq: 4, createdAt: 31, role: 'agent', isSidechain: false,
                content: [{ type: 'tool-result', tool_use_id: 'push', is_error: false, uuid: 'push-result', parentUUID: null,
                    content: { ok: true, result: { success: false, errorCode: 'REMOTE_AUTH_REQUIRED',
                        error: 'private provider diagnostic' } } }] }]);
        });
        expect(screen.getTextContent()).toContain(getScmUserFacingError({ errorCode: 'REMOTE_AUTH_REQUIRED',
            fallback: t('errors.operationFailed') }));
        expect(screen.getTextContent()).not.toContain('private provider diagnostic');
        await act(async () => {
            storage.getState().applySessions([{ ...ownerSession('Another Home private task', 3), serverId: 'foreign-home' }]);
        });
        expect(screen.getTextContent()).not.toContain('Another Home private task');
        expect(screen.getTextContent()).not.toContain('Add the health endpoint');
        await act(async () => retireActiveServerAccountScopeLifetime());
        expect(screen.getTextContent()).not.toContain(getScmUserFacingError({ errorCode: 'REMOTE_AUTH_REQUIRED',
            fallback: t('errors.operationFailed') }));
    } finally { await screen.unmount(); }
});

it("shows the preparing agent's own steps while it works (lab f1agent), from the Session's plan", async () => {
    const lifetime = captureActiveServerAccountScopeLifetime();
    if (!lifetime) throw new Error('Expected the real Account lifetime');
    const prepared = ownerSession('Prepare invoices for deploy');
    const workState = SessionWorkStateV1Schema.parse({ v: 1, backendId: 'claude', updatedAt: 10, items: [
        { id: 'read', kind: 'todo', origin: 'vendor', title: 'Read the repository', status: 'complete', updatedAt: 10 },
        { id: 'compose', kind: 'todo', origin: 'vendor', title: 'Write compose.yaml', status: 'active', updatedAt: 10 },
        { id: 'pr', kind: 'todo', origin: 'vendor', title: 'Open a pull request', status: 'pending', updatedAt: 10 },
    ] });
    storage.getState().applySessions([{ ...prepared, thinking: true,
        metadata: { ...prepared.metadata!, sessionWorkStateV1: workState },
    }]);
    const screen = await renderScreen(<DeploymentPreparationResult
        session={{ sessionId: 's1', serverId: runtime.serverId }} lifetime={lifetime} />, { wrapper: runtime.Wrapper });
    try {
        const text = screen.getTextContent();
        for (const step of ['Read the repository', 'Write compose.yaml', 'Open a pull request']) expect(text, text).toContain(step);
    } finally { await screen.unmount(); }
});
