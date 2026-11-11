import { describe, expect, it } from 'vitest';

import type { MachineAgent, MachineAgentSignInSession } from '@/agents/machineAgents/machineAgentTypes';
import { formatMachineAgentStatus } from './machineAgentCopy';
import { projectMachineAgent } from '@/agents/machineAgents/machineAgentModel';
import { MachineAgentInventoryItemSchema } from '@happier-dev/protocol/capabilities';
import { t } from '@/text';
import { resolveMachineAgentState, isMachineAgentReady } from '@/agents/machineAgents/resolveMachineAgentState';

import {
    isMachineAgentUnchecked,
    resolveAgentSetupPhase,
    rankFirstAgentChoices,
    resolveAgentSessionStartBlock,
    shouldOfferFirstAgentSetup,
    resolveMachineAgentPickerPlacement,
    splitMachineAgents,
    resolveMachineAgentRowAction,
    resolveMachineAgentStatus,
} from './machineAgentPresentation';

const idleSession: MachineAgentSignInSession = { phase: 'idle', terminalKey: null, authUrl: null, startedAtMs: null, failure: null };

function agent(overrides: Partial<MachineAgent> = {}): MachineAgent {
    return {
        agentId: 'antigravity',
        title: 'Antigravity',
        state: 'notInstalled',
        installed: false,
        version: null,
        latestVersion: null,
        update: null,
        signIn: { status: 'unknown', via: null, nativeLogin: 'terminal', connectedServices: [] },
        platform: { supported: true },
        install: { available: true, mode: 'vendor_recipe', sizeBytes: 680_000_000, guideUrl: 'https://example.test/guide', requiresVendorConsent: true },
        dependencies: [],
        job: null,
        stale: false,
        ...overrides,
    };
}

