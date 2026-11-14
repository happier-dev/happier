import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveHomeTargetFromDescriptor } from '@happier-dev/cli-common/homeTarget';
import { safeBashSingleQuote } from '@happier-dev/cli-common/ssh';
import { ManagedMachineV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';

import { runManagedMachineEnrollment, type ManagedNativeBootstrapIO } from './enrollment';

const execFileAsync = promisify(execFile);

describe('retained guest QA payload replacement', () => {
    afterEach(() => vi.unstubAllEnvs());

    it.skipIf(process.platform === 'win32')('replaces two builds reporting the same version without pairing or replacing the Machine', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-retained-payload-'));
        const payloadRoot = join(root, 'payload');
        const guestHome = join(root, 'guest');
        const resource = { contributionRef: { pluginId: 'test.provisioner', localId: 'vm' }, schemaVersion: 1,
            value: { nativeId: 'retained-instance' } };
        const retained = ManagedMachineV1Schema.parse({
            id: 'managed', homeId: 'srv_payload', custodianAccountId: 'owner', enrolledMachineId: 'retained-machine',
            launch: { provider: resource.contributionRef, schemaVersion: 1, name: 'Retained', choices: {} },
            controller: { machineId: 'controller', installationId: 'controller-installation' }, resource,
            allocation: 'bound', creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 1,
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
            enrollmentIdentity: { kind: 'existingUser', role: 'personal' },
        });
        const target = resolveHomeTargetFromDescriptor({ descriptor: {
            v: 1, homeServerIdentityId: retained.homeId, canonicalServerUrl: 'https://home.example.test', revision: 1,
            endpoints: [{ kind: 'https', url: 'https://home.example.test' }],
        }, authority: 'trusted_enrollment' });
        const commands: string[] = [];
        // The executable and native transport are OS boundaries. Promotion,
        // task admission, archive delivery and retained enrollment stay real.
        const native: ManagedNativeBootstrapIO = {
            exec: async ({ command }) => {
                commands.push(command);
                try {
                    const result = await execFileAsync('/bin/sh', ['-c', command], { env: { ...process.env, HOME: guestHome } });
                    return { status: 0, ...result };
                } catch (error) {
                    if (!(error instanceof Error) || !('code' in error) || typeof error.code !== 'number') throw error;
                    return { status: error.code,
                        stdout: 'stdout' in error ? String(error.stdout) : '',
                        stderr: 'stderr' in error ? String(error.stderr) : '' };
                }
            },
            putFile: async ({ path, bytes }) => {
                await mkdir(dirname(path), { recursive: true });
                await writeFile(path, bytes);
            },
        };
        const installer = [
            'import { installVersionedPayload } from "@happier-dev/cli-common/firstPartyRuntime";',
            'const args = process.argv.slice(1); const value = flag => args[args.indexOf(flag) + 1];',
            'await installVersionedPayload({ componentId: value("--component"), channel: value("--channel"), versionId: value("--version"), payloadRoot: value("--payload-root"), processEnv: process.env, selectAsDefaultReleaseChannel: true });',
        ].join('\n');
        const executable = (build: string) => [
            '#!/bin/sh',
            `# ${build}`,
            `if [ "$1 $2" = "self __install-payload" ]; then exec ${safeBashSingleQuote(process.execPath)} --conditions=happier-source --import ${safeBashSingleQuote(createRequire(import.meta.url).resolve('tsx'))} --input-type=module -e ${safeBashSingleQuote(installer)} "$@"; fi`,
            'if [ "$1" = "--version" ]; then echo 0.2.10; exit 0; fi',
            `if [ "$1 $2" = "daemon status" ]; then printf '%s\\n' '{"daemon":{"running":true,"healthy":true},"service":{"installed":true},"auth":{"needsAuth":false,"machineId":"retained-machine"}}'; exit 0; fi`,
            'if [ "$1 $2" = "daemon service" ]; then exit 0; fi',
            // Any attempt to pair or mutate a guest policy fails this boundary.
            'exit 97',
            '',
        ].join('\n');
        try {
            await mkdir(payloadRoot);
            await mkdir(guestHome);
            vi.stubEnv('HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_ROOT', payloadRoot);
            const installedBinary = join(guestHome, '.happier/cli/current/happier');
            for (const build of ['create-time-build', 'newer-qa-build']) {
                const bytes = executable(build);
                await writeFile(join(payloadRoot, 'happier'), bytes);
                const correlation = { homeId: retained.homeId, managedId: retained.id, requestId: build,
                    expectedIntentRevision: retained.intentRevision, controller: retained.controller, resource };
                await expect(runManagedMachineEnrollment({ correlation, homeCorrelation: correlation,
                    target, carrier: { kind: 'native', transport: { contributionRef: resource.contributionRef, schemaVersion: 1 } },
                    channel: 'stable',
                }, { readCurrentManagedRow: async () => retained, native })).resolves.toEqual({ machineId: 'retained-machine' });
                expect(await readFile(installedBinary, 'utf8')).toBe(bytes);
                expect((await execFileAsync(installedBinary, ['--version'])).stdout.trim()).toBe('0.2.10');
            }
            expect(commands.filter(command => /\bdaemon\b.*\bservice\b.*\brestart\b/u.test(command))).toHaveLength(2);
            expect(commands.some(command => /\bauth\b.*\b(request|wait)\b/u.test(command))).toBe(false);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
});
