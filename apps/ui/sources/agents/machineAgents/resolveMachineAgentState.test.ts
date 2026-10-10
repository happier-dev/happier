import { describe, expect, it } from 'vitest';
import { resolveMachineAgentState, isMachineAgentReady } from './resolveMachineAgentState';
import type { MachineAgent } from './machineAgentTypes';

const facts: Parameters<typeof resolveMachineAgentState>[0] = {
    installed: true,
    platform: { supported: true },
    signIn: { status: 'signedIn', via: { kind: 'connected', serviceId: 'account', title: 'Account', profileLabel: 'Work' }, nativeLogin: 'terminal', connectedServices: [] },
    dependencies: [], version: '1.0.0', latestVersion: '1.0.0', update: { supported: true, command: null }, job: null,
};

describe('machine agent readiness', () => {
    it('uses merged connected sign-in and requires the agent CLI, its dependencies and platform', () => {
        expect(resolveMachineAgentState(facts)).toBe('ready');
        expect(resolveMachineAgentState({ ...facts, installed: false, dependencies: [{ key: 'dep.acp', title: 'ACP', installed: true, version: null }] })).toBe('notInstalled');
        expect(resolveMachineAgentState({ ...facts, dependencies: [{ key: 'dep.acp', title: 'ACP', installed: false, version: null }] })).toBe('notInstalled');
        expect(resolveMachineAgentState({ ...facts, platform: { supported: false, reason: 'arch' } })).toBe('unsupported');
    });
    it('distinguishes signed-out and missing facts without treating unknown native auth as signed out', () => {
        expect(resolveMachineAgentState({ ...facts, signIn: { ...facts.signIn, status: 'signedOut', via: null } })).toBe('needsSignIn');
        expect(resolveMachineAgentState({ ...facts, signIn: { ...facts.signIn, status: 'unknown', via: null } })).toBe('ready');
        expect(resolveMachineAgentState({ ...facts, signIn: { ...facts.signIn, status: 'unknown', via: null }, requireSignedIn: true })).toBe('unknown');
        expect(resolveMachineAgentState({ ...facts, latestVersion: '1.1.0' })).toBe('updateAvailable');
        expect(resolveMachineAgentState({ ...facts, known: false, checking: true })).toBe('checking');
        expect(resolveMachineAgentState({ ...facts, known: false })).toBe('unknown');
        expect(resolveMachineAgentState({ ...facts, checking: true })).toBe('ready');
    });
    it('retains offline display facts but never admits them as current launch readiness', () => {
        expect(isMachineAgentReady({ state: 'ready', stale: true })).toBe(false);
        expect(isMachineAgentReady({ state: 'updateAvailable', stale: false })).toBe(true);
        expect(isMachineAgentReady(null)).toBe(false);
    });
    it('projects the install executor lifecycle', () => {
        const job: MachineAgent['job'] = { jobId: 'job', intent: 'install', startedAtMs: 1, steps: [], logLine: null, outcome: null };
        expect(resolveMachineAgentState({ ...facts, installed: false, job })).toBe('installing');
        expect(resolveMachineAgentState({ ...facts, job: { ...job, outcome: { kind: 'failed', code: 'download_failed', stepId: 'cli', message: null } } })).toBe('failed');
        const cancelled = { ...job, outcome: { kind: 'failed' as const, code: 'cancelled' as const, stepId: null, message: null } };
        expect(resolveMachineAgentState({ ...facts, installed: false, job: cancelled })).toBe('notInstalled');
        expect(resolveMachineAgentState({ ...facts, job: { ...cancelled, intent: 'update' } })).toBe('ready');
        expect(resolveMachineAgentState({ ...facts, latestVersion: '2.0.0', job: { ...cancelled, intent: 'update' } })).toBe('updateAvailable');
    });
});
