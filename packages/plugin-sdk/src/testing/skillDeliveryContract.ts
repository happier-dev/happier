import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute, sep } from 'node:path';
import { requireVitestContractRunner } from './vitestContractRunner.js';
import type { AgentContribution } from '../agents.js';
import type { AgentSessionOpenRequest, AgentSessionRuntime, AgentSessionSkillDelivery } from '../agentRuntime/session.js';
import type { ObservedAgentLaunch } from './observeAgentLaunch.js';
import { AgentSessionRuntimeEventSchema } from '@happier-dev/protocol/runtime/agentSessionV1';
import { AgentSessionSkillDeliveryV1Schema, resolveSessionSkillPlanV1, SessionSkillPlanV1Schema } from '@happier-dev/protocol/prompts/library/skills/resolveSessionSkillPlanV1';

export type AgentSkillDeliveryContractInput = Readonly<{
    agent: AgentContribution;
    openSession: (request: AgentSessionOpenRequest) => Promise<AgentSessionRuntime>;
    observeLaunch: () => ObservedAgentLaunch;
    invokeSkill?: (runtime: AgentSessionRuntime, name: string) => Promise<void>;
    variants?: readonly Readonly<{
        id: string;
        open: (request: AgentSessionOpenRequest) => Promise<AgentSessionRuntime>;
        expect: 'delivers' | 'restart_required' | 'unsupported';
    }>[];
}>;

export type AgentSkillDeclarationContractInput = Pick<AgentSkillDeliveryContractInput, 'agent'>
    & Partial<Record<Exclude<keyof AgentSkillDeliveryContractInput, 'agent'>, never>>;

function launchStrings(launch: ObservedAgentLaunch): string[] {
    const strings: string[] = [...launch.argv, ...Object.values(launch.env)];
    const collect = (value: unknown): void => {
        if (typeof value === 'string') strings.push(value);
        else if (Array.isArray(value)) value.forEach(collect);
        else if (value && typeof value === 'object') Object.values(value).forEach(collect);
    };
    collect(launch.acpSessionNew);
    launch.appServerRequests.forEach(request => collect(request.params));
    return strings;
}