describe('machine agent presentation', () => {
    it('distinguishes a known installation with unknown sign-in from a failed Machine check', () => {
        // Recorded QA Machine result: installed Droid 1.7.1, unknown native auth, no unavailable result.
        const facts = MachineAgentInventoryItemSchema.parse({ agentId: 'droid', title: 'Factory Droid',
            installed: true, version: '1.7.1', latestVersion: null, update: { supported: false, command: null },
            signIn: { status: 'unknown', loginSupport: 'login_terminal' }, platform: { supported: true },
            install: { available: true, mode: 'vendor_recipe', sizeBytes: null, guideUrl: null }, dependencies: [] });
        const project = (installed: boolean) => projectMachineAgent({ agentId: facts.agentId, title: facts.title,
            facts: { ...facts, installed }, checking: false, stale: false, connectedServices: [], job: null });
        const installed = project(true);
        expect(installed.state).toBe('unknown');
        expect(isMachineAgentReady(installed)).toBe(false);
        expect(installed.version).toBe('1.7.1');
        expect(resolveMachineAgentStatus(installed)).toEqual({ kind: 'signInUnknown', tone: 'quiet' });
        expect(formatMachineAgentStatus(resolveMachineAgentStatus(installed))).toBe(t('machineAgents.signInUnknown'));
        expect(resolveMachineAgentRowAction(installed)).toBeNull();
        expect(resolveMachineAgentStatus(project(false))).toMatchObject({ kind: 'notInstalled' });
        expect(resolveMachineAgentStatus({ ...installed, stale: true, staleReason: 'error',
            unavailableReason: { reason: 'probe_failed', errorCode: 'cli-detection-failed' } })).toMatchObject({ kind: 'unavailable' });
    });

    it('does not offer setup from retained Agent facts while its Machine is offline', () => {
        const missing = agent({ stale: true, staleReason: 'offline' });
        const signedOut = agent({ installed: true, state: 'needsSignIn', stale: true, staleReason: 'offline' });
        expect(resolveMachineAgentPickerPlacement(missing)).toMatchObject({ opensSetup: false });
        expect(resolveMachineAgentPickerPlacement(signedOut)).toMatchObject({ opensSetup: false });
        expect(resolveMachineAgentPickerPlacement({ ...missing, stale: false })).toMatchObject({ opensSetup: true });
    });
    it('keeps a runnable installed Agent selectable while its optional update is pending or failed', () => {
        const installed = agent({ installed: true, version: '1.0.0', latestVersion: '2.0.0',
            update: { supported: true, command: null },
            signIn: { status: 'signedIn', via: { kind: 'native', accountLabel: null }, nativeLogin: 'terminal', connectedServices: [] } });
        for (const outcome of [null, { kind: 'failed', code: 'download_failed', stepId: 'download', message: 'Update failed' }] as const) {
            const job: NonNullable<MachineAgent['job']> = { jobId: 'optional-update', intent: 'update',
                startedAtMs: 1, steps: [], logLine: null, outcome };
            const row = { ...installed, job, state: resolveMachineAgentState({ ...installed, job }) };
            expect(row.state).toBe('updateAvailable');
            expect(isMachineAgentReady(row)).toBe(true);
            expect(resolveAgentSessionStartBlock(row)).toBeNull();
            expect(resolveMachineAgentPickerPlacement(row)).toMatchObject({ group: 'onMachine', opensSetup: false });
            // The existing job presentation still makes the optional update outcome visible.
            expect(resolveMachineAgentStatus(row).kind).toBe(outcome === null ? 'installing' : 'failed');
        }
    });
    it('keeps transport diagnostics out of the shared status copy used by the composer and Machine rows', () => {
        expect(formatMachineAgentStatus({ kind: 'unavailable', tone: 'quiet',
            reason: { reason: 'probe_failed', errorCode: 'transport-error' } })).toBe(t('machineAgents.unknown'));
    });
    it('preserves the inventory-owned classified failure in its status instead of presenting unknown', () => {
        const row = agent({ installed: true, state: 'unknown', stale: true, staleReason: 'error',
            unavailableReason: { reason: 'probe_failed', errorCode: 'RPC_FORBIDDEN' } });
        expect(resolveMachineAgentStatus(row)).toEqual({ kind: 'unavailable', tone: 'quiet',
            reason: { reason: 'probe_failed', errorCode: 'RPC_FORBIDDEN' } });
    });

    it('tells an agent nobody asked about yet from a check in progress or a failed one', () => {
        expect(isMachineAgentUnchecked(null, 'idle')).toBe(true);
        expect(isMachineAgentUnchecked(null, 'loading')).toBe(false);
        expect(isMachineAgentUnchecked(null, 'error')).toBe(false);
        expect(isMachineAgentUnchecked(null, 'ready')).toBe(false);
    });
    it('presents unanswered inventory as checking until the probe settles, retaining known Agent facts', () => {
        const unanswered = agent({ state: 'unknown' });
        expect(resolveMachineAgentStatus(unanswered, idleSession, 'loading')).toEqual({ kind: 'checking', tone: 'quiet' });
        expect(resolveMachineAgentStatus(null, idleSession, 'loading')).toEqual({ kind: 'checking', tone: 'quiet' });
        expect(resolveMachineAgentStatus(unanswered, idleSession, 'error')).toEqual({ kind: 'unknown', tone: 'quiet' });
        expect(resolveMachineAgentStatus(null, idleSession, 'ready')).toEqual({ kind: 'unknown', tone: 'quiet' });
        const ready = agent({ state: 'ready', installed: true });
        expect(resolveMachineAgentStatus(ready, idleSession, 'loading').kind).toBe('ready');
        expect(resolveMachineAgentStatus(agent({ state: 'needsSignIn' }), idleSession, 'loading').kind).toBe('needsSignIn');
    });

    it('offers Install for an agent that is not installed, and the setup guide when Happier cannot install it', () => {
        expect(resolveAgentSetupPhase(agent(), idleSession)).toBe('install');
        expect(resolveMachineAgentRowAction(agent(), idleSession)).toEqual({ kind: 'install' });

        const manual = agent({ install: { available: false, mode: 'manual', sizeBytes: null, guideUrl: 'https://example.test/guide', requiresVendorConsent: false } });
        expect(resolveAgentSetupPhase(manual, idleSession)).toBe('manualInstall');
        expect(resolveMachineAgentRowAction(manual, idleSession)).toEqual({ kind: 'guide', url: 'https://example.test/guide' });
    });

    it('never offers Install on a machine the agent cannot run on', () => {
        const unsupported = agent({ state: 'unsupported', platform: { supported: false, reason: 'arch' } });
        expect(resolveAgentSetupPhase(unsupported, idleSession)).toBe('unsupported');
        expect(resolveMachineAgentRowAction(unsupported, idleSession)).toBeNull();
        expect(resolveMachineAgentStatus(unsupported, idleSession)).toMatchObject({ kind: 'unsupported', reason: 'arch' });
    });

    it('shows the running step with its byte progress while an install job runs, and Cancel', () => {
        const installing = agent({
            state: 'installing',
            job: {
                jobId: 'job-1',
                intent: 'install',
                startedAtMs: 0,
                logLine: null,
                outcome: null,
                steps: [
                    { stepId: 'cli', label: 'Install the Antigravity CLI', state: 'done', bytesDone: null, bytesTotal: null },
                    { stepId: 'dep.antigravity.agy-acp-server', label: 'Download the session server', state: 'running', bytesDone: 259_000_000, bytesTotal: 680_000_000 },
                ],
            },
        });
        expect(resolveAgentSetupPhase(installing, idleSession)).toBe('installing');
        expect(resolveMachineAgentRowAction(installing, idleSession)).toEqual({ kind: 'cancel' });
        expect(resolveMachineAgentStatus(installing, idleSession)).toEqual({
            kind: 'installing',
            tone: 'quiet',
            stepLabel: 'Download the session server',
            bytesDone: 259_000_000,
            bytesTotal: 680_000_000,
        });
    });

    it('names the failure and offers Try again after a failed job, but a cancelled one is just not installed', () => {
        const failedJob = {
            jobId: 'job-2', intent: 'install' as const, startedAtMs: 0, logLine: null, steps: [],
            outcome: { kind: 'failed' as const, code: 'download_failed' as const, stepId: 'dep', message: 'Connection reset' },
        };
        const failed = agent({ state: 'failed', job: failedJob });
        expect(resolveAgentSetupPhase(failed, idleSession)).toBe('installFailed');
        expect(resolveMachineAgentRowAction(failed, idleSession)).toEqual({ kind: 'retry' });
        expect(resolveMachineAgentStatus(failed, idleSession)).toMatchObject({ kind: 'failed', tone: 'bad', failure: { code: 'download_failed' } });

        const cancelled = agent({ state: 'notInstalled', job: { ...failedJob, outcome: { ...failedJob.outcome, code: 'cancelled' } } });
        expect(resolveAgentSetupPhase(cancelled, idleSession)).toBe('install');
    });

    it('asks for sign-in, then waits on the terminal once the native sign-in is open', () => {
        const signedOut = agent({ state: 'needsSignIn', installed: true, version: '1.1.1', signIn: { status: 'signedOut', via: null, nativeLogin: 'terminal', connectedServices: [] } });
        expect(resolveAgentSetupPhase(signedOut, idleSession)).toBe('signIn');
        expect(resolveMachineAgentRowAction(signedOut, idleSession)).toEqual({ kind: 'signIn' });
        expect(resolveMachineAgentStatus(signedOut, idleSession)).toMatchObject({ kind: 'needsSignIn', tone: 'warn' });

        const waiting: MachineAgentSignInSession = { phase: 'waiting', terminalKey: 'k', authUrl: null, startedAtMs: 0, failure: null };
        expect(resolveAgentSetupPhase(signedOut, waiting)).toBe('waitingForSignIn');
        expect(resolveMachineAgentRowAction(signedOut, waiting)).toEqual({ kind: 'showTerminal' });
    });

    it('says how a ready agent is signed in and offers an update only where Happier can update it', () => {
        const viaService = agent({
            agentId: 'claude', title: 'Claude Code', state: 'ready', installed: true, version: '2.1.278',
            signIn: { status: 'signedIn', via: { kind: 'connected', serviceId: 'claude-subscription', title: 'Claude subscription', profileLabel: 'Work · Max' }, nativeLogin: 'terminal', connectedServices: [] },
        });
        expect(resolveAgentSetupPhase(viaService, idleSession)).toBe('ready');
        expect(resolveMachineAgentRowAction(viaService, idleSession)).toBeNull();
        expect(resolveMachineAgentStatus(viaService, idleSession)).toMatchObject({ kind: 'ready', via: 'connected', label: 'Work · Max' });

        const update = agent({
            agentId: 'codex', title: 'Codex', state: 'updateAvailable', installed: true, version: '0.155.1', latestVersion: '0.157.0',
            update: { supported: true, command: null },
            signIn: { status: 'signedIn', via: { kind: 'native', accountLabel: null }, nativeLogin: 'terminal', connectedServices: [] },
        });
        expect(resolveMachineAgentRowAction(update, idleSession)).toEqual({ kind: 'update' });
        expect(resolveMachineAgentStatus(update, idleSession)).toMatchObject({ kind: 'ready', via: 'native', updateTo: '0.157.0' });

        const copyOnly = agent({ ...update, update: { supported: false, command: 'npm i -g @openai/codex' } });
        expect(resolveMachineAgentRowAction(copyOnly, idleSession)).toBeNull();
    });

    it('shows last-known facts for an offline machine and offers no action', () => {
        const offline = agent({
            agentId: 'claude', title: 'Claude Code', state: 'ready', installed: true, version: '2.1.278', stale: true,
            signIn: { status: 'signedIn', via: { kind: 'native', accountLabel: null }, nativeLogin: 'terminal', connectedServices: [] },
        });
        expect(resolveMachineAgentRowAction(offline, idleSession)).toBeNull();
        expect(resolveMachineAgentStatus(offline, idleSession)).toMatchObject({ kind: 'offline', lastKnown: 'signedIn' });
    });

    it('puts an agent that is not on the machine in its own rail group that opens setup, even when a dependency of it is installed', () => {
        const dependencyOnly = agent({ dependencies: [{ key: 'dep.antigravity.agy-acp-server', title: 'ACP server', installed: true, version: '1.1.1' }] });
        expect(resolveMachineAgentPickerPlacement(dependencyOnly, idleSession)).toEqual({ group: 'notOnMachine', marker: 'download', opensSetup: true });

        const signedOut = agent({ state: 'needsSignIn', installed: true, version: '1.1.1', signIn: { status: 'signedOut', via: null, nativeLogin: 'terminal', connectedServices: [] } });
        expect(resolveMachineAgentPickerPlacement(signedOut, idleSession)).toEqual({ group: 'onMachine', marker: 'needsSignIn', opensSetup: true });

        expect(resolveMachineAgentPickerPlacement(agent({ state: 'unsupported', platform: { supported: false, reason: 'os' } }), idleSession).group).toBe('cantRun');
        expect(resolveMachineAgentPickerPlacement(null, idleSession)).toEqual({ group: 'onMachine', marker: 'none', opensSetup: false });
    });

    it('lists installed agents first and never offers what cannot run here, keeping a just-installed agent where its open form is', () => {
        const installed = agent({ agentId: 'claude', state: 'ready', installed: true, version: '2', signIn: { status: 'signedIn', via: { kind: 'native', accountLabel: null }, nativeLogin: 'terminal', connectedServices: [] } });
        const missing = agent({ agentId: 'gemini' });
        const unsupported = agent({ agentId: 'kimi', state: 'unsupported', platform: { supported: false, reason: 'os' } });
        const justInstalled = agent({
            agentId: 'antigravity', state: 'needsSignIn', installed: true, version: '1.1.1',
            job: { jobId: 'j', intent: 'install', startedAtMs: 0, logLine: null, steps: [], outcome: { kind: 'succeeded', version: '1.1.1' } },
        });
        const split = splitMachineAgents([installed, missing, unsupported, justInstalled], (entry) => entry === justInstalled);
        expect(split.installed.map((entry) => entry.agentId)).toEqual(['claude']);
        expect(split.available.map((entry) => entry.agentId)).toEqual(['gemini', 'antigravity']);
        expect(split.anyInstalled).toBe(true);
        // Once its form closes, the agent is listed with what is installed (R88).
        const closed = splitMachineAgents([missing, justInstalled], () => false);
        expect(closed.installed.map((entry) => entry.agentId)).toEqual(['antigravity']);
        expect(closed.available.map((entry) => entry.agentId)).toEqual(['gemini']);
    });

    it('blocks starting a session with an agent that is not on the machine or signed out, never on missing facts', () => {
        expect(resolveAgentSessionStartBlock(agent())).toBe('notInstalled');
        expect(resolveAgentSessionStartBlock(agent({ dependencies: [{ key: 'dep', title: 'ACP server', installed: true, version: '1' }] }))).toBe('notInstalled');
        expect(resolveAgentSessionStartBlock(agent({ state: 'needsSignIn', installed: true, version: '1', signIn: { status: 'signedOut', via: null, nativeLogin: 'terminal', connectedServices: [] } }))).toBe('signedOut');
        expect(resolveAgentSessionStartBlock(agent({ state: 'ready', installed: true, version: '1', signIn: { status: 'signedIn', via: { kind: 'native', accountLabel: null }, nativeLogin: 'terminal', connectedServices: [] } }))).toBeNull();
        expect(resolveAgentSessionStartBlock(null)).toBeNull();
        expect(resolveAgentSessionStartBlock(agent({ stale: true }))).toBeNull();
    });

    it('offers Home\'s first-agent block only when the machine has no agent, leading with agents whose service is connected', () => {
        const connected = agent({ agentId: 'claude', signIn: { status: 'unknown', via: null, nativeLogin: 'terminal', connectedServices: [{ serviceId: 'claude-subscription', title: 'Claude subscription', connected: true, healthy: true, profileLabel: 'Work' }] } });
        const plain = agent({ agentId: 'codex' });
        const manual = agent({ agentId: 'cursor', install: { available: false, mode: 'manual', sizeBytes: null, guideUrl: null, requiresVendorConsent: false } });
        expect(rankFirstAgentChoices([plain, manual, connected]).choices.map((entry) => entry.agentId)).toEqual(['claude', 'codex']);

        expect(shouldOfferFirstAgentSetup({ status: 'ready', agents: [plain, connected] })).toBe(true);
        expect(shouldOfferFirstAgentSetup({ status: 'ready', agents: [plain, { ...connected, installed: true }] })).toBe(false);
        expect(shouldOfferFirstAgentSetup({ status: 'loading', agents: [] })).toBe(false);
    });
});
