import { lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { MachineSetupEffectError, type MachineRecipeStepV1, type MachineSetupStepObservationV1 } from './index.js';
import type { NativeRun } from './nativeSystemBackend.js';
import { mutateApt } from './nativePackageBackend.js';
import { inspectNativePath as inspectPath, inspectNativeAncestors as inspectAncestors,
    nativeFileFacts as facts, isMissingNativeFile as isMissing, type NativeFileState, type NativeFileIdentity } from './nativeFileSafety.js';

type SourceStep = Extract<MachineRecipeStepV1, { kind: 'packageSource' }>;
type FileStep = Extract<MachineRecipeStepV1, { kind: 'file' }>;
type Identity = NativeFileIdentity | Readonly<{ missingIdentity: string[] }>;

/** Signed native repository configuration; the package manager still owns package resolution and transactions. */
export function createNativePackageSourceBackend(options: Readonly<{
    run: NativeRun;
    identity(step: Pick<FileStep, 'owner' | 'group'>): Promise<Identity>;
    inspectFile(step: FileStep, equivalentContent?: (actual: Uint8Array, desired: Uint8Array) => boolean): Promise<MachineSetupStepObservationV1>;
    activate(path: string, bytes: string | Uint8Array, mode: number, owner: NativeFileIdentity, previous: NativeFileState): Promise<void>;
}>) {
    const { run, identity, inspectFile, activate } = options;
    const sourceBytes = (step: SourceStep, architecture: string) => step.manager === 'dnf'
            ? `[${step.repositoryId}]\nname=${step.repositoryId}\nbaseurl=${step.url.replaceAll('$basearch', architecture)}\nenabled=1\ngpgcheck=1\ngpgkey=${step.keyUrl}\n`
            : step.path.endsWith('.sources')
                ? `Types: deb\nURIs: ${step.url}\nSuites: ${step.suite}\nComponents: ${step.components.join(' ')}\nArchitectures: ${step.architectures.join(' ')}\nSigned-By: ${step.keyPath}\n`
                : `deb [arch=${step.architectures.join(',')} signed-by=${step.keyPath}] ${step.url} ${step.suite} ${step.components.join(' ')}\n`;
    const sourceFile = (step: SourceStep, architecture: string): FileStep => ({ id: step.id, kind: 'file', path: step.path, owner: 'root', group: 'root', mode: 0o644,
        content: { kind: 'literal', value: sourceBytes(step, architecture) } });
    const fingerprint = async (key: string | Uint8Array) => {
        const home = await mkdtemp(join(tmpdir(), 'happier-setup-key-'));
        try {
            const result = await run('gpg', ['--batch', '--no-options', '--homedir', home, '--with-colons', '--show-keys',
                ...(typeof key === 'string' ? ['--', key] : [])], { LC_ALL: 'C' }, typeof key === 'string' ? undefined : key);
            if (result.errorCode === 'ENOENT') throw new MachineSetupEffectError('required_fact_unavailable');
            if (result.code !== 0) throw new MachineSetupEffectError('validation_failed');
            const primary: string[] = [];
            let pending = false;
            for (const line of result.stdout.split('\n')) {
                const fields = line.split(':');
                if (fields[0] === 'pub') {
                    if (['e', 'r'].includes(fields[1] ?? '')) throw new MachineSetupEffectError('validation_failed');
                    pending = true;
                } else if (fields[0] === 'sub') pending = false;
                else if (fields[0] === 'fpr' && pending) { primary.push(fields[9] ?? ''); pending = false; }
            }
            if (primary.length !== 1 || !/^[A-F0-9]{40}$/.test(primary[0]!)) throw new MachineSetupEffectError('validation_failed');
            return primary[0]!;
        } finally { await rm(home, { recursive: true, force: true }); }
    };
    const rpmKeyImported = async (step: SourceStep) => {
        const keys = await run('rpm', ['--query', '--queryformat', '%{VERSION}\n', '--', 'gpg-pubkey'], { LC_ALL: 'C' });
        if (keys.code === 1 && keys.stdout.trim() === 'package gpg-pubkey is not installed' && !keys.stderr.trim()) return false;
        if (keys.code !== 0) throw new MachineSetupEffectError('required_fact_unavailable');
        // RPM <6 uses the short key id; RPM 6 uses the full primary fingerprint.
        const expected = step.keyFingerprint.toLowerCase();
        const version = keys.stdout.trim().split(/\r?\n/).find(value => value === expected || value === expected.slice(-8));
        if (!version) return false;
        const key = await run('rpm', ['--query', '--queryformat', '%{PUBKEYS:armor}\n', '--', `gpg-pubkey-${version}`], { LC_ALL: 'C' });
        if (key.code !== 0) throw new MachineSetupEffectError('required_fact_unavailable');
        if (await fingerprint(Buffer.from(key.stdout)) !== step.keyFingerprint) throw new MachineSetupEffectError('foreign_effect_conflict');
        return true;
    };
    // Chromium annotates its deb822 file and limits Architectures to the native
    // architecture during postinst. Preserve all other repository/key fields.
    const sourceFields = (bytes: Uint8Array, step: SourceStep, architecture: string) => Buffer.from(bytes).toString('utf8').split(/\r?\n/).map(line => line.trimEnd())
        .filter(line => !line.startsWith('#') && !/^X-[^:]+:/i.test(line)).map(line => {
            if (!line.startsWith('Architectures:')) return line;
            const values = line.slice('Architectures:'.length).trim().split(/\s+/);
            return values.includes(architecture) && values.every(value => step.architectures.includes(value))
                ? `Architectures: ${architecture}` : line;
        }).join('\n').replace(/^\n+|\n+$/g, '');
    const observe = async (step: SourceStep): Promise<MachineSetupStepObservationV1> => {
        const format = step.manager === 'apt' ? /\.(?:list|sources)$/.test(step.path) && /\.(?:asc|gpg)$/.test(step.keyPath)
            : step.path.endsWith('.repo') && step.keyPath.endsWith('.asc');
        if (!format || step.path === step.keyPath || /[\s\[\]#]/.test(step.keyPath) || /[\s#]/.test(step.url) || step.manager === 'dnf' && /[\s#]/.test(step.keyUrl)) return {
            stepId: step.id, status: 'unsupported', reason: 'required_fact_unavailable', facts: { requiredFact: step.manager === 'apt' ? 'aptSourceFormat' : 'dnfSourceFormat' } };
        const architecture = step.manager === 'apt' ? await run('dpkg', ['--print-architecture'], { LC_ALL: 'C' }) : await run('rpm', ['--eval', '%{_arch}'], { LC_ALL: 'C' });
        const manager = await run(step.manager === 'apt' ? 'apt-get' : 'dnf', ['--version'], { LC_ALL: 'C' });
        if (manager.errorCode === 'ENOENT' || architecture.errorCode === 'ENOENT') return { stepId: step.id, status: 'unsupported', reason: 'required_fact_unavailable', facts: { requiredFact: 'packageManager' } };
        if (manager.code !== 0 || architecture.code !== 0) return { stepId: step.id, status: 'unavailable', reason: 'required_fact_unavailable', facts: { requiredFact: 'packageManager' } };
        const arch = architecture.stdout.trim();
        if (!step.architectures.includes(arch)) return { stepId: step.id, status: 'unsupported', reason: 'required_fact_unavailable', facts: { requiredFact: 'packageArchitecture' } };
        const source = await inspectFile(sourceFile(step, arch), step.manager === 'apt' && step.path.endsWith('.sources')
            ? (actual, desired) => sourceFields(actual, step, arch) === sourceFields(desired, step, arch) : undefined);
        if (source.status === 'unavailable') return source;
        const key = await inspectPath(step.keyPath);
        if (key.kind !== 'absent' && key.kind !== 'file') return { stepId: step.id, status: 'unavailable', reason: 'foreign_effect_conflict', facts: {} };
        const owner = await identity(sourceFile(step, arch));
        if ('missingIdentity' in owner) return { stepId: step.id, status: 'unavailable', reason: 'required_fact_unavailable', facts: { missingIdentity: owner.missingIdentity } };
        if (key.kind === 'file' && await fingerprint(step.keyPath) !== step.keyFingerprint) return { stepId: step.id, status: 'unavailable', reason: 'foreign_effect_conflict', facts: {} };
        const armored = key.kind === 'file' && key.bytes!.toString('ascii').startsWith('-----BEGIN PGP PUBLIC KEY BLOCK-----');
        if (key.kind === 'file' && step.keyPath.endsWith('.asc') && !armored) return { stepId: step.id, status: 'unavailable', reason: 'validation_failed', facts: {} };
        const imported = step.manager !== 'dnf' || key.kind === 'file' && await rpmKeyImported(step);
        return { stepId: step.id, status: source.status === 'satisfied' && key.kind === 'file' && (step.keyPath.endsWith('.asc') || !armored)
            && key.uid === owner.uid && key.gid === owner.gid && key.mode === 0o644 && imported ? 'satisfied' : 'drifted',
            facts: { architecture: arch, source: source.facts, key: facts(key), keyFingerprint: key.kind === 'file' ? step.keyFingerprint : null, ...(step.manager === 'dnf' ? { keyImported: imported } : {}) } };
    };
    return { observe, async apply(step: SourceStep) {
        const checked = await observe(step);
        if (checked.status === 'satisfied') return;
        if (checked.status !== 'drifted') throw new MachineSetupEffectError(checked.reason === 'foreign_effect_conflict' ? 'foreign_effect_conflict' : 'required_fact_unavailable');
        const architecture = checked.facts.architecture;
        if (typeof architecture !== 'string') throw new MachineSetupEffectError('required_fact_unavailable');
        const source = sourceFile(step, architecture), previousSource = await inspectPath(step.path), previousKey = await inspectPath(step.keyPath);
        const owner = await identity(source);
        if ('missingIdentity' in owner) throw new MachineSetupEffectError('required_fact_unavailable');
        await inspectAncestors(step.keyPath);
        for (const parent of new Set([dirname(step.path), dirname(step.keyPath)])) {
            try {
                const stat = await lstat(parent);
                if (!stat.isDirectory() || stat.isSymbolicLink()) throw new MachineSetupEffectError('foreign_effect_conflict');
            } catch (error) { if (isMissing(error)) throw new MachineSetupEffectError('required_fact_unavailable'); throw error; }
        }
        const staging = await mkdtemp(join(dirname(step.keyPath), '.happier-setup-key-'));
        try {
            const downloaded = join(staging, 'downloaded');
            let bytes: Buffer;
            if (previousKey.kind === 'file') bytes = previousKey.bytes!;
            else {
                const download = await run('curl', ['--fail', '--location', '--silent', '--show-error', '--proto', '=https', '--proto-redir', '=https', '--output', downloaded, '--', step.keyUrl]);
                if (download.code !== 0) throw new MachineSetupEffectError(download.errorCode === 'ENOENT' ? 'required_fact_unavailable' : 'native_effect_failed');
                if (await fingerprint(downloaded) !== step.keyFingerprint) throw new MachineSetupEffectError('validation_failed');
                bytes = await readFile(downloaded);
            }
            const armored = bytes.toString('ascii').startsWith('-----BEGIN PGP PUBLIC KEY BLOCK-----');
            if (step.keyPath.endsWith('.asc') && !armored) throw new MachineSetupEffectError('validation_failed');
            if (step.keyPath.endsWith('.gpg') && armored) {
                if (previousKey.kind === 'file') await writeFile(downloaded, bytes, { flag: 'wx', mode: 0o600 });
                const binary = join(staging, 'key.gpg');
                if ((await run('gpg', ['--batch', '--no-options', '--homedir', staging, '--dearmor', '--output', binary, '--', downloaded])).code !== 0) throw new MachineSetupEffectError('validation_failed');
                bytes = await readFile(binary);
            }
            if (step.manager === 'dnf' && checked.facts.keyImported !== true) {
                const importPath = previousKey.kind === 'file' ? step.keyPath : downloaded;
                const imported = await run('rpm', ['--import', '--', importPath], { LC_ALL: 'C' });
                if (imported.code !== 0) throw new MachineSetupEffectError('native_effect_failed');
            }
            if (JSON.stringify(facts(await inspectPath(step.path))) !== JSON.stringify(facts(previousSource))) throw new MachineSetupEffectError('foreign_effect_conflict');
            await activate(step.keyPath, bytes, 0o644, owner, previousKey);
            await activate(step.path, sourceBytes(step, architecture), source.mode, owner, previousSource);
            if (step.manager === 'apt') await mutateApt(run, ['update']);
        } finally { await rm(staging, { recursive: true, force: true }); }
    } };
}
