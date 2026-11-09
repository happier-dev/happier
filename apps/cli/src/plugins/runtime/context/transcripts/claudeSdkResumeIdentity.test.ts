import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

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
import { createPluginTranscriptFileFollowService } from './fileFollow';
import { createTranscriptFileFollowPathGrantRegistry } from './fileFollowGrants';
import { createSessionHooksService } from '../../hooks/session/service';

async function createIdentityFixture() {
    const root = await mkdtemp(join(tmpdir(), 'happier-claude-sdk-proof-'));
    const providerSessionId = 'native-session';
    const path = join(root, `${providerSessionId}.jsonl`);
    const scope = { kind: 'session' as const, sessionId: 'happier-session' };
    const grants = createTranscriptFileFollowPathGrantRegistry();
    const hookOwner = createSessionHooksService({ happyHomeDir: root,
        hasCapability: capability => capability === 'sessionHooks',
        grantTranscriptFileFollowPath: async request => {
            await grants.grant({ pluginId: 'happier.agent.claude', runtimeId: 'sdk-runtime', scope,
                path: request.transcriptPath, reason: 'providerTranscriptSource',
                evidence: { kind: 'sessionStartTranscriptPath', providerSessionId: request.providerSessionId } });
        },
    });
    const fileFollow = createPluginTranscriptFileFollowService({
        pluginId: 'happier.agent.claude', runtimeId: 'sdk-runtime', readScope: () => scope,
        fileFollowPathGrants: grants,
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
    const ctx = createPluginContextFixture(createTerminalHostFixture().service, createEventsFixture().service, {
        exec: exec.service, sessionHooks: hooks.service, transcripts: { fileFollow },
    });
    return { root, path, providerSessionId, ctx, exec, hooks };
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
