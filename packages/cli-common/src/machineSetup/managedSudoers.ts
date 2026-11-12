import { MachineSetupEffectError } from './index.js';
import { computeSha256HexDigest } from '@happier-dev/protocol/crypto/canonicalDigest';
import { MachineAdminAccessV1Schema, type MachineAdminAccessV1 } from '@happier-dev/protocol/machines/adminAccessV1';
import type { MachineRecipeStepV1 } from '@happier-dev/protocol/machines/setup/machineRecipeV1';
import { MachineRecipeStepV1Schema } from '@happier-dev/protocol/machines/setup/machineRecipeV1';

export const MANAGED_SUDOERS_PATH = '/etc/sudoers.d/90-happier-daemon';

function render(daemonUsername: string, policy: Exclude<MachineAdminAccessV1, { mode: 'none' }>): string {
    return policy.mode === 'preauthorized' ? `${daemonUsername} ALL=(ALL:ALL) NOPASSWD: ALL\n`
        // targetpw is supported by classic sudo and sudo-rs. Authenticate the
        // named administrator first; its own sudo policy must authorize root.
        : `Defaults:${daemonUsername} targetpw, timestamp_timeout=0\n${daemonUsername} ALL=(${policy.administratorUsername}) PASSWD: ALL\n`;
}

/** Produces data only; the shared setup file backend owns activation/removal. */
export function buildManagedSudoersSteps(input: Readonly<{
    daemonUsername: string; previousPolicy: MachineAdminAccessV1; policy: MachineAdminAccessV1;
}>): Extract<MachineRecipeStepV1, { kind: 'file' }>[] {
    const previous = MachineAdminAccessV1Schema.parse(input.previousPolicy);
    const policy = MachineAdminAccessV1Schema.parse(input.policy);
    if (previous.mode === 'none' && policy.mode === 'none') return [];
    // Sudoers identities use the same admitted native-user grammar as setup.
    MachineRecipeStepV1Schema.parse({ id: 'daemon-principal', kind: 'user', username: input.daemonUsername });
    if (policy.mode === 'ask' && policy.administratorUsername === input.daemonUsername) {
        throw new MachineSetupEffectError('required_fact_unavailable', { kind: 'native_check_unavailable',
            reason: 'required_fact_unavailable', requiredFact: 'distinctAdministrator',
            remedy: 'Choose an administrator account different from the Machine daemon user, then retry.' });
    }
    const expectedContentDigest = previous.mode === 'none' ? undefined
        : computeSha256HexDigest(render(input.daemonUsername, previous));
    const file = { id: 'machine-admin-access-sudoers', kind: 'file' as const,
        path: MANAGED_SUDOERS_PATH, owner: 'root', group: 'root', mode: 0o440,
        ...(expectedContentDigest ? { expectedContentDigest } : {}) };
    return [policy.mode === 'none' ? { ...file, state: 'absent' }
        : { ...file, state: 'present', content: { kind: 'literal', value: render(input.daemonUsername, policy) }, validate: 'sudoers' }];
}

/** File identity/mode checks belong to the native observer, not this byte owner. */
export function recognizeManagedSudoersDropIn(content: string, daemonUsername: string): 'valid' | 'invalid' {
    if (!MachineRecipeStepV1Schema.safeParse({ id: 'daemon-principal', kind: 'user', username: daemonUsername }).success) return 'invalid';
    if (content === render(daemonUsername, { version: 1, mode: 'preauthorized' })) return 'valid';
    const prefix = `Defaults:${daemonUsername} targetpw, timestamp_timeout=0\n${daemonUsername} ALL=(`;
    const separator = ') PASSWD: ALL\n';
    const end = content.indexOf(separator, prefix.length);
    if (!content.startsWith(prefix) || end < 0) return 'invalid';
    const policy = MachineAdminAccessV1Schema.safeParse({ version: 1, mode: 'ask',
        administratorUsername: content.slice(prefix.length, end) });
    if (!policy.success || policy.data.mode !== 'ask') return 'invalid';
    try {
        const [step] = buildManagedSudoersSteps({ daemonUsername, previousPolicy: { version: 1, mode: 'none' }, policy: policy.data });
        return step?.content?.kind === 'literal' && step.content.value === content ? 'valid' : 'invalid';
    } catch { return 'invalid'; }
}
