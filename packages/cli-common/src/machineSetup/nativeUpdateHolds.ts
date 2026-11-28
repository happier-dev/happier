import { matchesGlob } from 'node:path';
import { MachineRecipePackageStepV1Schema, type MachineRecipeStepV1 } from '@happier-dev/protocol/machines/setup/machineRecipeV1';
import { readNativeAptPackages } from './nativeAptPackages.js';
import type { NativeRun } from './nativeSystemBackend.js';
import { MachineSetupEffectError, type MachineSetupStepObservationV1 } from './index.js';

type HoldStep = Extract<MachineRecipeStepV1, { kind: 'packageHold' }>;
type DnfRule = Readonly<{ name: string; hold: boolean; release?: Readonly<{ target: string; rule: string }> }>;
const locale = { LC_ALL: 'C' };
const packageName = /^[A-Za-z0-9][A-Za-z0-9+_.-]*$/;

/** versionlock list is a read. repoquery does not report transaction version locks. */
export async function readDnfVersionLocks(run: NativeRun, dnf5: boolean): Promise<readonly DnfRule[] | 'unsupported' | null> {
    const result = await run('dnf', ['--quiet', 'versionlock', 'list'], locale);
    if (result.code !== 0) {
        return /(?:no such command:|unknown (?:command|argument))\s+["']?versionlock\b/i.test(result.stderr)
            ? 'unsupported' : null;
    }
    if (result.stderr.trim()) return null;
    const output = result.stdout.trim();
    if (!output) return [];
    const rules: DnfRule[] = [];
    if (dnf5) {
        for (const stanza of output.split(/\r?\n\s*\r?\n/)) {
            const [header, ...conditions] = stanza.split(/\r?\n/).map(line => line.trim()).filter(line => !line.startsWith('#'));
            const name = /^Package name: (\S+)$/.exec(header ?? '')?.[1];
            if (!name || !conditions.length || conditions.some(line => !/^(?:evr|epoch|arch) (?:[!=<>]=?|<>) \S+$/.test(line))) return null;
            const exact = packageName.test(name) && conditions.length === 1 && /^evr = \S+$/.test(conditions[0]!);
            rules.push({ name, hold: !conditions.every(line => /^(?:evr|epoch|arch) (?:!=|<>) /.test(line)),
                ...(exact ? { release: { target: name, rule: conditions[0]! } } : {}) });
        }
    } else {
        for (const line of output.split(/\r?\n/).filter(line => line.trim() && !line.trimStart().startsWith('#'))) {
            const match = /^(!?)(\S+?)-(\d+:\S+)$/.exec(line.trim());
            if (!match) return null;
            const [, excluded, name, version] = match;
            const exact = !excluded && packageName.test(name!) && /^\d+:[0-9A-Za-z_.+~^]+-[0-9A-Za-z_.+~^]+\.\*$/.test(version!);
            // DNF4 also matches a bare argument against NAME-VERSION. Use the exact
            // native lock line so releasing one package cannot match another by version.
            rules.push({ name: name!, hold: !excluded,
                ...(exact ? { release: { target: line.trim(), rule: line.trim() } } : {}) });
        }
    }
    return rules;
}

export function dnfRuleMatchesName(rule: DnfRule, name: string): boolean {
    return rule.name === name || matchesGlob(name, rule.name);
}

/** Inspect just the named installed package and its native hold before planning or applying. */
export async function observeNativeUpdateHold(run: NativeRun, step: HoldStep) {
    const observation = (status: 'satisfied' | 'drifted' | 'unavailable' | 'unsupported',
        facts: Readonly<{ held?: boolean; version?: string; requiredFact?: string; target?: string; rule?: string }>) => ({
        stepId: step.id, status, facts,
        ...(status === 'unavailable' || status === 'unsupported' ? { reason: 'required_fact_unavailable' } : {}),
    });
    if (step.manager === 'apt') {
        const result = await run('dpkg-query', ['--show', '--showformat=${binary:Package}\t${Status}\t${Version}\t${Architecture}\n', '--', step.name], locale);
        if (result.code !== 0) return observation('unavailable', { requiredFact: 'installedPackage' });
        const rows = readNativeAptPackages(result.stdout);
        if (rows?.length !== 1 || rows[0]?.name !== step.name) return observation('unavailable', { requiredFact: 'installedPackage' });
        const { held, version } = rows[0];
        return observation(held === (step.operation === 'hold') ? 'satisfied' : 'drifted', { held, version });
    }
    const version = await run('dnf', ['--version'], locale);
    if (version.code !== 0) return observation('unavailable', { requiredFact: 'packageManager' });
    const dnf5 = /^(?:dnf5 version )?5\./m.test(version.stdout.trim());
    const rules = await readDnfVersionLocks(run, dnf5);
    if (rules === 'unsupported') return observation('unsupported', { requiredFact: 'versionlock' });
    if (!rules) return observation('unavailable', { requiredFact: 'versionlock' });
    const matching = rules.filter(rule => dnfRuleMatchesName(rule, step.name));
    const held = matching.some(rule => rule.hold);
    if (held === (step.operation === 'hold')) return observation('satisfied', { held });
    if (step.operation === 'release') {
        const release = matching.length === 1 && matching[0]?.name === step.name ? matching[0].release : undefined;
        return release ? observation('drifted', { held, ...release })
            : observation('unsupported', { held, requiredFact: 'exactVersionlock' });
    }
    const installed = await run('rpm', ['--query', '--queryformat', '%{NAME}\t%{EPOCHNUM}:%{VERSION}-%{RELEASE}\n', '--', step.name], locale);
    const [name, installedVersion, ...extra] = installed.stdout.trim().split('\t');
    if (installed.code !== 0 || name !== step.name || !installedVersion || extra.length
        || !MachineRecipePackageStepV1Schema.safeParse({
            id: step.id, kind: 'package', manager: 'dnf', packages: [{ name, version: installedVersion }],
        }).success) {
        return observation('unavailable', { requiredFact: 'installedPackage' });
    }
    return observation('drifted', { held, target: `${name}-${installedVersion}` });
}

export async function applyNativeUpdateHold(run: NativeRun, step: HoldStep, observed?: MachineSetupStepObservationV1): Promise<void> {
    const holding = step.operation === 'hold';
    const target = step.manager === 'apt' ? step.name : observed?.facts.target;
    if (typeof target !== 'string') throw new MachineSetupEffectError('required_fact_unavailable');
    const result = step.manager === 'apt'
        ? await run('apt-mark', [holding ? 'hold' : 'unhold', '--', target], locale)
        : await run('dnf', ['--quiet', 'versionlock', holding ? 'add' : 'delete', target], locale);
    if (result.code !== 0 || (holding && step.manager === 'dnf' && result.stderr.trim())) {
        throw new MachineSetupEffectError('native_effect_failed');
    }
}
