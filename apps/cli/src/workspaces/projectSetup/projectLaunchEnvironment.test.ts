import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { composeProjectLaunchEnvironment, prepareProjectLaunchEnvironment } from './projectLaunchEnvironment';

const roots: string[] = [];
it('carries admitted launch custody to observers without placing it in the child environment', async () => {
    const selected = await workspace();
    const requester = { accountId: 'alice', installationId: 'installation' };
    let observed: unknown;
    let declared: unknown;
    const result = await prepareProjectLaunchEnvironment({ workspace: selected, originalEnvironment: { CUSTOM_DATABASE: 'private-original', TOKEN: 'secret' },
        requirements: [{ name: 'CUSTOM_DATABASE', kind: 'config', required: true }, { name: 'TOKEN', kind: 'secret', required: false }],
        service: { project: { serverId: 'home', projectId: 'project' }, requester, serviceId: 'postgres',
            executionPlacement: { mode: 'spawn', machineId: 'machine' }, assignedPorts: {},
            async prepareServiceLaunchEnvironments(input) {
                observed = input.requester; declared = await input.readDeclaredEnvironment?.(); return [];
            } } });
    expect(observed).toEqual(requester);
    expect(declared).toMatchObject({ projectedEnvironment: { CUSTOM_DATABASE: 'private-original' } });
    expect(result.kind === 'prepared' && result.launchInput.environment).toEqual({ CUSTOM_DATABASE: 'private-original' });
});
it('uses Windows key identity without suppressing distinct POSIX variable names', () => {
    const input = { originalEnvironment: { Path: 'host', token: 'private', KEEP: 'yes' },
        requirements: [{ name: 'TOKEN', kind: 'secret' as const, required: false }], invocationEnvironment: { PATH: 'invocation' } };
    expect(composeProjectLaunchEnvironment({ ...input, platform: 'win32' }).environment)
        .toEqual({ PATH: 'invocation', KEEP: 'yes' });
    expect(composeProjectLaunchEnvironment({ ...input, platform: 'linux' }).environment)
        .toEqual({ Path: 'host', PATH: 'invocation', token: 'private', KEEP: 'yes' });
});
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
it('applies invocation removals using the target platform environment identity', () => {
    const input = { originalEnvironment: { Remove: 'upper', REMOVE: 'caps', KEEP: 'yes' }, requirements: [],
        invocationEnvironment: { REMOVE: undefined } };
    expect(composeProjectLaunchEnvironment({ ...input, platform: 'linux' }).environment).toEqual({ Remove: 'upper', KEEP: 'yes' });
    expect(composeProjectLaunchEnvironment({ ...input, platform: 'win32' }).environment).toEqual({ KEEP: 'yes' });
    expect(composeProjectLaunchEnvironment({ originalEnvironment: {}, requirements: [], runtimeEnvironment: { PORT: '42000' },
        invocationEnvironment: { PORT: undefined } })).toEqual({ environment: {} });
});
async function workspace() {
    const rootPath = await mkdtemp(join(tmpdir(), 'project-launch-env-'));
    roots.push(rootPath);
    return { id: 'workspace', serverId: 'home', machineId: 'machine', rootPath };
}

it('composes private and assigned defaults under deliberate Project, Profile and invocation values without inheriting secrets', async () => {
    const selected = await workspace();
    await writeFile(join(selected.rootPath, '.env'), 'PORT=3000\nURL=private-url\nTOKEN=private-secret\n');
    const originalEnvironment = { PORT: 'host', HAPPIER_WORKTREE_PORT: 'stale', HAPPIER_WORKTREE_PORT_9: 'stale',
        HAPPIER_WORKTREE_URL: 'stale', HAPPIER_WORKTREE_SLUG: 'stale', KEEP: 'yes', TOKEN: 'host-secret' };
    const result = await prepareProjectLaunchEnvironment({ workspace: selected, originalEnvironment,
        requirements: [{ name: 'TOKEN', kind: 'secret', required: false }, { name: 'URL', kind: 'config', required: true }, { name: 'PORT', kind: 'config', required: false }],
        runtimeEnvironment: { PORT: '42000', HAPPIER_WORKTREE_PORT: '42000' },
        projectEnvironment: { PORT: '43000' }, profileEnvironment: { PORT: '44000' }, invocationEnvironment: { PORT: '$literal' } });
    expect(result.kind === 'prepared' && result.launchInput.environment).toEqual({ KEEP: 'yes', URL: 'private-url', PORT: '$literal', HAPPIER_WORKTREE_PORT: '42000' });
    expect(originalEnvironment.PORT).toBe('host');
});

