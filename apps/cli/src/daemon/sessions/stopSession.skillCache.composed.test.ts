import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer, type ServerResponse } from 'node:http';
import { lstat, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { computePromptBundleDigestV1 } from '@happier-dev/protocol/prompts/library/promptLibraryDigests';
import { FIRST_PARTY_SKILLS_V1 } from '@happier-dev/protocol/prompts/library/skills/firstPartySkillsV1';
import { createCredentialedAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { configuration } from '@/configuration';
import { readSkillLibraryDigests } from '@/prompts/skills/library/readSkillLibraryContent';
import { createSkillStore } from '@/prompts/skills/store/skillStore';
import { logger } from '@/ui/logger';
import { readProcessIdentityByPid } from '../processIdentity';
import type { TrackedSession } from '../types';
import { createOnChildExited } from './onChildExited';
import { createStopSession } from './stopSession';
import { waitForExistingSessionExitIfStopRequested } from './waitForExistingSessionExitIfStopRequested';
import { waitForTrackedRunnerProcessesExit } from './waitForTrackedRunnerProcessesExit';
import { legacyPidSessionTrackingKey } from '@/daemon/sessions/sessionTrackingKey';

it.each(['complete', 'unavailable'] as const)(
    'collects unpinned plugin content despite an offline Machine, preserving Stop GC roots with %s Artifact coverage', async coverage => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-stop-skill-cache-'));
    const skills = ['deleted', 'retained', 'live', 'plugin-pinned', 'plugin-run', 'plugin-obsolete'].map(name => {
        const files = [{ path: 'SKILL.md', contentKind: 'utf8' as const,
            contentBase64: Buffer.from(`---\nname: ${name}\n---\nUse ${name}.`).toString('base64') }];
        return { skillId: name.startsWith('plugin-') ? `plugin:external.skills/${name}` : name, name, files,
            digest: computePromptBundleDigestV1({ v: 1, entries: files, createdAtMs: 0, updatedAtMs: 0 }) };
    });
    const [deleted, retained, live, pluginPinned, pluginRun, pluginObsolete] = skills;
    const firstParty = FIRST_PARTY_SKILLS_V1.map(stub => ({ skillId: stub.skillId, name: stub.name, files: [...stub.files],
        digest: computePromptBundleDigestV1({ v: 1, entries: [...stub.files], createdAtMs: 0, updatedAtMs: 0 }) }));
    let deletedFromLibrary = false;
    let holdInventory = false;
    let inventoryComplete = true;
    let heldResponse: ServerResponse | undefined;
    let releaseInventory: (() => void) | undefined;
    // HTTP is the Account boundary. The real client, persisted-mode decoder,
    // library reader, Stop/exit composition and filesystem collector run below it.
    const server = createServer((request, response) => {
        const url = new URL(request.url ?? '/', 'http://127.0.0.1');
        response.setHeader('content-type', 'application/json');
        if (request.method === 'DELETE' && url.pathname === '/v1/artifacts/deleted') {
            deletedFromLibrary = true;
            response.end(JSON.stringify({ success: true }));
        } else if (url.pathname === '/v1/artifacts') {
            const items = [deleted, retained].filter(item => !deletedFromLibrary || item !== deleted).map((item, index) => ({
                id: item.skillId, ownerAccountId: 'account', access: 'owner', publicAudience: 'none', encryptionMode: 'plain',
                dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, headerVersion: 1, bodyVersion: 1,
                seq: index + 1, createdAt: 1, updatedAt: 1,
                header: encodePlainArtifactStoredContent({ v: 1, kind: 'prompt_bundle.v2', title: item.name, bundleSchemaId: 'skills.skill_md_v1' }),
                body: encodePlainArtifactStoredContent({ body: JSON.stringify({ v: 1, entries: item.files, createdAtMs: 0, updatedAtMs: 0 }) }),
            }));
            const respond = () => response.end(JSON.stringify({ items, hasUnclassified: !inventoryComplete }));
            if (holdInventory) { heldResponse = response; releaseInventory = respond; }
            else respond();
        } else if (url.pathname === '/v1/plugins/availability/materializations/read') {
            response.end(JSON.stringify({ availabilityCursor: 1, inventoryComplete: true, releases: [],
                snapshots: [{ serverIdentityId: 'srv_skills', machineId: 'offline', materializations: [{
                    serverIdentityId: 'srv_skills', machineId: 'offline', materializationId: 'installation', pluginId: 'external.skills',
                    version: '1.0.0', sourceClass: 'localPath', portableRelease: false, uiArtifacts: [], enabled: true,
                    trustState: 'trusted', observedAt: 1,
                }] }] }));
        } else if (url.pathname === '/v1/machines') {
            response.end('[]');
        } else if (url.pathname === '/v1/account/encryption') {
            response.end(JSON.stringify({ mode: 'plain', updatedAt: 1 }));
        } else { response.statusCode = 404; response.end('{}'); }
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Fixture HTTP address unavailable');
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const credentials = { token: `header.${Buffer.from(JSON.stringify({ sub: 'account' })).toString('base64url')}.signature`, encryption: null };
    const store = createSkillStore({ happyHomeDir, readLibraryDigests: () => readSkillLibraryDigests(credentials) });
    const child = spawn(process.execPath, ['-e', "process.send('ready'); setInterval(() => {}, 1000)"],
        { detached: process.platform !== 'win32', stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    const exited = once(child, 'exit');
    const warn = vi.spyOn(logger, 'warnLocalFile');
    const skips = () => warn.mock.calls.filter(([, details]) => details && typeof details === 'object'
        && Reflect.get(details, 'reason') === 'library_inventory_unavailable');
    let sessionId: string | undefined;
    const cachePath = (item: Readonly<{ digest: string }>) => join(happyHomeDir, 'skills', 'cache', item.digest.slice(7));
    try {
        await once(child, 'message');
        const pid = child.pid!;
        sessionId = `PID-${pid}`;
        const identity = await readProcessIdentityByPid(pid);
        if (!identity) throw new Error('Owned fixture process identity unavailable');
        await runWithServerHttpBaseUrl(baseUrl, async () => {
            const session = await store.ensureSkillSessionDir({ ownerKey: sessionId!, items: [deleted], nativeDisables: [] });
            await store.ensureSkillSessionDir({ ownerKey: 'library-only', items: [retained, ...firstParty], nativeDisables: [] });
            await store.releaseSkillSessionDirs('library-only');
            await store.ensureSkillSessionDir({ ownerKey: 'other-live', items: [live, pluginPinned], nativeDisables: [] });
            await store.ensureSkillSessionDir({ ownerKey: 'other-live/runs/live-run', items: [pluginRun], nativeDisables: [] });
            expect(await readSkillLibraryDigests(credentials)).toEqual(expect.arrayContaining([deleted.digest, retained.digest]));
            expect(await createCredentialedAccountArtifactStore(credentials).delete(deleted.skillId)).toEqual({ ok: true });
            await store.collectSkillCache();
            expect(JSON.parse(await readFile(join(session.pluginRoot, 'session.json'), 'utf8')))
                .toMatchObject({ items: [{ digest: deleted.digest }] });
            expect(await lstat(cachePath(deleted))).toBeDefined();

            await store.ensureSkillSessionDir({ ownerKey: 'retired-plugin', items: [pluginObsolete], nativeDisables: [] });
            await store.releaseSkillSessionDirs('retired-plugin');
            holdInventory = true;
            const tracked: TrackedSession = { trackingKey: legacyPidSessionTrackingKey(pid), pid, childProcess: child, startedBy: 'daemon', happySessionId: sessionId,
                processStartTimeMs: identity.processStartTimeMs, processCommandHash: identity.processCommandHash };
            const sessions = new Map([[tracked.trackingKey, tracked]]);
            const onExit = createOnChildExited({ skillStore: store, trackedSessionsByKey: sessions,
                spawnResourceCleanupByKey: new Map(), sessionAttachCleanupByKey: new Map(), getApiMachineForSessions: () => null,
                // The fixture has no persisted Session marker; only its OS storage boundary is replaced.
                removeSessionMarkerFn: async () => {} });
            const stop = createStopSession({ trackedSessionsByKey: sessions,
                areTrackedRunnersExited: ({ trackedPids }) => waitForTrackedRunnerProcessesExit({
                    runners: trackedPids.map(pid => ({ pid })), timeoutMs: 0, pollIntervalMs: 0 }),
                waitForTrackedRunnersExit: async ({ sessionId, trackedPids }) => {
                    await waitForExistingSessionExitIfStopRequested({ sessionId, trackedSessionsByKey: sessions,
                        timeoutMs: configuration.daemonStopSessionWaitForExitMs,
                        pollIntervalMs: configuration.daemonStopSessionWaitForExitPollIntervalMs, onExitObserved: onExit });
                    return trackedPids.every(pid => !sessions.has(legacyPidSessionTrackingKey(pid)));
                } });
            expect(await stop(sessionId!)).toEqual({ status: 'stopped' });
            expect(sessions.size).toBe(0);
            await expect(lstat(session.pluginRoot)).rejects.toMatchObject({ code: 'ENOENT' });
            await vi.waitFor(() => expect(heldResponse).toBeDefined());
            expect(await lstat(cachePath(deleted))).toBeDefined();
            inventoryComplete = coverage === 'complete';
            releaseInventory!();
            holdInventory = false;
            if (coverage === 'unavailable') {
                await vi.waitFor(() => expect(skips()).toHaveLength(1));
                expect(await lstat(cachePath(deleted))).toBeDefined();
                expect(await lstat(cachePath(pluginObsolete))).toBeDefined();
                // Recovery belongs to the existing startup sweep, without a new retry/timer.
                inventoryComplete = true;
                await store.reconcileSkillSessionDirs({ liveSessionIds: ['other-live'] });
            }
            await vi.waitFor(async () => { await expect(lstat(cachePath(deleted))).rejects.toMatchObject({ code: 'ENOENT' }); });
            expect(await lstat(cachePath(retained))).toBeDefined();
            expect(await lstat(cachePath(live))).toBeDefined();
            expect(await lstat(cachePath(pluginPinned))).toBeDefined();
            expect(await lstat(cachePath(pluginRun))).toBeDefined();
            for (const stub of firstParty) expect(await lstat(cachePath(stub))).toBeDefined();
            await expect(lstat(cachePath(pluginObsolete))).rejects.toMatchObject({ code: 'ENOENT' });
            expect(skips()).toHaveLength(coverage === 'unavailable' ? 1 : 0);
        });
    } finally {
        heldResponse?.end(JSON.stringify({ items: [], hasUnclassified: true }));
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        await exited;
        // All fixture trees retire through the real owner, including immutable files.
        if (sessionId) await store.releaseSkillSessionDirs(sessionId);
        await store.releaseSkillSessionDirs('library-only');
        await store.releaseSkillSessionDirs('retired-plugin');
        await store.releaseSkillSessionDirs('other-live');
        await store.collectSkillCache({ libraryDigests: [] });
        warn.mockRestore();
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        await rm(happyHomeDir, { recursive: true, force: true });
    }
});
