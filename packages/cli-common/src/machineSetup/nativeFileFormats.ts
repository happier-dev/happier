import { copyFile, cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { MachineSetupEffectError, type MachineRecipeStepV1, type MachineSetupStepObservationV1 } from './index.js';
import type { MachineSetupNativeCommandResult } from './nativeBackend.js';
import type { NativeRun } from './nativeSystemBackend.js';

type FileProbe = NonNullable<Extract<MachineRecipeStepV1, { kind: 'file' }>['probe']>;
type SecurityProbe = Extract<FileProbe, { kind: 'fail2ban' | 'audit' }>;
const locale = { LC_ALL: 'C' };

/** Update owned options in place; leave the administrator's other INI data alone. */
export function renderNativeIniKeys(existing: string, sections: Record<string, Record<string, string>>): string {
    const newline = existing.includes('\r\n') ? '\r\n' : '\n';
    const lines = existing.split(/\r?\n/);
    if (lines.at(-1) === '') lines.pop();
    const remaining = new Map(Object.entries(sections).map(([section, keys]) =>
        [section, new Map(Object.entries(keys).map(([key, value]) => [key.toLowerCase(), { key, value }]))]));
    const result: string[] = [];
    let current: string | undefined;
    const appendMissing = () => {
        if (current === undefined) return;
        const keys = remaining.get(current);
        if (!keys) return;
        for (const { key, value } of keys.values()) result.push(`${key} = ${value}`);
        remaining.delete(current);
    };
    for (const line of lines) {
        const section = /^\s*\[([^\]]+)\]\s*(?:[;#].*)?$/.exec(line);
        if (section) { appendMissing(); current = section[1]!; }
        const option = /^\s*([^\s=:#;][^=:]*?)\s*[=:]/.exec(line);
        const key = option?.[1]?.trim().toLowerCase();
        const requested = current === undefined || key === undefined ? undefined
            : Object.entries(sections[current] ?? {}).find(([name]) => name.toLowerCase() === key);
        if (requested) {
            result.push(`${requested[0]} = ${requested[1]}`);
            remaining.get(current!)?.delete(key!);
        } else result.push(line);
    }
    appendMissing();
    for (const [section, keys] of remaining) {
        if (result.length && result.at(-1) !== '') result.push('');
        result.push(`[${section}]`);
        for (const { key, value } of keys.values()) result.push(`${key} = ${value}`);
    }
    return result.length ? `${result.join(newline)}${newline}` : '';
}

/** Fail2ban owns syntax validation; mirror its complete installed configuration. */
export async function validateNativeFail2banFile(run: NativeRun, candidatePath: string | undefined, targetPath: string): Promise<void> {
    const target = relative('/etc/fail2ban', targetPath);
    // A validator attached to another target must never escape its staging root.
    if (!target || target === '..' || target.startsWith('../') || isAbsolute(target)) throw new MachineSetupEffectError('validation_failed');
    const staging = await mkdtemp(join(tmpdir(), 'happier-fail2ban-check-'));
    try {
        await cp('/etc/fail2ban', staging, { recursive: true, dereference: true });
        const destination = join(staging, target);
        if (candidatePath === undefined) await rm(destination, { force: true });
        else {
            await mkdir(dirname(destination), { recursive: true });
            await copyFile(candidatePath, destination);
        }
        const result = await run('fail2ban-client', ['-t', '-c', staging], locale);
        if (result.errorCode === 'ENOENT') throw new MachineSetupEffectError('required_fact_unavailable');
        if (result.code !== 0) throw new MachineSetupEffectError('validation_failed');
    } finally { await rm(staging, { recursive: true, force: true }); }
}

const observation = (stepId: string, status: MachineSetupStepObservationV1['status'], reason?: string,
    facts: MachineSetupStepObservationV1['facts'] = {}): MachineSetupStepObservationV1 =>
    ({ stepId, status, facts, ...(reason ? { reason } : {}) });
const unavailable = (stepId: string) => observation(stepId, 'unavailable', 'required_fact_unavailable');
function commandFailure(stepId: string, executable: string, result: MachineSetupNativeCommandResult) {
    if (result.code === 0) return undefined;
    if (result.errorCode === 'ENOENT') return observation(stepId, 'unsupported', 'required_fact_unavailable',
        { requiredFact: 'commandExecutable', executable });
    return unavailable(stepId);
}

// Fail2ban 1.1.0 protocol.py and client/beautifier.py: actions and
// actionproperties return a heading followed by comma-separated identities.
function actionList(output: string, heading: string, empty: string): string[] | undefined {
    const value = output.trim();
    if (value === empty) return [];
    if (!value.startsWith(`${heading}\n`)) return undefined;
    return value.slice(heading.length + 1).split(',').map(item => item.trim()).filter(Boolean);
}

async function observeFail2ban(stepId: string, probe: Extract<SecurityProbe, { kind: 'fail2ban' }>, run: NativeRun) {
    for (const [jail, desired] of Object.entries(probe.jails)) {
        for (const [property, expected] of [['maxretry', desired.maxRetry], ['findtime', desired.findTimeSeconds], ['bantime', desired.banTimeSeconds]] as const) {
            const result = await run('fail2ban-client', ['get', jail, property], locale);
            if (result.code !== 0 && `${result.stdout}\n${result.stderr}`.includes(`Sorry but the jail '${jail}' does not exist`)) {
                return observation(stepId, 'drifted');
            }
            const failure = commandFailure(stepId, 'fail2ban-client', result);
            if (failure) return failure;
            if (!/^\d+$/.test(result.stdout.trim())) return unavailable(stepId);
            if (Number(result.stdout.trim()) !== expected) return observation(stepId, 'drifted');
        }
        if (desired.port === undefined) continue;
        const result = await run('fail2ban-client', ['get', jail, 'actions'], locale);
        const failure = commandFailure(stepId, 'fail2ban-client', result);
        if (failure) return failure;
        const actions = actionList(result.stdout, `The jail ${jail} has the following actions:`, `No actions for jail ${jail}`);
        if (!actions) return unavailable(stepId);
        let hasPort = false;
        for (const action of actions) {
            const propertiesResult = await run('fail2ban-client', ['get', jail, 'actionproperties', action], locale);
            const propertyFailure = commandFailure(stepId, 'fail2ban-client', propertiesResult);
            if (propertyFailure) return propertyFailure;
            const properties = actionList(propertiesResult.stdout, `The jail ${jail} action ${action} has the following properties:`,
                `No properties for jail ${jail} action ${action}`);
            if (!properties) return unavailable(stepId);
            if (!properties.includes('port')) continue;
            hasPort = true;
            const port = await run('fail2ban-client', ['get', jail, 'action', action, 'port'], locale);
            const portFailure = commandFailure(stepId, 'fail2ban-client', port);
            if (portFailure) return portFailure;
            if (port.stdout.trim() !== String(desired.port)) return observation(stepId, 'drifted');
        }
        if (!hasPort) return observation(stepId, 'drifted');
    }
    return observation(stepId, 'satisfied');
}

/** auditctl lists watch rules with either -k KEY or -F key=KEY. */
function auditWatchIdentity(rule: string): string | undefined {
    const parts = rule.trim().split(/\s+/);
    let path: string | undefined, permissions: string | undefined, key: string | undefined;
    for (let index = 0; index < parts.length; index += 2) {
        const flag = parts[index], value = parts[index + 1];
        if (value === undefined) return undefined;
        if (flag === '-w' && path === undefined) path = value;
        else if (flag === '-p' && permissions === undefined && /^[rwxa]+$/.test(value)) permissions = [...new Set(value)].sort().join('');
        else if (flag === '-k' && key === undefined) key = value;
        else if (flag === '-F' && value.startsWith('key=') && key === undefined) key = value.slice(4);
        else return undefined;
    }
    return path && permissions && key ? JSON.stringify([path, permissions, key]) : undefined;
}

async function observeAudit(stepId: string, probe: Extract<SecurityProbe, { kind: 'audit' }>, run: NativeRun) {
    if (probe.state !== 'absent') {
        const result = await run('auditctl', ['-s'], locale);
        const failure = commandFailure(stepId, 'auditctl', result);
        if (failure) return failure;
        const enabled = /^enabled\s+([012])\s*$/m.exec(result.stdout)?.[1];
        if (enabled === undefined) return unavailable(stepId);
        if (enabled === '0') return observation(stepId, 'drifted');
    }
    const result = await run('auditctl', ['-l'], locale);
    const failure = commandFailure(stepId, 'auditctl', result);
    if (failure) return failure;
    const lines = result.stdout.split(/\r?\n/);
    if (probe.state !== 'absent' && lines.some(line => /^\s*-[aA]\s+(?:never,task|task,never)(?:\s|$)/.test(line))) {
        return observation(stepId, 'unavailable', 'foreign_effect_conflict');
    }
    const loaded = new Set(lines.map(auditWatchIdentity).filter(identity => identity !== undefined));
    for (const rule of probe.rules) {
        const identity = auditWatchIdentity(rule);
        if (identity === undefined) return unavailable(stepId);
        if (loaded.has(identity) === (probe.state === 'absent')) return observation(stepId, 'drifted');
    }
    return observation(stepId, 'satisfied');
}

export async function observeNativeFileProbe(stepId: string, probe: SecurityProbe, run: NativeRun): Promise<MachineSetupStepObservationV1> {
    return probe.kind === 'audit' ? observeAudit(stepId, probe, run) : observeFail2ban(stepId, probe, run);
}
