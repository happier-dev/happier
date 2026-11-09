import { expect, it } from 'vitest';
import { MachineRecipeV1Schema, resolveMachineRecipeStepInputsV1 } from '@happier-dev/protocol/machines/setup/machineRecipeV1';
import { compilePluginJsonSchema, isValidPluginJsonSchemaValue } from '@happier-dev/protocol/plugins/actions/json-schema-validation';
import { automaticSecurityUpdates } from './automaticSecurityUpdates.js';

it('admits a closed no-input security recipe and binds native package and timer identities', () => {
    const recipe = MachineRecipeV1Schema.parse({ id: 'automatic-security-updates', ...automaticSecurityUpdates });
    const schema = compilePluginJsonSchema(recipe.inputSchema);
    expect(isValidPluginJsonSchemaValue(schema, {})).toBe(true);
    expect(isValidPluginJsonSchemaValue(schema, { autoReboot: true })).toBe(false);
    const facts = { 'os.packageManager': 'apt', 'os.automaticUpdatesPackage': 'unattended-upgrades',
        'os.automaticUpdatesTimer': 'apt-daily-upgrade.timer',
        'os.securityOrigins': '    "origin=Debian,codename=bookworm-security,label=Debian-Security";' } as const;
    expect(resolveMachineRecipeStepInputsV1(recipe.steps[0]!, {}, facts)).toMatchObject({ kind: 'package', manager: 'apt', packages: [{ name: 'unattended-upgrades' }] });
    const apt = recipe.steps.find(step => step.id === 'apt-security-policy');
    if (!apt) throw new Error('APT security policy missing');
    expect(resolveMachineRecipeStepInputsV1(apt, {}, facts)).toMatchObject({ kind: 'file',
        path: '/etc/apt/apt.conf.d/52happier-unattended-upgrades', content: { kind: 'literal', value:
            '#clear Unattended-Upgrade::Allowed-Origins;\n#clear Unattended-Upgrade::Origins-Pattern;\nUnattended-Upgrade::Origins-Pattern {\n    "origin=Debian,codename=bookworm-security,label=Debian-Security";\n};\nUnattended-Upgrade::Automatic-Reboot "false";\nAPT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";\n' } });
    expect(resolveMachineRecipeStepInputsV1(recipe.steps.at(-1)!, {}, facts)).toMatchObject({ kind: 'serviceUnit', unit: 'apt-daily-upgrade.timer', enabled: true, running: true });
});

it('edits only the DNF security/apply/reboot keys without a scheduling override or executable shell', () => {
    const recipe = MachineRecipeV1Schema.parse({ id: 'automatic-security-updates', ...automaticSecurityUpdates });
    const dnf = recipe.steps.find(step => step.id === 'dnf-security-policy');
    expect(dnf).toMatchObject({ kind: 'file', path: '/etc/dnf/automatic.conf' });
    if (dnf?.kind !== 'file') throw new Error('DNF security policy missing');
    expect(dnf.content).toEqual({ kind: 'iniKeys', sections: { commands: { upgrade_type: 'security', apply_updates: 'yes', reboot: 'never' } } });
    expect(recipe.steps.filter(step => step.kind === 'file').map(step => step.path)).toEqual([
        '/etc/apt/apt.conf.d/52happier-unattended-upgrades', '/etc/dnf/automatic.conf',
    ]);
    expect(recipe.steps.every(step => ['package', 'file', 'serviceUnit'].includes(step.kind))).toBe(true);
    const timer = resolveMachineRecipeStepInputsV1(recipe.steps.at(-1)!, {}, {
        'os.automaticUpdatesTimer': 'dnf5-automatic.timer',
    });
    expect(timer).toMatchObject({ kind: 'serviceUnit', unit: 'dnf5-automatic.timer', enabled: true, running: true });
});
