import { chmod, chown, lstat, mkdir, readFile, readlink, rmdir, unlink } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import type { MachineFirewallRecoveryV1 } from '@happier-dev/protocol/machines/adminAccessV1';
import { MachineSetupEffectError, type MachineRecipeStepV1, type MachineSetupStepObservationV1, type MachineSetupNativeStageV1 } from './index.js';
import type { NativeRun } from './nativeSystemBackend.js';
import { nativeSocketSshReader } from './nativeFirewallSshSockets.js';
import { observeNativeCaddyFirewallBindings, readCaddyContainerFirewallExposures } from './nativeCaddy.js';
import { nativeFirewallTransitionObservationStepId, readNativeFirewallPrivateWorkloads, replaceNativeFirewallPrivateWorkloads } from './nativeFirewallWorkloads.js';
import type { MachineFirewallPrivateWorkloadBindingsV1 } from '@happier-dev/protocol/machines/setup/machineFirewallV1';
import { activateNativeFile, assertProtectedNativeTarget, inspectNativeAncestors, inspectNativePath, isMissingNativeFile,
    nativeFileDigest, type NativeFileState } from './nativeFileSafety.js';

type Firewall = Extract<MachineRecipeStepV1, { kind: 'firewall' }>;
const rulesPath = '/etc/happier/firewall/rules.nft';
const unitPath = '/etc/systemd/system/happier-firewall.service';
const nft = '/usr/sbin/nft';
const unit = 'happier-firewall.service';
export const nativeFirewallUnit = '[Unit]\nDescription=Happier owned firewall\nAfter=network-pre.target docker.service\n\n[Service]\nType=oneshot\nRemainAfterExit=yes\nExecStart=/usr/sbin/nft -f /etc/happier/firewall/rules.nft\n\n[Install]\nWantedBy=multi-user.target\n';
const rootOwner = { uid: 0, gid: 0 };
const locale = { LC_ALL: 'C' };
const tableReplacementPrefix = 'table inet happier\ndelete table inet happier\n';

/** A confinement check, not an nft parser: native nft owns syntax/semantics.
 * There is one top-level owned-table transaction, no include/variable/command
 * escape. Quoted strings/comments cannot open or close a native block. */
