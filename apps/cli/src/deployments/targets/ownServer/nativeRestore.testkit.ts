import { createHash } from 'node:crypto';
import { readFile, writeFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { DeploymentBackupManifestV1Schema } from '@happier-dev/deployment-protocol';

export const archive = Buffer.from([80, 71, 68, 77, 80, 0, 255, 128, 10]);
export const database = "live\\db'";
export const snapshot = { id: 'a'.repeat(64), tree: 'b'.repeat(64), hostname: 'happier-env-finite-environment',
    time: '2026-10-31T12:00:00Z', paths: ['/database.dump'],
    tags: ['happier', 'env:finite-environment', 'kind:dump', 'src:database'] };
export const sourceManifest = DeploymentBackupManifestV1Schema.parse({ schemaVersion: 1, environmentId: 'finite-environment', sourceId: 'database',
    configRevision: 1, repositoryId: 'c'.repeat(64), kind: 'dump',
    producerChecksumSha256: createHash('sha256').update(archive).digest('hex'),
    totalBytesProcessed: archive.length, totalFilesProcessed: 1,
    snapshot: { snapshotId: snapshot.id, treeId: snapshot.tree, hostname: snapshot.hostname,
        time: snapshot.time, paths: snapshot.paths, tags: snapshot.tags } });

/** Extend the existing Docker executable at the genuine process boundary only.
 * Native admission, P42 custody, raw streams and the restore owner remain real.
 * This tiny PostgreSQL/restic substitute retains database names across processes.
 */
export async function installRestoreBoundary(root: string, mode: string, options?: Readonly<{ toolDirectory: string; environmentId: string }>) {
    const toolDirectory = options?.toolDirectory ?? join(root, 'tools');
    const nativeSnapshot = options ? { ...snapshot, hostname: `happier-env-${options.environmentId}`,
        tags: snapshot.tags.map(tag => tag.startsWith('env:') ? `env:${options.environmentId}` : tag) } : snapshot;
    const executable = join(toolDirectory, 'docker');
    const original = await readFile(executable, 'utf8');
    await writeFile(join(toolDirectory, 'docker-original.cjs'), original.replace(/^#![^\n]*\n/u, ''));
    const stateFile = join(toolDirectory, 'restore-state.json');
    const eventsFile = join(toolDirectory, 'restore-events.jsonl');
    await writeFile(stateFile, JSON.stringify({ names: mode === 'safety' ? [database] : [], mode, snapshot: nativeSnapshot,
        runtimeImageLoaded: options === undefined, archive: archive.toString('base64') }));
    await writeFile(eventsFile, '');
    await writeFile(executable, `#!${process.execPath}\n` + String.raw`
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const args = process.argv.slice(2);
const statePath = path.join(__dirname, 'restore-state.json');
const eventsPath = path.join(__dirname, 'restore-events.jsonl');
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const save = () => fs.writeFileSync(statePath, JSON.stringify(state));
const event = value => fs.appendFileSync(eventsPath, JSON.stringify(value)+'\n');
const command = args.indexOf('exec');
const native = JSON.parse(fs.readFileSync(path.join(__dirname, 'docker-state.json'),'utf8'));
const resticReference = args.find(value => native.images[value]?.image.service === 'restic');
if (args[0] === 'image' && args[1] === 'inspect' && resticReference && !state.runtimeImageLoaded) {
    process.stdout.write('[]'); process.exit(1);
}
if (args[0] === 'pull' && resticReference) {
    if (!resticReference.includes('@sha256:') || !args.includes('--platform')) throw new Error('unexpected_runtime_pull');
    state.runtimeImageLoaded = true; save(); event({kind:'runtimePull',argv:args}); process.exit(0);
}
if (args.includes('create') && args.includes('--repo')) {
    const name = args[args.indexOf('--name')+1];
    const id = crypto.createHash('sha256').update(name).digest('hex');
    fs.writeFileSync(path.join(__dirname, 'restic-'+id+'.json'), JSON.stringify(args));
}
if (['start','stop'].includes(args[0]) && !args.includes('--attach')) {
    const dockerPath = path.join(__dirname, 'docker-state.json');
    const docker = JSON.parse(fs.readFileSync(dockerPath,'utf8'));
    const selected = docker.containers.filter(row => args.slice(1).includes(row.Id));
    if (selected.length !== args.length-1) throw new Error('unexpected_control_identity');
    for (const row of selected) row.State.Status = args[0] === 'start' ? 'running' : 'exited';
    fs.writeFileSync(dockerPath,JSON.stringify(docker));
    event({kind:'nativeControl',operation:args[0],services:selected.map(row=>row.Config.Labels['com.docker.compose.service'])});
} else if (args[0] === 'start' && args.includes('--attach')) {
    const request = JSON.parse(fs.readFileSync(path.join(__dirname, 'restic-'+args.at(-1)+'.json'), 'utf8'));
    const offset = request.indexOf('--repo');
    const argv = request.slice(offset);
    let output;
    if (argv.includes('config')) output = JSON.stringify({version:2,id:'c'.repeat(64)});
    else if (argv.includes('snapshots')) {
        const selected = argv.includes('d'.repeat(64)) ? [state.safetySnapshot]
            : argv.includes('a'.repeat(64)) ? [state.snapshot]
            : [state.snapshot, ...(state.safetySnapshot ? [state.safetySnapshot] : [])];
        output = JSON.stringify(selected);
    }
    else if (argv.includes('tree')) output = JSON.stringify({nodes:[{name:argv.includes('e'.repeat(64)) ? state.safetySnapshot.paths[0].slice(1) : 'database.dump',type:'file',size:Buffer.from(state.archive,'base64').length}]});
    else if (argv.includes('backup')) {
        const filename = argv[argv.indexOf('--stdin-filename')+1];
        // A real restic snapshot becomes visible only when stdin reaches EOF.
        // The dump-failure test must distinguish stopped-before-EOF custody.
        output = JSON.stringify({message_type:'summary',snapshot_id:'d'.repeat(64),
            total_bytes_processed:Buffer.from(state.archive,'base64').length,total_files_processed:1});
    }
    else if (argv.includes('dump')) output = Buffer.from(state.archive,'base64');
    else if (argv.includes('forget')) {
        if (argv.includes('--dry-run')) output = JSON.stringify([{remove:[state.snapshot]}]);
        else {
            state.forgottenSnapshotIds = argv.filter(value => /^[a-f0-9]{64}$/.test(value));
            save(); output = '';
        }
    }
    else if (argv.includes('prune') || argv.includes('check')) output = '';
    else throw new Error('unexpected_restic_request');
    event({kind:'restic',argv});
    const finish = () => {
        const dockerPath = path.join(__dirname, 'docker-state.json');
        const docker = JSON.parse(fs.readFileSync(dockerPath,'utf8'));
        docker.operationStdoutBase64 = Buffer.from(output).toString('base64');
        if (argv.includes('check') && state.repositoryCheckExitCode !== undefined) {
            docker.containers.find(row => row.Id === args.at(-1)).State.ExitCode = state.repositoryCheckExitCode;
        }
        if (argv.includes('config') && state.repositoryConfigExitCode !== undefined) {
            docker.containers.find(row => row.Id === args.at(-1)).State.ExitCode = state.repositoryConfigExitCode;
        }
        fs.writeFileSync(dockerPath,JSON.stringify(docker));
        require('./docker-original.cjs');
    };
    if (argv.includes('backup')) {
        let bytes = 0;
        process.stdin.on('data', data => { bytes += data.length; });
        process.stdin.on('end', () => {
            const filename = argv[argv.indexOf('--stdin-filename')+1];
            state.safetySnapshot = {...state.snapshot,id:'d'.repeat(64),tree:'e'.repeat(64),paths:['/'+filename],
                tags:argv.flatMap((value,index)=>value === '--tag' ? [argv[index+1]] : [])};
            save(); event({kind:'safetyBytes',bytes}); finish();
        });
    } else finish();
} else if (command >= 0 && args[command+1] === '-T') {
    const argv = args.slice(command+3);
    event({kind:'postgres',argv});
    if (argv.includes('--version')) {
        if (state.mode === 'missingTool' && argv[0] === 'pg_amcheck') process.exitCode = 127;
    } else if (argv[0] === 'pg_amcheck') {
        if (state.mode === 'failure') process.exitCode = 1;
    } else if (argv[0] === 'pg_dump') {
        process.stdout.write(Buffer.from(state.archive,'base64'));
        if (state.mode === 'dumpFailure') process.exitCode = 7;
    }
    else if (argv[0] === 'createdb') { state.names.push(argv.at(-1)); save(); }
    else if (argv[0] === 'pg_restore') {
        let bytes = 0;
        process.stdin.on('data', data => { bytes += data.length; });
        process.stdin.on('end', () => { event({kind:'imported',bytes}); });
    } else if (argv[0] === 'psql') {
        const sql = argv.at(-1);
        if (sql.startsWith('SELECT COALESCE')) process.stdout.write(JSON.stringify(state.names));
        else {
            const matched = /^ALTER DATABASE "((?:[^"]|"")*)" RENAME TO "((?:[^"]|"")*)"$/.exec(sql);
            if (!matched) throw new Error('unexpected_sql');
            const from = matched[1].replaceAll('""','"'), to = matched[2].replaceAll('""','"');
            if (!state.names.includes(from) || state.names.includes(to)) process.exitCode = 1;
            else { state.names[state.names.indexOf(from)] = to; save(); }
            if (state.mode === 'healthFailure' && from === 'restore-stage') {
                const dockerPath = path.join(__dirname, 'docker-state.json');
                const docker = JSON.parse(fs.readFileSync(dockerPath,'utf8'));
                docker.health.worker = 'unhealthy';
                fs.writeFileSync(dockerPath,JSON.stringify(docker));
            }
            event({kind:'rename',from,to});
            if (state.mode === 'cancel') {
                // Native reply is held until the test has issued Stop. No timer.
                const releasePath = path.join(__dirname,'release-rename');
                const watcher = fs.watch(__dirname, () => { if (fs.existsSync(releasePath)) watcher.close(); });
                if (fs.existsSync(releasePath)) watcher.close();
            }
        }
    } else throw new Error('unexpected_postgres_command');
} else require('./docker-original.cjs');
`);
    await chmod(executable, 0o700);
    return { stateFile, eventsFile,
        async setRepositoryConfigExitCode(exitCode: number) {
            const state = JSON.parse(await readFile(stateFile, 'utf8'));
            state.repositoryConfigExitCode = exitCode;
            await writeFile(stateFile, JSON.stringify(state));
        },
        async setRepositoryCheckExitCode(exitCode: number) {
            const state = JSON.parse(await readFile(stateFile, 'utf8'));
            state.repositoryCheckExitCode = exitCode;
            await writeFile(stateFile, JSON.stringify(state));
        },
    };
}
