import { glob, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, matchesGlob, resolve } from 'node:path';
import { MachineSetupEffectError, type MachineRecipeStepV1 } from './index.js';
import { isMissingNativeFile } from './nativeFileSafety.js';
import type { NativeRun } from './nativeSystemBackend.js';
import type { MachineSetupSshHostKeyEvidenceV1 } from '@happier-dev/protocol/machines/setup/backupReceiverV1';
import { parseSshKnownHostLine } from '../systemTasks/kinds/sshKnownHostLine.js';

type FileStep = Extract<MachineRecipeStepV1, { kind: 'file' }>;
export type NativeSshProbe = Extract<NonNullable<FileStep['probe']>, { kind: 'sshd' }>;

const mainConfiguration = '/etc/ssh/sshd_config';

/** Only Include arguments are interpreted here; sshd owns all SSH syntax. */
function includeArguments(line: string): string[] | undefined {
    const match = /^\s*Include(?:\s*=\s*|\s+)(.*)$/i.exec(line);
    if (!match) return undefined;
    const result: string[] = [];
    let token = '', quote: string | undefined, started = false;
    const value = match[1]!;
    for (let i = 0; i < value.length; i++) {
        const character = value[i]!;
        if (character === '\\') {
            const next = value[i + 1];
            if (next === '"' || next === "'" || next === '\\' || quote === undefined && next === ' ') token += value[++i]!;
            else token += character;
            started = true;
        } else if (quote === undefined && (character === '"' || character === "'")) { quote = character; started = true; }
        else if (character === quote) quote = undefined;
        else if (quote === undefined && /\s/.test(character)) {
            if (started) { result.push(token); token = ''; started = false; }
        } else if (quote === undefined && character === '#' && !started) break;
        else { token += character; started = true; }
    }
    if (quote !== undefined) throw new MachineSetupEffectError('validation_failed');
    if (started) result.push(token);
    if (!result.length) throw new MachineSetupEffectError('validation_failed');
    return result;
}

async function ssh(run: NativeRun, args: readonly string[]) {
    const result = await run('/usr/sbin/sshd', args, { LC_ALL: 'C' });
    if (result.errorCode === 'ENOENT') throw new MachineSetupEffectError('required_fact_unavailable');
    if (result.errorCode === 'EACCES' || result.errorCode === 'EPERM') throw new MachineSetupEffectError('needs_admin_to_check');
    if (result.code !== 0) throw new MachineSetupEffectError('validation_failed');
    return result.stdout;
}

async function effective(run: NativeRun, mainPath: string, context: NativeSshProbe['contexts'][number]) {
    return ssh(run, ['-T', '-f', mainPath, '-C', `user=${context.user},host=${context.host},addr=${context.address}`]);
}

function satisfies(output: string, expected: Readonly<Record<string, string>>) {
    const actual = new Map<string, string[]>();
    for (const line of output.trim().split('\n')) {
        const separator = line.indexOf(' ');
        if (separator < 1) continue;
        const key = line.slice(0, separator).toLowerCase();
        actual.set(key, [...(actual.get(key) ?? []), line.slice(separator + 1).trim()]);
    }
    return Object.entries(expected).every(([key, value]) => actual.get(key.toLowerCase())?.join('\n') === value);
}

/**
 * Mirror the Include graph, replacing only the owned target in its original
 * lexical position. Separate mirrored files preserve Include/Match semantics;
 * neither validation nor removal temporarily edits the live configuration.
 * OpenSSH's Include contract: man.openbsd.org/sshd_config#Include.
 */