it('offers each service contribution the same original private snapshot and preserves conflicting replacement keys', async () => {
    const selected = await workspace();
    await writeFile(join(selected.rootPath, '.env'), 'URL=private-original\n');
    const result = await prepareProjectLaunchEnvironment({ workspace: selected, originalEnvironment: {},
        requirements: [{ name: 'URL', kind: 'config', required: true }],
        service: { project: { serverId: 'home', projectId: 'project' }, serviceId: 'web', executionPlacement: { mode: 'spawn', machineId: 'machine' }, assignedPorts: { capture: 42000 },
            async prepareServiceLaunchEnvironments(input) {
                const original = await input.readEnvironment(['URL']);
                expect(original.projectedEnvironment).toEqual({ URL: 'private-original' });
                return [{ contribution: { pluginId: 'capture', localId: 'one' }, result: { kind: 'replace', defaults: { OTEL_SERVICE_NAME: 'default' }, replacements: { URL: 'proxy-one' }, async release() {} } },
                    { contribution: { pluginId: 'capture', localId: 'two' }, result: { kind: 'replace', replacements: { URL: 'proxy-two' }, async release() {} } }];
            } } });
    expect(result.kind === 'prepared' && result.launchInput.environment).toEqual({ URL: 'private-original', OTEL_SERVICE_NAME: 'default' });
    expect(result.kind === 'prepared' && result.launchInput.service).toEqual({ kind: 'conflict', reason: 'replacement_key_conflict', names: ['URL'] });
});

it('does not demand dotenv without declared config or a service contribution requesting it', async () => {
    const selected = await workspace();
    await writeFile(join(selected.rootPath, '.env'), 'INVALID INPUT');
    const result = await prepareProjectLaunchEnvironment({ workspace: selected, originalEnvironment: { KEEP: 'yes' }, requirements: [] });
    expect(result.kind === 'prepared' && result.launchInput.environment).toEqual({ KEEP: 'yes' });
});

it('reports the winning PORT source by layer even when selected values equal the assigned value', () => {
    const assigned = { originalEnvironment: { PORT: '42000' }, requirements: [], runtimeEnvironment: { PORT: '42000' } };
    expect(composeProjectLaunchEnvironment(assigned).portSource).toBe('assigned');
    expect(composeProjectLaunchEnvironment({ ...assigned, projectEnvironment: { PORT: '42000' } }).portSource).toBe('fixed');
    expect(composeProjectLaunchEnvironment({ ...assigned, profileEnvironment: { PORT: '42000' } }).portSource).toBe('fixed');
    expect(composeProjectLaunchEnvironment({ ...assigned, invocationEnvironment: { port: '42000' }, platform: 'win32' }).portSource).toBe('fixed');
    expect(composeProjectLaunchEnvironment({ originalEnvironment: { PORT: '42000' }, requirements: [] }).portSource).toBeUndefined();
});

it('carries listener demand privately to the contribution without allocating before that contribution requests it', async () => {
    const selected = await workspace();
    const requested: string[][] = [];
    const result = await prepareProjectLaunchEnvironment({ workspace: selected, originalEnvironment: {}, requirements: [],
        service: { project: { serverId: 'home', projectId: 'project' }, serviceId: 'web',
            executionPlacement: { mode: 'spawn', machineId: 'machine' }, assignedPorts: {},
            async requestListenerPorts(keys) {
                requested.push([...keys]);
                return { kind: 'unavailable', code: 'project_worktree_ports_unavailable', reason: 'state_corrupt' };
            },
            async prepareServiceLaunchEnvironments(input) {
                expect(requested).toEqual([]);
                expect(await input.requestListenerPorts?.(['acme.capture.database'])).toEqual({
                    kind: 'unavailable', code: 'project_worktree_ports_unavailable', reason: 'state_corrupt',
                });
                return [{ contribution: { pluginId: 'capture', localId: 'proxy' }, result: {
                    kind: 'unavailable', code: 'service_launch_environment_unavailable', reason: 'state_corrupt',
                } }];
            } } });
    if (result.kind !== 'prepared') throw new Error('Expected usable service without capture');
    expect(result.launchInput.environment).toEqual({});
    expect(result.launchInput.service).toMatchObject({ kind: 'unavailable', reason: 'state_corrupt' });
    expect(requested).toEqual([['acme.capture.database']]);
});