function confinedTable(value: string): string {
    if (/[\r\0]/.test(value)) throw new MachineSetupEffectError('validation_failed');
    const table = value.startsWith(tableReplacementPrefix) ? value.slice(tableReplacementPrefix.length) : value;
    let lexical = '', quoted = false, escaped = false, comment = false, depth = 0, closed = false;
    for (const char of table) {
        if (comment) { if (char === '\n') { comment = false; lexical += '\n'; } continue; }
        if (quoted) {
            if (escaped) escaped = false;
            else if (char === '\\') escaped = true;
            else if (char === '"') quoted = false;
            continue;
        }
        if (char === '#') { comment = true; continue; }
        if (closed && !/\s/.test(char)) throw new MachineSetupEffectError('validation_failed');
        if (char === '"') { quoted = true; lexical += '""'; continue; }
        if (char === '\\') throw new MachineSetupEffectError('validation_failed');
        if (char === '{') depth++;
        if (char === '}') { if (--depth < 0) throw new MachineSetupEffectError('validation_failed'); if (depth === 0) closed = true; }
        lexical += char;
    }
    if (quoted || depth !== 0 || !closed || !/^\s*table\s+inet\s+happier\s*\{/.test(lexical)) throw new MachineSetupEffectError('validation_failed');
    const body = lexical.replace(/^\s*table\s+inet\s+happier\s*\{/, '');
    if (/\b(?:include|define|undefine|import|export|flush|add|create|delete|replace|insert|destroy|reset|monitor|list|table)\b/.test(body)) {
        throw new MachineSetupEffectError('validation_failed');
    }
    return table;
}
function candidateRules(value: string) {
    if (!value.startsWith(tableReplacementPrefix)) throw new MachineSetupEffectError('validation_failed');
    confinedTable(value);
    return value;
}
/** Native list output is compared conservatively; a different canonical form
 * is drift, never a green claim inferred from mere table existence. */
function equivalentTable(left: string, right: string) {
    const tokens = (value: string) => {
        const table = confinedTable(value);
        let result = '', ordinary = '', quoted = false, escaped = false, comment = false;
        const flush = () => { result += ordinary.replace(/priorityfilter-10/g, 'priority-10'); ordinary = ''; };
        for (const char of table) {
            if (comment) { if (char === '\n') comment = false; continue; }
            if (quoted) {
                result += char;
                if (escaped) escaped = false;
                else if (char === '\\') escaped = true;
                else if (char === '"') quoted = false;
            } else if (char === '#') comment = true;
            else if (char === '"') { flush(); quoted = true; result += char; }
            else if (!/[\s;]/.test(char)) ordinary += char;
        }
        flush(); return result;
    };
    return tokens(left) === tokens(right);
}
type Boot = Readonly<{ present: boolean; enabled: boolean; running: boolean }>;
type Snapshot = Readonly<{ rules: NativeFileState; unit: NativeFileState; table: string | null; boot: Boot }>;
const absentFirewall: Snapshot = {
    rules: { kind: 'absent' }, unit: { kind: 'absent' }, table: null,
    boot: { present: false, enabled: false, running: false },
};
function firewallAbsent(state: Snapshot): boolean {
    return state.rules.kind === 'absent' && state.unit.kind === 'absent' && state.table === null && !state.boot.present;
}
type PrivateInterface = { providerId: string; networkIdentity: string; hostAddress: string; interfaceName: string };
type SshEndpoint = { interfaceName: string; hostAddress: string; port: number; sourceCidrs: string[] };
/** An optional observation, not another native readiness or admission gate. */
export type MachineSetupFirewallTransitionFactsV1 = Readonly<{
    status: 'available'; externalInterfaces: string[]; privateInterfaces: PrivateInterface[]; retainedSshEndpoints: SshEndpoint[];
    privateWorkloadBindings?: MachineFirewallPrivateWorkloadBindingsV1[];
}> | Readonly<{ status: 'unavailable'; requiredFact: string }>;
type RestoreStep = Readonly<
    { kind: 'file'; path: string; state: NativeFileState; mode: number }
    | { kind: 'command'; executable: string; args: string[]; when?: 'unitCreated' | 'tablePresent'; input?: string }
>;
const quoteShell = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
/** The one ordered restoration program, shared by native undo and the recovery card. */
function restoreSteps(state: Snapshot): RestoreStep[] {
    const command = (executable: string, args: string[], when?: 'unitCreated' | 'tablePresent'): RestoreStep =>
        ({ kind: 'command', executable, args, ...(when ? { when } : {}) });
    // A drifted live policy is separate from the saved boot artifact. Restore
    // it after systemd so a service start cannot replace it with the boot rules.
    const liveRules = state.table !== null && state.rules.kind === 'file' && !equivalentTable(state.table, state.rules.bytes!.toString('utf8'))
        ? tableReplacementPrefix + confinedTable(state.table) : undefined;
    return [
        ...(state.unit.kind === 'absent' ? [command('systemctl', ['stop', '--', unit], 'unitCreated'),
            command('systemctl', ['disable', '--', unit], 'unitCreated')] : []),
        { kind: 'file', path: rulesPath, state: state.rules, mode: 0o600 },
        { kind: 'file', path: unitPath, state: state.unit, mode: 0o644 },
        ...(state.table === null ? [command(nft, ['delete', 'table', 'inet', 'happier'], 'tablePresent')]
            : liveRules === undefined ? [command(nft, ['-f', rulesPath])] : []),
        command('systemctl', ['daemon-reload']),
        ...(state.unit.kind !== 'absent' ? [command('systemctl', [state.boot.enabled ? 'enable' : 'disable', '--', unit])] : []),
        ...(state.boot.running ? [command('systemctl', ['start', '--', unit])]
            : state.unit.kind !== 'absent' ? [command('systemctl', ['stop', '--', unit])] : []),
        ...(liveRules === undefined ? [] : [{ kind: 'command' as const, executable: nft, args: ['-f', '-'], input: liveRules }]),
    ];
}
function restoreCommand(step: RestoreStep): string {
    if (step.kind === 'file') {
        if (step.state.kind === 'absent') return `rm -f -- ${quoteShell(step.path)}`;
        if (step.state.kind !== 'file') throw new MachineSetupEffectError('foreign_effect_conflict');
        return `printf '%s' ${quoteShell(step.state.bytes!.toString('utf8'))} > ${quoteShell(step.path)}\nchown 0:0 ${quoteShell(step.path)}\nchmod ${step.mode.toString(8)} ${quoteShell(step.path)}`;
    }
    const command = [step.executable, ...step.args].map(quoteShell).join(' ');
    if (step.when === 'unitCreated') return `if test -f ${quoteShell(unitPath)}; then ${command}; fi`;
    if (step.when === 'tablePresent') return `if ${quoteShell(nft)} list table inet happier >/dev/null 2>&1; then ${command}; fi`;
    if (step.input !== undefined) return `printf '%s' ${quoteShell(step.input)} | ${command}`;
    return command;
}
function recoveryData(state: Snapshot, steps: readonly RestoreStep[]): MachineFirewallRecoveryV1 {
    const file = (value: NativeFileState): MachineFirewallRecoveryV1['rules'] => {
        if (value.kind === 'absent') return { kind: 'absent' };
        if (value.kind !== 'file') throw new MachineSetupEffectError('foreign_effect_conflict');
        return { kind: 'file', content: value.bytes!.toString('utf8') };
    };
    return { rules: file(state.rules), unit: file(state.unit), table: state.table, boot: state.boot,
        restore: { capturedAt: new Date().toISOString(), commands: ['set -e', ...steps.map(restoreCommand)] } };
}
function record(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function normalizedIp(address: string): string | null {
    if (isIP(address) === 4) return address;
    return isIP(address) === 6 && !address.includes('%') ? new URL(`http://[${address}]`).hostname : null;
}
/** Only the native owner's supported input-policy vocabulary is proved here.
 * Unknown expressions/jumps are unavailable, never a guessed inverse policy.
 * Source-restricted deny/subtraction is intentionally not approximated. */
function retainedSources(value: unknown, endpoint: Omit<SshEndpoint, 'sourceCidrs'>): string[] | null {
    const items = record(value)?.nftables;
    if (!Array.isArray(items)) return null;
    const chains = items.map(item => record(record(item)?.chain)).filter(chain => chain?.hook === 'input');
    const chain = chains.length === 1 ? chains[0] : undefined;
    if (!chain || chain.family !== 'inet' || chain.table !== 'happier' || chain.type !== 'filter'
        || typeof chain.name !== 'string' || !['accept', 'drop'].includes(String(chain.policy))) return null;
    const family = isIP(endpoint.hostAddress), anySource = family === 4 ? '0.0.0.0/0' : '::/0';
    const sources: string[] = [];
    const matches = (actual: string | number, expected: unknown): boolean | null => {
        if (typeof expected === 'string' || typeof expected === 'number') return actual === expected;
        // libnftables emits list expressions as bare arrays (including ct state).
        const set = Array.isArray(expected) ? expected : record(expected)?.set;
        return Array.isArray(set) && set.every(item => typeof item === typeof actual) ? set.includes(actual) : null;
    };
    for (const item of items) {
        const rule = record(record(item)?.rule);
        if (!rule || rule.chain !== chain.name) continue;
        if (rule.family !== 'inet' || rule.table !== 'happier' || !Array.isArray(rule.expr)) return null;
        let applies = true, destinationDependent = false, source: string | undefined, verdict: 'accept' | 'drop' | undefined;
        for (const raw of rule.expr) {
            const expr = record(raw);
            if (!expr || Object.keys(expr).length !== 1 || verdict) return null;
            if ('counter' in expr) continue;
            if ('accept' in expr || 'drop' in expr) { verdict = 'accept' in expr ? 'accept' : 'drop'; continue; }
            const match = record(expr.match), left = record(match?.left);
            if (!match || !left || !['==', 'in'].includes(String(match.op))) return null;
            const meta = record(left.meta), payload = record(left.payload), ct = record(left.ct);
            let matched: boolean | null = null;
            if (meta?.key === 'iifname') matched = matches(endpoint.interfaceName, match.right);
            else if (meta?.key === 'nfproto') matched = matches(family === 4 ? 'ipv4' : 'ipv6', match.right);
            else if (meta?.key === 'l4proto') matched = matches('tcp', match.right);
            else if (ct?.key === 'state') matched = matches('new', match.right);
            else if (payload?.protocol === 'tcp' && payload.field === 'dport') matched = matches(endpoint.port, match.right);
            else if (payload?.protocol === 'udp' && payload.field === 'dport') matched = false;
            else if (['ip', 'ip6'].includes(String(payload?.protocol)) && ['saddr', 'daddr'].includes(String(payload?.field))) {
                if ((payload!.protocol === 'ip' ? 4 : 6) !== family) matched = false;
                else if (payload!.field === 'saddr') {
                    const prefix = record(record(match.right)?.prefix);
                    const address = prefix?.addr ?? match.right;
                    const length = prefix?.len ?? (family === 4 ? 32 : 128);
                    if (typeof address !== 'string' || isIP(address) !== family || !Number.isInteger(length)
                        || Number(length) < 0 || Number(length) > (family === 4 ? 32 : 128)) return null;
                    const cidr = `${address}/${length}`;
                    if (source && source !== cidr) return null;
                    source = cidr; matched = true;
                } else {
                    // A wildcard socket's destination-dependent policy cannot
                    // be collapsed to one source scope without broadening it.
                    if (endpoint.hostAddress === '0.0.0.0' || endpoint.hostAddress === '::') {
                        destinationDependent = true; matched = true;
                    } else matched = typeof match.right === 'string' ? normalizedIp(endpoint.hostAddress) === normalizedIp(match.right) : null;
                }
            }
            if (matched === null) return null;
            applies &&= matched;
        }
        if (!applies) continue;
        if (destinationDependent) return null;
        if (!verdict) return null;
        if (verdict === 'drop') return source ? null : [...new Set(sources)];
        if (!source) return [anySource];
        sources.push(source);
    }
    return chain.policy === 'accept' ? [anySource] : [...new Set(sources)];
}

export function createNativeFirewallBackend(run: NativeRun, recover: NativeRun, signal?: AbortSignal) {
    const effect = async (invoke: NativeRun, executable: string, args: readonly string[], input?: string) => {
        if ((await invoke(executable, args, locale, input === undefined ? undefined : Buffer.from(input))).code !== 0) {
            throw new MachineSetupEffectError('native_effect_failed');
        }
    };
    const boot = async (invoke = run): Promise<Boot> => {
        const result = await invoke('systemctl', ['show', '--property=LoadState', '--property=UnitFileState', '--property=ActiveState', '--', unit], locale);
        const fields = Object.fromEntries(result.stdout.trim().split('\n').map(line => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)]; }));
        if (result.code !== 0) throw new MachineSetupEffectError('required_fact_unavailable');
        if (fields.LoadState === 'not-found') return { present: false, enabled: false, running: false };
        if (fields.LoadState !== 'loaded' || !['enabled', 'disabled'].includes(fields.UnitFileState ?? '')
            || !['active', 'inactive', 'failed'].includes(fields.ActiveState ?? '')) throw new MachineSetupEffectError('required_fact_unavailable');
        return { present: true, enabled: fields.UnitFileState === 'enabled', running: fields.ActiveState === 'active' };
    };
    const table = async (invoke = run): Promise<string | null> => {
        const catalog = await invoke(nft, ['-j', 'list', 'tables'], locale);
        if (catalog.code !== 0) throw new MachineSetupEffectError('required_fact_unavailable');
        const value: unknown = JSON.parse(catalog.stdout);
        if (!value || typeof value !== 'object' || !('nftables' in value) || !Array.isArray(value.nftables)) throw new MachineSetupEffectError('required_fact_unavailable');
        const found = value.nftables.some((entry: unknown) => entry !== null && typeof entry === 'object' && 'table' in entry
            && entry.table !== null && typeof entry.table === 'object' && 'family' in entry.table && entry.table.family === 'inet'
            && 'name' in entry.table && entry.table.name === 'happier');
        if (!found) return null;
        // Compare the same symbolic vocabulary as the owned rules file.
        // Numeric output also rewrites ct state/direction and protocol names.
        const result = await invoke(nft, ['-s', 'list', 'table', 'inet', 'happier'], locale);
        if (result.code !== 0) throw new MachineSetupEffectError('required_fact_unavailable');
        confinedTable(result.stdout);
        return result.stdout;
    };
    const inspect = async (step: Firewall, invoke = run): Promise<Snapshot> => {
        candidateRules(step.rules);
        await assertProtectedNativeTarget(nft, 0, true);
        await assertProtectedNativeTarget(rulesPath, 0o600);
        await assertProtectedNativeTarget(unitPath, 0o644);
        const init = (await readFile('/proc/1/comm', 'utf8')).trim();
        if (init !== 'systemd') throw new MachineSetupEffectError('required_fact_unavailable');
        const [rules, definition, nativeTable, service] = await Promise.all([
            inspectNativePath(rulesPath, false, true), inspectNativePath(unitPath, false, true), table(invoke), boot(invoke),
        ]);
        if (rules.kind === 'file') candidateRules(rules.bytes!.toString('utf8'));
        if (definition.kind === 'file' ? definition.bytes!.toString('utf8') !== nativeFirewallUnit : service.present) {
            throw new MachineSetupEffectError('foreign_effect_conflict');
        }
        // Recipe replacement owns drift when both protected artifacts identify
        // the table. Removal and live Network transition planning require the
        // installed policy to match its rules file.
        if (nativeTable) {
            if (rules.kind !== 'file') throw new MachineSetupEffectError('foreign_effect_conflict');
            if ((step.operation === 'remove' || step.id === nativeFirewallTransitionObservationStepId || definition.kind !== 'file')
                && !equivalentTable(nativeTable, rules.bytes!.toString('utf8'))) {
                throw new MachineSetupEffectError('foreign_effect_conflict');
            }
        }
        if (step.operation === 'remove' && (rules.kind === 'file'
            ? rules.bytes!.toString('utf8') !== step.rules
            : definition.kind !== 'absent' || service.present)) throw new MachineSetupEffectError('foreign_effect_conflict');
        return { rules, unit: definition, table: nativeTable, boot: service };
    };
    const available = async () => {
        await assertProtectedNativeTarget(nft, 0, true);
        const version = await run(nft, ['--version'], locale);
        if (version.errorCode === 'ENOENT') return false;
        if (version.code !== 0) throw new MachineSetupEffectError('required_fact_unavailable');
        return true;
    };
    const satisfied = (step: Firewall, state: Snapshot) => step.operation === 'remove' ? firewallAbsent(state)
        : state.rules.kind === 'file' && state.rules.bytes!.toString('utf8') === step.rules
        && state.unit.kind === 'file' && state.unit.bytes!.toString('utf8') === nativeFirewallUnit
        && state.table !== null && equivalentTable(state.table, step.rules) && state.boot.enabled && state.boot.running;
    const transitionFacts = async (step: Firewall, state: Snapshot): Promise<{
        fact: MachineSetupFirewallTransitionFactsV1; privateScopeAvailable: boolean;
    }> => {
        let requiredFact = 'kernelRoutes';
        let privateScopeAvailable = !step.exposures?.some(exposure => exposure.exposure === 'privateNetwork');
        const output = async (executable: string, args: readonly string[]) => {
            const result = await run(executable, args, locale);
            if (result.code !== 0) throw new MachineSetupEffectError('required_fact_unavailable');
            return result.stdout;
        };
        try {
            requiredFact = 'privateWorkloadBindings';
            const privateWorkloadBindings = state.rules.kind === 'file'
                ? readNativeFirewallPrivateWorkloads(state.rules.bytes!.toString('utf8')) : [];
            // Only the CHECK-only discovery step selects one Environment over
            // retained policy. Materialized steps already declare their complete
            // desired exposures; withdrawn addresses must not be resurrected.
            const selectedWorkloads = step.id === nativeFirewallTransitionObservationStepId
                ? readNativeFirewallPrivateWorkloads(step.rules).reduce(
                    (retained, selected) => replaceNativeFirewallPrivateWorkloads(retained, selected), privateWorkloadBindings)
                : [];
            const exposures = [...(step.exposures ?? []), ...selectedWorkloads.flatMap(item => item.bindings.map(binding => binding.exposure))];
            privateScopeAvailable = !exposures.some(exposure => exposure.exposure === 'privateNetwork');
            requiredFact = 'kernelRoutes';
            const routes = await Promise.all(['-4', '-6'].map(async family => {
                const value: unknown = JSON.parse(await output('ip', ['-j', family, 'route', 'show', 'default']));
                if (!Array.isArray(value)) throw new MachineSetupEffectError('required_fact_unavailable');
                return value.flatMap(raw => {
                    const route = record(raw);
                    const hops = route?.nexthops;
                    const devices = Array.isArray(hops) ? hops.map((hop: unknown) => record(hop)?.dev) : [route?.dev];
                    if (route?.dst !== 'default' || !devices.length || devices.some(device => typeof device !== 'string' || !device)) {
                        throw new MachineSetupEffectError('required_fact_unavailable');
                    }
                    return devices as string[];
                });
            }));
            const externalInterfaces = [...new Set(routes.flat())];
            requiredFact = 'kernelInterfaceAddresses';
            const interfaces = networkInterfaces();
            if (externalInterfaces.some(name => !interfaces[name]?.length)) throw new MachineSetupEffectError('required_fact_unavailable');
            requiredFact = 'privateInterfaces';
            const privateInterfaces: PrivateInterface[] = [];
            for (const exposure of exposures) {
                if (exposure.exposure !== 'privateNetwork') continue;
                const address = normalizedIp(exposure.hostAddress);
                const names = Object.entries(interfaces).filter(([, entries]) => entries?.some(entry =>
                    !entry.internal && address !== null && normalizedIp(entry.address) === address)).map(([name]) => name);
                if (['0.0.0.0', '::'].includes(exposure.hostAddress) || names.length !== 1 || externalInterfaces.includes(names[0]!)
                    || !exposure.providerId || !exposure.networkIdentity) throw new MachineSetupEffectError('required_fact_unavailable');
                const found = { providerId: exposure.providerId, networkIdentity: exposure.networkIdentity,
                    hostAddress: exposure.hostAddress, interfaceName: names[0]! };
                if (!privateInterfaces.some(item => JSON.stringify(item) === JSON.stringify(found))) privateInterfaces.push(found);
            }
            privateScopeAvailable = true;
            requiredFact = 'sshListeners';
            const retainedSshEndpoints: SshEndpoint[] = [];
            const executablePaths = new Map<number, string>();
            const socketSsh = nativeSocketSshReader(output);
            for (const family of [4, 6]) {
                const sockets = await output('ss', [`-${family}`, '-H', '-ltnp']);
                for (const line of sockets.split('\n').filter(value => value.trim())) {
                    const columns = line.trim().split(/\s+/);
                    if (columns[0] !== 'LISTEN' || columns.length < 6) throw new MachineSetupEffectError('required_fact_unavailable');
                    const owners = [...line.matchAll(/\("[^"]+",pid=(\d+),fd=\d+\)/g)].map(match => Number(match[1]));
                    if (!owners.length) throw new MachineSetupEffectError('required_fact_unavailable');
                    let ssh = false;
                    for (const pid of owners) {
                        let executable = executablePaths.get(pid);
                        if (!executable) {
                            executable = await readlink(`/proc/${pid}/exe`);
                            if (basename(executable.replace(/ \(deleted\)$/, '')) === 'sshd'
                                || pid === 1 && basename(executable) === 'systemd') {
                                // A name alone is not a system SSH identity.
                                // Reuse the native executable owner; the sshd
                                // process itself may legitimately be non-root.
                                requiredFact = 'sshExecutableIdentity';
                                await assertProtectedNativeTarget(executable, 0, true);
                                requiredFact = 'sshListeners';
                            }
                            executablePaths.set(pid, executable);
                        }
                        if (basename(executable.replace(/ \(deleted\)$/, '')) === 'sshd') ssh = true;
                        else if (pid === 1 && basename(executable) === 'systemd') {
                            if (await socketSsh(columns[3]!)) ssh = true;
                        }
                    }
                    if (!ssh) continue;
                    const local = columns[3]!, colon = local.lastIndexOf(':');
                    const rawAddress = local.slice(0, colon).replace(/^\[|\]$/g, '');
                    const hostAddress = rawAddress === '*' ? family === 4 ? '0.0.0.0' : '::' : rawAddress;
                    const port = Number(local.slice(colon + 1));
                    if (colon < 1 || hostAddress.includes('%') || isIP(hostAddress) !== family || !Number.isInteger(port) || port < 1 || port > 65535) {
                        throw new MachineSetupEffectError('required_fact_unavailable');
                    }
                    const wildcard = hostAddress === '0.0.0.0' || hostAddress === '::';
                    const boundInterfaces = wildcard ? Object.entries(interfaces).filter(([, entries]) =>
                        entries?.some(entry => !entry.internal && isIP(entry.address) === family)).map(([name]) => name)
                        : Object.entries(interfaces).filter(([, entries]) =>
                        entries?.some(entry => normalizedIp(entry.address) === normalizedIp(hostAddress))).map(([name]) => name);
                    if (!wildcard && boundInterfaces.length !== 1) throw new MachineSetupEffectError('required_fact_unavailable');
                    for (const interfaceName of boundInterfaces) {
                        if (!interfaces[interfaceName]?.some(entry =>
                            !entry.internal && isIP(entry.address) === family)) continue;
                        if (!retainedSshEndpoints.some(item => item.interfaceName === interfaceName && item.hostAddress === hostAddress && item.port === port)) {
                            retainedSshEndpoints.push({ interfaceName, hostAddress, port, sourceCidrs: [family === 4 ? '0.0.0.0/0' : '::/0'] });
                        }
                    }
                }
            }
            if (state.table !== null && retainedSshEndpoints.length) {
                requiredFact = 'retainedSshPolicy';
                const policy: unknown = JSON.parse(await output(nft, ['-j', 'list', 'table', 'inet', 'happier']));
                for (const endpoint of retainedSshEndpoints) {
                    const sources = retainedSources(policy, endpoint);
                    if (sources === null) throw new MachineSetupEffectError('required_fact_unavailable');
                    endpoint.sourceCidrs = sources;
                }
            }
            return { fact: { status: 'available', externalInterfaces, privateInterfaces, retainedSshEndpoints,
                ...(privateWorkloadBindings.length ? { privateWorkloadBindings } : {}) }, privateScopeAvailable };
        } catch (error) {
            if (signal?.aborted) throw error;
            return { fact: { status: 'unavailable', requiredFact }, privateScopeAvailable };
        }
    };
    const observe = async (step: Firewall): Promise<MachineSetupStepObservationV1> => {
        try {
            candidateRules(step.rules);
            if (!await available()) return { stepId: step.id, status: 'unsupported', reason: 'required_fact_unavailable', facts: { requiredFact: 'systemNft' } };
            const caddy = step.caddyObservation ? await observeNativeCaddyFirewallBindings(step.caddyObservation, {
                run: command => run(command.executable, command.args, command.env), signal,
            }) : undefined;
            if (caddy?.status === 'unavailable') return { stepId: step.id, status: 'unavailable',
                reason: 'required_fact_unavailable', facts: { firewallTransition: { status: 'unavailable',
                    requiredFact: caddy.details?.requiredFact ?? 'caddyFirewall',
                    ...(caddy.details ? { remedy: caddy.details.remedy } : {}), caddy } } };
            const observedStep = caddy?.status === 'ready' ? { ...step,
                exposures: [...(step.exposures ?? []), ...readCaddyContainerFirewallExposures(caddy.bindings)] } : step;
            const state = await inspect(observedStep);
            if (step.operation === 'remove') return { stepId: step.id, status: satisfied(step, state) ? 'satisfied' : 'drifted', facts: {} };
            const transition = await transitionFacts(observedStep, state);
            return { stepId: step.id, status: transition.privateScopeAvailable ? satisfied(step, state) ? 'satisfied' : 'drifted' : 'unavailable',
                ...(!transition.privateScopeAvailable ? { reason: 'required_fact_unavailable' as const } : {}), facts: {
                rulesDigest: state.rules.kind === 'file' ? state.rules.digest! : null,
                unitDigest: state.unit.kind === 'file' ? state.unit.digest! : null,
                ownedTableDigest: state.table === null ? null : nativeFileDigest(state.table),
                bootEnabled: state.boot.enabled, bootActive: state.boot.running,
                firewallTransition: { ...transition.fact, ...(caddy ? { caddy } : {}) },
            } };
        } catch (error) {
            if (signal?.aborted) throw error;
            return { stepId: step.id, status: isMissingNativeFile(error) ? 'unsupported' : 'unavailable',
                reason: error instanceof MachineSetupEffectError ? error.reasonCode : 'required_fact_unavailable', facts: {} };
        }
    };
    const stage = async (step: Firewall): Promise<MachineSetupNativeStageV1> => {
        candidateRules(step.rules);
        if (!await available()) throw new MachineSetupEffectError('required_fact_unavailable');
        const previous = await inspect(step);
        const restoration = restoreSteps(previous);
        const recovery = recoveryData(previous, restoration);
        if (satisfied(step, previous)) return {
            recovery,
            verify: async () => !signal?.aborted && satisfied(step, await inspect(step)),
            commit() {},
            async undo() {
                // A later constructor may have changed native state and then
                // failed its own undo before it could return a stage handle.
                // Resolve only when THIS captured original state is proved;
                // recovery must not inherit forward-operation cancellation.
                if (!satisfied(step, await inspect(step, recover))) throw new MachineSetupEffectError('required_fact_unavailable');
            },
        };
        const created: string[] = [];
        let settled = false, mutationPossible = false;
        const ensureDirectory = async (path: string): Promise<void> => {
            await inspectNativeAncestors(path, true);
            try { const stat = await lstat(path); if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o022)) throw new MachineSetupEffectError('foreign_effect_conflict'); }
            catch (error) {
                if (!isMissingNativeFile(error)) throw error;
                await ensureDirectory(dirname(path)); await mkdir(path, { mode: 0o755 }); await chown(path, 0, 0); await chmod(path, 0o755); created.push(path);
            }
        };
        const restore = async (path: string, state: NativeFileState, mode: number) => {
            await assertProtectedNativeTarget(path, mode);
            const current = await inspectNativePath(path, false, true);
            const stagedBytes = path === rulesPath ? step.rules : nativeFirewallUnit;
            if (current.kind === 'file' && current.bytes!.toString('utf8') !== stagedBytes
                && (state.kind !== 'file' || !current.bytes!.equals(state.bytes!))) throw new MachineSetupEffectError('foreign_effect_conflict');
            if (state.kind === 'absent') { if (current.kind !== 'absent') await unlink(path); }
            else if (state.kind === 'file') await activateNativeFile({ path, bytes: state.bytes!, mode, owner: rootOwner,
                previous: current, protectedTarget: true });
            else throw new MachineSetupEffectError('foreign_effect_conflict');
        };
        const runRestoration = async (target: Snapshot, operations: readonly RestoreStep[], invoke: typeof run) => {
            const currentUnit = await inspectNativePath(unitPath, false, true);
            const unitCreated = target.unit.kind === 'absent' && currentUnit.kind === 'file';
            if (unitCreated && currentUnit.bytes!.toString('utf8') !== nativeFirewallUnit) throw new MachineSetupEffectError('foreign_effect_conflict');
            for (const operation of operations) {
                if (operation.kind === 'file') await restore(operation.path, operation.state, operation.mode);
                else {
                    if (operation.when === 'unitCreated' && !unitCreated) continue;
                    if (operation.when === 'tablePresent' && !await table(invoke)) continue;
                    await effect(invoke, operation.executable, operation.args, operation.input);
                }
            }
        };
        const undo = async () => {
            if (settled) return;
            if (!mutationPossible) {
                for (const path of created.reverse()) await rmdir(path);
                settled = true;
                return;
            }
            // Recovery stays in this same invocation and native owner, but must
            // not inherit the already-aborted forward-effect signal.
            await assertProtectedNativeTarget(nft, 0, true);
            const currentTable = await table(recover);
            if (currentTable !== null && !equivalentTable(currentTable, step.rules)
                && (previous.table === null || !equivalentTable(currentTable, previous.table))) {
                throw new MachineSetupEffectError('foreign_effect_conflict');
            }
            await runRestoration(previous, restoration, recover);
            const restoredTable = await table(recover), restoredBoot = await boot(recover);
            if ((previous.table === null) !== (restoredTable === null) || previous.table !== null && restoredTable !== null && !equivalentTable(previous.table, restoredTable)
                || restoredBoot.enabled !== previous.boot.enabled || restoredBoot.running !== previous.boot.running) throw new MachineSetupEffectError('required_fact_unavailable');
            for (const path of created.reverse()) await rmdir(path);
            settled = true;
        };
        try {
            if (step.operation === 'remove') {
                mutationPossible = true;
                await runRestoration(absentFirewall, restoreSteps(absentFirewall), run);
            } else {
                await ensureDirectory(dirname(rulesPath)); await ensureDirectory(dirname(unitPath));
                await activateNativeFile({ path: rulesPath, bytes: step.rules, mode: 0o600, owner: rootOwner, previous: previous.rules,
                    protectedTarget: true, signal, validate: async candidate => {
                        if ((await run(nft, ['-c', '-f', candidate], locale)).code !== 0) throw new MachineSetupEffectError('validation_failed');
                        mutationPossible = true;
                        await effect(run, nft, ['-f', candidate]);
                    } });
                await activateNativeFile({ path: unitPath, bytes: nativeFirewallUnit, mode: 0o644, owner: rootOwner, previous: previous.unit,
                    protectedTarget: true, signal });
                await effect(run, 'systemctl', ['daemon-reload']); await effect(run, 'systemctl', ['enable', '--', unit]);
                await effect(run, 'systemctl', ['start', '--', unit]);
            }
            const verify = async () => !signal?.aborted && satisfied(step, await inspect(step));
            if (!await verify()) throw new MachineSetupEffectError('required_fact_unavailable');
            return { recovery, verify, commit() {
                if (settled) return;
                // The interpreter verifies the FINAL current stage before
                // releasing this whole invocation's stack. An earlier stage
                // must not be re-required after a reviewed later replacement.
                settled = true;
            }, undo };
        } catch (error) { await undo(); throw error; }
    };
    return { observe, stage, async apply(step: Firewall) {
        const pending = await stage(step);
        try {
            if (!await pending.verify()) throw new MachineSetupEffectError('required_fact_unavailable');
            await pending.commit();
        } catch (error) { await pending.undo(); throw error; }
    } };
}
