import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { storage } from '@/sync/domains/state/storage';
import { getServerUrl, setServerUrl } from '@/sync/domains/server/serverConfig';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { buildSessionListRenderableFromSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { useVoiceTargetStore } from '@/voice/runtime/voiceTargetStore';
import { listRecentPathsForVoiceTool } from './pathsListRecent';

const workspacePath = '/Users/leeroy/projects/happier';

function setRecentPaths(paths: Array<{ machineId: string; path: string }>) {
    storage.getState().applyAuthoringMemory({ recentMachinePaths: paths });
}

function forceRawPathSharing() {
    storage.setState((state) => ({ settings: {
        ...state.settings,
        voice: { ...state.settings.voice, privacy: { ...state.settings.voice.privacy, shareFilePaths: true } },
    } }));
}

describe('listRecentPathsForVoiceTool', () => {
    let previousState: ReturnType<typeof storage.getState>;
    let previousVoiceState: ReturnType<typeof useVoiceTargetStore.getState>;
    let previousServerUrl: string;
    let serverId: string;

    beforeEach(async () => {
        previousState = storage.getState();
        previousVoiceState = useVoiceTargetStore.getState();
        previousServerUrl = getServerUrl();
        await setServerUrl('https://voice-paths.example.test');
        serverId = getActiveServerSnapshot().serverId;
        useVoiceTargetStore.setState({ scope: 'global', primaryActionSessionAddress: null, lastFocusedSessionAddress: null });
        storage.setState({
            sessions: { s1: createSessionFixture({ id: 's1', serverId, updatedAt: 1000,
                metadata: { machineId: 'm1', path: workspacePath, host: 'leeroy-mbp' } }) },
            machines: { m1: createMachineFixture({ id: 'm1', metadata: {
                displayName: 'Leeroy MacBook Pro', host: 'leeroy-mbp', platform: 'darwin',
                happyCliVersion: 'test', happyHomeDir: '/Users/leeroy/.happier', homeDir: '/Users/leeroy',
            } }) },
            machineListByServerId: {},
            sessionListRowsByServerId: {},
            ordinarySessionListMembershipByServerId: {},
            sessionListIndexByServerId: {},
            concurrentSessionListCacheByServerId: {},
            settings: { ...previousState.settings, voice: { ...previousState.settings.voice,
                privacy: { ...previousState.settings.voice.privacy, shareDeviceInventory: true, shareFilePaths: false },
            } },
        });
        setRecentPaths([{ machineId: 'm1', path: workspacePath }]);
    });

    afterEach(async () => {
        storage.setState(previousState, true);
        useVoiceTargetStore.setState(previousVoiceState, true);
        await setServerUrl(previousServerUrl || null);
    });

    it('lists every recent folder by default and honors a requested 201-folder projection while redacting paths', async () => {
        storage.setState({ sessions: {} });
        const paths = Array.from({ length: 202 }, (_, i) => ({ machineId: 'm1', path: `/private/projects/project-${i}` }));
        setRecentPaths(paths.slice(0, 51));
        expect(await listRecentPathsForVoiceTool({ machineId: 'm1' })).toHaveProperty('items.length', 51);
        setRecentPaths(paths);
        const result = await listRecentPathsForVoiceTool({ machineId: 'm1', limit: 201 });
        expect(result).toHaveProperty('items.length', 201);
        expect(result).not.toHaveProperty('items.0.path');
        expect(result).not.toHaveProperty('items.0.machineId');
        expect(JSON.stringify(result)).not.toContain('/private/projects');
        expect(await listRecentPathsForVoiceTool({ machineId: 'm1', limit: 2 })).toHaveProperty('items.length', 2);
    });

    it('returns redacted labels without workspace handles when file paths are hidden', async () => {
        expect(await listRecentPathsForVoiceTool({ limit: 10 }))
            .toEqual({ items: [{ label: 'happier — Leeroy MacBook Pro', lastUsedAt: 1000 }] });
    });

    it('still redacts labels when a raw voice privacy blob tries to enable file path sharing', async () => {
        forceRawPathSharing();
        expect(await listRecentPathsForVoiceTool({ limit: 10 }))
            .toEqual({ items: [{ label: 'happier — Leeroy MacBook Pro', lastUsedAt: 1000 }] });
    });

    it('resolves the default machine and lastUsedAt from an explicit replacement target even when raw path sharing is force-enabled', async () => {
        useVoiceTargetStore.getState().setPrimaryActionSessionAddress({ serverId, sessionId: 's1' });
        storage.setState((state) => ({
            sessions: { s1: createSessionFixture({ id: 's1', serverId, updatedAt: 1000, metadata: {
                machineId: 'm-stale', path: workspacePath, homeDir: '/Users/leeroy', host: 'old-host',
            } }) },
            machines: { ...state.machines, 'm-stale': createMachineFixture({
                id: 'm-stale', active: false, replacedByMachineId: 'm1',
            }) },
        }));
        forceRawPathSharing();
        setRecentPaths([]);
        expect(await listRecentPathsForVoiceTool({ limit: 10 }))
            .toEqual({ items: [{ label: 'happier — Leeroy MacBook Pro', lastUsedAt: 1000 }] });
    });

    it('does not route a session-scoped inventory read through a stale global target', async () => {
        useVoiceTargetStore.setState({ scope: 'session', primaryActionSessionAddress: { serverId, sessionId: 'stale-global-session' } });
        storage.setState({
            sessions: { 'stale-global-session': createSessionFixture({ id: 'stale-global-session', serverId, updatedAt: 2000,
                metadata: { machineId: 'm-stale-target', path: '/Users/leeroy/projects/stale', host: 'old-host' } }) },
        });
        setRecentPaths([{ machineId: 'm1', path: '/Users/leeroy/projects/recent' }]);
        expect(await listRecentPathsForVoiceTool({ limit: 10 }))
            .toEqual({ items: [{ label: 'recent — Leeroy MacBook Pro', lastUsedAt: 0 }] });
    });

    it('canonicalizes the default machine from recent path entries before listing paths', async () => {
        storage.setState((state) => ({
            sessions: {},
            machines: { ...state.machines, 'm-stale': createMachineFixture({
                id: 'm-stale', active: false, replacedByMachineId: 'm1',
            }) },
        }));
        setRecentPaths([{ machineId: 'm-stale', path: workspacePath }]);
        expect(await listRecentPathsForVoiceTool({ limit: 10 }))
            .toEqual({ items: [{ label: 'happier — Leeroy MacBook Pro', lastUsedAt: 0 }] });
    });

    it('counts lastUsedAt from visible lookup session metadata when the raw session path is stale', async () => {
        const source = storage.getState().sessions.s1;
        storage.setState({
            sessions: { s1: { ...source, metadata: { ...source.metadata!, path: '/Users/leeroy/projects/old' } } },
            sessionListRowsByServerId: { [serverId]: { s1: buildSessionListRenderableFromSession(source) } },
            ordinarySessionListMembershipByServerId: { [serverId]: ['s1'] },
            sessionListIndexByServerId: { [serverId]: [{ type: 'session', sessionId: 's1', serverId, serverName: 'Server A' }] },
        });
        expect(await listRecentPathsForVoiceTool({ machineId: 'm1', limit: 10 }))
            .toEqual({ items: [{ label: 'happier — Leeroy MacBook Pro', lastUsedAt: 1000 }] });
    });
});
