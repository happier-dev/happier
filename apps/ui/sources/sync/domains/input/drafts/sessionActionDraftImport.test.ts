import { afterEach, expect, it, vi } from 'vitest';
import { getPersistenceStorage } from '@/sync/domains/state/persistenceStorage';
import { scopedSessionLocalStateKey } from '@/sync/domains/state/sessionLocalStateKeys';
import * as repository from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import { getSessionDraftDocumentField } from '@/sync/ops/sessionDrafts/sessionDraftDocumentFields';
import { importSessionActionDrafts } from './sessionActionDraftImport';

afterEach(() => vi.restoreAllMocks());

it('imports only this Account/Home into existing launcher keys, preserving collision selections and sources until durable', async () => {
    const scope = { serverId: 'import-home', accountId: 'import-owner' };
    const other = { ...scope, accountId: 'other-owner' };
    const device = getPersistenceStorage();
    const sourceKey = scopedSessionLocalStateKey('session-action-drafts-v1', scope);
    const otherKey = scopedSessionLocalStateKey('session-action-drafts-v1', other);
    const card = { id: 'editing', sessionId: 's1', actionId: 'review.start', createdAt: 1,
        status: 'editing', input: { instructions: 'Imported editing', engineIds: ['legacy'] } };
    const source = JSON.stringify({ s1: [card, { ...card, id: 'failed', status: 'failed', input: { instructions: 'Imported failed' } },
        { ...card, id: 'running', status: 'running', input: { instructions: 'Already admitted' } }],
        addressed: [{ ...card, sessionId: undefined, id: 'addressed', address: { serverId: scope.serverId, sessionId: 's2' },
            accountId: scope.accountId, input: { sessionId: 'stale', instructions: 'Addressed', engineIds: ['selected'], roleId: 'reviewer', permissionMode: 'acceptEdits' } }],
        foreign: [{ ...card, sessionId: undefined, address: { serverId: other.serverId, sessionId: 's3' }, accountId: other.accountId }],
        foreignHome: [{ ...card, sessionId: undefined, address: { serverId: 'other-home', sessionId: 's4' }, accountId: scope.accountId }] });
    device.set(sourceKey, source);
    device.set(otherKey, source);
    let refuseDestination = false;
    let refuseSource = false;
    let saved = false;
    const write = device.set.bind(device);
    const remove = device.delete.bind(device);
    // MMKV is the real repository's native durable storage boundary.
    vi.spyOn(device, 'set').mockImplementation((key, value) => {
        if (key.startsWith('session-drafts-repository-v1:')) {
            if (refuseDestination) throw new Error('disk refused');
            write(key, value);
            saved = true;
            return;
        }
        if (key === sourceKey) {
            expect(saved).toBe(true);
            if (refuseSource) throw new Error('source refused');
        }
        write(key, value);
    });
    vi.spyOn(device, 'delete').mockImplementation(key => {
        if (key === sourceKey) {
            expect(saved).toBe(true);
            if (refuseSource) throw new Error('source refused');
        }
        remove(key);
    });
    const selection = { identity: { correlationId: 'existing', inputLocalId: 'existing-input' }, actionInput: { engineIds: ['existing'] } };
    repository.writeExistingSessionDraft({ scope, sessionId: 's1', patch: { executionRunLauncher: { key: 'review', patch: { text: 'Existing', selection } } } });
    await repository.flushSessionDraftLocally({ scope });
    refuseDestination = true;
    saved = false;
    await expect(importSessionActionDrafts(scope)).rejects.toThrow('disk refused');
    expect(device.getString(sourceKey)).toBe(source);
    refuseDestination = false;
    refuseSource = true;
    await expect(importSessionActionDrafts(scope)).rejects.toThrow('source refused');
    expect(device.getString(sourceKey)).toBe(source);
    refuseSource = false;
    await importSessionActionDrafts(scope);
    const read = (sessionId: string, field: 'text' | 'selection', key = 'review') => getSessionDraftDocumentField(repository.getSessionDraftSnapshot(scope,
        { kind: 'session', sessionId })?.document ?? null, repository.executionRunLauncherDraftFieldPath(key, field))?.value;
    expect(read('s1', 'text')).toBe('Existing\n\nImported editing\n\nImported failed\n\nImported editing\n\nImported failed\n\nImported editing\n\nImported failed');
    expect(read('s1', 'selection')).toEqual(selection);
    expect(read('s2', 'text', 'review:reviewer')).toBe('Addressed');
    expect(read('s2', 'selection', 'review:reviewer')).toMatchObject({ actionInput: { sessionId: 's2', instructions: '', engineIds: ['selected'], roleId: 'reviewer', permissionMode: 'workspace_write' } });
    expect(repository.getSessionDraftSnapshot(scope, { kind: 'session', sessionId: 's3' })).toBeNull();
    expect(repository.getSessionDraftSnapshot(scope, { kind: 'session', sessionId: 's4' })).toBeNull();
    expect(device.getString(otherKey)).toBe(source);
    const retained = JSON.parse(source);
    retained.s1 = [retained.s1[2]];
    delete retained.addressed;
    expect(JSON.parse(device.getString(sourceKey)!)).toEqual(retained);
    const lastSource = JSON.stringify({ s5: [{ ...card, sessionId: 's5', input: { instructions: 'Last source' } }] });
    device.set(sourceKey, lastSource);
    refuseSource = true;
    await expect(importSessionActionDrafts(scope)).rejects.toThrow('source refused');
    expect(device.getString(sourceKey)).toBe(lastSource);
    expect(read('s5', 'text')).toBe('Last source');
    refuseSource = false;
    await importSessionActionDrafts(scope);
    expect(read('s5', 'text')).toBe('Last source\n\nLast source');
    expect(device.getString(sourceKey)).toBeUndefined();
    device.delete(otherKey);
});
