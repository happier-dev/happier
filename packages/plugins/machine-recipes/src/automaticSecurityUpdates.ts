import type { MachineRecipeV1 } from '@happier-dev/plugin-sdk';

const manager = { kind: 'targetFact' as const, fact: 'os.packageManager' as const };
const aptManager = { executable: 'test', args: [manager, '=', 'apt'], unsatisfiedExitCodes: [1] };

export const automaticSecurityUpdates: Omit<MachineRecipeV1, 'id'> = {
    revision: '1', title: 'Automatic security updates',
    description: 'Apply native security updates without automatic reboots, using the distribution’s timer.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    checks: [{ id: 'apt-manager', kind: 'command', executable: aptManager.executable, args: aptManager.args, check: aptManager }],
    steps: [
        { id: 'automatic-updates-package', kind: 'package', manager, state: 'present',
            packages: [{ name: { kind: 'targetFact', fact: 'os.automaticUpdatesPackage' } }],
            requiredFacts: [{ kind: 'init', system: 'systemd' }] },
        { id: 'apt-security-policy', kind: 'file', path: '/etc/apt/apt.conf.d/52happier-unattended-upgrades',
            owner: 'root', group: 'root', mode: 0o644,
            when: [{ checkId: 'apt-manager', status: ['satisfied'] }],
            content: { kind: 'template', value: '#clear Unattended-Upgrade::Allowed-Origins;\n#clear Unattended-Upgrade::Origins-Pattern;\nUnattended-Upgrade::Origins-Pattern {\n{origins}\n};\nUnattended-Upgrade::Automatic-Reboot "false";\nAPT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";\n',
                variables: { origins: { kind: 'targetFact', fact: 'os.securityOrigins' } } } },
        { id: 'dnf-security-policy', kind: 'file', path: '/etc/dnf/automatic.conf',
            owner: 'root', group: 'root', mode: 0o644,
            when: [{ checkId: 'apt-manager', status: ['drifted'] }],
            content: { kind: 'iniKeys', sections: { commands: { upgrade_type: 'security', apply_updates: 'yes', reboot: 'never' } } } },
        { id: 'automatic-updates-timer', kind: 'serviceUnit', unit: { kind: 'targetFact', fact: 'os.automaticUpdatesTimer' },
            enabled: true, running: true },
    ],
};