it('shares one lazy original snapshot, excludes secret names, and retains prepared service cleanup through launch', async () => {
    const selected = await workspace();
    await writeFile(join(selected.rootPath, '.env'), 'URL=original-file\nTOKEN=private-token\n');
    let released = false;
    const result = await prepareProjectLaunchEnvironment({ workspace: selected, originalEnvironment: { TOKEN: 'host-token' },
        requirements: [{ name: 'TOKEN', kind: 'secret', required: false }],
        service: { project: { serverId: 'home', projectId: 'project' }, serviceId: 'web',
            executionPlacement: { mode: 'spawn', machineId: 'machine' }, assignedPorts: { capture: 42000 },
            async prepareServiceLaunchEnvironments(input) {
                const original = await input.readEnvironment(['URL', 'TOKEN']);
                expect(original.projectedEnvironment).toEqual({ URL: 'original-file' });
                await writeFile(join(selected.rootPath, '.env'), 'URL=changed-later\n');
                expect((await input.readEnvironment(['URL'])).projectedEnvironment).toEqual({ URL: 'original-file' });
                return [{ contribution: { pluginId: 'capture', localId: 'proxy' }, result: { kind: 'replace',
                    replacements: { URL: 'local-proxy', TOKEN: 'cannot-replace-secret' }, async release() { released = true; } } }];
            } } });
    if (result.kind !== 'prepared') throw new Error('Expected private launch preparation');
    expect(result.launchInput.environment).toEqual({ URL: 'local-proxy' });
    expect(released).toBe(false);
    await result.launchInput.releaseServiceEnvironment?.();
    expect(released).toBe(true);
});

it('keeps a service usable and safe diagnostics visible when a contribution fails', async () => {
    const selected = await workspace();
    const result = await prepareProjectLaunchEnvironment({ workspace: selected, originalEnvironment: { PORT: '3000' }, requirements: [],
        service: { project: { serverId: 'home', projectId: 'project' }, serviceId: 'web',
            executionPlacement: { mode: 'spawn', machineId: 'machine' }, assignedPorts: {},
            async prepareServiceLaunchEnvironments() { throw new Error('private-upstream-password'); } } });
    if (result.kind !== 'prepared') throw new Error('Expected ordinary service launch');
    expect(result.launchInput.environment).toEqual({ PORT: '3000' });
    expect(result.launchInput.service).toEqual({ kind: 'unavailable', code: 'service_launch_environment_failed' });
    expect(JSON.stringify(result.launchInput)).not.toContain('private-upstream-password');
});


it('validates required config with platform key identity and keeps the original host snapshot across preparation awaits', async () => {
    const selected = await workspace();
    const originalEnvironment = { api_url: 'original-upstream' };
    const prepared = prepareProjectLaunchEnvironment({ workspace: selected, originalEnvironment, platform: 'win32',
        requirements: [{ name: 'API_URL', kind: 'config', required: true }] });
    originalEnvironment.api_url = 'changed-after-admission';
    const result = await prepared;
    expect(result.kind).toBe('prepared');
    if (result.kind === 'prepared') {
        expect(result.launchInput.environment).toEqual({ api_url: 'original-upstream' });
        expect(result.launchInput.originalEnvironment).toEqual({ api_url: 'original-upstream' });
    }
    const caseSensitive = await prepareProjectLaunchEnvironment({ workspace: selected, originalEnvironment, platform: 'linux',
        requirements: [{ name: 'API_URL', kind: 'config', required: true }] });
    expect(caseSensitive.kind).toBe('refused');
});