async function candidateMain(input: Readonly<{ path: string; candidate: string | null; mainPath: string; staging: string }>) {
    const active = new Set<string>();
    let sequence = 0, reached = false;
    const render = async (path: string): Promise<string> => {
        if (active.has(path)) throw new MachineSetupEffectError('validation_failed');
        active.add(path);
        const destination = join(input.staging, `configuration-${sequence++}`);
        const source = path === input.path ? input.candidate : path;
        if (!source) throw new MachineSetupEffectError('foreign_effect_conflict');
        if (path === input.path) reached = true;
        const lines = (await readFile(source, 'utf8')).split('\n');
        const result: string[] = [];
        for (const line of lines) {
            const patterns = includeArguments(line);
            if (!patterns) { result.push(line); continue; }
            const includes: string[] = [];
            for (const relative of patterns) {
                const pattern = isAbsolute(relative) ? relative : resolve('/etc/ssh', relative);
                // Node glob adds non-POSIX patterns. Refuse these rather than
                // validate a graph different from the native parser's graph.
                if (pattern.includes('**') || /[{}]|[?*+@!]\(/.test(pattern)) throw new MachineSetupEffectError('required_fact_unavailable');
                const paths: string[] = [];
                for await (const found of glob(pattern)) paths.push(found);
                if (matchesGlob(input.path, pattern)) {
                    reached = true;
                    if (input.candidate !== null && !paths.includes(input.path)) paths.push(input.path);
                }
                for (const included of paths.sort()) {
                    if (included === input.path && input.candidate === null) continue;
                    includes.push(await render(included));
                }
            }
            // A nonmatching Include has no effect. Preserve that property.
            result.push(...includes.map(included => `Include "${included}"`));
        }
        active.delete(path);
        await writeFile(destination, result.join('\n'), { flag: 'wx', mode: 0o600 });
        return destination;
    };
    const main = await render(input.mainPath);
    if (!reached) throw new MachineSetupEffectError('foreign_effect_conflict');
    return main;
}

export async function validateNativeSshFile(input: Readonly<{
    path: string; candidate: string | null; probe: NativeSshProbe; run: NativeRun; mainPath?: string;
}>): Promise<void> {
    const mainPath = input.mainPath ?? mainConfiguration;
    // Reuse the file owner's candidate directory instead of a root process's
    // inherited TMPDIR, whose parent may belong to the requesting daemon user.
    const staging = await mkdtemp(join(dirname(input.candidate ?? input.path), '.happier-sshd-check-'));
    try {
        const main = await candidateMain({ ...input, mainPath, staging });
        await ssh(input.run, ['-t', '-f', main]);
        for (const context of input.probe.contexts) {
            const output = await effective(input.run, main, context);
            if (context.expected === undefined) {
                if (output !== await effective(input.run, mainPath, context)) throw new MachineSetupEffectError('foreign_effect_conflict');
            } else if (!satisfies(output, context.expected)) {
                throw new MachineSetupEffectError('foreign_effect_conflict');
            }
        }
    } catch (error) {
        if (isMissingNativeFile(error)) throw new MachineSetupEffectError('required_fact_unavailable');
        if (error !== null && typeof error === 'object' && 'code' in error && (error.code === 'EACCES' || error.code === 'EPERM')) {
            throw new MachineSetupEffectError('needs_admin_to_check');
        }
        throw error;
    } finally { await rm(staging, { recursive: true, force: true }); }
}

export async function probeNativeSshFile(probe: NativeSshProbe, run: NativeRun, options: Readonly<{ mainPath?: string }> = {}):
    Promise<Readonly<{ satisfied: boolean; hostKeyEvidence?: MachineSetupSshHostKeyEvidenceV1 }>> {
    const mainPath = options.mainPath ?? mainConfiguration;
    await ssh(run, ['-t', '-f', mainPath]);
    let configuration: string | undefined;
    for (const context of probe.contexts) {
        const output = await effective(run, mainPath, context);
        configuration ??= output;
        if (context.expected !== undefined && !satisfies(output, context.expected)) return { satisfied: false };
    }
    if (!probe.publicHostKeyEvidence) return { satisfied: true };
    const paths = (configuration ?? '').split(/\r?\n/u).flatMap(line => {
        const match = /^hostkey (\/[^\r\n]+)$/u.exec(line.trim());
        return match ? [match[1]!] : [];
    });
    let invalid = false;
    for (const path of paths) {
        let publicKey: string;
        // The native SSH validator owns key sanity. Read only its public sibling.
        try { publicKey = await readFile(`${path}.pub`, 'utf8'); }
        catch { continue; }
        const match = /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)) ([A-Za-z0-9+/]+={0,2})(?: [^\r\n]*)?$/u.exec(publicKey.trim());
        if (!match) { invalid = true; continue; }
        const parsed = parseSshKnownHostLine(`receiver ${match[1]} ${match[2]}`);
        if (!parsed) { invalid = true; continue; }
        return { satisfied: true, hostKeyEvidence: { status: 'ready',
            publicKey: `${parsed.keyType} ${parsed.key}`, fingerprint: parsed.fingerprint } };
    }
    return { satisfied: true, hostKeyEvidence: { status: 'unavailable', reason: invalid ? 'host_key_invalid' : 'host_key_unreadable' } };
}
