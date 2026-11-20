import { appendFile, mkdir, mkdtemp, realpath, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import {
    createEventsFixture,
    createPluginContextFixture,
    createSdkExecFixture,
    createSessionHooksFixture,
    createTerminalHostFixture,
} from '../../../../../../../packages/plugins/claude/src/agent/runtime/engine.testkit';
import { createClaudeAgentSdkTurnOperations } from '../../../../../../../packages/plugins/claude/src/agent/runtime/remote/sdk/session';
import { createClaudeAgentSdkResumeIdentityOwner } from '../../../../../../../packages/plugins/claude/src/agent/runtime/remote/sdk/resumeIdentity';
import type { ClaudeProviderEvent } from '../../../../../../../packages/plugins/claude/src/agent/runtime/providerEvents';

import { buildInactiveSessionResumeSpawnOptions } from '@/daemon/sessions/runtimeSnapshot/buildInactiveSessionResumeSpawnOptions';
import { resolveSessionRuntimeSnapshot } from '@/daemon/sessions/runtimeSnapshot/resolveSessionRuntimeSnapshot';
import { subscribeSessionRuntimePublicationToMetadata } from '@/agent/runtime/identity/metadata/subscription';
import { createCliRuntimeSessionStateBridge } from '@/agent/runtime/state/bridge';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { createPluginTranscriptFileFollowService } from './fileFollow';
import { createTranscriptFileFollowPathGrantRegistry } from './fileFollowGrants';
import { createSessionHooksService } from '../../hooks/session/service';
import { createFilesystemEffectChannel, initializeFilesystemEffectChannel } from '@/rpc/handlers/fileSystem/filesystemEffectChannel';
import { runFilesystemEffectInternal } from '@/rpc/handlers/fileSystem/filesystemEffectInternal';

const nativeOpenBoundary = vi.hoisted(() => ({
    path: '',
    redirect: undefined as undefined | (() => Promise<() => Promise<void>>),
}));
// Redirect a real parent only at the OS open boundary, after native path
// authorization. The framed worker, identity proof and publication stay real.
vi.mock('node:fs/promises', async importOriginal => {
    const actual = await importOriginal<typeof import('node:fs/promises')>();
    return { ...actual, open: async (...args: Parameters<typeof actual.open>) => {
        const redirect = args[0] === nativeOpenBoundary.path ? nativeOpenBoundary.redirect : undefined;
        if (!redirect) return actual.open(...args);
        nativeOpenBoundary.redirect = undefined;
        const restore = await redirect();
        try { return await actual.open(...args); }
        finally { await restore(); }
    } };
});

async function createIdentityFixture(member = false) {
    const root = await mkdtemp(join(tmpdir(), 'happier-claude-sdk-proof-'));
    const providerSessionId = 'native-session';
    const home = member ? join(root, 'member') : root;
    if (member) await mkdir(home, { mode: 0o700 });
    const path = join(home, `${providerSessionId}.jsonl`);
    const scope = { kind: 'session' as const, sessionId: 'happier-session' };
    const grants = createTranscriptFileFollowPathGrantRegistry();
    const hookOwner = createSessionHooksService({ happyHomeDir: root,
        hasCapability: capability => capability === 'sessionHooks',
        grantTranscriptFileFollowPath: member ? undefined : async request => {
            await grants.grant({ pluginId: 'happier.agent.claude', runtimeId: 'sdk-runtime', scope,
                path: request.transcriptPath, reason: 'providerTranscriptSource',
                evidence: { kind: 'sessionStartTranscriptPath', providerSessionId: request.providerSessionId } });
        },
    });
    const memberReadFailures: unknown[] = [];
    let memberOpenCount = 0;
    const memberFilesystem = {
        home,
        async open(configuration: Parameters<typeof initializeFilesystemEffectChannel>[1], signal: AbortSignal) {
            memberOpenCount += 1;
            // Substitute the OS process boundary only. The real member worker
            // receives the framed configuration and performs all native reads.
            const input = new PassThrough();
            const output = new PassThrough();
            const worker = runFilesystemEffectInternal(input, output, signal);
            void worker.catch(error => output.destroy(error));
            const channel = createFilesystemEffectChannel({ input, output, signal, dispose: async () => {
                await worker;
                output.end();
            } });
            try {
                await initializeFilesystemEffectChannel(channel, configuration);
                return {
                    dispose: channel.dispose,
                    async request(request: unknown) {
                        try { return await channel.request(request); }
                        catch (error) { memberReadFailures.push(error); throw error; }
                    },
                };
            } catch (error) { await channel.dispose().catch(() => undefined); throw error; }
        },
    };
    const fileFollow = createPluginTranscriptFileFollowService({
        pluginId: 'happier.agent.claude', runtimeId: 'sdk-runtime', readScope: () => scope,
        fileFollowPathGrants: grants,
        ...(member ? { memberFilesystem } : {}),
        // Disable watcher wakeups and defer polling so only the actual lifecycle drain
        // can establish the proof; OS wakeup scheduling is the genuine boundary.
        watchFile: () => () => undefined,
        policy: { activeBurstPollIntervalMs: 60_000, activeFallbackPollIntervalMs: 60_000,
            idleFallbackPollIntervalMs: 60_000, missingFileRetryIntervalMs: 60_000 },
    });
    const exec = createSdkExecFixture();
    const hooks = createSessionHooksFixture();
    hooks.service.observeSessionHook.mockImplementation(async request => {
        await hookOwner.observeSessionHook({ ...request, providerId: 'claude', sessionId: scope.sessionId });
    });
    const context = createPluginContextFixture(createTerminalHostFixture().service, createEventsFixture().service, {
        exec: exec.service, sessionHooks: hooks.service, transcripts: { fileFollow },
    });
    const ctx = member ? { ...context, agentRuntime: { ...context.agentRuntime, startsRemote: true as const } } : context;
    return { root, path, providerSessionId, ctx, exec, hooks, memberReadFailures, memberOpenCount: () => memberOpenCount };
}

function nativeRows(providerSessionId: string, prompt: string) {
    return [
        { type: 'queue-operation', operation: 'enqueue', content: prompt },
        { type: 'user', uuid: 'accepted-user', timestamp: new Date().toISOString(), sessionId: providerSessionId,
            message: { role: 'user', content: prompt } },
        { type: 'assistant', uuid: 'settled-assistant', sessionId: providerSessionId,
            message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } },
    ].map(row => JSON.stringify(row)).join('\n') + '\n';
}

