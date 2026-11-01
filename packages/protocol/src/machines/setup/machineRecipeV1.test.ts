import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { MachineRecipeStepV1Schema, MachineRecipeStepDeclarationV1Schema, MachineRecipeV1Schema, MachineRecipeSelectionV1Schema, MachineSetupEffectPlanV1Schema, MachineSetupElevatedEffectV1Schema, resolveMachineRecipeStepInputsV1 } from './machineRecipeV1.js';

describe('machine recipe executable declarations', () => {
    it('binds the daemon operator CHECK to the same captured identity as its command argv', () => {
        const declaration: unknown = { id: 'operator', revision: '1', title: 'Native operator',
            inputSchema: { type: 'object', properties: {}, additionalProperties: false },
            steps: [{ id: 'operator', kind: 'command', executable: 'tailscale',
                args: ['set', { kind: 'template', value: '--operator={daemon}', variables: {
                    daemon: { kind: 'targetFact', fact: 'daemon.username' } } }],
                check: { executable: 'tailscale', args: ['debug', 'prefs'], unsatisfiedExitCodes: [],
                    stdoutJson: { op: 'eq', path: 'OperatorUser', value: { kind: 'targetFact', fact: 'daemon.username' } } } }] };
        const parsed = MachineRecipeV1Schema.safeParse(declaration);
        expect(parsed.success).toBe(true);
        if (!parsed.success) return;
        const facts = { 'daemon.username': 'actual-daemon', 'daemon.primaryGroup': 'operators' };
        expect(resolveMachineRecipeStepInputsV1(parsed.data.steps[0]!, {}, facts)).toMatchObject({
            args: ['set', '--operator=actual-daemon'],
            check: { stdoutJson: { op: 'eq', path: 'OperatorUser', value: 'actual-daemon' } },
        });
    });

    it('binds a reviewed JSON-output predicate value without interpreting submitted data as declarations', () => {
        const check = { executable: 'native-client', args: ['status', '--json'], unsatisfiedExitCodes: [],
            stdoutJson: { op: 'and', all: [{ op: 'eq', path: 'state', value: 'Connected' },
                { op: 'eq', path: 'profileName', value: { kind: 'input', path: 'config.profileName' } }] } };
        const recipe = MachineRecipeV1Schema.parse({ id: 'membership', revision: '1', title: 'Membership',
            inputSchema: { type: 'object', properties: { config: { type: 'object', properties: { profileName: { type: 'string' } },
                required: ['profileName'], additionalProperties: false } }, required: ['config'], additionalProperties: false },
            steps: [{ id: 'join', kind: 'command', executable: 'native-client', args: ['up'], check }],
        });
        const name = '{kind:input,path:unrelated}';
        const resolved = resolveMachineRecipeStepInputsV1(recipe.steps[0]!, { config: { profileName: name } });
        expect(resolved).toEqual({ id: 'join', kind: 'command', executable: 'native-client', args: ['up'], check: { ...check,
            stdoutJson: { op: 'and', all: [{ op: 'eq', path: 'state', value: 'Connected' }, { op: 'eq', path: 'profileName', value: name }] } } });
        expect(MachineRecipeStepV1Schema.parse(resolved)).toEqual(resolved);
        expect(() => resolveMachineRecipeStepInputsV1(recipe.steps[0]!, {})).toThrow();
        expect(() => resolveMachineRecipeStepInputsV1(recipe.steps[0]!, { config: { profileName: { kind: 'input', path: 'other' } }, other: 'not-followed' })).toThrow();
        for (const stdoutJson of [
            { op: 'javascript', expression: 'true' }, { op: 'eq', path: 'profileName', value: 'reviewed', private: 'opaque' },
            { kind: 'input', path: 'other' }, { op: 'truthy', path: 'management..connected' },
        ]) expect(MachineRecipeV1Schema.safeParse({ ...recipe, steps: [{ ...recipe.steps[0], check: { ...check, stdoutJson } }] }).success).toBe(false);
        expect(MachineRecipeV1Schema.parse({ ...recipe, steps: [resolved] }).steps[0]).toEqual(resolved);
    });

    it('carries one operation digest per admitted elevated plan without a competing inner expectation', () => {
        const plan = { v: 1, basis: { kind: 'setup', machineId: 'machine-a', desiredRevision: 1 },
            steps: [], nativeFacts: [], planDigest: 'a'.repeat(64) };
        const effect = { kind: 'setupOperation', plans: [{ plan }] };
        expect(MachineSetupElevatedEffectV1Schema.safeParse(effect).success).toBe(true);
        expect(MachineSetupElevatedEffectV1Schema.safeParse({ ...effect,
            plans: [{ plan, expectedPlanDigest: plan.planDigest }] }).success).toBe(false);
    });

    it('admits an exact positive safe UID on the existing user declaration for retained native identity repair', () => {
        const user = { id: 'member', kind: 'user', username: 'hpm-0123456789abcdef01234567',
            home: '/var/lib/happier/members/retained', ownershipMarker: 'happier-member-retained', uid: 2401 };
        expect(MachineRecipeStepV1Schema.parse(user)).toEqual(user);
        for (const uid of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
            expect(MachineRecipeStepV1Schema.safeParse({ ...user, uid }).success).toBe(false);
        }
        const { uid: _uid, ...existing } = user;
        expect(MachineRecipeStepV1Schema.parse(existing)).toEqual(existing);
    });
    it('rejects the unused sysctl step vocabulary', () => {
        expect(MachineRecipeStepV1Schema.safeParse({ id: 'kernel-setting', kind: 'sysctl',
            key: 'net.ipv4.ip_forward', value: '1', persistence: 'runtime' }).success).toBe(false);
    });
    it('binds whole package identity inputs in an array without interpreting submitted objects as declarations', () => {
        const recipe = MachineRecipeV1Schema.parse({ id: 'package', revision: '1', title: 'Package',
            inputSchema: { type: 'object', properties: { identity: { type: 'object', properties: {
                name: { type: 'string' }, version: { type: 'string' },
            }, required: ['name'], additionalProperties: false } }, required: ['identity'], additionalProperties: false },
            steps: [{ id: 'package', kind: 'package', manager: 'apt', packages: [{ kind: 'input', path: 'identity' }] }],
        });
        expect(resolveMachineRecipeStepInputsV1(recipe.steps[0]!, { identity: { name: 'jq' } }))
            .toEqual({ id: 'package', kind: 'package', manager: 'apt', packages: [{ name: 'jq' }] });
        expect(resolveMachineRecipeStepInputsV1(recipe.steps[0]!, { identity: { name: 'jq', version: '1.7.1-1' } }))
            .toEqual({ id: 'package', kind: 'package', manager: 'apt', packages: [{ name: 'jq', version: '1.7.1-1' }] });
        for (const identity of [{ name: '--option' }, { kind: 'input', path: 'other' }, { name: 'jq', source: 'winget' }]) {
            expect(() => resolveMachineRecipeStepInputsV1(recipe.steps[0]!, { identity, other: { name: 'jq' } })).toThrow();
        }
    });
    it('admits static localized recipe input hints only at declared input paths', () => {
        const field = { path: 'manager', title: { key: 'software.manager', fallback: 'Package manager' }, widget: 'select',
            options: [{ value: 'brew', label: 'Homebrew' }, { value: 'winget', label: 'WinGet' }] };
        const recipe = { id: 'install-package', revision: '1', title: 'Exact package', software: true,
            inputSchema: { type: 'object', properties: { manager: { type: 'string', enum: ['brew', 'winget'] } },
                required: ['manager'], additionalProperties: false },
            inputHints: { fields: [field] }, steps: [],
        };
        const parsed = MachineRecipeV1Schema.safeParse(recipe);
        expect(parsed.success).toBe(true);
        if (!parsed.success) throw parsed.error;
        expect(parsed.data).toEqual(recipe);
        for (const invalid of [
            { ...field, optionsSourceId: 'machines.setup.software.available' },
            { ...field, connectedAccountOptions: true },
            { ...field, inputType: { hostType: 'machine' } },
            { ...field, path: 'undeclared' },
            { ...field, path: 'manager..name' },
        ]) expect(MachineRecipeV1Schema.safeParse({ ...recipe, inputHints: { fields: [invalid] } }).success).toBe(false);
        const { inputHints: _hints, ...oldDefinition } = recipe;
        expect(MachineRecipeV1Schema.parse(oldDefinition)).toEqual(oldDefinition);
    });

    it('admits only the declared daemon identity facts in ownership and template bindings', () => {
        const group = { kind: 'targetFact', fact: 'daemon.primaryGroup' };
        const directory = { id: 'socket', kind: 'directory', path: '/run/private-service', owner: 'root', group, mode: 0o750 };
        const file = { id: 'service', kind: 'file', path: '/etc/private-service.conf', owner: 'root', group: 'root', mode: 0o600,
            content: { kind: 'template', value: 'Group={daemonGroup}\n', variables: { daemonGroup: group } } };
        const recipe = { id: 'service', revision: '1', title: 'Service', inputSchema: { type: 'object', properties: {}, additionalProperties: false },
            steps: [directory, file] };
        expect(MachineRecipeV1Schema.parse(recipe)).toEqual(recipe);
        expect(MachineRecipeStepV1Schema.safeParse(directory).success).toBe(false);
        const daemonOwned = MachineRecipeV1Schema.safeParse({ ...recipe, steps: [{ ...directory, owner: { ...group, fact: 'daemon.username' } }] });
        expect(daemonOwned.success).toBe(true);
        if (!daemonOwned.success) throw new Error('Expected the declared daemon username fact');
        const daemonFacts = { 'daemon.username': 'native-daemon', 'daemon.primaryGroup': 'native-operators' };
        expect(resolveMachineRecipeStepInputsV1(daemonOwned.data.steps[0]!, {}, daemonFacts))
            .toEqual({ ...directory, owner: 'native-daemon', group: 'native-operators' });
        expect(MachineRecipeV1Schema.safeParse({ ...recipe, steps: [{ ...directory, group: { ...group, fact: 'daemon.homeDirectory' } }] }).success).toBe(false);
        expect(() => resolveMachineRecipeStepInputsV1(MachineRecipeV1Schema.parse(recipe).steps[0]!, {})).toThrow();
        const admitted = MachineRecipeV1Schema.parse(recipe);
        const targetFacts = { 'daemon.primaryGroup': 'native-operators' };
        expect(resolveMachineRecipeStepInputsV1(admitted.steps[0]!, {}, targetFacts)).toEqual({ ...directory, group: 'native-operators' });
        expect(resolveMachineRecipeStepInputsV1(admitted.steps[1]!, {}, targetFacts)).toEqual({ ...file,
            content: { kind: 'literal', value: 'Group=native-operators\n' } });
        expect(() => resolveMachineRecipeStepInputsV1(admitted.steps[0]!, {}, { 'daemon.primaryGroup': null }))
            .toThrow('machine_recipe_target_fact_unavailable');
    });
    it('binds a proven existing journal group and exact supplementary removal through the same group arm', () => {
        const group = { kind: 'input', path: 'journalGroup' };
        const membership = { id: 'journal-access', kind: 'group', name: group, members: ['happier'], existingOnly: true,
            requiredFacts: [{ kind: 'journalReadGroup', group }] };
        const recipe = MachineRecipeV1Schema.parse({ id: 'journal-reader', revision: '1', title: 'Journal reader',
            inputSchema: { type: 'object', properties: { journalGroup: { type: 'string' } }, required: ['journalGroup'], additionalProperties: false },
            steps: [membership], removeSteps: [{ ...membership, state: 'absent' }] });
        for (const [step, state] of [[recipe.steps[0]!, undefined], [recipe.removeSteps![0]!, 'absent']] as const) {
            expect(resolveMachineRecipeStepInputsV1(step, { journalGroup: 'systemd-journal' })).toEqual({
                ...membership, name: 'systemd-journal', ...(state ? { state } : {}),
                requiredFacts: [{ kind: 'journalReadGroup', group: 'systemd-journal' }],
            });
            expect(MachineRecipeStepV1Schema.safeParse(step).success).toBe(false);
            expect(() => resolveMachineRecipeStepInputsV1(step, { journalGroup: '--root' })).toThrow();
        }
        expect(MachineRecipeStepV1Schema.safeParse({ id: 'group', kind: 'group', name: 'adm', members: ['happier'] }).success).toBe(true);
        expect(MachineRecipeStepV1Schema.safeParse({ id: 'group', kind: 'group', name: 'adm', members: ['happier'], existingOnly: false }).success).toBe(false);
    });
    it('admits guarded prior-manager checks without inventing an unreviewed manager choice', () => {
        const recipe = { id: 'manager-choice', revision: '1', title: 'Manager choice',
            inputSchema: { type: 'object', properties: {}, additionalProperties: false },
            checks: [{ id: 'apt', kind: 'package', manager: 'apt', packages: [{ name: 'wanted' }] }],
            steps: [{ id: 'brew', kind: 'package', manager: 'brew', packages: [{ name: 'wanted', kind: 'formula' }],
                when: [{ checkId: 'apt', status: ['packageManagerUnavailable'], ifInput: { op: 'truthy', path: 'apt' } }] }] };
        expect(MachineRecipeV1Schema.parse(recipe)).toEqual(recipe);
    });
    it('binds exact requested architectures to the canonical read-only kernel check and command verification', () => {
        const kernel = { kind: 'kernel', capability: 'binfmt', architectures: { kind: 'input', path: 'architectures' } };
        const recipe = { id: 'emulation', revision: '1', title: 'Build emulation',
            inputSchema: { type: 'object', properties: { architectures: { type: 'array', items: { type: 'string' } } },
                required: ['architectures'], additionalProperties: false },
            checks: [{ id: 'foreign-execution', ...kernel }], steps: [{ id: 'native-registration', kind: 'command',
                executable: '/usr/lib/systemd/systemd-binfmt', args: [], check: kernel,
                when: [{ checkId: 'foreign-execution', status: ['drifted'] }] }] };
        expect(MachineRecipeV1Schema.parse(recipe)).toEqual(recipe);
        for (const architectures of [[], ['arm64', 'arm64'], ['--privileged'], ['arm64\n']]) {
            expect(MachineRecipeV1Schema.safeParse({ ...recipe,
                checks: [{ id: 'foreign-execution', ...kernel, architectures }] }).success).toBe(false);
        }
        expect(MachineRecipeStepV1Schema.safeParse({ id: 'foreign-execution', ...kernel, architectures: ['arm64'] }).success).toBe(false);
    });
    it('renders exact prior reviewed content for owned removal without executable references in the root plan', () => {
        const input = (path: string) => ({ kind: 'input', path });
        const content = { kind: 'template', value: 'restrict,command="internal-sftp" {key}\n', variables: { key: input('senderPublicKey') } };
        const recipe = MachineRecipeV1Schema.parse({ id: 'receiver', revision: '1', title: 'Receiver',
            inputSchema: { type: 'object', properties: {}, additionalProperties: false }, steps: [], removeSteps: [{
                id: 'key', kind: 'file', path: { kind: 'template', value: '/etc/ssh/keys/{username}', variables: { username: input('username') } },
                owner: 'root', group: 'root', mode: 0o644, state: 'absent', expectedContentDigest: { kind: 'renderedContent', content },
            }] });
        const inputs = { username: 'backup', senderPublicKey: 'ssh-ed25519 AAAA{key}' };
        expect(resolveMachineRecipeStepInputsV1(recipe.removeSteps![0]!, inputs)).toEqual({
            id: 'key', kind: 'file', path: '/etc/ssh/keys/backup', owner: 'root', group: 'root', mode: 0o644,
            state: 'absent', expectedContentDigest: createHash('sha256').update('restrict,command="internal-sftp" ssh-ed25519 AAAA{key}\n').digest('hex'),
        });
        expect(MachineRecipeStepV1Schema.safeParse(recipe.removeSteps![0]).success).toBe(false);
        expect(() => resolveMachineRecipeStepInputsV1(recipe.removeSteps![0]!, { username: 'backup' })).toThrow();
    });

    it('preserves exact package absence and identity through reviewed input binding', () => {
        const recipe = MachineRecipeV1Schema.parse({ id: 'remove-package', revision: '1', title: 'Remove a package',
            inputSchema: { type: 'object', properties: {}, additionalProperties: false }, steps: [],
            removeSteps: [{ id: 'remove', kind: 'package', state: 'absent', manager: { kind: 'input', path: 'manager' },
                packages: { kind: 'input', path: 'packages' } }] });
        const inputs = { manager: 'winget', packages: [{ name: 'Example.Tool', version: '2.1', source: 'winget', scope: 'user' }] };
        expect(resolveMachineRecipeStepInputsV1(recipe.removeSteps![0]!, inputs)).toEqual({
            id: 'remove', kind: 'package', state: 'absent', ...inputs,
        });
        expect(MachineRecipeStepV1Schema.safeParse({ id: 'remove', kind: 'package', state: 'purged', ...inputs }).success).toBe(false);
    });
    it('admits reviewed input bindings and closed native-fact conditions only as recipe declarations', () => {
        const input = (path: string) => ({ kind: 'input', path });
        const packageCheck = { id: 'package-available', kind: 'package', manager: 'apt', packages: [{ name: 'qemu-user-static' }] };
        const steps = [
            { id: 'receiver', kind: 'user', username: input('receiver.username'), home: input('receiver.home'), locked: true },
            { id: 'sender-key', kind: 'file', path: input('receiver.keyPath'), owner: input('receiver.username'), group: 'root', mode: 0o600,
                content: { kind: 'template', value: 'restrict {senderKey}\n', variables: { senderKey: input('senderPublicKey') } } },
            { id: 'package-primary', kind: 'package', manager: input('manager'), packages: input('packages'),
                when: [{ checkId: 'package-available', status: ['satisfied', 'drifted'] }] },
            { id: 'native-fallback', kind: 'command', executable: '/usr/bin/true', args: [],
                check: { executable: '/usr/bin/false', args: [], unsatisfiedExitCodes: [1] },
                when: [{ checkId: 'package-available', status: ['packageUnavailable'] }] },
        ];
        const recipe = { id: 'configured', revision: '1', title: 'Configured',
            inputSchema: { type: 'object', properties: {}, additionalProperties: false }, checks: [packageCheck], steps };
        expect(MachineRecipeV1Schema.parse(recipe)).toEqual(recipe);
        expect(MachineRecipeV1Schema.safeParse({ ...recipe, steps: [{ ...steps[2], manager: 'apt', packages: [{ name: 'qemu-user-static' }] }] }).success).toBe(true);
        expect(MachineRecipeV1Schema.safeParse({ ...recipe, steps: [{ ...steps[2],
            when: [{ input: { op: 'truthy', path: 'packages' } }, ...steps[2]!.when!] }] }).success).toBe(true);
        for (const step of steps) expect(MachineRecipeStepV1Schema.safeParse(step).success).toBe(false);
        for (const when of [[], [{ checkId: 'unknown', status: ['drifted'] }],
            [{ checkId: 'package-available', status: [] }], [{ checkId: 'package-available', status: ['drifted', 'drifted'] }],
            [{ checkId: 'package-available', status: ['failed'] }], [{ input: { op: 'javascript', expression: 'packages' } }],
            [{ input: { op: 'truthy', path: 'packages..apt' } }]]) {
            expect(MachineRecipeV1Schema.safeParse({ ...recipe, steps: [{ ...steps[2], when }] }).success).toBe(false);
        }
        expect(MachineRecipeV1Schema.safeParse({ ...recipe, checks: [{ id: 'not-observe-only', kind: 'user', username: 'root' }] }).success).toBe(false);
        expect(MachineRecipeV1Schema.safeParse({ ...recipe, steps: [{ ...steps[0], username: input('receiver..username') }] }).success).toBe(false);
    });

    it('pairs conditional checks with exact ordered facts without permitting them as unresolved root effects', () => {
        const check = { id: 'package-available', kind: 'package', manager: 'apt', packages: [{ name: 'qemu-user-static' }] };
        const checkFact = { stepId: check.id, status: 'unsupported', reason: 'required_fact_unavailable', facts: { requiredFact: 'packageAvailability' } };
        const plan = { v: 1, basis: { kind: 'setup', machineId: 'machine-a', desiredRevision: 0 }, steps: [], nativeFacts: [],
            checks: [check], checkFacts: [checkFact], planDigest: 'a'.repeat(64) };
        expect(MachineSetupEffectPlanV1Schema.parse(plan)).toEqual(plan);
        for (const changed of [{ checks: undefined }, { checkFacts: undefined }, { checkFacts: [] },
            { checks: [check, check], checkFacts: [checkFact, checkFact] },
            { checkFacts: [{ ...checkFact, stepId: 'another-check' }] },
            { checks: [{ ...check, manager: { kind: 'input', path: 'manager' } }] },
            { checks: [{ id: 'file-check', kind: 'file', path: '/etc/fixture', owner: 'root', group: 'root', mode: 0o600,
                content: { kind: 'secretGrant', grantRef: 'not-a-probe' } }] }]) {
            expect(MachineSetupEffectPlanV1Schema.safeParse({ ...plan, ...changed }).success).toBe(false);
        }
    });

    it('admits exact software package identities through external declarations without a separate family', () => {
        const steps = [
            { id: 'brew', kind: 'package', manager: 'brew', packages: [
                { name: 'homebrew/core/ffmpeg', kind: 'formula', version: '7.1' },
                { name: 'example-app', kind: 'cask', version: '1.2.3-a45,ccdd88' },
            ] },
            { id: 'winget', kind: 'package', manager: 'winget', packages: [
                { name: 'Google.Chrome', version: '130.0.6723.70', source: 'winget', scope: 'user' },
            ] },
            { id: 'dnf', kind: 'package', manager: 'dnf', packages: [{ name: 'google-chrome-stable', version: '130.0-1' }] },
            { id: 'external-manager', kind: 'package', manager: 'pacman', packages: [{ name: 'ffmpeg' }] },
        ];
        const recipe = { id: 'software', revision: '1', title: 'Software', software: true,
            inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'], additionalProperties: false },
            steps, removeSteps: steps };
        expect(MachineRecipeV1Schema.parse(recipe)).toEqual(recipe);
        for (const packages of [[{ name: 'ffmpeg' }], [{ name: '--cask', kind: 'formula' }],
            [{ name: 'ffmpeg;curl', kind: 'formula' }], [{ name: 'ffmpeg', kind: 'formula', source: 'unreviewed' }]]) {
            expect(MachineRecipeStepV1Schema.safeParse({ ...steps[0], packages }).success).toBe(false);
        }
        expect(MachineRecipeStepV1Schema.safeParse({ ...steps[1], packages: [{ name: 'Google.Chrome', scope: 'all' }] }).success).toBe(false);
        expect(MachineRecipeStepV1Schema.safeParse({ ...steps[1], packages: [{ name: 'Google.Chrome', manifest: 'local.yaml' }] }).success).toBe(false);
        const { software: _software, ...olderDeclaration } = { ...recipe, steps: [], removeSteps: [] };
        expect(MachineRecipeV1Schema.parse(olderDeclaration)).toEqual(olderDeclaration);
    });

    it('rejects option, whitespace and shell fragments in exact package pins', () => {
        const step = { id: 'package', kind: 'package', manager: 'apt', packages: [{ name: 'ffmpeg', version: '7:7.1-1+deb12' }] };
        expect(MachineRecipeStepV1Schema.safeParse(step).success).toBe(true);
        for (const version of ['--allow-unauthenticated', '1 latest', '1\n2', '1;curl', '$(curl)']) {
            expect(MachineRecipeStepV1Schema.safeParse({ ...step, packages: [{ name: 'ffmpeg', version }] }).success).toBe(false);
        }
    });

    it('admits closed native validators, effective probes and declared service handlers', () => {
        const file = { id: 'sshd-policy', kind: 'file', path: '/etc/ssh/sshd_config.d/90-happier.conf',
            owner: 'root', group: 'root', mode: 0o644, requiredFacts: [{ kind: 'command', executable: 'sshd' }],
            content: { kind: 'iniKeys', sections: { Match: { PasswordAuthentication: 'no' } } },
            validate: { kind: 'sshd', contexts: [{ user: 'operator', host: 'machine', address: '192.0.2.1' }] },
            probe: { kind: 'sshd', contexts: [{ user: 'operator', host: 'machine', address: '192.0.2.1' }] },
            onChange: { serviceStepId: 'sshd-service', action: 'reload' } };
        expect(MachineRecipeStepV1Schema.safeParse(file).success).toBe(true);
        expect(MachineRecipeStepV1Schema.safeParse({ ...file, validate: { ...file.validate, shell: 'arbitrary' } }).success).toBe(false);
        expect(MachineRecipeStepV1Schema.safeParse({ ...file, probe: { kind: 'plugin', callback: 'check' } }).success).toBe(false);
        expect(MachineRecipeStepV1Schema.safeParse({ ...file, content: { kind: 'secretGrant', grantRef: 'grant-a', value: 'secret' } }).success).toBe(false);
        expect(MachineRecipeStepV1Schema.safeParse({ ...file, content: { kind: 'secretGrant', grantRef: 'grant-a' }, expectedContentDigest: 'a'.repeat(64) }).success).toBe(false);
        const service = { id: 'sshd-service', kind: 'serviceUnit', unit: 'sshd.service', enabled: true, running: true };
        const inputSchema = { type: 'object', properties: { settings: { type: 'object',
            properties: { enabled: { type: 'boolean' } }, additionalProperties: false } }, additionalProperties: false };
        const recipe = { id: 'ssh-hardening', revision: '1', title: 'SSH hardening', inputSchema, steps: [file, service] };
        expect(MachineRecipeV1Schema.parse(recipe)).toEqual(recipe);
        for (const invalid of [{ ...recipe, callback: 'install' }, { ...recipe, steps: [file] },
            { ...recipe, steps: [file, file, service] }, { ...recipe, inputSchema: {
                ...inputSchema, properties: { settings: { type: 'object', properties: { enabled: { type: 'boolean' } } } } } }]) {
            expect(MachineRecipeV1Schema.safeParse(invalid).success).toBe(false);
        }
        const selection = { ref: { pluginId: 'example.machine', recipeId: recipe.id, revision: recipe.revision }, inputs: { settings: { enabled: true } } };
        expect(MachineRecipeSelectionV1Schema.parse(selection)).toEqual(selection);
        expect(MachineRecipeSelectionV1Schema.safeParse({ ...selection, ref: { ...selection.ref, revision: '' } }).success).toBe(false);
        expect(MachineRecipeSelectionV1Schema.safeParse({ ...selection, ref: { ...selection.ref, latest: true } }).success).toBe(false);
    });

    it('rejects the unused portRequirement step vocabulary while retaining native firewall exposure data', () => {
        const exposure = { requirementId: 'app-port', protocol: 'tcp', hostAddress: '10.9.0.2',
            hostPort: 15432, containerPort: 5432, exposure: 'privateNetwork', providerId: 'tailscale', networkIdentity: 'tailnet-a' };
        const firewall = { id: 'owned-firewall', kind: 'firewall', rules: 'table inet happier {}', exposures: [exposure] };
        expect(MachineRecipeStepV1Schema.safeParse(firewall).success).toBe(true);
        expect(MachineRecipeStepDeclarationV1Schema.safeParse(firewall).success).toBe(true);
        expect(MachineRecipeStepDeclarationV1Schema.safeParse({ id: 'reboot', kind: 'reboot' }).success).toBe(false);
        for (const changed of [{ ...exposure, networkIdentity: undefined }, { ...exposure, exposure: 'public' },
            { ...exposure, callback: 'open' }]) {
            expect(MachineRecipeStepV1Schema.safeParse({ ...firewall, exposures: [changed] }).success).toBe(false);
        }
        const port = { id: 'app-port', kind: 'portRequirement', protocol: 'tcp', port: 15432, purpose: 'Database' };
        for (const scope of [{ exposure: 'public' }, { exposure: 'loopback' },
            { exposure: 'privateNetwork', providerId: 'tailscale', networkIdentity: 'tailnet-a' }]) {
            expect(MachineRecipeStepV1Schema.safeParse({ ...port, ...scope }).success).toBe(false);
            expect(MachineRecipeStepDeclarationV1Schema.safeParse({ ...port, ...scope }).success).toBe(false);
        }
    });
    it('binds an administrator transition to its real Machine operation rather than a fabricated setup revision', () => {
        const basis = { kind: 'adminAccess', machineId: 'machine-a', operationId: 'operation-a',
            previousPolicy: { version: 1, mode: 'ask', administratorUsername: 'operator.name' },
            policy: { version: 1, mode: 'none' } };
        const plan = { v: 1, basis, steps: [], nativeFacts: [], planDigest: 'a'.repeat(64) };
        expect(MachineSetupEffectPlanV1Schema.safeParse(plan).success).toBe(true);
        for (const changed of [{ ...basis, desiredRevision: 0 }, { ...basis, password: 'not-retained' },
            { ...basis, previousPolicy: { ...basis.previousPolicy, administratorUsername: 'root' } }]) {
            expect(MachineSetupEffectPlanV1Schema.safeParse({ ...plan, basis: changed }).success).toBe(false);
        }
    });
    it('accepts native account names with a dot without allowing option or newline injection', () => {
        const group = { id: 'membership', kind: 'group', name: 'happier-workspace', members: ['build.agent'] };
        expect(MachineRecipeStepV1Schema.safeParse(group).success).toBe(true);
        expect(MachineRecipeStepV1Schema.safeParse({ ...group, members: ['--root'] }).success).toBe(false);
        expect(MachineRecipeStepV1Schema.safeParse({ ...group, members: ['build\nroot'] }).success).toBe(false);
    });
    it('rejects shell wrappers and unchecked commands while admitting native checked argv', () => {
        const command = { id: 'refresh', kind: 'command', executable: '/usr/sbin/nft', args: ['-f', '/etc/happier/firewall/rules.nft'],
            check: { executable: '/usr/sbin/nft', args: ['list', 'table', 'inet', 'happier'], unsatisfiedExitCodes: [1] } };
        expect(MachineRecipeStepV1Schema.safeParse(command).success).toBe(true);
        expect(MachineRecipeStepV1Schema.safeParse({ ...command, executable: '/bin/sh', args: ['-c', 'arbitrary script'] }).success).toBe(false);
        expect(MachineRecipeStepV1Schema.safeParse({ ...command, check: undefined }).success).toBe(false);
        expect(MachineRecipeStepV1Schema.safeParse({ ...command, callback: 'plugin-code' }).success).toBe(false);
        expect(MachineRecipeStepV1Schema.safeParse({ ...command, check: { ...command.check, unsatisfiedExitCodes: [0] } }).success).toBe(false);
    });

    it('accepts a task-owned SSH bootstrap basis without synthetic Machine authority and keeps it closed', () => {
        const basis = { kind: 'sshBootstrap', operationId: 'host-task', admittedInputDigest: 'a'.repeat(64) };
        const plan = { v: 1, basis, steps: [], nativeFacts: [], planDigest: 'b'.repeat(64) };
        expect(MachineSetupEffectPlanV1Schema.safeParse(plan).success).toBe(true);
        for (const extra of [{ managedId: 'synthetic' }, { machineId: 'forged' }, { password: 'never-retained' }]) {
            expect(MachineSetupEffectPlanV1Schema.safeParse({ ...plan, basis: { ...basis, ...extra } }).success).toBe(false);
        }
    });

    it('retires a connector file through the same closed secret grant reference without a public digest', () => {
        const step = { id: 'connector-token', kind: 'file', path: '/etc/happier/connector.token',
            owner: 'root', group: 'root', mode: 0o600, state: 'absent',
            content: { kind: 'secretGrant', grantRef: 'connector-grant' } };
        expect(MachineRecipeStepV1Schema.safeParse(step).success).toBe(true);
        const declared = MachineRecipeStepDeclarationV1Schema.parse(step);
        expect(resolveMachineRecipeStepInputsV1(declared, {})).toEqual(step);
        for (const invalid of [
            { ...step, expectedContentDigest: 'a'.repeat(64) },
            { ...step, content: { ...step.content, value: 'private-bytes' } },
            { ...step, content: { kind: 'literal', value: 'not-a-removal-proof' } },
            { ...step, content: undefined },
        ]) expect(MachineRecipeStepV1Schema.safeParse(invalid).success).toBe(false);
    });

    it('keeps the plan basis and nested file authority closed, and binds ordered observations to steps', () => {
        const file = { id: 'sudoers', kind: 'file', path: '/etc/sudoers.d/90-happier-daemon', owner: 'root', group: 'root', mode: 0o440,
            content: { kind: 'literal', value: '# Happier managed administrator access\nhappier ALL=(ALL:ALL) NOPASSWD: ALL\n' }, validate: 'sudoers' };
        const plan = { v: 1, basis: { kind: 'bootstrap', managedId: 'managed-a', operationId: 'op-a', admittedInputDigest: 'a'.repeat(64) },
            steps: [file], nativeFacts: [{ stepId: 'sudoers', status: 'drifted', facts: { present: false } }], planDigest: 'b'.repeat(64) };
        expect(MachineSetupEffectPlanV1Schema.safeParse(plan).success).toBe(true);
        expect(MachineSetupEffectPlanV1Schema.safeParse({ ...plan, basis: { ...plan.basis, password: 'never-retained' } }).success).toBe(false);
        expect(MachineSetupEffectPlanV1Schema.safeParse({ ...plan, steps: [{ ...file, content: { ...file.content, pluginModule: 'root.js' } }] }).success).toBe(false);
        expect(MachineSetupEffectPlanV1Schema.safeParse({ ...plan, nativeFacts: [{ stepId: 'another-step', status: 'drifted', facts: {} }] }).success).toBe(false);
        expect(MachineSetupEffectPlanV1Schema.safeParse({ ...plan, steps: [file, file] }).success).toBe(false);
        expect(MachineRecipeStepV1Schema.safeParse({ ...file, state: 'absent', content: undefined, expectedContentDigest: 'c'.repeat(64) }).success).toBe(true);
        expect(MachineRecipeStepV1Schema.safeParse({ ...file, state: 'absent', content: undefined }).success).toBe(false);
        expect(MachineRecipeStepV1Schema.safeParse({ ...file, state: 'absent', expectedContentDigest: 'c'.repeat(64) }).success).toBe(false);
    });
});
