import { createHash } from 'node:crypto';
import { chmod, chown, lstat, mkdtemp, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { MachineSetupEffectError } from './index.js';

export type NativeFileState = Readonly<{ kind: 'absent' }> | Readonly<{
    kind: 'file' | 'directory' | 'foreign'; uid: number; gid: number; mode: number; digest?: string; bytes?: Buffer;
}>;
export type NativeFileIdentity = Readonly<{ uid: number; gid: number }>;
export type NativeFileCurrentness = Readonly<{ assertCurrent(): Promise<void> }>;
export function nativeFileDigest(bytes: string | Buffer) { return createHash('sha256').update(bytes).digest('hex'); }
export function isMissingNativeFile(error: unknown) { return error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'; }

export async function inspectNativeAncestors(path: string, protectedAncestors = false) {
    if (path.includes('\0') || path.split('/').some(part => part === '.' || part === '..')) {
        throw new MachineSetupEffectError('foreign_effect_conflict');
    }
    const parents: string[] = [];
    for (let parent = dirname(path); ; parent = dirname(parent)) {
        parents.push(parent);
        if (dirname(parent) === parent) break;
    }
    for (const parent of parents.reverse()) {
        try {
            const stat = await lstat(parent);
            if (!stat.isDirectory() || stat.isSymbolicLink()
                || protectedAncestors && (stat.uid !== 0 || (stat.mode & 0o022) !== 0)) {
                throw new MachineSetupEffectError('foreign_effect_conflict');
            }
        } catch (error) { if (isMissingNativeFile(error)) return; throw error; }
    }
}

/** Metadata only: this MUST precede protected-content reads and grant custody. */
export async function assertProtectedNativeTarget(path: string, mode: number, executable = false) {
    if (!path.startsWith('/')) throw new MachineSetupEffectError('foreign_effect_conflict');
    await inspectNativeAncestors(path, true);
    try {
        const stat = await lstat(path);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== 0 || stat.gid !== 0
            || (executable ? (stat.mode & 0o022) !== 0 || (stat.mode & 0o111) === 0 : (stat.mode & 0o7777) !== mode)) {
            throw new MachineSetupEffectError('foreign_effect_conflict');
        }
    } catch (error) { if (isMissingNativeFile(error) && !executable) return; throw error; }
}

export async function inspectNativePath(path: string, privateContent = false, protectedAncestors = false): Promise<NativeFileState> {
    await inspectNativeAncestors(path, protectedAncestors);
    try {
        const stat = await lstat(path);
        if (stat.isSymbolicLink() || !stat.isFile() && !stat.isDirectory()) return { kind: 'foreign', uid: stat.uid, gid: stat.gid, mode: stat.mode & 0o7777 };
        if (stat.isDirectory()) return { kind: 'directory', uid: stat.uid, gid: stat.gid, mode: stat.mode & 0o7777 };
        const bytes = await readFile(path);
        return { kind: 'file', uid: stat.uid, gid: stat.gid, mode: stat.mode & 0o7777,
            ...(!privateContent ? { digest: nativeFileDigest(bytes) } : {}), bytes };
    } catch (error) { if (isMissingNativeFile(error)) return { kind: 'absent' }; throw error; }
}
export function nativeFileFacts(state: NativeFileState) {
    return state.kind === 'absent' ? { present: false } : { present: true, kind: state.kind,
        uid: state.uid, gid: state.gid, mode: state.mode, ...(state.digest ? { contentDigest: state.digest } : {}) };
}

/** Exact native retirement; private expected bytes come only from the admitted grant opener. */
export async function removeNativeFile(input: Readonly<{
    path: string; previous: NativeFileState; signal?: AbortSignal;
    secret?: NativeFileCurrentness & Readonly<{ bytes: Uint8Array }>;
}>) {
    const { path, previous, secret } = input;
    if (secret) {
        // The native caller checked the protected target before opening this material.
        if (previous.kind !== 'file' || previous.bytes?.equals(secret.bytes) !== true) throw new MachineSetupEffectError('foreign_effect_conflict');
        input.signal?.throwIfAborted();
        await secret.assertCurrent();
        await unlink(path);
        return;
    }
    await inspectNativeAncestors(path);
    const current = await inspectNativePath(path);
    if (current.kind !== 'file' || JSON.stringify(nativeFileFacts(current)) !== JSON.stringify(nativeFileFacts(previous))) {
        throw new MachineSetupEffectError('foreign_effect_conflict');
    }
    input.signal?.throwIfAborted();
    await unlink(path);
}

/** The sole same-parent candidate writer, shared by ordinary files and fixed root contracts. */
export async function activateNativeFile(input: Readonly<{
    path: string; bytes: string | Uint8Array; mode: number; owner: NativeFileIdentity; previous: NativeFileState;
    validate?: (candidate: string) => Promise<void>; signal?: AbortSignal; secret?: NativeFileCurrentness;
    protectedTarget?: true;
}>) {
    const { path, bytes, mode, owner, previous, secret } = input;
    if (input.protectedTarget) {
        if (owner.uid !== 0 || owner.gid !== 0) throw new MachineSetupEffectError('foreign_effect_conflict');
        if (!secret) await assertProtectedNativeTarget(path, mode);
    } else await inspectNativeAncestors(path);
    const parent = await lstat(dirname(path));
    if (!parent.isDirectory() || parent.isSymbolicLink()) throw new MachineSetupEffectError('foreign_effect_conflict');
    const staging = await mkdtemp(join(dirname(path), '.happier-setup-'));
    try {
        const candidate = join(staging, 'candidate');
        await secret?.assertCurrent();
        await writeFile(candidate, bytes, { flag: 'wx', mode: 0o600 });
        await chown(candidate, owner.uid, owner.gid); await chmod(candidate, mode);
        if (input.protectedTarget) await assertProtectedNativeTarget(candidate, mode);
        if (input.validate) await input.validate(candidate);
        input.signal?.throwIfAborted();
        if (input.protectedTarget && !secret) await assertProtectedNativeTarget(path, mode);
        const current = await inspectNativePath(path, secret !== undefined, input.protectedTarget);
        try {
            if (JSON.stringify(nativeFileFacts(current)) !== JSON.stringify(nativeFileFacts(previous))
                || secret && current.kind === 'file' && previous.kind === 'file' && !current.bytes!.equals(previous.bytes!)) {
                throw new MachineSetupEffectError('foreign_effect_conflict');
            }
            await secret?.assertCurrent();
            await rename(candidate, path);
        } finally { if (secret && current.kind !== 'absent') current.bytes?.fill(0); }
    } finally { await rm(staging, { recursive: true, force: true }); }
}