describe('Claude SDK native resume proof with the host file follower', () => {
    it.skipIf(process.platform !== 'linux' && process.platform !== 'darwin').each([
        'persisted', 'first file', 'disabled', 'historical', 'replaced', 'directory',
        'outside home', 'symlink escape', 'parent redirect', 'ordinary hook',
    ] as const)(
        'requires a new row in the owned member transcript for cold Send (%s)', async kind => {
        const fixture = await createIdentityFixture(true);
        const outside = join(fixture.root, 'outside.jsonl');
        const path = kind === 'outside home' ? outside
            : kind === 'first file' ? join(dirname(fixture.path), '.claude', 'projects', 'native-session.jsonl')
            : kind === 'parent redirect' ? join(dirname(fixture.path), 'nested', 'native-session.jsonl')
              : fixture.path;
        const prompt = 'accepted member prompt';
        const operations = createClaudeAgentSdkTurnOperations({ ctx: fixture.ctx, directory: fixture.root,
            launchEnv: {}, permissionMode: 'default', happierSessionId: 'happier-session', enableSessionResumability: true });
        let metadata = createTestMetadata({ machineId: 'machine-1', path: fixture.root, flavor: 'claude' });
        const session = { sessionId: 'happier-session', updateMetadata: async () => undefined };
        const state = createCliRuntimeSessionStateBridge({ session, credentials: { token: 'member-home', encryption: null },
            metadataPort: { update: async (_sessionId, update) => {
                metadata = createTestMetadata(update(metadata));
                return { ok: true, version: 1 };
            } } });
        const publication = subscribeSessionRuntimePublicationToMetadata({
            session, sessionState: state.engine, runtime: { readSessionIdentity: () => ({ sessionId: null }) },
            providerSessionMetadataKey: 'claudeSessionId',
        });
        let sequence = 0;
        const events: ClaudeProviderEvent[] = [];
        operations.subscribeProviderEvents(event => {
            if (event.kind !== 'session-id-publish') return;
            events.push(event);
            publication.observeRuntimeEvent({ kind: 'provider-session-id', sequence: ++sequence,
                sessionId: event.sessionId, emittedAtMs: event.emittedAtMs, providerSessionId: event.publishedSessionId,
                nativeSessionLogPath: event.nativeSessionLogPath });
        });
        try {
            if (kind === 'symlink escape') {
                await writeFile(outside, nativeRows(fixture.providerSessionId, prompt));
                await symlink(outside, path);
            }
            if (kind === 'historical' || kind === 'persisted' || kind === 'replaced') {
                await writeFile(path, nativeRows(fixture.providerSessionId, prompt));
            }
            if (kind === 'directory') await mkdir(path);
            if (kind === 'parent redirect') {
                const parent = dirname(path);
                const parked = `${parent}-original`;
                const outsideParent = join(fixture.root, 'outside');
                await mkdir(parent);
                await mkdir(outsideParent);
                await writeFile(path, nativeRows(fixture.providerSessionId, prompt));
                await writeFile(join(outsideParent, 'native-session.jsonl'), nativeRows(fixture.providerSessionId, prompt));
                nativeOpenBoundary.path = await realpath(path);
                nativeOpenBoundary.redirect = async () => {
                    await rename(parent, parked);
                    await symlink(outsideParent, parent);
                    return async () => { await unlink(parent); await rename(parked, parent); };
                };
            }
            await operations.sendProviderTurnPrompt(prompt);
            const hook = { hook_event_name: 'UserPromptSubmit', transcript_path: path, prompt };
            if (kind === 'ordinary hook') {
                const hookServer = fixture.hooks.service.startServer.mock.calls[0]?.[0];
                if (!hookServer?.onSessionHook) throw new Error('missing Session hook listener');
                await hookServer.onSessionHook(fixture.providerSessionId, hook);
            } else {
                await fixture.exec.emitSessionHook(fixture.providerSessionId, hook);
            }
            expect(events.filter(event => event.kind === 'session-id-publish')).toEqual([]);
            if (kind === 'replaced') {
                await rename(path, `${path}-original`);
                // The replacement has a matching row beyond the old offset;
                // its different inode must prevent promoting that row.
                await writeFile(path, nativeRows(fixture.providerSessionId, prompt).repeat(2));
            } else if (kind !== 'disabled' && kind !== 'historical' && kind !== 'directory') {
                if (kind === 'first file') await mkdir(dirname(path), { recursive: true });
                await appendFile(path, nativeRows(fixture.providerSessionId, prompt));
            }
            await fixture.exec.emit({ type: 'result', subtype: 'success', is_error: false, result: 'done',
                session_id: fixture.providerSessionId, queued_turn_count: 0, usage: {}, modelUsage: {} });
            await operations.waitForProviderTurnCompletion();
            expect(fixture.memberOpenCount()).toBe(kind === 'ordinary hook' ? 0 : 1);
            const publications = events.filter(event => event.kind === 'session-id-publish');
            if (kind === 'directory' || kind === 'outside home' || kind === 'symlink escape' || kind === 'parent redirect') {
                expect(fixture.memberReadFailures).toContainEqual(expect.objectContaining({ code: 'access_denied' }));
            }
            if (kind !== 'persisted' && kind !== 'first file') {
                expect(publications).toEqual([]);
                expect(metadata).not.toHaveProperty('claudeSessionId');
                expect(metadata).not.toHaveProperty('claudeTranscriptPath');
                return;
            }
            expect(publications).toEqual([expect.objectContaining({
                publishedSessionId: fixture.providerSessionId, nativeSessionLogPath: path,
            })]);
            await publication.waitForProviderSessionIdPublication(fixture.providerSessionId, new AbortController().signal);
            expect(metadata).toMatchObject({ claudeSessionId: fixture.providerSessionId, claudeTranscriptPath: path });
            const options = buildInactiveSessionResumeSpawnOptions({ sessionId: 'happier-session',
                rawSession: { machineId: 'machine-1', path: fixture.root }, metadata });
            if (!options) throw new Error('missing inactive session resume options');
            const resume = resolveSessionRuntimeSnapshot({ incomingOptions: options, persistedMetadata: metadata }).snapshot.vendorResumeId;
            if (!resume) throw new Error('missing member native resume id');
            await operations.disposeProviderSession();
            const cold = createClaudeAgentSdkTurnOperations({ ctx: fixture.ctx, directory: fixture.root,
                launchEnv: {}, permissionMode: 'default', happierSessionId: 'happier-session',
                initialProviderSessionId: resume.value, enableSessionResumability: true });
            try {
                await cold.sendProviderTurnPrompt('cold Send');
                expect(fixture.exec.spawnClient.mock.calls.at(-1)?.[0].launch.args)
                    .toEqual(expect.arrayContaining(['--resume', fixture.providerSessionId]));
            } finally { await cold.disposeProviderSession(); }
        } finally {
            nativeOpenBoundary.redirect = undefined;
            publication();
            await operations.disposeProviderSession();
            await rm(fixture.root, { recursive: true, force: true });
        }
    });

    it('publishes a fresh completed turn before another start hook and permits inactive resume', async () => {
        const fixture = await createIdentityFixture();
        const operations = createClaudeAgentSdkTurnOperations({ ctx: fixture.ctx, directory: fixture.root,
            launchEnv: {}, permissionMode: 'default', happierSessionId: 'happier-session', enableSessionResumability: true });
        const events: ClaudeProviderEvent[] = [];
        operations.subscribeProviderEvents(event => events.push(event));
        try {
            await operations.sendProviderTurnPrompt('accepted prompt');
            const hook = fixture.exec.emitSessionHook;
            await hook(fixture.providerSessionId, { hook_event_name: 'SessionStart', source: 'startup',
                session_id: fixture.providerSessionId, transcript_path: fixture.path });
            await fixture.exec.emit({ type: 'system', subtype: 'init', session_id: fixture.providerSessionId });
            expect(events.filter(event => event.kind === 'session-id-publish')).toEqual([]);
            await hook(fixture.providerSessionId, { hook_event_name: 'UserPromptSubmit',
                session_id: fixture.providerSessionId, prompt: 'accepted prompt' });
            await writeFile(fixture.path, nativeRows(fixture.providerSessionId, 'accepted prompt'));
            await fixture.exec.emit({ type: 'result', subtype: 'success', is_error: false, result: 'done',
                session_id: fixture.providerSessionId, queued_turn_count: 0, usage: {}, modelUsage: {} });
            await operations.waitForProviderTurnCompletion();
            const publication = events.find(event => event.kind === 'session-id-publish');
            expect(publication).toMatchObject({ publishedSessionId: fixture.providerSessionId, nativeSessionLogPath: fixture.path });
            if (publication?.kind !== 'session-id-publish') throw new Error('missing native identity publication');
            const metadata = { machineId: 'machine-1', path: fixture.root, flavor: 'claude',
                claudeSessionId: publication.publishedSessionId };
            const options = buildInactiveSessionResumeSpawnOptions({ sessionId: 'happier-session',
                rawSession: { machineId: 'machine-1', path: fixture.root }, metadata });
            expect(options).toMatchObject({ backendTarget: { backendId: 'claude' } });
            if (!options) throw new Error('missing inactive session resume options');
            // Derived provider identity is selected separately from explicit spawn intent.
            expect(resolveSessionRuntimeSnapshot({ incomingOptions: options, persistedMetadata: metadata }).snapshot.vendorResumeId)
                .toMatchObject({ value: fixture.providerSessionId });
        } finally {
            await operations.disposeProviderSession();
            await rm(fixture.root, { recursive: true, force: true });
        }
    });

    it.each(['unaccepted', 'missing', 'empty', 'mismatched', 'conflicting'] as const)('keeps %s native proof provisional at completion', async kind => {
        const fixture = await createIdentityFixture();
        const operations = createClaudeAgentSdkTurnOperations({ ctx: fixture.ctx, directory: fixture.root,
            launchEnv: {}, permissionMode: 'default', happierSessionId: 'happier-session', enableSessionResumability: true });
        const events: ClaudeProviderEvent[] = [];
        operations.subscribeProviderEvents(event => events.push(event));
        try {
            await operations.sendProviderTurnPrompt('accepted prompt');
            const hook = fixture.exec.emitSessionHook;
            await hook(fixture.providerSessionId, { hook_event_name: 'SessionStart', source: 'startup',
                session_id: fixture.providerSessionId, transcript_path: fixture.path });
            if (kind !== 'unaccepted') await hook(fixture.providerSessionId, { hook_event_name: 'UserPromptSubmit',
                session_id: fixture.providerSessionId, prompt: 'accepted prompt' });
            if (kind === 'unaccepted') await writeFile(fixture.path, nativeRows(fixture.providerSessionId, 'accepted prompt'));
            if (kind === 'empty') await writeFile(fixture.path, '');
            if (kind === 'mismatched' || kind === 'conflicting') await writeFile(fixture.path, JSON.stringify({
                type: 'user', uuid: 'foreign-user', timestamp: new Date().toISOString(), session_id: 'foreign-session',
                ...(kind === 'conflicting' ? { sessionId: fixture.providerSessionId } : {}),
                message: { role: 'user', content: 'accepted prompt' },
            }) + '\n');
            await fixture.exec.emit({ type: 'result', subtype: 'success', is_error: false, result: 'done',
                session_id: fixture.providerSessionId, queued_turn_count: 0, usage: {}, modelUsage: {} });
            await operations.waitForProviderTurnCompletion();
            expect(events.filter(event => event.kind === 'session-id-publish')).toEqual([]);
            await operations.sendProviderTurnPrompt('follow-up prompt');
            expect(fixture.exec.spawnClient.mock.calls.at(-1)?.[0].launch.args).not.toContain('--resume');
            await fixture.exec.emit({ type: 'result', subtype: 'success', is_error: false, result: 'done',
                session_id: fixture.providerSessionId, queued_turn_count: 0, usage: {}, modelUsage: {} });
            await operations.waitForProviderTurnCompletion();
        } finally {
            await operations.disposeProviderSession();
            await rm(fixture.root, { recursive: true, force: true });
        }
    });

    it('does not promote an idle start hook even when native user records arrive', async () => {
        const fixture = await createIdentityFixture();
        const promotions: Array<{ providerSessionId: string; transcriptPath: string }> = [];
        const owner = createClaudeAgentSdkResumeIdentityOwner({ ctx: fixture.ctx, onProviderSessionId: () => undefined,
            onTranscriptPromoted: async proof => { promotions.push({ providerSessionId: proof.providerSessionId, transcriptPath: proof.transcriptPath }); } });
        try {
            await fixture.hooks.service.observeSessionHook({ providerSessionId: fixture.providerSessionId, payload: {
                hook_event_name: 'SessionStart', session_id: fixture.providerSessionId, transcript_path: fixture.path,
            } });
            await owner.observeSessionHook(fixture.providerSessionId, { hook_event_name: 'SessionStart', source: 'startup',
                session_id: fixture.providerSessionId, transcript_path: fixture.path });
            await writeFile(fixture.path, nativeRows(fixture.providerSessionId, 'historical prompt'));
            await owner.settleCurrentCandidate();
            expect(promotions).toEqual([]);
        } finally {
            await owner.dispose();
            await rm(fixture.root, { recursive: true, force: true });
        }
    });

    it('accepts a complete first user record larger than a 64 KiB reader chunk', async () => {
        const fixture = await createIdentityFixture();
        const promotions: Array<{ providerSessionId: string; transcriptPath: string }> = [];
        const owner = createClaudeAgentSdkResumeIdentityOwner({ ctx: fixture.ctx, onProviderSessionId: () => undefined,
            onTranscriptPromoted: async proof => { promotions.push({ providerSessionId: proof.providerSessionId, transcriptPath: proof.transcriptPath }); } });
        try {
            await fixture.hooks.service.observeSessionHook({ providerSessionId: fixture.providerSessionId, payload: {
                hook_event_name: 'SessionStart', session_id: fixture.providerSessionId, transcript_path: fixture.path,
            } });
            const prompt = 'diagnostic '.repeat(7_000);
            owner.recordSubmittedPrompt(prompt);
            await owner.observeSessionHook(fixture.providerSessionId, { hook_event_name: 'SessionStart', source: 'startup',
                session_id: fixture.providerSessionId, transcript_path: fixture.path });
            await owner.observeSessionHook(fixture.providerSessionId, { hook_event_name: 'UserPromptSubmit',
                session_id: fixture.providerSessionId, prompt });
            await writeFile(fixture.path, nativeRows(fixture.providerSessionId, prompt));
            await owner.settleCurrentCandidate();
            expect(promotions).toEqual([{ providerSessionId: fixture.providerSessionId, transcriptPath: fixture.path }]);
        } finally {
            await owner.dispose();
            await rm(fixture.root, { recursive: true, force: true });
        }
    });
});
