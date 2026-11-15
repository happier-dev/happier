import { appendFile, mkdtemp, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { watch as watchFile } from 'node:fs';

import { describe, expect, it, onTestFinished } from 'vitest';
import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';

import { systemdRuntime } from '../../../../../../../packages/plugins/machine-services/src/systemd';
import { createManagedServiceNativeLogs } from '@/plugins/runtime/invocation/services/managedServiceNativeLogs';
import { createProductionPluginInvocationServiceOwners } from '@/plugins/runtime/invocation/services/production';

describe('journal native source with production Exec', () => {
    async function fixture(native: string, maxBytes = 64) {
        const root = await mkdtemp(join(tmpdir(), 'happier-journal-source-'));
        const calls = join(root, 'calls.jsonl');
        const completions = join(root, 'completions.jsonl');
        const script = join(root, 'journalctl.cjs');
        const journalPath = `${script}.journal`;
        await writeFile(journalPath, 'journal');
        await writeFile(completions, '');
        const controller = new AbortController();
        let current = true;
        const executable = { kind: 'systemTool' as const, id: 'journalctl' };
        // Only the native journalctl process is substituted; source lifecycle,
        // invocation policy, Exec, process settlement and host logs stay real.
        await writeFile(script, `const fs=require('node:fs');const args=process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(args)+${JSON.stringify('\n')});
process.on('exit',()=>fs.appendFileSync(${JSON.stringify(completions)},JSON.stringify(args)+${JSON.stringify('\n')}));
${native.replaceAll('/var/log/journal/test/system.journal', journalPath)}`);
        const owners = createProductionPluginInvocationServiceOwners({ loggerSink: { write() {} }, exec: {
            resolveExecutable: async () => ({ command: process.execPath, args: [script] }),
            resolvePath: async () => { throw new Error('Machine-native logs have no Workspace'); },
            agentIsolation: { read: () => ({ enabled: true,
                status: { kind: 'applying', phase: 'runtime_replacement' }, workspaceRoots: [] }) },
        } });
        const seed = { plugin: { id: 'happier.machine.services', version: '0.0.0' },
            contribution: { id: 'systemd', qualifiedId: 'happier.machine.services/projectNativeAdapters/systemd' },
            occurrenceId: 'journal-source', correlationId: 'journal-source', surface: 'cli' as const,
            signal: controller.signal, isOccurrenceCurrent: () => current };
        const context: PluginInvocationContext = { plugin: seed.plugin, contribution: seed.contribution,
            surface: seed.surface, invokedAtMs: 0, signal: seed.signal,
            services: owners.createOperationServices(seed, {
                executionKind: 'machine_native', filesystemRoots: { pluginData: root, projects: new Map() },
                hostAccessRequests: [{ required: true, request: { id: 'journal-process', capability: 'process',
                    reason: 'Read exact native service logs', scope: { executables: [executable], envKeys: ['LC_ALL'] } } },
                    { required: true, request: { id: 'journal-source', capability: 'filesystem',
                        reason: 'Observe native journal changes', scope: { locations: [{ root: 'machine', pathPrefix: root }], access: ['read'] } } }],
            }) };
        const lifecycle = systemdRuntime.nativeServiceLifecycle!;
        const instance = { adapter: { pluginId: 'happier.machine.services', localId: 'systemd' },
            nativeResourceId: 'user/worker.service' };
        const logs = createManagedServiceNativeLogs({ signal: seed.signal, maxBytes,
            isCurrent: () => current, redactedValues: () => [],
            ...(lifecycle.logs ? { invoke: request => request.kind === 'read'
                ? lifecycle.logs!(instance, request, context) : lifecycle.logs!(instance, request, context) } : {}),
        });
        const records = async (path: string) => (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as string[]);
        const nativeCalls = () => records(calls);
        let disposal: Promise<void> | undefined;
        const dispose = () => disposal ??= Promise.resolve().then(async () => {
            controller.abort(); await logs.dispose(); await owners.dispose();
            await rm(root, { recursive: true, force: true });
        });
        onTestFinished(dispose);
        const waitForNativeRecord = (path: string, matches: (args: readonly string[]) => boolean, after = 0) => new Promise<void>((resolve, reject) => {
            let closed = false;
            const finish = (error?: unknown) => {
                if (closed) return;
                closed = true;
                observation.close();
                controller.signal.removeEventListener('abort', aborted);
                if (error) reject(error); else resolve();
            };
            const sample = async () => {
                try {
                    const values = await records(path);
                    if (!closed && values.slice(after).some(matches)) finish();
                } catch (error) { if (!closed) finish(error); }
            };
            const observation = watchFile(path, () => { void sample(); });
            const aborted = () => finish();
            observation.on('error', finish);
            controller.signal.addEventListener('abort', aborted, { once: true });
            if (controller.signal.aborted) aborted(); else void sample();
        });
        return { logs, context, lifecycle, instance, root, journalPath,
            waitForNativeCall: (matches: (args: readonly string[]) => boolean, after = 0) => waitForNativeRecord(calls, matches, after),
            waitForNativeCompletion: (matches: (args: readonly string[]) => boolean) => waitForNativeRecord(completions, matches),
            retire() { current = false; },
            calls: nativeCalls, dispose,
        };
    }

    it.skipIf(process.platform !== 'linux')('returns the exact reviewed journal recipe on native permission denial', async () => {
        const f = await fixture("process.stderr.write('No journal files were opened due to insufficient permissions.\\n');process.exit(1);");
        try {
            expect(await f.logs.read()).toEqual({ kind: 'unavailable', reason: 'denied', recipeRemedy: {
                pluginId: 'happier.machine.recipes', recipeId: 'journal-reader', revision: '1',
            } });
            const nativeCalls = await f.calls();
            // Permission failure is the real read failure, never a second access
            // probe, shell launcher, membership mutation or elevation attempt.
            expect(nativeCalls).toEqual([['--user', '--unit=worker.service', '--no-pager', '--header']]);
        } finally {
            await f.dispose();
        }
    });

    it.skipIf(process.platform !== 'linux')('reads finite UTF-8 pages through real native framing and resumes without dropping an oversized message', async () => {
        const message = 'prefix ' + '🌍'.repeat(100) + '\nsecond line';
        const f = await fixture(`
if(args.includes('--header')) {
 process.stdout.write('File path: /var/log/journal/test/system.journal\\nFile ID: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\\nBoot ID: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\\n');
} else {
 const binary=(name,data)=>{const size=Buffer.alloc(8);size.writeBigUInt64LE(BigInt(data.length));return Buffer.concat([Buffer.from(name+'\\n'),size,data,Buffer.from('\\n')]);};
 // Fields may repeat, be binary, and precede their cursor. Irrelevant fields
 // exceed Exec capture: only the requested decoded page may be retained.
 const entry=Buffer.concat([binary('IGNORED',Buffer.alloc(300000,42)),binary('MESSAGE',Buffer.from(${JSON.stringify(message)})),
 Buffer.from('MESSAGE=final\\n__CURSOR=s=first;i=1;b=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\\n_BOOT_ID=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\\n\\n')]);
 if(!args.some(arg=>arg.startsWith('--after-cursor='))) process.stdout.write(entry);
}`, 64);
        try {
            let text = '';
            let cursor: import('@happier-dev/plugin-sdk/managed-services').ManagedServiceNativeLogCursorV1 | undefined;
            let pages = 0;
            for (;;) {
                const result = await f.logs.read(cursor ? { cursor } : undefined);
                expect(result.kind).toBe('page');
                if (result.kind !== 'page') break;
                expect(Buffer.byteLength(result.page.text, 'utf8')).toBeLessThanOrEqual(64);
                expect(result.page.text).not.toContain('�');
                text += result.page.text;
                pages += 1;
                if (!result.page.truncated) break;
                expect(result.page.nextCursor).not.toBeNull();
                cursor = result.page.nextCursor!;
                expect(pages).toBeLessThan(20);
            }
            expect(text).toBe(`${message}\nfinal\n`);
            expect(pages).toBeGreaterThan(1);
            const calls = await f.calls();
            expect(calls.every(args => args.includes('--user') && args.includes('--unit=worker.service'))).toBe(true);
            expect(calls.some(args => args.includes('--output=export'))).toBe(true);
            expect(calls.some(args => args.includes('--lines=0'))).toBe(false);
        } finally { await f.dispose(); }
    });

    it.skipIf(process.platform !== 'linux')('returns the first page and establishes follow without draining historical continuations', async () => {
        const message = 'x'.repeat(640);
        const f = await fixture(`
if(args.includes('--header')) process.stdout.write('File path: /var/log/journal/test/system.journal\\nFile ID: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\\nBoot ID: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\\n');
else if(!args.some(arg=>arg.startsWith('--after-cursor='))) process.stdout.write('MESSAGE='+${JSON.stringify(message)}+'\\n__CURSOR=position-1\\n\\n');`, 64);
        try {
            const first = await f.logs.read();
            if (first.kind !== 'page' || !first.page.nextCursor) throw new Error('Expected a finite first page');
            expect(first.page.text).toHaveLength(64);
            expect(first.page.truncated).toBe(true);
            const pages: unknown[] = [];
            let emitted!: () => void;
            const emission = new Promise<void>(resolve => { emitted = resolve; });
            const watch = await f.logs.watch({ cursor: first.page.nextCursor, emit: value => { pages.push(value); emitted(); } });
            try {
                await emission;
                expect(pages).toHaveLength(1);
                const exports = (await f.calls()).filter(args => args.includes('--output=export'));
                expect(exports).toHaveLength(2);
                expect(exports[1]).toContain('--cursor=position-1');
                const next = await f.logs.read({ cursor: first.page.nextCursor });
                expect(next).toMatchObject({ kind: 'page', page: { text: 'x'.repeat(64), truncated: true } });
            } finally { await watch.dispose(); }
        } finally { await f.dispose(); }
    });

    it.skipIf(process.platform !== 'linux')('fences a rotated source before content IO and releases a cancelled native read', async () => {
        const f = await fixture(`
if(args.includes('--header')) {
 const revision=fs.existsSync(${JSON.stringify('PLACEHOLDER')})?'cccccccccccccccccccccccccccccccc':'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
 process.stdout.write('File path: /var/log/journal/test/system.journal\\nFile ID: '+revision+'\\nBoot ID: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\\n');
} else if(args.some(arg=>arg.startsWith('--after-cursor='))) {
 setInterval(()=>{},1000);
} else process.stdout.write('MESSAGE=ready\\n__CURSOR=opaque-native-position\\n\\n');`);
        // The native executable's source marker stands in for a journal file ID,
        // not for host source-comparison logic.
        const script = join(f.root, 'journalctl.cjs');
        await writeFile(script, (await readFile(script, 'utf8')).replace('PLACEHOLDER', join(f.root, 'rotated')));
        try {
            const first = await f.logs.read();
            expect(first.kind).toBe('page');
            if (first.kind !== 'page' || !first.page.nextCursor) return;
            const lifetime = new AbortController();
            const started = f.waitForNativeCall(args => args.includes('--after-cursor=opaque-native-position'));
            const pending = f.logs.read({ cursor: first.page.nextCursor, signal: lifetime.signal });
            // Assert rejection immediately so native cancellation cannot create
            // a test-process unhandled rejection while cleanup is awaited.
            const cancelled = expect(pending).rejects.toBeDefined();
            await started;
            expect((await f.calls()).some(args => args.includes('--after-cursor=opaque-native-position'))).toBe(true);
            lifetime.abort();
            await cancelled;
            const before = (await f.calls()).filter(args => args.includes('--output=export')).length;
            await writeFile(join(f.root, 'rotated'), 'rotation');
            expect(await f.logs.read({ cursor: first.page.nextCursor })).toMatchObject({ kind: 'source-changed' });
            expect((await f.calls()).filter(args => args.includes('--output=export'))).toHaveLength(before);
        } finally { await f.dispose(); }
    });

    it.skipIf(process.platform !== 'linux')('keeps append positions stable but discards bytes when the journal rotates during a read', async () => {
        const f = await fixture(`
const statePath=__filename+'.state';
const state=fs.existsSync(statePath)?JSON.parse(fs.readFileSync(statePath,'utf8')):{headers:0,rotated:false};
if(args.includes('--header')) {
 state.headers++;fs.writeFileSync(statePath,JSON.stringify(state));
 process.stdout.write('File path: /var/log/journal/test/system.journal\\nFile ID: '+(state.rotated?'cccccccccccccccccccccccccccccccc':'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')+'\\nBoot ID: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\\nTail sequential number: '+state.headers+'\\n');
} else {
 const after=args.some(arg=>arg.startsWith('--after-cursor='));
 process.stdout.write('MESSAGE='+(after?'appended':'initial')+'\\n__CURSOR='+(after?'position-2':'position-1')+'\\n\\n');
 if(fs.existsSync(__filename+'.rotate')) {state.rotated=true;fs.writeFileSync(statePath,JSON.stringify(state));}
}`);
        try {
            const first = await f.logs.read();
            expect(first).toMatchObject({ kind: 'page', page: { text: 'initial\n', truncated: false } });
            if (first.kind !== 'page' || !first.page.nextCursor) throw new Error('Expected the first journal position');
            const appended = await f.logs.read({ cursor: first.page.nextCursor });
            expect(appended).toMatchObject({ kind: 'page', page: {
                sourceRevision: first.page.sourceRevision, text: 'appended\n', truncated: false,
            } });
            await writeFile(join(f.root, 'journalctl.cjs.rotate'), 'rotate during export');
            const raced = await f.logs.read({ cursor: first.page.nextCursor });
            expect(raced).toMatchObject({ kind: 'source-changed' });
            expect(raced).not.toHaveProperty('page');
        } finally { await f.dispose(); }
    });

    it.skipIf(process.platform !== 'linux').each(['append', 'in-place'] as const)('follows an admitted journal cursor on %s updates without probing unchanged headers and releases native demand on pause', async update => {
        const f = await fixture(`
if(args.includes('--header')) process.stdout.write('File path: /var/log/journal/test/system.journal\\nFile ID: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\\nBoot ID: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\\n');
else {
 if(!args.some(arg=>arg.startsWith('--after-cursor='))) process.stdout.write('MESSAGE=initial\\n__CURSOR=position-1\\n\\n');
 else if(args.includes('--after-cursor=position-1')&&fs.readFileSync(__filename+'.journal','utf8').includes('appended'))
  process.stdout.write('MESSAGE=appended\\n__CURSOR=position-2\\n\\n');
}`);
        try {
            if (update === 'in-place') await writeFile(f.journalPath, 'journal ');
            const first = await f.logs.read();
            if (first.kind !== 'page' || !first.page.nextCursor) throw new Error('Expected the first journal position');
            const values: unknown[] = [];
            let emitted!: () => void;
            const next = new Promise<void>(resolve => { emitted = resolve; });
            const watch = await f.logs.watch({ cursor: first.page.nextCursor, emit: value => { values.push(value); emitted(); } });
            try {
                await f.waitForNativeCompletion(args => args.includes('--after-cursor=position-1'));
                const headers = (await f.calls()).filter(args => args.includes('--header')).length;
                if (update === 'append') await appendFile(f.journalPath, ' appended');
                else {
                    const file = await open(f.journalPath, 'r+');
                    try { await file.write('appended', 0, 'utf8'); }
                    finally { await file.close(); }
                }
                await next;
                expect(values).toContainEqual({ kind: 'page', page: {
                    sourceRevision: first.page.sourceRevision, text: 'appended\n',
                    nextCursor: { sourceRevision: first.page.sourceRevision,
                        token: JSON.stringify({ v: 1, cursor: 'position-2', offset: 0, after: true }) },
                    truncated: false,
                } });
                const continued = f.waitForNativeCall(args => args.includes('--after-cursor=position-2'));
                await appendFile(f.journalPath, ' unrelated unit append');
                await continued;
                expect((await f.calls()).some(args => args.includes('--after-cursor=position-2'))).toBe(true);
                expect((await f.calls()).filter(args => args.includes('--header'))).toHaveLength(headers);
            } finally { await watch.dispose(); }
            const before = await f.calls();
            await appendFile(f.journalPath, ' after pause');
            await new Promise(resolve => setTimeout(resolve, 50));
            expect(await f.calls()).toEqual(before);
        } finally { await f.dispose(); }
    });

    it.skipIf(process.platform !== 'linux').each(['replacement', 'truncation'] as const)('retires a journal continuation on native %s before reading content', async change => {
        const f = await fixture(`
if(args.includes('--header')) {
 const data=fs.readFileSync(__filename+'.journal','utf8');
 process.stdout.write('File path: /var/log/journal/test/system.journal\\nFile ID: '+(data==='R'?'cccccccccccccccccccccccccccccccc':'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')+'\\nBoot ID: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\\n');
} else if(!args.some(arg=>arg.startsWith('--after-cursor='))) process.stdout.write('MESSAGE=initial\\n__CURSOR=position-1\\n\\n');`);
        try {
            const first = await f.logs.read();
            if (first.kind !== 'page' || !first.page.nextCursor) throw new Error('Expected an initial journal position');
            const values: unknown[] = [];
            let emitted!: () => void;
            const next = new Promise<void>(resolve => { emitted = resolve; });
            const watch = await f.logs.watch({ cursor: first.page.nextCursor, emit: value => { values.push(value); emitted(); } });
            try {
                await f.waitForNativeCompletion(args => args.includes('--after-cursor=position-1'));
                const before = (await f.calls()).filter(args => args.includes('--output=export')).length;
                if (change === 'replacement') await rename(f.journalPath, `${f.journalPath}.old`);
                await writeFile(f.journalPath, 'R');
                await next;
                expect(values).toEqual([{ kind: 'source-changed', sourceRevision: expect.any(String) }]);
                expect(values[0]).not.toEqual({ kind: 'source-changed', sourceRevision: first.page.sourceRevision });
                expect((await f.calls()).filter(args => args.includes('--output=export'))).toHaveLength(before);
            } finally { await watch.dispose(); }
        } finally { await f.dispose(); }
    });

    it.skipIf(process.platform !== 'linux')('withdraws a real invocation generation before native continuation IO', async () => {
        const f = await fixture(`
if(args.includes('--header')) process.stdout.write('File path: /var/log/journal/test/system.journal\\nFile ID: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\\nBoot ID: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\\n');
else if(!args.some(arg=>arg.startsWith('--after-cursor='))) process.stdout.write('MESSAGE=initial\\n__CURSOR=position-1\\n\\n');
else if(fs.readFileSync(__filename+'.journal','utf8').includes('append')) process.stdout.write('MESSAGE=retired bytes\\n__CURSOR=position-2\\n\\n');`);
        try {
            const first = await f.logs.read();
            if (first.kind !== 'page' || !first.page.nextCursor) throw new Error('Expected an initial journal position');
            const values: unknown[] = [];
            const watch = await f.logs.watch({ cursor: first.page.nextCursor, emit: value => { values.push(value); } });
            try {
                await f.waitForNativeCompletion(args => args.includes('--after-cursor=position-1'));
                const before = await f.calls();
                f.retire();
                await appendFile(f.journalPath, ' append');
                await new Promise(resolve => setTimeout(resolve, 50));
                await watch.dispose();
                expect(await f.calls()).toEqual(before);
                expect(values).toEqual([]);
            } finally { await watch.dispose(); }
        } finally { await f.dispose(); }
    });

    it.skipIf(process.platform !== 'linux')('leaves oversized appended history to consumer-paced finite cursor reads', async () => {
        const message = '🌍'.repeat(100);
        const f = await fixture(`
if(args.includes('--header')) process.stdout.write('File path: /var/log/journal/test/system.journal\\nFile ID: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\\nBoot ID: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\\n');
else if(!args.some(arg=>arg.startsWith('--after-cursor=')||arg.startsWith('--cursor='))) process.stdout.write('MESSAGE=initial\\n__CURSOR=position-1\\n\\n');
else if(!args.includes('--after-cursor=position-2')&&fs.readFileSync(__filename+'.journal','utf8').includes('appended')) {
 const data=Buffer.from(${JSON.stringify(message)});const size=Buffer.alloc(8);size.writeBigUInt64LE(BigInt(data.length));
 process.stdout.write(Buffer.concat([Buffer.from('MESSAGE\\n'),size,data,Buffer.from('\\n__CURSOR=position-2\\n\\n')]));
}`);
        try {
            const first = await f.logs.read();
            if (first.kind !== 'page' || !first.page.nextCursor) throw new Error('Expected an initial journal position');
            const pages: Array<Extract<Awaited<ReturnType<typeof f.logs.read>>, { kind: 'page' }>['page']> = [];
            let emitted!: (value: Awaited<ReturnType<typeof f.logs.read>>) => void;
            const emission = new Promise<Awaited<ReturnType<typeof f.logs.read>>>(resolve => { emitted = resolve; });
            const watch = await f.logs.watch({ cursor: first.page.nextCursor, emit: value => {
                if (value.kind === 'page') pages.push(value.page);
                emitted(value);
            } });
            try {
                await f.waitForNativeCompletion(args => args.includes('--after-cursor=position-1'));
                const headers = (await f.calls()).filter(args => args.includes('--header')).length;
                await appendFile(f.journalPath, ' appended');
                expect((await emission).kind).toBe('page');
                expect(pages).toHaveLength(1);
                expect(pages[0]?.truncated).toBe(true);
                expect((await f.calls()).filter(args => args.includes('--header'))).toHaveLength(headers);
                const consumed = [...pages];
                while (consumed.at(-1)!.truncated) {
                    const result = await f.logs.read({ cursor: consumed.at(-1)!.nextCursor! });
                    if (result.kind !== 'page') throw new Error('Expected a demanded continuation');
                    consumed.push(result.page);
                }
                expect(consumed.map(page => page.text).join('')).toBe(`${message}\n`);
                expect(consumed.every(page => Buffer.byteLength(page.text, 'utf8') <= 64
                    && page.sourceRevision === first.page.sourceRevision && !page.text.includes('�'))).toBe(true);
                expect(pages).toHaveLength(1);
            } finally { await watch.dispose(); }
        } finally { await f.dispose(); }
    });

    it.skipIf(process.platform !== 'linux')('settles an in-flight native continuation on cancellation without late bytes or resumed demand', async () => {
        const f = await fixture(`
if(args.includes('--header')) process.stdout.write('File path: /var/log/journal/test/system.journal\\nFile ID: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\\nBoot ID: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\\n');
else if(!args.some(arg=>arg.startsWith('--after-cursor='))) process.stdout.write('MESSAGE=initial\\n__CURSOR=position-1\\n\\n');
else if(fs.readFileSync(__filename+'.journal','utf8').includes('appended')) setInterval(()=>{},1000);`);
        try {
            const first = await f.logs.read();
            if (first.kind !== 'page' || !first.page.nextCursor) throw new Error('Expected an initial journal position');
            const lifetime = new AbortController();
            const values: unknown[] = [];
            const watch = await f.logs.watch({ cursor: first.page.nextCursor, signal: lifetime.signal,
                emit: value => { values.push(value); } });
            try {
                await f.waitForNativeCompletion(args => args.includes('--after-cursor=position-1'));
                const before = (await f.calls()).length;
                const started = f.waitForNativeCall(args => args.includes('--output=export'), before);
                await appendFile(f.journalPath, ' appended');
                await started;
                expect((await f.calls()).length).toBeGreaterThan(before);
                lifetime.abort();
                await watch.dispose();
                const stopped = await f.calls();
                await appendFile(f.journalPath, ' after cancellation');
                await new Promise(resolve => setTimeout(resolve, 50));
                expect(await f.calls()).toEqual(stopped);
                expect(values).toEqual([]);
            } finally { await watch.dispose(); }
        } finally { await f.dispose(); }
    });
});
