import { createHash } from 'node:crypto';
import { readFile, writeFile, chmod, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { DeploymentBackupManifestV1Schema } from '@happier-dev/deployment-protocol';

export const archive = Buffer.from([80, 71, 68, 77, 80, 0, 255, 128, 10]);
/** Fixed valid TAR bytes shared by native and public finite-upload corridors. */
export const volumeTarFixture = (() => {
    const bytes = Buffer.alloc(2048);
    const header = bytes.subarray(0, 512);
    header.write('restored.txt'); header.write('0000644\0', 100); header.write('0000000\0', 108);
    header.write('0000000\0', 116); header.write('00000000011\0', 124); header.write('00000000000\0', 136);
    header.fill(32, 148, 156); header.write('0', 156); header.write('ustar\0', 257); header.write('00', 263);
    header.write(header.reduce((sum, value) => sum + value, 0).toString(8).padStart(6, '0') + '\0 ', 148);
    bytes.write('restored\n', 512);
    return bytes;
})();
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
 * This PostgreSQL/SQLite/restic substitute retains native state across processes.
 */
export async function installRestoreBoundary(root: string, mode: string, options?: Readonly<{ toolDirectory: string; environmentId: string }>) {
    const toolDirectory = options?.toolDirectory ?? join(root, 'tools');
    if (mode === 'sqliteBackup') {
        // Keep SQLite's actual file/VACUUM behavior beneath the Docker boundary.
        const { DatabaseSync } = await import('node:sqlite');
        const directory = join(toolDirectory, 'volume-fixture-physical-data');
        await mkdir(directory, { recursive: true });
        const database = new DatabaseSync(join(directory, 'database.sqlite'));
        try { database.exec("CREATE TABLE records(value TEXT); INSERT INTO records VALUES('retained value');"); }
        finally { database.close(); }
    }
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
// Record fixture failures without command operands, SQL, credentials or stdout.
process.on('uncaughtExceptionMonitor', error => event({kind:'boundaryFailure',
    errorClass:error?.name, fixtureCode:/^(?:unexpected|missing)_[a-z_]+$/.test(error?.message) ? error.message : undefined}));
const command = args.indexOf('exec');
const native = JSON.parse(fs.readFileSync(path.join(__dirname, 'docker-state.json'),'utf8'));
if (args.includes('compose') && args.includes('up') && state.failVolumeActivation) {
    state.failVolumeActivation = false; save();
    event({kind:'volumeActivationFailure'}); process.exit(1);
}
const resticReference = args.find(value => native.images[value]?.image.service === 'restic');
if (args[0] === 'image' && args[1] === 'inspect' && resticReference && !state.runtimeImageLoaded) {
    process.stdout.write('[]'); process.exit(1);
}
if (args[0] === 'pull' && resticReference) {
    if (!resticReference.includes('@sha256:') || !args.includes('--platform')) throw new Error('unexpected_runtime_pull');
    state.runtimeImageLoaded = true; save(); event({kind:'runtimePull',argv:args}); process.exit(0);
}
if (args.includes('create') && (args.includes('--repo') || args.includes('/bin/tar') || args.includes('/bin/cat')
    || args.some(value => native.images[value]?.image.service === 'sqlite'))) {
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
    const sqliteIndex = request.findIndex(value => native.images[value]?.image.service === 'sqlite');
    if (sqliteIndex >= 0 || request.includes('/bin/cat')) {
        const stage = request.find(value => value.includes('target=/happier/staging'));
        if (!stage) throw new Error('missing_sqlite_stage');
        const stagingPath = path.join(__dirname, 'volume-' + /source=([^,]+)/.exec(stage)[1]);
        const snapshotPath = path.join(stagingPath, 'backup.sqlite');
        let output = Buffer.alloc(0);
        if (sqliteIndex >= 0) {
            const argv = request.slice(sqliteIndex + 1);
            if (JSON.stringify(argv) !== JSON.stringify(['-batch', '-bail', '-readonly', '/happier/source/database.sqlite',
                "VACUUM INTO '/happier/staging/backup.sqlite';"])) throw new Error('unexpected_sqlite_snapshot');
            const source = request.find(value => value.includes('target=/happier/source'));
            if (!source || !source.includes('readonly')) throw new Error('missing_sqlite_readonly_source');
            const physicalName = /source=([^,]+)/.exec(source)[1];
            fs.mkdirSync(stagingPath, {recursive:true});
            const { DatabaseSync } = require('node:sqlite');
            const database = new DatabaseSync(path.join(__dirname, 'volume-' + physicalName, 'database.sqlite'), {readOnly:true});
            try { database.exec("VACUUM INTO '" + snapshotPath.replaceAll("'", "''") + "';"); }
            finally { database.close(); }
            state.archive = fs.readFileSync(snapshotPath).toString('base64'); save();
            event({kind:'sqlite',operation:'vacuum'});
        } else {
            if (request.at(-1) !== '/happier/staging/backup.sqlite') throw new Error('unexpected_sqlite_snapshot_read');
            output = fs.readFileSync(snapshotPath);
        }
        native.operationStdoutBase64 = output.toString('base64');
        fs.writeFileSync(path.join(__dirname, 'docker-state.json'), JSON.stringify(native));
        require('./docker-original.cjs');
    } else if (request.includes('/bin/tar')) {
        const imageIndex = request.findIndex(value => native.images[value]?.image.service === 'restic');
        const argv = request.slice(imageIndex + 1);
        const stage = request.find(value => value.includes('target=/happier/staging'));
        const stagingPath = stage ? path.join(__dirname, 'volume-' + /source=([^,]+)/.exec(stage)[1]) : undefined;
        if (stagingPath) fs.mkdirSync(stagingPath, {recursive:true});
        const chunks = [];
        process.stdin.on('data', bytes => chunks.push(bytes));
        process.stdin.on('end', () => {
            const bytes = Buffer.concat(chunks);
            // Docker is the mocked OS boundary. The actual archive tool reads
            // admitted bytes and writes the fixture's mapped native volume.
            const extracted = require('node:child_process').spawnSync('/bin/tar', argv.map(value => value === '/happier/staging' ? stagingPath : value), {input:bytes});
            if (extracted.error) throw extracted.error;
            const dockerPath = path.join(__dirname, 'docker-state.json');
            const docker = JSON.parse(fs.readFileSync(dockerPath, 'utf8'));
            docker.operationStdoutBase64 = extracted.stdout.toString('base64');
            docker.containers.find(row => row.Id === args.at(-1)).State.ExitCode = extracted.status;
            fs.writeFileSync(dockerPath, JSON.stringify(docker));
            event({kind:'archive',operation:argv.includes('-tf') ? 'list' : 'extract',bytes:bytes.length});
            require('./docker-original.cjs');
        });
    } else {
    const offset = request.indexOf('--repo');
    const argv = request.slice(offset);
    const repository = argv[1];
    let output;
    if (argv.includes('config')) output = JSON.stringify({version:2,id:'c'.repeat(64)});
    else if (argv.includes('init')) {
        // The fixture's generated --mount uses these fixed CSV fields. Mirror
        // restic 0.19.1 local.Create: only init creates the selected directory.
        const mount = request.find(value => value.startsWith('type=bind,source=')
            && value.endsWith(',target=/run/happier/backup/repository'));
        if (mount) {
            const source = mount.slice('type=bind,source='.length, -',target=/run/happier/backup/repository'.length);
            const segments = path.posix.relative('/run/happier/backup/repository', repository).split('/').filter(Boolean);
            let parent = source;
            let firstCreated;
            for (const segment of segments) {
                parent = path.join(parent, segment);
                if (!fs.existsSync(parent)) { firstCreated = parent; break; }
            }
            fs.mkdirSync(path.join(source, ...segments), {recursive:true, mode:0o700});
            if (state.mode === 'repositoryOwnership') {
                const repositoryPath = path.join(source, ...segments);
                const indexPath = path.join(repositoryPath, 'index');
                fs.mkdirSync(indexPath, {mode:0o700});
                fs.writeFileSync(path.join(indexPath, 'fixture-index'), 'index', {mode:0o400});
                // Docker is the OS boundary. A root helper's private directory
                // is inaccessible to this non-root daemon; model that with 000
                // without creating root-owned files in the shared test host.
                fs.chmodSync(indexPath, 0o000);
            }
            // The real container runs as root and creates private 0700 folders.
            // This same-UID boundary substitutes 000 on a newly created parent
            // to reproduce the daemon's EACCES without privileged test setup.
            if (firstCreated) fs.chmodSync(firstCreated, 0o000);
        }
        state.initializedRepositories = [...(state.initializedRepositories || []), repository];
        save(); output = JSON.stringify({message_type:'initialized',id:'c'.repeat(64)});
    }
    else if (argv.includes('snapshots')) {
        const selected = argv.includes('d'.repeat(64)) ? [state.safetySnapshot]
            : argv.includes('a'.repeat(64)) ? [state.snapshot]
            : [state.snapshot, ...(state.safetySnapshot ? [state.safetySnapshot] : [])];
        output = JSON.stringify(selected);
    }
    // restic 0.19.1 cat tree resolves a snapshot selector, not a tree blob ID.
    else if (argv.includes('tree')) {
        process.stderr.write('Fatal: could not find snapshot: no matching ID found\n');
        process.exit(1);
    }
    else if (argv.includes('blob')) output = JSON.stringify({nodes:[{name:argv.includes('e'.repeat(64)) ? state.safetySnapshot.paths[0].slice(1) : 'database.dump',type:'file',size:Buffer.from(state.archive,'base64').length}]});
    else if (argv.includes('backup')) {
        const filename = argv[argv.indexOf('--stdin-filename')+1];
        // A real restic snapshot becomes visible only when stdin reaches EOF.
        // The dump-failure test must distinguish stopped-before-EOF custody.
        output = JSON.stringify({message_type:'summary',snapshot_id:'d'.repeat(64),
            total_bytes_processed:Buffer.from(state.archive,'base64').length,total_files_processed:1});
    }
    else if (argv.includes('dump')) output = argv.includes('/destination-probe') ? Buffer.from(state.probePayload,'base64') : Buffer.from(state.archive,'base64');
    else if (argv.includes('restore')) {
        if (argv[argv.indexOf('--target') + 1] !== '/happier/staging' || !argv.includes('--verify')
            || !argv.some(value => /^[a-f0-9]{64}:\/happier\/source$/.test(value))) throw new Error('unexpected_volume_restore');
        output = JSON.stringify({ message_type: 'summary', files_restored: 1, total_files: 1 });
        if (state.mode === 'volumeRestoreFailure') { state.failVolumeActivation = true; save(); }
    }
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
        // Docker/OS boundary: a root helper can chown its admitted repository.
        // The separate real-image probe exercises the actual shell/chown.
        const repair = request.indexOf('happier-restic-repository');
        if (state.mode === 'repositoryOwnership' && repair >= 0) {
            const daemonUser = process.getuid()+':'+process.getgid();
            if (request[repair + 1] !== daemonUser || request[repair + 2] !== repository
                || request.includes('--user')) throw new Error('unexpected_repository_ownership');
            const mount = request.find(value => value.startsWith('type=bind,source=')
                && value.endsWith(',target=/run/happier/backup/repository'));
            const source = mount.slice('type=bind,source='.length, -',target=/run/happier/backup/repository'.length);
            const repositoryPath = path.join(source, path.posix.relative('/run/happier/backup/repository', repository));
            if (fs.existsSync(repositoryPath)) fs.chmodSync(repositoryPath, 0o700);
            const indexPath = path.join(repositoryPath, 'index');
            if (fs.existsSync(indexPath)) fs.chmodSync(indexPath, 0o700);
        }
        const dockerPath = path.join(__dirname, 'docker-state.json');
        const docker = JSON.parse(fs.readFileSync(dockerPath,'utf8'));
        docker.operationStdoutBase64 = Buffer.from(output).toString('base64');
        if (argv.includes('check') && state.repositoryCheckExitCode !== undefined) {
            docker.containers.find(row => row.Id === args.at(-1)).State.ExitCode = state.repositoryCheckExitCode;
        }
        if (argv.includes('config') && state.repositoryConfigExitCode !== undefined) {
            docker.containers.find(row => row.Id === args.at(-1)).State.ExitCode = state.repositoryConfigExitCode;
        }
        if (argv.includes('config') && state.missingRepositoryPrefix && repository.startsWith(state.missingRepositoryPrefix)
            && !(state.initializedRepositories || []).includes(repository)) {
            docker.containers.find(row => row.Id === args.at(-1)).State.ExitCode = 10;
        }
        fs.writeFileSync(dockerPath,JSON.stringify(docker));
        require('./docker-original.cjs');
    };
    if (argv.includes('backup') && !argv.includes('--stdin')) {
        if (state.mode !== 'volumeBackupFailure') {
            state.safetySnapshot = {...state.snapshot,id:'d'.repeat(64),tree:'e'.repeat(64),
                paths:argv.slice(argv.indexOf('backup')+1).filter(value => value.startsWith('/')),
                hostname:argv[argv.indexOf('--host')+1],
                tags:argv.flatMap((value,index)=>value === '--tag' ? [argv[index+1]] : [])};
            save();
        }
        if (state.mode === 'volumeBackupFailure') {
            const dockerPath = path.join(__dirname, 'docker-state.json');
            const docker = JSON.parse(fs.readFileSync(dockerPath,'utf8'));
            docker.containers.find(row => row.Id === args.at(-1)).State.ExitCode = 7;
            fs.writeFileSync(dockerPath,JSON.stringify(docker));
        }
        finish();
    } else if (argv.includes('backup')) {
        let bytes = 0;
        const probeChunks = [];
        process.stdin.on('data', data => { bytes += data.length; if (argv.includes('destination-probe')) probeChunks.push(data); });
        process.stdin.on('end', () => {
            const filename = argv[argv.indexOf('--stdin-filename')+1];
            state.safetySnapshot = {...state.snapshot,id:'d'.repeat(64),tree:'e'.repeat(64),paths:['/'+filename],
                hostname:argv[argv.indexOf('--host')+1],
                tags:argv.flatMap((value,index)=>value === '--tag' ? [argv[index+1]] : [])};
            if (filename === 'destination-probe') state.probePayload = Buffer.concat(probeChunks).toString('base64');
            save(); event({kind:filename === 'destination-probe' ? 'probeBytes' : 'safetyBytes',bytes}); finish();
        });
    } else finish();
    }
} else if (args[0] === 'exec' && args[1] === '-i' && args.slice(3).join(' ') === 'sh -s') {
    // The installed SQL client is the OS boundary. Its rows depend on bytes
    // imported by the real restore lifecycle, rather than a fixed query reply.
    let script = '';
    process.stdin.on('data', bytes => { script += bytes.toString('utf8'); });
    process.stdin.on('end', () => {
        if (!native.containers.some(row => row.Id === args[2])
            || !script.includes('--username=happier_ro') || !script.includes('default_transaction_read_only=on')
            || !script.includes('BEGIN READ ONLY;\nCOPY (\n')
            || !script.includes('SELECT COUNT(*) AS restored_rows FROM recovered_fixture')
            || !script.includes('ROLLBACK;\n')) throw new Error('unexpected_read_only_query');
        const restored = state.names.length > 0 && state.importedBytes === Buffer.from(state.archive,'base64').length;
        event({kind:'readOnlyQuery'});
        process.stdout.write('restored_rows\n' + (restored ? '1' : '0') + '\n');
    });
} else if (command >= 0 && args[command+1] === '-T') {
    let serviceIndex = command + 2;
    while (args[serviceIndex] === '--env') serviceIndex += 2;
    const argv = args.slice(serviceIndex + 1);
    event({kind:'postgres',argv});
    if (argv.includes('--version')) {
        if (state.mode === 'missingTool' && argv[0] === 'pg_amcheck') process.exitCode = 127;
    } else if (argv[0] === 'pg_amcheck') {
        if (state.mode === 'failure') process.exitCode = 1;
    } else if (argv[0] === 'pg_dump') {
        process.stdout.write(Buffer.from(state.archive,'base64'));
        if (state.mode === 'dumpFailure') {
            process.stderr.write('pg_dump: connection for user ' + argv.find(value => value.startsWith('--username=')).slice('--username='.length) + ' failed');
            process.exitCode = 7;
        }
    }
    else if (argv[0] === 'createdb') { state.names.push(argv.at(-1)); save(); }
    else if (argv[0] === 'pg_restore') {
        let bytes = 0;
        // Custom archives are self-delimiting: pg_restore can finish before
        // the restic/Docker producer closes stdout. It does not await pipe EOF.
        process.stdin.on('data', data => { bytes += data.length;
            if (bytes >= Buffer.from(state.archive,'base64').length) {
                if (argv.includes('--list')) event({kind:'archiveListed'});
                else { state.importedBytes = bytes; save(); event({kind:'imported',bytes}); }
                process.exit(0);
            }
        });
    } else if (argv[0] === 'psql') {
        if (!argv.includes('-c')) {
            let statement = '';
            process.stdin.on('data', bytes => { statement += bytes.toString('utf8'); });
            process.stdin.on('end', () => {
                if (!statement.startsWith('CREATE ROLE ') && !statement.startsWith('ALTER ROLE ')) throw new Error('unexpected_role_control');
                // Credentials are deliberately absent from fixture event/log state.
                event({kind:'roleControl',operation:statement.startsWith('CREATE ROLE ') ? 'create' : 'retire'});
            });
        } else {
        const sql = argv.at(-1);
        if (sql.startsWith('SELECT current_user =')) {
            if (!argv.some(arg => arg.startsWith('--username=')) || !process.env.PGPASSWORD) throw new Error('missing_import_role_connection');
            process.stdout.write('t\n');
        }
        else
        if (sql.startsWith('SELECT COALESCE')) {
            if (state.nameObservations?.length) { state.names = state.nameObservations.shift(); save(); }
            process.stdout.write(JSON.stringify(state.names));
        }
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
        }
    } else throw new Error('unexpected_postgres_command');
} else require('./docker-original.cjs');
`);
    await chmod(executable, 0o700);
    return { stateFile, eventsFile,
        async setDatabaseNameObservations(observations: readonly (readonly string[])[]) {
            const state = JSON.parse(await readFile(stateFile, 'utf8'));
            state.nameObservations = observations;
            await writeFile(stateFile, JSON.stringify(state));
        },
        async setRepositoryMissing(repositoryPrefix: string) {
            const state = JSON.parse(await readFile(stateFile, 'utf8'));
            state.missingRepositoryPrefix = repositoryPrefix;
            await writeFile(stateFile, JSON.stringify(state));
        },
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
