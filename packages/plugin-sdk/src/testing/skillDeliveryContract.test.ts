import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterAll } from 'vitest';
import type { AgentContribution } from '../agents.js';
import type { AgentSessionRuntime } from '../agentRuntime/session.js';
import { createAgentLaunchObserver, type AgentLaunchObserverBoundaries } from './observeAgentLaunch.js';
import { runAgentSkillDeliveryContract } from './skillDeliveryContract.js';

const home = mkdtempSync(join(tmpdir(), 'happier-skills-kit-home-'));
afterAll(() => rmSync(home, { recursive: true, force: true }));
const observer = createAgentLaunchObserver({ home });
const boundaries = observer.boundaries as AgentLaunchObserverBoundaries;
const agent = {
    id: 'fixture', title: 'Fixture', primary: 'sessions', runtime: { kind: 'custom' },
    capabilities: { sessions: { open: ['create'], delivery: ['newTurn'], cancel: true },
        skills: { delivery: 'session_dir', nativeDisable: 'supported', liveReload: 'supported', usageEvidence: 'reported' } },
} satisfies AgentContribution;
// A fake Agent is the self-test subject; no first-party plugin implementation is replaced.
const open: Parameters<typeof runAgentSkillDeliveryContract>[0]['openSession'] = async request => {
    boundaries.reset();
    boundaries.recordLaunch({ argv: request.skills
        ? ['--plugin-dir', request.skills.pluginRoot, '--settings', JSON.stringify({
            skillOverrides: Object.fromEntries(request.skills.nativeDisables.map(item => [item.name, 'off'])),
        })] : ['--stdio'], env: { HOME: home } });
    return {
        async send() { return { status: 'admitted' }; },
        async cancel() { return { status: 'notRunning' }; },
        async updateConfiguration() { return { status: 'applied', changed: [] }; },
        watch() { return { dispose() {} }; },
        async refreshSkills() { return { kind: 'applied' }; },
        async dispose() {},
    } satisfies AgentSessionRuntime;
};
runAgentSkillDeliveryContract({ agent, openSession: open, observeLaunch: observer.observeLaunch,
    async invokeSkill(_runtime, name) {
        boundaries.recordRuntimeEvent({ kind: 'skill-usage', sequence: 1, sessionId: 'skill-delivery-contract',
            turnId: 'fixture-turn', emittedAtMs: 1, skills: [{ name }] });
    } });

const privateHomeAgent = {
    ...agent,
    id: 'private-home-fixture',
    capabilities: { ...agent.capabilities,
        skills: { delivery: 'session_dir', nativeDisable: 'supported', liveReload: 'unsupported' } },
} satisfies AgentContribution;
runAgentSkillDeliveryContract({
    agent: privateHomeAgent,
    async openSession(request) {
        const privateHome = mkdtempSync(join(tmpdir(), 'happier-skills-kit-private-home-'));
        mkdirSync(join(privateHome, '.agents', 'skills'), { recursive: true });
        mkdirSync(join(privateHome, '.gemini'), { recursive: true });
        for (const item of request.skills?.items ?? []) {
            const source = item.directory;
            const destination = join(privateHome, '.agents', 'skills', basename(item.directory));
            if (process.platform === 'win32') cpSync(source, destination, { recursive: true });
            else symlinkSync(source, destination, 'dir');
        }
        writeFileSync(join(privateHome, '.gemini', 'settings.json'), JSON.stringify({
            skills: { disabled: request.skills?.nativeDisables.map(item => item.name) ?? [] },
        }));
        boundaries.reset();
        boundaries.recordLaunch({ argv: ['--stdio', '--config', join(privateHome, '.gemini', 'settings.json')],
            env: { HOME: privateHome, GEMINI_CLI_HOME: privateHome, XDG_CONFIG_HOME: join(privateHome, '.config') } });
        boundaries.recordAcpSessionNew({ cwd: request.cwd, mcpServers: [] });
        return {
            async send() { return { status: 'admitted' }; },
            async cancel() { return { status: 'notRunning' }; },
            async updateConfiguration() { return { status: 'applied', changed: [] }; },
            watch() { return { dispose() {} }; },
            async dispose() { rmSync(privateHome, { recursive: true, force: true }); },
        } satisfies AgentSessionRuntime;
    },
    observeLaunch: observer.observeLaunch,
});
