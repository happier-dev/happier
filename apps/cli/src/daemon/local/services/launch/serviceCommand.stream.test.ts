import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { watch } from 'node:fs';
import childProcessBoundary from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { createProviderRedactionLease } from '@/providers/spawn/redaction';
import * as commands from './serviceCommand';
import { machineNativeEffectAdmission } from './machineNativeEffectAdmission';
import { logger } from '@/ui/logger';

describe('host service command stream', () => {
    it.each([0, 1] as const)('settles a self-terminating archive reader with exit %s, drains the producer and releases both native captures', async exitCode => {
        const root = await mkdtemp(join(tmpdir(), 'happier-archive-stream-'));
        const consumerEnded = join(root, 'consumer-ended');
        const keys = [{ kind: 'composeProject' as const, dockerEndpoint: 'archive-stream-engine', projectName: root }];
        const secret = 'archive-reader-credential-sentinel';
        const redaction = createProviderRedactionLease({ values: [secret] });
        let released = 0;
        let producerExit!: () => void;
        const producerEnded = new Promise<void>(resolve => { producerExit = resolve; });
        const originalSpawn = childProcessBoundary.spawn;
        const consumerScript = `process.stdin.once("data",()=>{process.stderr.write(${JSON.stringify(`pg_restore: archive ${secret}`)},()=>process.exit(${exitCode}));});process.stdin.resume();`;
        const spawn = vi.spyOn(childProcessBoundary, 'spawn').mockImplementation((...args) => {
            const child: ReturnType<typeof originalSpawn> = Reflect.apply(originalSpawn, childProcessBoundary, args);
            if (Array.isArray(args[1]) && args[1][1] === consumerScript) {
                child.once('exit', () => { void writeFile(consumerEnded, 'exited'); });
            } else child.once('exit', producerExit);
            return child;
        });
        syncBuiltinESMExports();
        const bytes = Buffer.alloc(1024 * 1024, 255);
        const producerScript = `const fs=require('node:fs');const w=fs.watch(${JSON.stringify(root)},(_,f)=>{if(String(f)==='consumer-ended'){w.close();process.stdout.end(Buffer.alloc(${bytes.length},255));}});process.stdout.write(Buffer.alloc(1,255));`;
        try {
            await machineNativeEffectAdmission.run({ operation: { operationId: root, kind: 'restore' }, keys }, async context => {
                const capture = (script: string) => commands.admitNativeServiceCommandForHost({ context,
                    async assertCurrent() {}, async launch() { return { command: process.execPath, args: ['-e', script], env: {},
                        secretRedactionLease: redaction, release() { released++; } }; } });
                const result = await commands.executeAdmittedServiceCommand(commands.admitServiceCommandStreamForHost({
                    producer: capture(producerScript), consumer: capture(consumerScript),
                }));
                expect(result).toMatchObject({ kind: 'completed', exitCode, stderr: 'pg_restore: archive [REDACTED]',
                    stderrTruncated: false, producer: { exitCode: 0,
                    bytes: bytes.length + 1, checksumSha256: createHash('sha256').update(Buffer.concat([Buffer.from([255]), bytes])).digest('hex') } });
            });
            expect(released).toBe(2);
            // A subsequent real admission must not inherit failed stream custody.
            await machineNativeEffectAdmission.run({ operation: { operationId: `next-${root}`, kind: 'backup' }, keys }, async () => {});
        } finally {
            await writeFile(consumerEnded, 'exited'); await producerEnded;
            await machineNativeEffectAdmission.reconcileUnknown({ keys, async observeSettled() { return true; } });
            spawn.mockRestore(); syncBuiltinESMExports(); redaction.close(); await rm(root, { recursive: true, force: true });
        }
    });
    it('redacts a completed native read failure before releasing its lease while preserving raw binary stdout measurements', async () => {
        const secret = 'native-read-credential-sentinel';
        const bytes = Buffer.concat([Buffer.from([0, 255, 195, 40, 128]), Buffer.from(secret)]);
        const redaction = createProviderRedactionLease({ values: [secret] });
        let released = false;
        try {
            await machineNativeEffectAdmission.run({ operation: { operationId: 'native-read-failure-evidence', kind: 'backup' }, keys: [] }, async context => {
                const command = commands.admitNativeServiceCommandForHost({ context, rawStdout: true, async assertCurrent() {},
                    async launch() { return { command: process.execPath, args: ['-e',
                        `process.stdout.write(Buffer.from(${JSON.stringify(bytes.toString('base64'))},'base64'));process.stderr.write(${JSON.stringify(`Fatal: could not find snapshot ${secret}`)});process.exitCode=1;`],
                        env: {}, secretRedactionLease: redaction, release() { released = true; redaction.close(); } }; } });
                const result = await commands.executeAdmittedServiceCommand(command);
                expect(result).toMatchObject({ kind: 'completed', exitCode: 1, stderr: 'Fatal: could not find snapshot [REDACTED]',
                    stderrTruncated: false, stdoutBytes: bytes.byteLength, stdoutChecksumSha256: createHash('sha256').update(bytes).digest('hex') });
                expect(released).toBe(true);
            });
        } finally { redaction.close(); }
    });

    it.each(['shell', 'exec', 'stream'] as const)('requires redeploy before %s when original masking custody is lost', async mode => {
        const redaction = createProviderRedactionLease({ values: ['retired-command-secret'] });
        redaction.close();
        let releases = 0;
        let consumed = false;
        const spawn = vi.spyOn(childProcessBoundary, 'spawn');
        syncBuiltinESMExports();
        try {
            await machineNativeEffectAdmission.run({ operation: { operationId: `closed-masking-${mode}`, kind: 'exec' }, keys: [] }, async context => {
                const capture = { context, async assertCurrent() {}, async launch() {
                    return { command: process.execPath, args: ['-e', 'process.exit(0)'], env: {},
                        ...(mode === 'shell' ? {} : { secretRedactionLease: redaction }),
                        release() { releases++; } };
                } };
                const command = () => commands.admitNativeServiceCommandForHost(capture);
                const result = mode === 'shell'
                    ? commands.withAdmittedServiceShellForHost(capture, async () => {
                        consumed = true;
                        return { kind: 'not_started', terminal: null };
                    })
                    : commands.executeAdmittedServiceCommand(mode === 'exec' ? command()
                        : commands.admitServiceCommandStreamForHost({ producer: command(), consumer: command() }));
                await expect(result).rejects.toMatchObject({ code: 'secret_redaction_redeploy_required', retryable: false });
                expect(consumed).toBe(false);
                expect(spawn).not.toHaveBeenCalled();
                expect(releases).toBe(1);
            });
        } finally { spawn.mockRestore(); syncBuiltinESMExports(); }
    });

    it('finishes native commands inside the protected swap after real job Stop without admitting the next stage', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-protected-command-'));
        const readyPath = join(root, 'ready'), finishPath = join(root, 'finish');
        const controller = new AbortController();
        const redaction = createProviderRedactionLease({ values: [] });
        let ready!: () => void;
        const started = new Promise<void>(resolve => { ready = resolve; });
        const watcher = watch(root, (_event, filename) => { if (String(filename) === 'ready') ready(); });
        const statuses: string[] = [];
        let releases = 0;
        const keys = [{ kind: 'composeProject' as const, dockerEndpoint: 'protected-command-engine', projectName: root }];
        try {
            await machineNativeEffectAdmission.run({ operation: { operationId: root, kind: 'restore', signal: controller.signal }, keys }, async context => {
                const command = (script: string) => commands.admitNativeServiceCommandForHost({ context,
                    signal: context.operation.signal, async assertCurrent() {}, async observeNativeSettlement() { return true; },
                    async launch() {
                        return { command: process.execPath, args: ['-e', script], env: {}, secretRedactionLease: redaction,
                            release() { releases++; } };
                    } });
                const swapping = command(`const fs=require('node:fs');const w=fs.watch(${JSON.stringify(root)},(_,f)=>{if(String(f)==='finish'){w.close();process.stdout.write('swap');}});fs.writeFileSync(${JSON.stringify(readyPath)},'ready');`);
                const protectedStage = machineNativeEffectAdmission.runStage(context, async () => {
                    expect(await commands.executeAdmittedServiceCommand(swapping)).toMatchObject({ kind: 'completed', exitCode: 0, stdout: 'swap' });
                    // verify-or-undo must still launch after the real parent Stop.
                    return commands.executeAdmittedServiceCommand(command('process.stdout.write("verified")'));
                }, { protected: true, onStopPending() { statuses.push('stop_pending'); } });
                const observed = protectedStage.then(value => ({ value }), error => ({ error }));
                try {
                    await started;
                    controller.abort();
                    await writeFile(finishPath, 'finish');
                    expect(await observed).toMatchObject({ value: { kind: 'completed', exitCode: 0, stdout: 'verified' } });
                    expect(statuses).toEqual(['stop_pending']);
                    expect(context.operation.signal?.aborted).toBe(true);
                    await expect(commands.executeAdmittedServiceCommand(command('process.exit(0)')))
                        .rejects.toMatchObject({ code: 'cancelled' });
                    expect(releases).toBe(2);
                } finally { await writeFile(finishPath, 'finish'); await observed; }
            });
        } finally {
            watcher.close(); redaction.close();
            // This fixture's only native process is the settled local child.
            await machineNativeEffectAdmission.reconcileUnknown({ keys, async observeSettled() { return true; } });
            await rm(root, { recursive: true, force: true });
        }
    });
    it.each(['complete', 'unprovable'] as const)('reconciles a failed stream only from both complete native child proofs: %s', async proofKind => {
        const root = await mkdtemp(join(tmpdir(), 'happier-stream-reconcile-'));
        const redaction = createProviderRedactionLease({ values: [] });
        const paths = [join(root, 'producer-native-ended'), join(root, 'consumer-native-ended')];
        const proof = (index: number) => readFile(paths[index]!).then(() => true, () => false);
        const keys = [{ kind: 'composeProject' as const, dockerEndpoint: 'stream-fixture-engine', projectName: root }];
        let released = 0;
        let launches = 0;
        let admittedNext = 0;
        const next = () => machineNativeEffectAdmission.run({ operation: { operationId: `next-${root}`, kind: 'backup' }, keys },
            async () => { admittedNext++; });
        try {
            await machineNativeEffectAdmission.run({ operation: { operationId: root, kind: 'backup' }, keys }, async context => {
                // The files substitute the native Docker-helper terminal probes,
                // independently of the real, already-closed local client processes.
                const child = (index: number, script: string) => commands.admitNativeServiceCommandForHost({ context,
                    async assertCurrent() {}, ...(index === 0 || proofKind === 'complete' ? { observeNativeSettlement: () => proof(index) } : {}),
                    async launch() {
                        launches++;
                        return { command: process.execPath, args: ['-e', script], env: {}, secretRedactionLease: redaction,
                            release() { released++; } };
                    } });
                const producer = child(0, 'process.stdout.write(Buffer.alloc(65536),()=>process.kill(process.pid,"SIGKILL"))');
                const consumer = child(1, 'process.stdin.resume();process.stdin.on("end",()=>process.exit(0))');
                const stream = commands.admitServiceCommandStreamForHost({ producer, consumer });
                expect(await commands.executeAdmittedServiceCommand(stream)).toEqual({ kind: 'outcome_unknown' });
            });
            await expect(next()).rejects.toMatchObject({ code: 'effect_in_progress' });
            expect(released).toBe(0);
            await writeFile(paths[0]!, 'ended');
            await expect(next()).rejects.toMatchObject({ code: 'effect_in_progress' });
            expect(released).toBe(0);
            await writeFile(paths[1]!, 'ended');
            if (proofKind === 'unprovable') {
                await expect(next()).rejects.toMatchObject({ code: 'effect_in_progress' });
                expect(released).toBe(0);
                // Explicit fresh joint native proof cleans this negative fixture;
                // the ordinary next request must not invent the missing child proof.
                await machineNativeEffectAdmission.reconcileUnknown({ keys, async observeSettled() { return await proof(0) && await proof(1); } });
            }
            await next();
            await next();
            expect(released).toBe(2);
            expect(admittedNext).toBe(2);
            expect(launches).toBe(2); // Reconciliation must never dispatch either child again.
        } finally { redaction.close(); await rm(root, { recursive: true, force: true }); }
    });
    it('settles an actually exited finite child before releasing its launch', async () => {
        const redaction = createProviderRedactionLease({ values: [] });
        let released = false;
        let actuallyClosed = false;
        const script = 'process.stdout.write("complete")';
        const originalSpawn = childProcessBoundary.spawn;
        let observeClose!: (observation: Readonly<{ exitCode: number | null; signal: NodeJS.Signals | null }>) => void;
        let observeFailure!: (error: Error) => void;
        const nativeClose = new Promise<Readonly<{ exitCode: number | null; signal: NodeJS.Signals | null }>>((resolve, reject) => {
            observeClose = resolve; observeFailure = reject;
        });
        // Spy only at the genuine OS spawn boundary and delegate unchanged to
        // Node. The production supervisor and command owner remain real.
        const spawn = vi.spyOn(childProcessBoundary, 'spawn').mockImplementation((...args) => {
            // Reflect preserves Node's overloaded native spawn call unchanged.
            const child: ReturnType<typeof originalSpawn> = Reflect.apply(originalSpawn, childProcessBoundary, args);
            if (args[0] === process.execPath && Array.isArray(args[1]) && args[1][1] === script) {
                child.once('error', observeFailure);
                child.once('close', (exitCode, signal) => {
                    actuallyClosed = true;
                    console.info('[C-P30 finite OS close]', { exitCode, signal });
                    observeClose({ exitCode, signal });
                });
            }
            return child;
        });
        // The production supervisor imports Node's named binding. Keep it on
        // this same passthrough OS boundary while the default-object spy lives.
        syncBuiltinESMExports();
        // Framework timeout does not cancel an intentionally stuck public
        // settlement promise. Restore the boundary spy on that RED path too.
        onTestFinished(() => { spawn.mockRestore(); syncBuiltinESMExports(); redaction.close(); });
        try {
            await machineNativeEffectAdmission.run({ operation: { operationId: 'finite-native-settlement', kind: 'exec' }, keys: [] }, async context => {
                const command = commands.admitNativeServiceCommandForHost({ context, async assertCurrent() {}, async launch() {
                    return { command: process.execPath, args: ['-e', script], env: {},
                        secretRedactionLease: redaction, release() {
                            expect(actuallyClosed, 'launch release must follow actual OS child close').toBe(true);
                            released = true;
                        } };
                } });
                const pending = commands.executeAdmittedServiceCommand(command);
                expect(await nativeClose, 'the OS child must actually close successfully before diagnosing a settlement hang')
                    .toEqual({ exitCode: 0, signal: null });
                // A timeout HERE, after the preceding native close assertion,
                // identifies the missing finite-owner disposal/settlement step.
                expect(await pending, 'a successful closed finite child must settle through the public command owner')
                    .toMatchObject({ kind: 'completed', exitCode: 0, stdout: 'complete' });
                expect(released).toBe(true);
            });
        } finally { redaction.close(); }
    });

    it.each([0, 7, 'cancel', 'consumerExit', 'producerFailure'] as const)('withholds consumer EOF after dump stdout closes until producer outcome %s', async exitCode => {
        // Replace only the private file sink; native processes and supervision remain real.
        const localLog = vi.spyOn(logger, 'warnLocalFile').mockImplementation(() => {});
        onTestFinished(() => localLog.mockRestore());
        const root = await mkdtemp(join(tmpdir(), 'happier-stream-'));
        const success = join(root, 'producer-success');
        const eof = join(root, 'consumer-eof');
        const stopped = join(root, 'consumer-stopped');
        const nativeStop = join(root, 'native-stop');
        let consumerExited!: () => void;
        const nativeConsumerClosed = new Promise<void>(resolve => { consumerExited = resolve; });
        const originalSpawn = childProcessBoundary.spawn;
        const nativeSpawn = exitCode === 'producerFailure' ? vi.spyOn(childProcessBoundary, 'spawn').mockImplementation((...args) => {
            const child: ReturnType<typeof originalSpawn> = Reflect.apply(originalSpawn, childProcessBoundary, args);
            if (Array.isArray(args[1]) && args[1][1]?.includes('Fatal: context canceled')) child.once('close', consumerExited);
            return child;
        }) : undefined;
        if (nativeSpawn) syncBuiltinESMExports();
        const redaction = createProviderRedactionLease({ values: ['raw-secret-sentinel'] });
        let released = 0;
        const controller = new AbortController();
        const closed = join(root, 'producer-stdout-closed');
        const watcher = watch(root, (_event, filename) => {
            if (exitCode === 'cancel' && filename === 'producer-stdout-closed') controller.abort();
        });
        // OS fixtures stand in for Compose/restic. All admission, dispatch,
        // stream supervision and redaction remain production implementations.
        const launch = (script: string) => ({ command: process.execPath, args: ['-e', script], env: {},
            secretRedactionLease: redaction, release() { released += 1; } });
        try {
            await machineNativeEffectAdmission.run({ operation: { operationId: `stream-${root}`, kind: 'backup' }, keys: [] }, async context => {
                const producer = commands.admitNativeServiceCommandForHost({ context, signal: controller.signal, async assertCurrent() {}, async launch() {
                    return launch(`const fs=require('node:fs'); const b=Buffer.alloc(65536,255); let n=129; function write(){ while(n-->0)if(!process.stdout.write(b))return process.stdout.once('drain',write); process.stdout.end(()=>{fs.writeFileSync(${JSON.stringify(closed)},'closed');${exitCode === 'cancel' ? 'process.stdin.resume();' : `setTimeout(()=>{${exitCode === 0 ? `fs.writeFileSync(${JSON.stringify(success)},'ok');` : ''}${exitCode === 'producerFailure' ? 'process.stderr.write("pg_dump: database raw-secret-sentinel does not exist");' : ''}process.exit(${typeof exitCode === 'number' ? exitCode : exitCode === 'producerFailure' ? 7 : 0})},100);`}}); } write();`);
                } });
                const consumer = commands.admitNativeServiceCommandForHost({ context, signal: controller.signal, async assertCurrent() {},
                    ...(exitCode === 'producerFailure' ? { async stopNative() { await writeFile(nativeStop, 'stop'); await nativeConsumerClosed; } } : {}), async launch() {
                    return launch(`const fs=require('node:fs');const h=require('node:crypto').createHash('sha256');let bytes=0;${exitCode === 'producerFailure' ? `const w=fs.watch(${JSON.stringify(root)},(_,f)=>{if(String(f)==='native-stop'){w.close();fs.writeFileSync(${JSON.stringify(stopped)},'stopped');process.stderr.write("Fatal: context canceled",()=>process.exit(130));}});` : ''}process.on('SIGTERM',()=>{fs.writeFileSync(${JSON.stringify(stopped)},'stopped');process.exit(0)});process.stdin.on('data',b=>{${exitCode === 'consumerExit' ? 'process.exit(1);' : ''}bytes+=b.length;h.update(b)});process.stdin.on('end',()=>{fs.writeFileSync(${JSON.stringify(eof)},'eof');process.stdout.write(JSON.stringify({bytes,checksum:h.digest('hex'),producerSucceeded:fs.existsSync(${JSON.stringify(success)})}));});`);
                } });
                const compose = Reflect.get(commands, 'admitServiceCommandStreamForHost') as ((input: Readonly<{
                    producer: commands.AdmittedServiceExecContextV1; consumer: commands.AdmittedServiceExecContextV1;
                }>) => commands.AdmittedServiceExecContextV1) | undefined;
                expect(compose, 'the canonical command owner must compose both admitted children').toBeTypeOf('function');
                const stream = compose!({ producer, consumer });
                const result = await commands.executeAdmittedServiceCommand(stream);
                if (exitCode === 0) {
                    expect(result.kind).toBe('completed');
                    if (result.kind !== 'completed') return;
                    const expected = createHash('sha256');
                    for (let n = 0; n < 129; n++) expected.update(Buffer.alloc(65536, 255));
                    expect(JSON.parse(result.stdout)).toEqual({ bytes: 129 * 65536, checksum: expected.digest('hex'), producerSucceeded: true });
                    expect(result.stderr).toBe('');
                    expect(result.producer).toMatchObject({ exitCode: 0, bytes: 129 * 65536,
                        checksumSha256: JSON.parse(result.stdout).checksum });
                } else {
                    if (exitCode === 'consumerExit') expect(result).toMatchObject({ kind: 'completed', exitCode: 1, producer: { exitCode: 0 } });
                    else if (exitCode === 'producerFailure') expect(result).toMatchObject({ kind: 'completed', exitCode: 7,
                        stderr: 'pg_dump: database [REDACTED] does not exist', producer: { exitCode: 7 } });
                    else expect(result.kind).toBe('outcome_unknown');
                    if (exitCode === 7 || exitCode === 'producerFailure') {
                        expect(localLog).toHaveBeenCalledWith('[Service command stream] Native stream failed', expect.objectContaining({
                            operationId: context.operation.operationId, producerExitCode: 7,
                        }));
                        expect(JSON.stringify(localLog.mock.calls)).not.toContain('raw-secret-sentinel');
                    }
                    await expect(readFile(eof)).rejects.toMatchObject({ code: 'ENOENT' });
                    if (exitCode !== 'consumerExit') expect(await readFile(stopped, 'utf8')).toBe('stopped');
                }
                expect(released).toBe(exitCode === 0 || exitCode === 'consumerExit' || exitCode === 'producerFailure' ? 2 : exitCode === 7 ? 1 : 0);
            });
        } finally { nativeSpawn?.mockRestore(); if (nativeSpawn) syncBuiltinESMExports(); watcher.close(); redaction.close(); await rm(root, { recursive: true, force: true }); }
    });
});
