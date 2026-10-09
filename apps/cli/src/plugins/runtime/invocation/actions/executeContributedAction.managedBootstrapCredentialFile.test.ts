import { generateKeyPairSync } from 'node:crypto';
import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { executeContributedAction } from './executeContributedAction';
import { fixture, pluginId, roleResult } from './managedCustody.testkit';

describe('private native key delivery at contributed dispatch', () => {
    it.each([false, true])('preserves admitted paid native result through private delivery (cleanup failure: %s)', async cleanupFailure => {
        const key = generateKeyPairSync('rsa', { modulusLength: 2048,
            privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
        let deliveredPath = '';
        let consumed = false;
        const f = fixture({ nativeCredentialService: true, nativeCommandArgs: [],
            nativeRoleResults: { acquire: roleResult('acquire') },
            onNativeRole: async (role, _input, context) => {
                if (role !== 'acquire') return;
                await context.services.machineProvisioners.withBootstrapCredentialFile({ relativePath: 'state/crabbox/testboxes/cbx_abcdef123456/id_ed25519' }, async lease => {
                    deliveredPath = lease.path;
                    // Only harmless OS execution is substituted for the native
                    // binary. Public dispatch, custody and file lifetime run.
                    const result = await context.services.exec.run({ executable: { kind: 'systemTool', id: 'fixture-node' },
                        args: ['-e', 'const fs = require("node:fs"); const key = fs.readFileSync(process.argv[1], "utf8"); const pub = fs.readFileSync(process.argv[1] + ".pub", "utf8"); if (!key.includes("PRIVATE KEY") || !pub.startsWith("ssh-rsa ")) process.exit(1); process.stdout.write("native-reader-confirmed");', lease.path],
                    });
                    expect(result.termination).toEqual({ observed: { kind: 'exit', exitCode: 0 }, requestedBy: { kind: 'none' } });
                    expect(new TextDecoder().decode(result.stdout)).toBe('native-reader-confirmed');
                    await expect(readFile(lease.path, 'utf8')).resolves.toBe(key.privateKey);
                    consumed = true;
                    if (cleanupFailure) {
                        await rm(lease.path);
                        await mkdir(lease.path);
                    }
                });
            },
        });
        const result = await executeContributedAction({ runtimeRegistry: f.runtimeRegistry,
            actionId: `${pluginId}/acquire`, input: { launch: {} }, context: { surface: 'plugin' },
            admittedManagedProviderOperation: { ...f.custody, readBootstrapCredential: async () => new TextEncoder().encode(key.privateKey) },
        });
        if (cleanupFailure && deliveredPath) await rm(deliveredPath, { recursive: true, force: true });
        expect(result).toMatchObject({ matched: true, result: { ok: true, result: roleResult('acquire') } });
        expect(consumed).toBe(true);
        await expect(stat(deliveredPath)).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(stat(deliveredPath + '.pub')).rejects.toMatchObject({ code: 'ENOENT' });
    });
});
