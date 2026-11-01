import type { MachineRecipeV1 } from '@happier-dev/plugin-sdk';

const missingEmulation = { checkId: 'requested-emulation', status: ['drifted' as const] };
const packageAvailable = { checkId: 'distro-package', status: ['satisfied' as const, 'drifted' as const] };
const targets = [{ architecture: 'amd64', format: 'x86_64' }, { architecture: 'arm64', format: 'aarch64' },
    { architecture: 'riscv64', format: 'riscv64' }];

/** Cold data. Native package availability and exact requested execution decide support. */
export const binfmtQemu: Omit<MachineRecipeV1, 'id'> = {
    revision: '1', title: 'Build emulation',
    description: 'Prepare this build Machine for the requested foreign Linux architectures. Emulated builds are slower. '
        + 'Native or already-working support changes nothing. Missing distro packages are unsupported until a persistent pinned installer is available.',
    inputSchema: { type: 'object', properties: {
        manager: { type: 'string', enum: ['apt', 'dnf'] },
        architectures: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string', pattern: '^[a-z0-9][a-z0-9_.-]*(/[a-z0-9][a-z0-9_.-]*)?$' } },
    }, required: ['manager', 'architectures'], additionalProperties: false },
    checks: [
        { id: 'requested-emulation', kind: 'kernel', capability: 'binfmt', architectures: { kind: 'input', path: 'architectures' } },
        { id: 'distro-package', kind: 'package', manager: { kind: 'input', path: 'manager' }, packages: [{ name: 'qemu-user-static' }] },
    ],
    steps: [
        { id: 'distro-package', kind: 'package', manager: { kind: 'input', path: 'manager' }, packages: [{ name: 'qemu-user-static' }],
            requiredFacts: [{ kind: 'init' as const, system: 'systemd' as const }],
            when: [missingEmulation, packageAvailable] },
        ...targets.flatMap(({ architecture, format }) => (['apt', 'dnf'] as const).map(manager => ({
            id: `register-${manager}-${architecture}`, kind: 'command' as const,
            // Without a positional config systemd-binfmt flushes all registrations.
            // These exact native package files preserve unrelated handlers.
            executable: '/usr/lib/systemd/systemd-binfmt', args: [`qemu-${format}${manager === 'dnf' ? '-static' : ''}.conf`],
            requiredFacts: [{ kind: 'init' as const, system: 'systemd' as const }],
            check: { kind: 'kernel' as const, capability: 'binfmtPersistent', architectures: [architecture] },
            when: [missingEmulation,
                { input: { op: 'includes' as const, path: 'architectures', value: architecture } },
                { input: { op: 'eq' as const, path: 'manager', value: manager } }, packageAvailable],
        }))),
    ],
    // Registration/package ownership may predate Happier or serve other builders.
    // No inverse or foreign-handler ownership is inferred for removal.
};
