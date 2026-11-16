import { mkdirSync, writeFileSync } from 'node:fs';
import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { devNull } from 'node:os';
import { fileURLToPath } from 'node:url';
import { admitAgentIsolationLaunchForHost, type HostAgentIsolationLaunchContext } from '@/daemon/agentIsolation/agentIsolationLaunchPolicy';
import { createHappierTempDir, removeHappierTempDir } from '@happier-dev/cli-common/tempDirs';
import type { ScmCommandInput, ScmCommandRunner, ScmExecResult } from './runtime';
import { currentWorkspaceSource } from '@/workspaces/source/workspaceSource';
import { sessionProcessEnvironment } from '@/agent/runtime/lifecycle/hostedSessionScope';

const PUSH_DATA_CONFIG = /^(?:remote\..+\.(?:url|pushurl|push|fetch|mirror)|branch\..+\.(?:remote|pushremote|merge)|push\.(?:default|followtags|autosetupremote|pushoption))$/i;

function entries(output: string): Array<readonly [string, string]> {
    return output.split('\0').filter(Boolean).map(entry => {
        const separator = entry.indexOf('\n');
        return separator < 0 ? [entry, 'true'] : [entry.slice(0, separator), entry.slice(separator + 1)];
    });
}

async function trustedHostEntries(output: string, cwd: string, context: HostAgentIsolationLaunchContext | undefined,
    readSource: (canonicalPath: string) => Promise<ReadonlySet<string>>): Promise<Array<readonly [string, string]>> {
    const fields = output.split('\0');
    if (fields.at(-1) === '') fields.pop();
    if (fields.length % 2 !== 0) throw new Error('Git configuration origins are unavailable');
    const trustedOrigins = new Map<string, ReadonlySet<string> | null>();
    const result: Array<readonly [string, string]> = [];
    for (let index = 0; index < fields.length; index += 2) {
        const origin = fields[index];
        if (!origin.startsWith('file:') || !origin.slice(5)) throw new Error('Git configuration origin is unavailable');
        let trustedValues = trustedOrigins.get(origin);
        if (trustedValues === undefined) {
            const originPath = resolve(cwd, origin.slice(5));
            try {
                // The canonical policy realpaths the whole file, including a
                // private-looking symlink into any enrolled writable root.
                if (await admitAgentIsolationLaunchForHost({ context, cwd: originPath, requestedCwd: originPath })) {
                    trustedValues = null;
                } else {
                    const canonicalPath = await realpath(originPath);
                    if (await admitAgentIsolationLaunchForHost({ context, cwd: canonicalPath, requestedCwd: canonicalPath })) {
                        trustedValues = null;
                    } else trustedValues = await readSource(canonicalPath);
                }
            } catch { trustedValues = null; }
            trustedOrigins.set(origin, trustedValues);
        }
        // Applicability/order from the original Git traversal cannot authorize
        // bytes read before the origin proof. A symlink swap must not launder
        // Agent-authored helpers as if they came from a private source.
        for (const entry of entries(`${fields[index + 1]}\0`)) {
            if (trustedValues?.has(JSON.stringify(entry))) result.push(entry);
        }
    }
    return result;
}

function quote(value: string): string {
    return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n').replaceAll('\t', '\\t').replaceAll('\b', '\\b')}"`;
}

function configLine(key: string, value: string): string {
    const firstDot = key.indexOf('.');
    const lastDot = key.lastIndexOf('.');
    if (firstDot < 1 || /[\0\r\n]/.test(key) || /[\0\r]/.test(value)) throw new Error('Invalid Git transport configuration');
    const section = key.slice(0, firstDot);
    const name = key.slice(lastDot + 1);
    if (!/^[a-zA-Z][a-zA-Z0-9-]*$/.test(section) || !/^[a-zA-Z][a-zA-Z0-9-]*$/.test(name)) throw new Error('Invalid Git transport configuration');
    return `[${section}${lastDot > firstDot ? ` ${quote(key.slice(firstDot + 1, lastDot))}` : ''}]\n\t${name} = ${quote(value)}\n`;
}

