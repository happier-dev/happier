import { globalGitConfigCommand } from './globalGitConfig.js';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { MachineSetupEffectError, type MachineRecipeStepV1, type MachineSetupStepObservationV1 } from './index.js';
import { readLocalAccount, type NativeRun } from './nativeSystemBackend.js';
import { parsePosixAcl, posixAclEntryAllows } from './posixAcl.js';
import { inspectNativeAncestors, isMissingNativeFile } from './nativeFileSafety.js';

type WorkspaceStep = Extract<MachineRecipeStepV1, { kind: 'workspaceAccess' | 'pathTraversal' }>;
const safeGitEnvironment = { LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };

/** Git configuration belongs only to metadata at the reviewed Workspace root,
 * never an enclosing repository. Plain folder Workspaces need filesystem access. */
async function hasLocalGitMetadata(path: string): Promise<boolean> {
    try { await lstat(join(path, '.git')); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

/** Only the setup interpreter walks a reviewed tree; launches read held roots. */
export function createWorkspaceAccessBackend(run: NativeRun) {
    const requirePath = async (path: string) => {
        if (await realpath(path) !== path) throw new MachineSetupEffectError('foreign_effect_conflict');
        for (let parent = path; ; parent = dirname(parent)) {
            if ((await lstat(parent)).isSymbolicLink()) throw new MachineSetupEffectError('foreign_effect_conflict');
            if (parent === dirname(parent)) break;
        }
    };
    const tree = async (root: string) => {
        await requirePath(root);
        const entries: { path: string; dev: number; ino: number; uid: number; gid: number; mode: number; directory: boolean }[] = [];
        const visit = async (path: string): Promise<void> => {
            const stat = await lstat(path);
            if (stat.isSymbolicLink()) return;
            if (!stat.isDirectory() && !stat.isFile()) throw new MachineSetupEffectError('foreign_effect_conflict');
            entries.push({ path, dev: stat.dev, ino: stat.ino, uid: stat.uid, gid: stat.gid, mode: stat.mode & 0o7777, directory: stat.isDirectory() });
            if (stat.isDirectory()) for (const name of (await readdir(path)).sort()) await visit(join(path, name));
        };
        await visit(root);
        return entries;
    };
    // Checkout metadata is Agent-writable. Even config-only Git must run with
    // Agent rights, so a planted gitdir/config link cannot borrow root access.
    const git = (step: WorkspaceStep, args: readonly string[]) => run('runuser', ['-u', step.agentUsername, '--',
        'git', '-c', `safe.directory=${step.path}`, '-C', step.path, 'config', '--local', ...args], safeGitEnvironment);
    const trust = (step: WorkspaceStep, args: readonly string[]) => {
        const command = globalGitConfigCommand(step.agentUsername, args);
        return run(command.executable, command.args, { LC_ALL: 'C' });
    };
    const checked = async (command: string, args: readonly string[]) => {
        if ((await run(command, args, { LC_ALL: 'C' })).code !== 0) throw new MachineSetupEffectError('native_effect_failed');
    };
    return {
        async observe(step: WorkspaceStep): Promise<MachineSetupStepObservationV1> {
            if (step.kind === 'pathTraversal') {
                try { await lstat(step.path); }
                catch (error) {
                    if (!isMissingNativeFile(error)) throw error;
                    // A preceding directory step may create this parent during
                    // APPLY. Known absence is drift, not an unavailable fact.
                    // Still reject an existing symlink in its ancestor chain.
                    await inspectNativeAncestors(step.path);
                    return { stepId: step.id, status: 'drifted', facts: { present: false } };
                }
            }
            await requirePath(step.path);
            const user = await readLocalAccount(run, 'passwd', step.agentUsername);
            if (step.kind === 'pathTraversal') {
                const acl = await run('getfacl', ['-n', '-c', '-p', step.path], { LC_ALL: 'C' });
                if (acl.code !== 0) throw new MachineSetupEffectError('required_fact_unavailable');
                const lines = parsePosixAcl(acl.stdout);
                const ready = !!user && posixAclEntryAllows(lines, `user:${user[2]}:`, 'x');
                return { stepId: step.id, status: ready ? 'satisfied' : 'drifted', facts: { acl: lines, agentUid: user ? Number(user[2]) : null } };
            }
            const group = await readLocalAccount(run, 'group', step.group);
            const entries = await tree(step.path);
            const gitMetadata = await hasLocalGitMetadata(step.path);
            const shared = user && gitMetadata ? await git(step, ['--get', 'core.sharedRepository']) : null;
            const safe = user && gitMetadata ? await trust(step, ['--get-all', 'safe.directory']) : null;
            if (safe && safe.code !== 0 && safe.code !== 1) throw new MachineSetupEffectError('required_fact_unavailable');
            const trusted = gitMetadata ? safe?.stdout.trim().split('\n').includes(step.path) === true : null;
            const sharedGit = gitMetadata ? shared?.code === 0 && ['group', '1', 'true', '2', 'all', 'world', 'everybody'].includes(shared.stdout.trim()) : null;
            const gid = group ? Number(group[2]) : null;
            const ready = !!user && gid !== null && (!gitMetadata || trusted && sharedGit) && entries.every(entry => entry.gid === gid
                && !(entry.mode & (entry.directory ? 0o4000 : 0o6000))
                && (entry.mode & 0o060) === 0o060 && (!entry.directory && !(entry.mode & 0o111) || (entry.mode & 0o010) !== 0)
                && (!entry.directory || (entry.mode & 0o2000) !== 0));
            return { stepId: step.id, status: ready ? 'satisfied' : 'drifted', facts: {
                groupId: gid, agentUid: user ? Number(user[2]) : null, gitMetadata, sharedGit, trusted,
                treeDigest: createHash('sha256').update(JSON.stringify(entries)).digest('hex'),
            } };
        },
        async apply(step: WorkspaceStep): Promise<void> {
            await requirePath(step.path);
            const user = await readLocalAccount(run, 'passwd', step.agentUsername);
            if (!user) throw new MachineSetupEffectError('required_fact_unavailable');
            if (step.kind === 'pathTraversal') {
                await checked('setfacl', ['-m', `u:${user[2]}:--x`, '--', step.path]);
                return;
            }
            const group = await readLocalAccount(run, 'group', step.group);
            if (!group) throw new MachineSetupEffectError('required_fact_unavailable');
            for (const entry of await tree(step.path)) {
                // Pin the reviewed inode without following a replacement link.
                // Path-based chown/chmod would follow a swap after lstat.
                const file = await open(entry.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
                try {
                    const current = await file.stat();
                    if (current.dev !== entry.dev || current.ino !== entry.ino || current.uid !== entry.uid
                        || current.isDirectory() !== entry.directory || !current.isDirectory() && !current.isFile()) {
                        throw new MachineSetupEffectError('foreign_effect_conflict');
                    }
                    await file.chown(entry.uid, Number(group[2]));
                    // Shared writable files must not retain executable privilege bits.
                    const ordinaryMode = entry.mode & ~(entry.directory ? 0o4000 : 0o6000);
                    await file.chmod(ordinaryMode | 0o060 | (entry.directory || entry.mode & 0o111 ? 0o010 : 0) | (entry.directory ? 0o2000 : 0));
                } finally { await file.close(); }
            }
            if (!await hasLocalGitMetadata(step.path)) return;
            if ((await git(step, ['core.sharedRepository', 'group'])).code !== 0) throw new MachineSetupEffectError('native_effect_failed');
            const safe = await trust(step, ['--get-all', 'safe.directory']);
            if (safe.code !== 0 && safe.code !== 1) throw new MachineSetupEffectError('required_fact_unavailable');
            if (!safe.stdout.trim().split('\n').includes(step.path) && (await trust(step, ['--add', 'safe.directory', step.path])).code !== 0) {
                throw new MachineSetupEffectError('native_effect_failed');
            }
        },
    };
}
