import { describe, expect, it } from 'vitest';

import { t } from '@/text';
import type { WorkspaceSyncRelationshipStateLabelKey } from '@/sync/domains/sessionHandoff/workspaceSyncPresentation';

import { presentWorkspaceSyncStatusLine } from './WorkspaceSyncStatusLine';

function present(stateKey: WorkspaceSyncRelationshipStateLabelKey, overrides: Partial<Parameters<typeof presentWorkspaceSyncStatusLine>[0]> = {}) {
    return presentWorkspaceSyncStatusLine({ stateKey, status: null, readError: null, pending: false, lastCheckedLabel: null, ...overrides });
}

describe('presentWorkspaceSyncStatusLine', () => {
    it('keeps routine states quiet, with the last check beside them', () => {
        expect(present('workspaceSync.state.watching', { lastCheckedLabel: 'Last checked 10:44' }))
            .toEqual({ text: `${t('workspaceSync.state.watching')} · Last checked 10:44`, tone: 'quiet', busy: false, action: null });
        expect(present('workspaceSync.state.paused')).toMatchObject({ tone: 'quiet', action: null });
        expect(present('workspaceSync.state.flushing')).toMatchObject({ tone: 'quiet', busy: true });
    });

    it('names why the status is unavailable and offers to ask again', () => {
        const unreachable = Object.assign(new Error('rpc failed'), { code: 'controller_unavailable' });
        expect(present('workspaceSync.state.controllerUnavailable', { readError: unreachable }))
            .toEqual({ text: t('workspaceSync.error.machineOffline'), tone: 'warn', busy: false, action: 'retry' });
        // An unclassified read failure still says what is wrong and keeps the same next step.
        expect(present('workspaceSync.state.controllerUnavailable', { readError: new Error('boom') }))
            .toEqual({ text: t('workspaceSync.state.controllerUnavailable'), tone: 'warn', busy: false, action: 'retry' });
    });

    it('shows work in progress instead of the state while an action settles', () => {
        expect(present('workspaceSync.state.controllerUnavailable', { pending: true }))
            .toEqual({ text: t('workspaceSync.state.working'), tone: 'quiet', busy: true, action: null });
    });
});
