import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildManagedSudoersSteps } from './managedSudoers.js';

// Native validators are genuine OS boundaries. CI/developer hosts may provide
// either implementation; explicit paths also support an unpacked upstream binary.
const validators = [
    { name: 'classic sudo', executable: process.env.HAPPIER_TEST_VISUDO_CLASSIC
        ?? (existsSync('/usr/sbin/visudo.ws') ? '/usr/sbin/visudo.ws' : '/usr/sbin/visudo') },
    { name: 'sudo-rs', executable: process.env.HAPPIER_TEST_VISUDO_RS ?? '/usr/lib/cargo/bin/visudo' },
];

describe.each(validators)('managed sudoers accepted by $name', ({ executable }) => {
    it.skipIf(!existsSync(executable))('validates Ask and preauthorized policies using the native parser', () => {
        const root = mkdtempSync(join(tmpdir(), 'managed-sudoers-validator-'));
        try {
            for (const policy of [
                { version: 1, mode: 'ask', administratorUsername: 'qa126admin' },
                { version: 1, mode: 'preauthorized' },
            ] as const) {
                const [step] = buildManagedSudoersSteps({ daemonUsername: 'happier',
                    previousPolicy: { version: 1, mode: 'none' }, policy });
                if (step?.content?.kind !== 'literal') throw new Error('Expected the managed sudoers file');
                const candidate = join(root, `sudoers-${policy.mode}`);
                writeFileSync(candidate, step.content.value, { mode: 0o440 });
                const result = spawnSync(executable, ['-c', '-f', candidate], { encoding: 'utf8' });
                expect(result.error).toBeUndefined();
                expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
            }
        } finally { rmSync(root, { recursive: true, force: true }); }
    });
});
