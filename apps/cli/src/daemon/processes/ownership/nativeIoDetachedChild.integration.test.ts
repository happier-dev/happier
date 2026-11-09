import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { watch } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { createProjectNativeToolchainIoForHost } from '@/plugins/runtime/invocation/services/exec';
import { createProcessOwnershipRuntime } from './processOwnershipRuntime';
import { listHappierProcessRoots } from '../roots/listHappierProcessRoots';
import { configuration } from '@/configuration';
import { resolveProcessOwnerScopeKey } from '@/processes/ownerTag';
import { stripUnsetEnvironmentVariables } from '@/utils/processEnv/buildScopedProcessEnv';

describe('native IO detached child observation', () => {
    it('observes a detached daemon-tagged child outside the native tree while its generic producer is still alive', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'happier-detached-native-'));
        const readyPath = join(directory, 'ready.json');
        const aborted = new AbortController();
        let detachedPid: number | undefined;
        let watcher: ReturnType<typeof watch> | undefined;
        const ready = new Promise<Readonly<{ rootPid: number; detachedPid: number }>>((resolve, reject) => {
            watcher = watch(directory, (_event, name) => {
                if (String(name) !== 'ready.json') return;
                void readFile(readyPath, 'utf8').then(raw => {
                    const value: unknown = JSON.parse(raw);
                    if (!value || typeof value !== 'object' || !('rootPid' in value) || typeof value.rootPid !== 'number'
                        || !('detachedPid' in value) || typeof value.detachedPid !== 'number') throw new Error('Invalid fixture readiness');
                    resolve({ rootPid: value.rootPid, detachedPid: value.detachedPid });
                }).catch(reject);
            });
            watcher.on('error', reject);
        });
        const intermediate = `const child = require('node:child_process').spawn(process.execPath,
            ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
            child.unref(); console.log(child.pid);`;
        const script = `const fs=require('node:fs'); const cp=require('node:child_process');
            const child=cp.spawn(process.execPath,['-e',${JSON.stringify(intermediate)}],{stdio:['ignore','pipe','ignore']});
            let output=''; child.stdout.on('data', chunk=>output+=chunk);
            child.on('close',()=>{fs.writeFileSync(${JSON.stringify(`${readyPath}.tmp`)},JSON.stringify({rootPid:process.pid,detachedPid:Number(output.trim())}));
                fs.renameSync(${JSON.stringify(`${readyPath}.tmp`)},${JSON.stringify(readyPath)});});
            setInterval(()=>{},1000);`;
        const io = createProjectNativeToolchainIoForHost({ resolveTool: async () => null });
        const running = io.run({ command: process.execPath, args: ['-e', script], cwd: directory,
            env: stripUnsetEnvironmentVariables(process.env, undefined), signal: aborted.signal });
        const settled = running.then(result => ({ result }), error => ({ error }));
        try {
            const native = await Promise.race([ready, settled.then(() => { throw new Error('Generic fixture exited before readiness'); })]);
            detachedPid = native.detachedPid;
            const daemonScopeKey = resolveProcessOwnerScopeKey(configuration.happyHomeDir);
            const ownership = createProcessOwnershipRuntime({ daemonScopeKey,
                listRoots: snapshot => listHappierProcessRoots({ snapshot, daemonScopeKey }) });
            const view = await ownership.readOwners({ freshness: 'fresh' });
            if (view.status !== 'ok') throw new Error(`Native observation unavailable: ${view.reason}`);
            expect(view.snapshot.rows.some(row => row.pid === native.rootPid && row.state !== 'zombie')).toBe(true);
            const orphan = view.snapshot.rows.find(row => row.pid === native.detachedPid);
            expect(orphan?.ppid).not.toBe(native.rootPid);
            expect(view.rows.find(row => row.pid === native.detachedPid)).toMatchObject({ owner: { kind: 'happier' },
                ownerEnded: false, level: 'proven', evidence: expect.arrayContaining([{ kind: 'parent_chain', state: 'not_met', reason: 'no_live_root' }]) });
        } finally {
            watcher!.close();
            if (detachedPid !== undefined) process.kill(detachedPid, 'SIGTERM');
            aborted.abort();
            await settled;
            await rm(directory, { recursive: true, force: true });
        }
    });
});
