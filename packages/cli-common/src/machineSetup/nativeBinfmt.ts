import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MachineRecipeCheckV1 } from '@happier-dev/protocol/machines/setup/machineRecipeV1';
import type { NativeRun } from './nativeSystemBackend.js';
import type { MachineSetupStepObservationV1 } from './index.js';

type KernelCheck = Extract<MachineRecipeCheckV1, { kind: 'kernel' }>;
type Rule = Readonly<{ interpreter: string; flags: string; magic: Buffer; mask: Buffer; offset: number }>;
const root = '/proc/sys/fs/binfmt_misc';
const locale = { LC_ALL: 'C' };
const aliases: Readonly<Record<string, string>> = { x86_64: 'amd64', aarch64: 'arm64', x64: 'amd64', arm64: 'arm64', riscv64: 'riscv64' };

/** Linux ELF64 exit(42), with no loader, libc, shell or downloaded probe. */
function executable(architecture: string): Buffer | undefined {
    const targets: Readonly<Record<string, Readonly<{ machine: number; code: string }>>> = {
        amd64: { machine: 62, code: 'b83c000000bf2a0000000f05' },
        arm64: { machine: 183, code: '400580d2a80b80d2010000d4' },
        riscv64: { machine: 243, code: '1305a0029308d00573000000' },
    };
    const target = targets[architecture];
    if (!target) return undefined;
    const code = Buffer.from(target.code, 'hex'), bytes = Buffer.alloc(120 + code.length);
    bytes.write('\x7fELF', 0, 'binary'); bytes[4] = 2; bytes[5] = 1; bytes[6] = 1;
    bytes.writeUInt16LE(2, 16); bytes.writeUInt16LE(target.machine, 18); bytes.writeUInt32LE(1, 20);
    bytes.writeBigUInt64LE(0x400078n, 24); bytes.writeBigUInt64LE(64n, 32);
    bytes.writeUInt16LE(64, 52); bytes.writeUInt16LE(56, 54); bytes.writeUInt16LE(1, 56);
    bytes.writeUInt32LE(1, 64); bytes.writeUInt32LE(5, 68); bytes.writeBigUInt64LE(0x400000n, 80);
    bytes.writeBigUInt64LE(0x400000n, 88); bytes.writeBigUInt64LE(BigInt(bytes.length), 96);
    bytes.writeBigUInt64LE(BigInt(bytes.length), 104); bytes.writeBigUInt64LE(0x1000n, 112);
    code.copy(bytes, 120);
    return bytes;
}
function matches(rule: Rule, bytes: Buffer): boolean {
    return rule.offset >= 0 && rule.magic.length > 0 && rule.magic.length === rule.mask.length
        && rule.offset + rule.magic.length <= bytes.length
        && rule.magic.every((byte, index) => (bytes[rule.offset + index]! & rule.mask[index]!) === (byte & rule.mask[index]!));
}
function activeRule(text: string): Rule | undefined {
    if (text.split('\n')[0] !== 'enabled') return;
    const interpreter = /^interpreter (\/[^\n\0]+)$/m.exec(text)?.[1];
    const magic = /^magic ([a-fA-F0-9]+)$/m.exec(text)?.[1];
    const mask = /^mask ([a-fA-F0-9]+)$/m.exec(text)?.[1];
    const offset = /^offset (\d+)$/m.exec(text)?.[1];
    const flags = /^flags:\s*([A-Z]*)$/m.exec(text)?.[1];
    if (!interpreter || !magic || magic.length % 2 || mask && mask.length !== magic.length || offset === undefined || flags === undefined) return;
    return { interpreter, magic: Buffer.from(magic, 'hex'), mask: mask ? Buffer.from(mask, 'hex') : Buffer.alloc(magic.length / 2, 255),
        offset: Number(offset), flags };
}
/** No ELF loader or DT_NEEDED libraries; static PIE's relocation table is valid. */
function staticElf(bytes: Buffer): boolean {
    if (bytes.length < 52 || bytes.subarray(0, 4).toString('binary') !== '\x7fELF' || ![1, 2].includes(bytes[4]!) || ![1, 2].includes(bytes[5]!)) return false;
    const wide = bytes[4] === 2, little = bytes[5] === 1;
    if (wide && bytes.length < 64) return false;
    const u16 = (at: number) => little ? bytes.readUInt16LE(at) : bytes.readUInt16BE(at);
    const u32 = (at: number) => little ? bytes.readUInt32LE(at) : bytes.readUInt32BE(at);
    const word = (at: number) => wide ? Number(little ? bytes.readBigUInt64LE(at) : bytes.readBigUInt64BE(at)) : u32(at);
    const offset = word(wide ? 32 : 28);
    const size = u16(wide ? 54 : 42), count = u16(wide ? 56 : 44);
    if (!Number.isSafeInteger(offset) || size < (wide ? 56 : 32) || offset + size * count > bytes.length) return false;
    for (let index = 0; index < count; index++) {
        const header = offset + size * index, kind = u32(header);
        if (kind === 3) return false;
        if (kind !== 2) continue;
        const start = word(header + (wide ? 8 : 4)), length = word(header + (wide ? 32 : 16));
        const entrySize = wide ? 16 : 8;
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(length) || start + length > bytes.length || length % entrySize) return false;
        for (let at = start; at < start + length; at += entrySize) {
            const tag = word(at);
            if (tag === 0) break;
            if (tag === 1) return false;
        }
    }
    return true;
}
function escapedBytes(text: string): Buffer | undefined {
    const bytes: number[] = [];
    for (let index = 0; index < text.length; index++) {
        if (text[index] === '\\') {
            const escape = /^\\x([a-fA-F0-9]{2})/.exec(text.slice(index));
            if (!escape) return;
            bytes.push(Number.parseInt(escape[1]!, 16)); index += 3;
        } else bytes.push(text.charCodeAt(index));
    }
    return Buffer.from(bytes);
}
function persistentRules(text: string): Rule[] {
    let durable = false;
    const rules: Rule[] = [];
    for (const raw of text.split('\n')) {
        const line = raw.trim();
        if (line.startsWith('# /')) { durable = /^# \/(?:etc|usr\/lib|usr\/local\/lib)\/binfmt\.d\/[^/]+\.conf$/.test(line); continue; }
        if (!durable || !line || line.startsWith('#') || line.startsWith(';')) continue;
        const parts = line.split(line[0]!);
        if (parts.length !== 8 || parts[2] !== 'M' || !/^\d*$/.test(parts[3]!) || !parts[6]?.startsWith('/')) continue;
        const magic = escapedBytes(parts[4]!), mask = parts[5] ? escapedBytes(parts[5]) : magic ? Buffer.alloc(magic.length, 255) : undefined;
        if (magic && mask) rules.push({ magic, mask, interpreter: parts[6], flags: parts[7]!, offset: Number(parts[3] || 0) });
    }
    return rules;
}

/** Finite read-only demand; scratch holds only the host-authored exit probe. */
export async function observeNativeBinfmt(check: KernelCheck, run: NativeRun): Promise<MachineSetupStepObservationV1> {
    const facts: MachineSetupStepObservationV1['facts'] = { requiredFact: check.capability };
    const result = (status: MachineSetupStepObservationV1['status'], reason?: string): MachineSetupStepObservationV1 => ({
        stepId: check.id, status, facts, ...(reason ? { reason } : {}),
    });
    if (!['binfmt', 'binfmtPersistent'].includes(check.capability) || !check.architectures?.length) return result('unsupported', 'required_fact_unavailable');
    const machine = await run('uname', ['-m'], locale);
    if (machine.errorCode === 'ENOENT') return result('unsupported', 'required_fact_unavailable');
    if (machine.code !== 0 || !/^[a-zA-Z0-9_-]+$/.test(machine.stdout.trim())) return result('unavailable', 'required_fact_unavailable');
    const native = aliases[machine.stdout.trim()] ?? machine.stdout.trim();
    // Prove the boot owner before an absent runtime can become installable drift.
    if (check.capability === 'binfmtPersistent' && check.architectures.some(architecture => architecture !== native)) {
        const service = await run('systemctl', ['show', '--property=LoadState', '--property=UnitFileState', '--', 'systemd-binfmt.service'], locale);
        if (service.errorCode === 'ENOENT') return result('unsupported', 'required_fact_unavailable');
        if (service.code !== 0) return result('unavailable', 'required_fact_unavailable');
        const load = /^LoadState=(.+)$/m.exec(service.stdout)?.[1], state = /^UnitFileState=(.+)$/m.exec(service.stdout)?.[1];
        if (load !== 'loaded' || !state) return result(load === 'not-found' ? 'unsupported' : 'unavailable', 'required_fact_unavailable');
        if (!['static', 'enabled'].includes(state)) return result('unsupported', 'required_fact_unavailable');
    }
    const entries: Array<Record<string, string | boolean>> = [];
    facts.architectures = entries;
    let registry: Array<{ name: string; rule: Rule }> | undefined;
    let durable: Rule[] | undefined;
    let drifted = false;
    for (const architecture of check.architectures) {
        if (architecture === native) { entries.push({ architecture, native: true, executable: true }); continue; }
        const bytes = executable(architecture);
        if (!bytes) { facts.requiredFact = 'architectureProbe'; facts.architecture = architecture; return result('unsupported', 'required_fact_unavailable'); }
        if (!registry) {
            let enabled: string;
            try { enabled = (await readFile(`${root}/status`)).toString('utf8').trim(); }
            catch (error) {
                if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') { entries.push({ architecture, native: false, executable: false }); drifted = true; continue; }
                throw error;
            }
            if (!['enabled', 'disabled'].includes(enabled)) return result('unavailable', 'required_fact_unavailable');
            if (enabled === 'disabled') { entries.push({ architecture, native: false, executable: false }); drifted = true; continue; }
            registry = [];
            for (const name of await readdir(root)) {
                if (name === 'register' || name === 'status') continue;
                const rule = activeRule((await readFile(join(root, name))).toString('utf8'));
                if (rule) registry.push({ name, rule });
            }
        }
        const matching = registry.filter(({ rule }) => matches(rule, bytes));
        const active = matching.find(({ rule }) => rule.flags.includes('F'));
        if (!active) { entries.push({ architecture, native: false, fixBinary: false, executable: false }); drifted = true; continue; }
        const entry = { architecture, native: false, handler: active.name, fixBinary: true,
            staticInterpreter: staticElf(await readFile(active.rule.interpreter)), executable: false };
        entries.push(entry);
        if (!entry.staticInterpreter) { drifted = true; continue; }
        const scratch = await mkdtemp(join(tmpdir(), 'happier-binfmt-check-'));
        try {
            const path = join(scratch, architecture);
            await writeFile(path, bytes, { flag: 'wx', mode: 0o700 });
            const executed = await run(path, [], locale);
            if (executed.code !== 42) return result('unavailable', 'required_fact_unavailable');
            entry.executable = true;
        } finally { await rm(scratch, { recursive: true, force: true }); }
        if (check.capability === 'binfmtPersistent') {
            if (!durable) {
                const configuration = await run('/usr/lib/systemd/systemd-binfmt', ['--cat-config', '--no-pager'], locale);
                if (configuration.errorCode === 'ENOENT') return result('unsupported', 'required_fact_unavailable');
                if (configuration.code !== 0) return result('unavailable', 'required_fact_unavailable');
                durable = persistentRules(configuration.stdout);
            }
            const persistent = durable.some(rule => rule.flags.includes('F') && rule.interpreter === active.rule.interpreter && matches(rule, bytes));
            Object.assign(entry, { persistent });
            if (!persistent) drifted = true;
        }
    }
    return result(drifted ? 'drifted' : 'satisfied');
}
