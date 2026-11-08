import { describe, expect, it, vi } from 'vitest';
import type { ServerFetch } from '@/sync/http/client';
import { encodeBase64StoredJsonContentEnvelope } from '@/sync/encryption/base64StoredJsonContent';
import { createWorkspaceTabsHandoffPublisher, readWorkspaceTabsHandoff } from './workspaceTabsHandoff';
import { emptyWorkspaceTabs, type SharedWorkspaceTabs } from './workspaceSyncedTabs';

// Native installation identity and the mounted app are external application boundaries.
vi.mock('expo-constants', () => ({ default: { installationId: 'device-1' } }));
vi.mock('@/sync/runtime/getSyncSingleton', () => ({ getSyncSingleton: () => ({ encryption: null }) }));

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const currentness = { mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 };
const plain = (v: unknown) => encodeBase64StoredJsonContentEnvelope({ t: 'plain', v });

describe('workspace tabs explicit handoff', () => {
    it('publishes only explicit local changes to its device/window key and resolves CAS conflicts', async () => {
        const stored = new Map<string, { value: string; version: number }>();
        const prior: SharedWorkspaceTabs = emptyWorkspaceTabs();
        stored.set('workspace:handoff-tabs:v1:device-1:window-1', { value: plain(prior), version: 2 });
        const paths: string[] = [];
        const request: ServerFetch = async (path, init) => {
            paths.push(path);
            if (path === '/v1/account/encryption/currentness') return json(currentness);
            const { mutations } = JSON.parse(String(init?.body));
            const mutation = mutations[0];
            const existing = stored.get(mutation.key);
            if (existing && existing.version !== mutation.version) return json({ success: false, errors: [{
                key: mutation.key, error: 'version-mismatch', ...existing,
            }] }, 409);
            const version = (existing?.version ?? -1) + 1;
            stored.set(mutation.key, { value: mutation.value, version });
            return json({ success: true, results: [{ key: mutation.key, version }] });
        };
        const publisher = createWorkspaceTabsHandoffPublisher({ windowId: 'window-1', credentials: { token: 'Account-A' }, request, shouldContinue: () => true });
        expect(paths).toEqual([]);
        const record: SharedWorkspaceTabs = { v: 1, tabsById: { a: { id: 'a', target: { kind: 'home', params: {} }, pinned: true } }, order: ['a'], pairs: [] };
        await publisher.publish(record);
        expect(stored.get('workspace:handoff-tabs:v1:device-1:window-1')).toEqual({ value: plain(record), version: 3 });
        expect(stored.has('workspace:tabs:v1')).toBe(false);
        const otherWindow = createWorkspaceTabsHandoffPublisher({ windowId: 'window-2', credentials: { token: 'Account-A' }, request, shouldContinue: () => true });
        await otherWindow.publish(record);
        expect(stored.get('workspace:handoff-tabs:v1:device-1:window-2')).toEqual({ value: plain(record), version: 0 });
        expect(paths.every(path => path === '/v1/kv' || path === '/v1/account/encryption/currentness')).toBe(true);
    });

    it('reads only the explicitly named source through the captured Account transport', async () => {
        const record = emptyWorkspaceTabs();
        const request = vi.fn<ServerFetch>().mockResolvedValueOnce(json(currentness))
            .mockResolvedValueOnce(json({ values: [{ key: 'workspace:handoff-tabs:v1:other-device:other-window', value: plain(record), version: 4 }] }));
        await expect(readWorkspaceTabsHandoff({ source: { deviceId: 'other-device', windowId: 'other-window' }, credentials: { token: 'Account-A' }, request, shouldContinue: () => true }))
            .resolves.toEqual({ value: record, version: 4 });
        expect(request.mock.calls.map(call => call[0])).toEqual(['/v1/account/encryption/currentness', '/v1/kv/bulk']);
        expect(JSON.parse(String(request.mock.calls[1]?.[1]?.body))).toEqual({ keys: ['workspace:handoff-tabs:v1:other-device:other-window'] });
    });

    it('refuses publish and explicit reads after the captured Account retires', async () => {
        const request = vi.fn<ServerFetch>();
        const publisher = createWorkspaceTabsHandoffPublisher({ windowId: 'window-1', credentials: { token: 'Account-A' }, request, shouldContinue: () => false });
        await expect(publisher.publish(emptyWorkspaceTabs())).rejects.toMatchObject({ code: 'account_kv_scope_retired' });
        await expect(readWorkspaceTabsHandoff({ source: publisher.source, credentials: { token: 'Account-A' }, request, shouldContinue: () => false }))
            .rejects.toMatchObject({ code: 'account_kv_scope_retired' });
        expect(request).not.toHaveBeenCalled();
    });
});