/** Only the built-in push transport is credentialed. Worktree execution stays at Exec. */
export function isHostGitPush(input: ScmCommandInput): boolean {
    if (input.bin !== 'git') return false;
    let index = 0;
    while (input.args[index] === '-c' && input.args[index + 1]) index += 2;
    return input.args[index] === 'push';
}

/**
 * Git cannot turn off repository config for ordinary commands. A host-private
 * metadata view therefore supplies only reference/object identities and push
 * data, never repository/include/attributes execution policy. Credentials stay
 * in host custody; helpers run from this private directory, not the workspace.
 */
export async function runHostGitPush(input: ScmCommandInput, runHost: ScmCommandRunner,
    context?: HostAgentIsolationLaunchContext, runWorkspace?: ScmCommandRunner): Promise<ScmExecResult | undefined> {
    // Host credentials and host config files serve only a workspace on this Machine. In a target the
    // config origins are reported by the guest's own Git, so reading them here would let the guest
    // name any host file; the push runs in the target with the target's own credentials instead.
    if (currentWorkspaceSource().kind !== 'local') return undefined;
    const environment = sessionProcessEnvironment();
    const clearedGitEnvironment = Object.fromEntries(Object.keys(environment)
        .filter(key => key.startsWith('GIT_') || key === 'SSH_ASKPASS')
        .map(key => [key, undefined]));
    const inspectionEnvironment: Record<string, string | undefined> = { ...clearedGitEnvironment,
        GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: devNull, GIT_NO_REPLACE_OBJECTS: '1', GIT_TERMINAL_PROMPT: '0' };
    const inspect = (args: string[], env = inspectionEnvironment) => runHost({
        ...input, args, env, stdin: undefined, stdinInteraction: undefined,
        stdoutConsumer: undefined, stdoutFilePath: undefined,
    });
    const [objects, refs, symbolicHead, head, local, global, system] = await Promise.all([
        inspect(['rev-parse', '--git-path', 'objects', '--show-object-format']),
        inspect(['for-each-ref', '--format=%(objectname) %(refname)']),
        inspect(['symbolic-ref', '-q', 'HEAD']), inspect(['rev-parse', '--verify', 'HEAD']),
        inspect(['config', '--local', '--includes', '--null', '--list']),
        inspect(['config', '--global', '--includes', '--show-origin', '--null', '--list'], {
            ...inspectionEnvironment, GIT_CONFIG_GLOBAL: environment.GIT_CONFIG_GLOBAL,
        }),
        inspect(['config', '--system', '--includes', '--show-origin', '--null', '--list'], {
            ...inspectionEnvironment, GIT_CONFIG_NOSYSTEM: '0', GIT_CONFIG_SYSTEM: environment.GIT_CONFIG_SYSTEM,
        }),
    ]);
    for (const result of [objects, refs, head, local]) if (!result.success) return result;
    const [objectPath, objectFormat] = objects.stdout.trim().split(/\r?\n/);
    if (!objectPath || !['sha1', 'sha256'].includes(objectFormat)) {
        return { success: false, stdout: '', stderr: 'Git transport object storage is unavailable', exitCode: -1 };
    }
    const oid = objectFormat === 'sha256' ? '[0-9a-f]{64}' : '[0-9a-f]{40}';
    const validRef = new RegExp(`^${oid} refs/[^\\s\\x00-\\x1f]+$`);
    const referenceLines = refs.stdout.trim().split(/\r?\n/).filter(Boolean);
    if (!new RegExp(`^${oid}$`).test(head.stdout.trim()) || referenceLines.some(line => !validRef.test(line))) {
        return { success: false, stdout: '', stderr: 'Git transport references are invalid', exitCode: -1 };
    }
    const directory = createHappierTempDir({ purpose: 'scm-transport' });
    try {
        mkdirSync(join(directory, 'objects'));
        mkdirSync(join(directory, 'refs'));
        const hooks = join(directory, 'hooks');
        mkdirSync(hooks);
        const sources = new Map<string, Promise<ReadonlySet<string>>>();
        const readSource = (canonicalPath: string): Promise<ReadonlySet<string>> => {
            const previous = sources.get(canonicalPath);
            if (previous) return previous;
            const reading = (async () => {
                const source = await readFile(canonicalPath, 'utf8');
                const parsed = await runHost({ ...input, env: inspectionEnvironment,
                    args: ['config', '--file', '-', '--no-includes', '--null', '--list'], stdin: source,
                    stdinInteraction: undefined, stdoutConsumer: undefined, stdoutFilePath: undefined });
                if (!parsed.success) throw new Error('Trusted Git configuration is unavailable');
                return new Set(entries(parsed.stdout).map(entry => JSON.stringify(entry)));
            })();
            sources.set(canonicalPath, reading);
            return reading;
        };
        const hostEntries = (await trustedHostEntries((system.success ? system.stdout : '')
            + (global.success ? global.stdout : ''), input.cwd, context, readSource))
            .filter(([key]) => !/^include(?:if)?\./i.test(key) && !/^remote\..+\.(?:vcs|receivepack|uploadpack)$/i.test(key)
                && !/^protocol\..+\.allow$/i.test(key));
        const repositoryEntries = entries(local.stdout).filter(([key]) => PUSH_DATA_CONFIG.test(key));
        const fixed: Array<readonly [string, string]> = [
            ['core.repositoryformatversion', objectFormat === 'sha256' ? '1' : '0'],
            ...(objectFormat === 'sha256' ? [['extensions.objectformat', 'sha256'] as const] : []),
            ['core.bare', 'true'], ['core.hooksPath', hooks], ['core.fsmonitor', 'false'],
            ['core.alternateRefsCommand', ''], ['core.gitProxy', 'none'], ['core.askPass', ''],
            ['gc.auto', '0'], ['maintenance.auto', 'false'], ['push.gpgSign', 'false'],
            ['protocol.allow', 'never'], ...['file', 'http', 'https', 'ssh', 'git'].map(protocol => [`protocol.${protocol}.allow`, 'always'] as const),
        ];
        const viewEntries = [...hostEntries, ...repositoryEntries, ...fixed];
        const writeConfig = (config: readonly (readonly [string, string])[]) => writeFileSync(join(directory, 'config'), config
            .map(([key, value]) => configLine(key, value)).join(''), { mode: 0o600 });
        writeConfig(viewEntries);
        referenceLines.sort((left, right) => {
            const a = left.slice(left.indexOf(' ') + 1);
            const b = right.slice(right.indexOf(' ') + 1);
            return a < b ? -1 : a > b ? 1 : 0;
        });
        writeFileSync(join(directory, 'packed-refs'), `# pack-refs with: sorted\n${referenceLines.join('\n')}\n`, { mode: 0o600 });
        writeFileSync(join(directory, 'HEAD'), symbolicHead.success
            ? `ref: ${symbolicHead.stdout.trim()}\n` : `${head.stdout.trim()}\n`, { mode: 0o600 });
        let commandIndex = 0;
        const safeOverrides: string[] = [];
        while (input.args[commandIndex] === '-c') {
            const override = input.args[commandIndex + 1];
            if (override && PUSH_DATA_CONFIG.test(override.split('=')[0])) safeOverrides.push('-c', override);
            commandIndex += 2;
        }
        const fixedEnvironment: Record<string, string | undefined> = {
            ...clearedGitEnvironment, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: devNull,
            GIT_OBJECT_DIRECTORY: isAbsolute(objectPath) ? objectPath : resolve(input.cwd, objectPath),
            GIT_NO_REPLACE_OBJECTS: '1', GIT_TERMINAL_PROMPT: '0',
            // Terminal source-transport policy. Local receive-pack clears Git
            // environment overrides and uses the literal receiver policy below.
            GIT_CONFIG_COUNT: String(fixed.length),
        };
        fixed.forEach(([key, value], index) => {
            fixedEnvironment[`GIT_CONFIG_KEY_${index}`] = key;
            fixedEnvironment[`GIT_CONFIG_VALUE_${index}`] = value;
        });
        const commandArguments = input.args.slice(commandIndex + 1);
        // Action push argv has one optional remote followed by refspecs. Other
        // argument grammars remain at the existing Agent execution boundary.
        if (commandArguments.some(argument => argument.startsWith('--repo=')
            || ['--repo', '--receive-pack', '--exec', '-o', '--push-option'].includes(argument))) return undefined;
        const currentBranch = symbolicHead.success ? symbolicHead.stdout.trim().replace(/^refs\/heads\//, '') : '';
        const readConfig = (key: string) => [...hostEntries, ...repositoryEntries].filter(([name]) => name === key).at(-1)?.[1];
        const remote = commandArguments.find(argument => !argument.startsWith('-'))
            ?? readConfig(`branch.${currentBranch}.pushremote`) ?? readConfig('remote.pushdefault')
            ?? readConfig(`branch.${currentBranch}.remote`) ?? 'origin';
        const setsUpstream = commandArguments.some(argument => argument === '-u' || argument === '--set-upstream')
            || readConfig('push.autosetupremote') === 'true';
        if (setsUpstream) {
            if (!runWorkspace) return { success: false, stdout: '', stderr: 'scm_exec_unavailable', exitCode: -1 };
            const available = await runWorkspace({ ...input, args: ['rev-parse', '--git-dir'],
                stdin: undefined, stdinInteraction: undefined, stdoutConsumer: undefined, stdoutFilePath: undefined });
            if (!available.success) return available;
        }
        const remoteUrls = await runHost({ ...input, cwd: directory, env: fixedEnvironment,
            args: ['remote', 'get-url', '--push', '--all', remote], stdin: undefined, stdinInteraction: undefined,
            stdoutConsumer: undefined, stdoutFilePath: undefined });
        const urls = remoteUrls.success ? remoteUrls.stdout.trim().split(/\r?\n/).filter(Boolean) : [remote];
        const localTransports = urls.map(url => /^file:/i.test(url) || (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)
            && (!/^[^/\\]+:/.test(url) || /^[a-z]:[/\\]/i.test(url))));
        if (localTransports.some(Boolean) && !localTransports.every(Boolean)) return undefined;
        if (localTransports.every(Boolean)) {
            const destinations: string[] = [];
            for (const url of urls) {
                const destination = /^file:/i.test(url) ? fileURLToPath(url) : resolve(input.cwd, url);
                destinations.push(destination);
                const bare = await runHost({ ...input, cwd: destination, env: inspectionEnvironment,
                    args: ['rev-parse', '--is-bare-repository'], stdin: undefined, stdinInteraction: undefined,
                    stdoutConsumer: undefined, stdoutFilePath: undefined });
                // updateInstead may run checkout filters. Preserve that mode
                // only through the admitted Agent Exec identity, never host Git.
                if (!bare.success || bare.stdout.trim() !== 'true') return undefined;
            }
            if (remoteUrls.success) {
                // Expanded URLs are now absolute to the original checkout, not
                // the private view. Do not apply insteadOf a second time.
                writeConfig([...viewEntries.filter(([key]) => key !== `remote.${remote}.pushurl`
                    && !/^url\..+\.(?:insteadof|pushinsteadof)$/i.test(key)),
                    ...destinations.map(destination => [`remote.${remote}.pushurl`, destination] as const)]);
            } else {
                const remoteIndex = commandArguments.findIndex(argument => argument === remote);
                if (remoteIndex < 0) return undefined;
                commandArguments[remoteIndex] = destinations[0];
            }
        }
        // Git clears GIT_CONFIG_* for a local receive-pack. A literal command
        // carries the fixed receiver settings through Git's own argument/remote
        // pathname quoting; no pathname or repository text enters shell code.
        const receivePack = localTransports.every(Boolean)
            ? 'git --config-env=core.hooksPath=HAPPIER_SCM_EMPTY_HOOKS -c core.bare=true -c receive.denyCurrentBranch=refuse -c core.fsmonitor=false -c core.alternateRefsCommand= -c gc.auto=0 -c maintenance.auto=false -c receive.autogc=false receive-pack'
            : 'git-receive-pack';
        fixedEnvironment.HAPPIER_SCM_EMPTY_HOOKS = hooks;
        const result = await runHost({ ...input, cwd: directory, env: fixedEnvironment,
            args: [...safeOverrides, 'push', ...commandArguments,
                `--receive-pack=${receivePack}`, '--recurse-submodules=no', '--signed=false'],
        });
        if (result.success) {
            const tracking = await runHost({ ...input, cwd: directory, env: fixedEnvironment,
                args: ['for-each-ref', '--format=%(objectname) %(refname)', 'refs/remotes/'],
                stdin: undefined, stdinInteraction: undefined, stdoutConsumer: undefined, stdoutFilePath: undefined });
            if (!tracking.success) return { ...result, stderr: `${result.stderr}\nPush succeeded; tracking references unavailable: ${tracking.stderr}` };
            const original = new Map(referenceLines.map(line => [line.slice(line.indexOf(' ') + 1), line.slice(0, line.indexOf(' '))]));
            const updates = tracking.stdout.trim().split(/\r?\n/).filter(Boolean).flatMap(line => {
                if (!validRef.test(line)) throw new Error('Git tracking reference is invalid');
                const separator = line.indexOf(' ');
                const name = line.slice(separator + 1);
                const value = line.slice(0, separator);
                const previous = original.get(name);
                return value === previous ? [] : [`update ${name} ${value} ${previous ?? '0'.repeat(value.length)}\n`];
            });
            if (updates.length) {
                // This metadata-only command cannot invoke worktree filters;
                // its one execution callback is disabled at this same owner.
                const updated = await runHost({ ...input, env: inspectionEnvironment,
                    args: ['-c', `core.hooksPath=${hooks}`, '-c', 'core.fsmonitor=false', 'update-ref', '--stdin'],
                    stdin: updates.join(''), stdinInteraction: undefined, stdoutConsumer: undefined, stdoutFilePath: undefined });
                if (!updated.success) return { ...result, stderr: `${result.stderr}\nPush succeeded; tracking references unavailable: ${updated.stderr}` };
            }
            const configuration = await runHost({ ...input, cwd: directory, env: fixedEnvironment,
                args: ['config', '--local', '--null', '--list'], stdin: undefined, stdinInteraction: undefined,
                stdoutConsumer: undefined, stdoutFilePath: undefined });
            if (!configuration.success) return { ...result, stderr: `${result.stderr}\nPush succeeded; upstream configuration unavailable: ${configuration.stderr}` };
            const upstreamKey = /^branch\..+\.(?:remote|merge)$/;
            const originalConfiguration = new Map([...hostEntries, ...repositoryEntries].filter(([key]) => upstreamKey.test(key)));
            for (const [key, value] of entries(configuration.stdout).filter(([key]) => upstreamKey.test(key))) {
                if (originalConfiguration.get(key) === value) continue;
                // Agent-writable config may itself be a symlink. Only the
                // existing workspace Exec identity can mutate that source.
                const updated = runWorkspace ? await runWorkspace({ ...input,
                    args: ['config', '--local', '--replace-all', key, value], stdin: undefined,
                    stdinInteraction: undefined, stdoutConsumer: undefined, stdoutFilePath: undefined })
                    : { success: false, stderr: 'scm_exec_unavailable' };
                if (!updated.success) return { ...result,
                    stderr: `${result.stderr}\nPush succeeded; upstream configuration unavailable: ${updated.stderr}` };
            }
        }
        return result;
    } finally {
        removeHappierTempDir(directory);
    }
}