function isWithin(path: string, root: string): boolean {
    const child = relative(root, path);
    return child === '' || (!isAbsolute(child) && child !== '..' && !child.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`));
}

function readOwnPath(value: unknown, path: readonly string[]): unknown {
    for (const key of path) {
        if (!value || typeof value !== 'object' || !Object.hasOwn(value, key)) return undefined;
        value = Reflect.get(value, key);
    }
    return value;
}

function ownsPrivateHome(launch: ObservedAgentLaunch): boolean {
    const privateHome = launch.env.GEMINI_CLI_HOME;
    return Boolean(privateHome && launch.env.HOME === privateHome
        && launch.env.XDG_CONFIG_HOME && isWithin(launch.env.XDG_CONFIG_HOME, privateHome));
}

function comparableLaunch(launch: ObservedAgentLaunch): unknown {
    const privateHome = launch.env.GEMINI_CLI_HOME;
    // Private-home launches allocate a new directory even without skills.
    // Compare the shared root identity while retaining every relative path.
    const normalize = (value: unknown): unknown => {
        if (privateHome && ownsPrivateHome(launch) && typeof value === 'string'
            && (value === privateHome || value.startsWith(`${privateHome}${sep}`))) {
            return `<private-home>${value.slice(privateHome.length)}`;
        }
        if (Array.isArray(value)) return value.map(normalize);
        if (value && typeof value === 'object') {
            return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, normalize(child)]));
        }
        return value;
    };
    return normalize({ argv: launch.argv, env: launch.env, acpSessionNew: launch.acpSessionNew,
        appServerRequests: launch.appServerRequests });
}

/**
 * Register the manifest's projection and launch contracts with genuine boundary adapters.
 * No-delivery declarations can check their projection without a vendor launch adapter.
 */
export function runAgentSkillDeliveryContract(input: AgentSkillDeliveryContractInput | AgentSkillDeclarationContractInput): void {
    const { afterEach, beforeEach, describe, expect, it } = requireVitestContractRunner();
    const capability = 'skills' in input.agent.capabilities ? input.agent.capabilities.skills : undefined;
    const acpDefinition = 'runtime' in input.agent && input.agent.runtime.kind === 'acp' ? input.agent.runtime.definition : undefined;
    const acpDelivery = acpDefinition?.skills?.sessionDelivery;
    describe(`${input.agent.id} skill declaration contract`, () => {
        it('K0 projects native, index and unavailable outcomes through the canonical skill plan', () => {
            const tools = 'tools' in input.agent.capabilities ? input.agent.capabilities.tools : undefined;
            const hasActionChannel = tools !== undefined;
            // Loss of the Action channel must not turn an index fallback into native delivery.
            for (const agentHasActionChannel of hasActionChannel ? [true, false] : [false]) {
                const plan = SessionSkillPlanV1Schema.parse(resolveSessionSkillPlanV1({
                    items: [{ skillId: 'contract:skill', name: 'contract-skill', sourceFolderName: 'contract-source', digest: 'sha256:contract',
                        description: 'Contract skill', disableModelInvocation: false, userInvocable: true }],
                    selected: [{ kind: 'skill', id: 'contract:skill', name: 'contract-skill', selected: true, reachEnabled: true,
                        selectable: true, reason: 'rule_on', decidedBy: null, sessionOverride: null }],
                    excludeNativeSkillNames: [], agentSkills: capability ?? null, agentHasActionChannel,
                    nativeSkills: { status: 'ok', names: [] },
                }));
                const expected = capability?.delivery === 'session_dir' ? 'session_dir' : agentHasActionChannel ? 'index' : 'none';
                expect(plan.plan).toBe(expected);
                expect(plan.items).toEqual([{ skillId: 'contract:skill', name: 'contract-skill', digest: 'sha256:contract',
                    state: expected === 'none' ? 'unavailable' : 'delivered',
                    reason: expected === 'none' ? 'agent_unsupported' : 'rule_on' }]);
                expect(plan.nativeDisables).toEqual([]);
                expect(plan.diagnostics).toEqual([]);
            }
            if (capability?.delivery !== 'session_dir') {
                expect(acpDelivery, 'K0: a no-delivery declaration must not configure a native skill carrier').toBeUndefined();
            }
        });
    });
    if (!input.openSession) {
        if (capability?.delivery === 'session_dir') throw new Error('Native skill delivery requires launch contract adapters.');
        return;
    }
    describe(`${input.agent.id} skill delivery contract`, () => {
        let directory: string;
        let skills: AgentSessionSkillDelivery;
        const runtimes: AgentSessionRuntime[] = [];
        const request = (delivery?: AgentSessionSkillDelivery): AgentSessionOpenRequest => ({
            kind: 'create', sessionId: 'skill-delivery-contract', cwd: directory,
            ...(delivery ? { skills: delivery } : {}),
        });
        const assertNativeHomePreserved = (delivery?: AgentSessionSkillDelivery) => {
            const launch = input.observeLaunch();
            const home = launch.env.HOME;
            const privateHome = ownsPrivateHome(launch);
            const nativeRoots = home && !privateHome ? [
                ...['.claude', '.agents', '.codex', '.config/opencode', '.copilot', '.gemini', '.pi', '.qwen']
                    .map(path => join(home, path)),
                ...(capability?.nativeRoots?.user ?? []).map(parts => join(home, ...parts)),
            ] : [];
            expect(launch.filesWritten.filter(path => nativeRoots.some(root => isWithin(path, root))),
                'K5: native folders and configuration are immutable during launch').toEqual([]);
            const privateRoots = [...(delivery ? [delivery.pluginRoot] : []), ...Object.entries(launch.env)
                .filter(([key]) => key.endsWith('_CONFIG_DIR') || key === 'XDG_CONFIG_HOME' || key === 'GEMINI_CLI_HOME')
                .map(([, value]) => value)
                // An inherited config directory inside HOME is native, not private.
                // Gemini's actual fresh private-home relation is the narrow exception.
                .filter(root => home && (!isWithin(root, home) || privateHome))];
            expect(launch.filesWritten.filter(path => !privateRoots.some(root => isWithin(path, root))),
                'K5: launch must not write the native fixture home').toEqual([]);
        };
        const open = async (factory: AgentSkillDeliveryContractInput['openSession'], delivery?: AgentSessionSkillDelivery) => {
            if (delivery) AgentSessionSkillDeliveryV1Schema.parse(delivery);
            const runtime = await factory(request(delivery));
            runtimes.push(runtime);
            // Check every launch: an adapter resetting its observer between cases
            // must not hide a native configuration write made only on first use.
            assertNativeHomePreserved(delivery);
            return runtime;
        };
        const assertDelivery = async () => {
            const launch = input.observeLaunch();
            if (ownsPrivateHome(launch)) {
                const candidates = ['.agents', '.gemini'].map(root => join(launch.env.GEMINI_CLI_HOME!, root, 'skills', 'contract-source'));
                const delivered = [];
                for (const candidate of candidates) {
                    try {
                        await lstat(candidate);
                        delivered.push(candidate);
                    } catch (error) {
                        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
                    }
                }
                expect(delivered, 'K1: one skill reaches the real private home').toHaveLength(1);
                if (process.platform !== 'win32') {
                    expect(await realpath(delivered[0]!)).toBe(await realpath(join(skills.skillsRoot, 'contract-source')));
                }
                expect(await readFile(join(delivered[0]!, 'SKILL.md'), 'utf8')).toContain('Contract skill');
                expect(await readFile(join(delivered[0]!, 'scripts', 'nested.txt'), 'utf8')).toBe('supporting file');
                return;
            }
            if (acpDelivery?.kind === 'native_config_skills_dir') {
                const nativeConfig = acpDefinition?.mcp?.nativeSessionConfig;
                if (!nativeConfig) throw new Error('Native skill delivery requires its declared config root.');
                const key = process.platform === 'win32' ? nativeConfig.configRootEnvKey.win32 : nativeConfig.configRootEnvKey.posix;
                const root = launch.env[key];
                expect(root, 'K1: the declared private config root reaches the actual launch').toBeTruthy();
                const deliveredRoot = join(root!, nativeConfig.directory, acpDelivery.subdirectory);
                const directory = await lstat(deliveredRoot);
                expect(directory.isDirectory() && !directory.isSymbolicLink(), 'K1: the native skill directory stays private and real').toBe(true);
                expect(await realpath(join(deliveredRoot, 'contract-source'))).toBe(await realpath(join(skills.skillsRoot, 'contract-source')));
                expect(await readFile(join(deliveredRoot, 'contract-source', 'SKILL.md'), 'utf8')).toContain('Contract skill');
                expect(await readFile(join(deliveredRoot, 'contract-source', 'scripts', 'nested.txt'), 'utf8')).toBe('supporting file');
                return;
            }
            const strings = launchStrings(launch);
            if (acpDelivery?.kind === 'defaults_file_env') {
                const file = launch.env[acpDelivery.envKey];
                expect(file, 'K1: the declared defaults file reaches the actual launch').toBeTruthy();
                const parsed: unknown = JSON.parse(await readFile(file!, 'utf8'));
                const directories = readOwnPath(parsed, acpDelivery.directoriesKeyPath);
                expect(Array.isArray(directories), 'K1: the real defaults file contains its declared directories list').toBe(true);
                if (Array.isArray(directories)) strings.push(...directories.filter((value): value is string => typeof value === 'string'));
            }
            // Match the longer skills root first: it already includes pluginRoot.
            const roots = [skills.skillsRoot, skills.pluginRoot].sort((a, b) => b.length - a.length);
            const references = strings.flatMap(value => {
                const hits: string[] = [];
                let remaining = value;
                while (remaining.length) {
                    const candidates = roots.map(root => ({ root, index: remaining.indexOf(root) })).filter(hit => hit.index >= 0);
                    candidates.sort((a, b) => a.index - b.index || b.root.length - a.root.length);
                    const hit = candidates[0];
                    if (!hit) break;
                    hits.push(hit.root);
                    remaining = remaining.slice(hit.index + hit.root.length);
                }
                return hits;
            });
            expect(references, 'K1: one session-private skills root reaches the Agent').toHaveLength(1);
            const deliveredRoot = references[0] === skills.pluginRoot ? join(references[0], 'skills') : references[0];
            expect(await readFile(join(deliveredRoot, 'contract-source', 'SKILL.md'), 'utf8')).toContain('Contract skill');
            expect(await readFile(join(deliveredRoot, 'contract-source', 'scripts', 'nested.txt'), 'utf8')).toBe('supporting file');
        };
        beforeEach(async () => {
            directory = await mkdtemp(join(tmpdir(), 'happier-skill-delivery-contract-'));
            const pluginRoot = join(directory, 'session');
            const skillsRoot = join(pluginRoot, 'skills');
            await mkdir(join(pluginRoot, '.claude-plugin'), { recursive: true });
            await writeFile(join(pluginRoot, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'happier' }));
            await mkdir(join(skillsRoot, 'contract-source', 'scripts'), { recursive: true });
            await writeFile(join(skillsRoot, 'contract-source', 'SKILL.md'), '---\nname: contract-skill\ndescription: Contract skill\n---\nRead scripts/nested.txt.\n');
            await writeFile(join(skillsRoot, 'contract-source', 'scripts', 'nested.txt'), 'supporting file');
            skills = { pluginRoot, skillsRoot, items: [{ name: 'contract-skill', directory: join(skillsRoot, 'contract-source'), skillId: 'contract:skill', digest: 'sha256:contract' }],
                nativeDisables: [{ name: 'contract-native-blocked', path: join(directory, 'native', 'contract-native-blocked', 'SKILL.md') }] };
        });
        afterEach(async () => {
            try { for (const runtime of runtimes.splice(0).reverse()) await runtime.dispose(); }
            finally { if (directory) await rm(directory, { recursive: true, force: true }); }
        });
        it('K0/K1 delivers the admitted source directory rather than reconstructing it from the skill name', async () => {
            const runtime = await open(input.openSession, skills);
            if (capability?.delivery === 'session_dir') {
                expect(runtime.skillsDelivered).not.toBe(false);
                await assertDelivery();
            } else {
                expect(launchStrings(input.observeLaunch()).join('\n')).not.toContain(skills.pluginRoot);
            }
        });
        it('K1 leaves launches without skills unchanged after a skills launch', async () => {
            const baseline = await open(input.openSession);
            const before = input.observeLaunch();
            await baseline.dispose();
            runtimes.splice(runtimes.indexOf(baseline), 1);
            const delivered = await open(input.openSession, skills);
            await delivered.dispose();
            runtimes.splice(runtimes.indexOf(delivered), 1);
            await open(input.openSession);
            const after = input.observeLaunch();
            expect(comparableLaunch(after)).toEqual(comparableLaunch(before));
        });
        it('K3 applies native disables iff the declaration supports them', async () => {
            await open(input.openSession, skills);
            const launch = input.observeLaunch();
            if (ownsPrivateHome(launch)) {
                const raw = await readFile(join(launch.env.GEMINI_CLI_HOME!, '.gemini', 'settings.json'), 'utf8').catch((error: NodeJS.ErrnoException) => {
                    if (error.code === 'ENOENT') return '{}';
                    throw error;
                });
                const parsed: unknown = JSON.parse(raw);
                const disabled = readOwnPath(parsed, ['skills', 'disabled']);
                expect(Array.isArray(disabled) && disabled.includes('contract-native-blocked')).toBe(capability?.nativeDisable === 'supported');
                return;
            }
            if (acpDelivery?.kind === 'defaults_file_env' && acpDelivery.disabledKeyPath) {
                const parsed: unknown = JSON.parse(await readFile(launch.env[acpDelivery.envKey]!, 'utf8'));
                const disabled = readOwnPath(parsed, acpDelivery.disabledKeyPath);
                expect(Array.isArray(disabled) && disabled.includes('contract-native-blocked')).toBe(capability?.nativeDisable === 'supported');
                return;
            }
            const strings = launchStrings(launch);
            const observed = strings.join('\n');
            const disabled = observed.includes('contract-native-blocked');
            expect(disabled).toBe(capability?.nativeDisable === 'supported');
            if (disabled) {
                expect(strings.some(value => value.includes('contract-native-blocked')
                    && (/"(?:off|deny)"/.test(value) || /enabled\s*[=:]\s*false/.test(value)
                        || /"disabled(?:Extensions)?"/.test(value))), 'K3: a native selector must actually disable the skill').toBe(true);
            }
        });
        it('K5 preserves the fixture native home byte-for-byte', async () => {
            await open(input.openSession, skills);
            assertNativeHomePreserved(skills);
        });
        it('K6 implements and acknowledges declared live reload', async () => {
            const runtime = await open(input.openSession, skills);
            if (capability?.liveReload !== 'supported') return;
            expect(runtime.refreshSkills).toBeTypeOf('function');
            expect(await runtime.refreshSkills!({ skills })).toEqual({ kind: 'applied' });
            assertNativeHomePreserved(skills);
        });
        for (const variant of input.variants ?? []) {
            it(`K10 reports ${variant.id} truthfully`, async () => {
                const runtime = await open(variant.open, skills);
                if (variant.expect === 'unsupported') {
                    expect(runtime.skillsDelivered).toBe(false);
                    expect(launchStrings(input.observeLaunch()).join('\n')).not.toContain(skills.pluginRoot);
                    if (capability?.liveReload === 'supported') {
                        expect(runtime.refreshSkills).toBeTypeOf('function');
                        expect(await runtime.refreshSkills!({ skills })).toEqual({ kind: 'restart_required', reason: 'launch_path_unsupported' });
                        assertNativeHomePreserved(skills);
                    }
                    return;
                }
                expect(runtime.skillsDelivered).not.toBe(false);
                await assertDelivery();
                if (variant.expect === 'restart_required') {
                    expect(runtime.refreshSkills).toBeTypeOf('function');
                    expect(await runtime.refreshSkills!({ skills })).toEqual({ kind: 'restart_required', reason: 'launch_path_unsupported' });
                    assertNativeHomePreserved(skills);
                }
            });
        }
        if (capability?.usageEvidence === 'reported') {
            it('K13 emits native invocation evidence when declared', async () => {
                expect(input.invokeSkill).toBeTypeOf('function');
                const runtime = await open(input.openSession, skills);
                const before = input.observeLaunch().runtimeEvents.length;
                await input.invokeSkill!(runtime, 'contract-skill');
                const usages = input.observeLaunch().runtimeEvents.slice(before)
                    .filter(event => event !== null && typeof event === 'object' && 'kind' in event && event.kind === 'skill-usage')
                    .map(event => AgentSessionRuntimeEventSchema.parse(event))
                    .filter(event => event.kind === 'skill-usage');
                expect(usages.every(event => event.sessionId === 'skill-delivery-contract'),
                    'K13: invocation evidence belongs to the opened Session').toBe(true);
                const matching = usages.flatMap(event => event.skills.filter(skill => skill.name === 'contract-skill' || skill.name === 'happier:contract-skill'));
                expect(matching, 'K13: a native invocation is reported exactly once').toHaveLength(1);
            });
        }
    });
}
