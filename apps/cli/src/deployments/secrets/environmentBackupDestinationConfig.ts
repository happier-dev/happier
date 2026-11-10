import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import type { BackupDestinationOpenV1 } from '@happier-dev/plugin-sdk';
import { parseSshKnownHostLine, resolveSshKnownHostTrust } from '@happier-dev/cli-common/systemTasks';
import { createProtectedLocalStateDirectory, createProtectedLocalStateFileExclusive,
    ensureProtectedLocalStateDirectory } from '@/utils/fs/protectedLocalState';

/** Host-private selected-destination adapter; the existing materializer owns
 * exact row/grant admission and the opaque attachment owns finite settlement. */
export async function createEnvironmentBackupDestinationConfigForHost(input: Readonly<{
    baseDir: string;
    repositoryPassword: string;
    accessKeyId?: string;
    secretAccessKey?: string;
    sessionToken?: string;
    sshPrivateKey?: string;
    sftp?: BackupDestinationOpenV1['sftp'];
}>) {
    await ensureProtectedLocalStateDirectory(input.baseDir);
    const directory = await createProtectedLocalStateDirectory(join(input.baseDir, 'backup-'));
    const env: Record<string, string> = Object.create(null);
    const dispose = () => {
        for (const key of Object.keys(env)) delete env[key];
        rmSync(directory, { recursive: true, force: true });
    };
    try {
        const passwordFile = join(directory, 'repository-password');
        await createProtectedLocalStateFileExclusive(passwordFile, input.repositoryPassword);
        env.RESTIC_PASSWORD_FILE = passwordFile;
        if (input.accessKeyId !== undefined) env.AWS_ACCESS_KEY_ID = input.accessKeyId;
        if (input.secretAccessKey !== undefined) env.AWS_SECRET_ACCESS_KEY = input.secretAccessKey;
        if (input.sessionToken !== undefined) env.AWS_SESSION_TOKEN = input.sessionToken;
        const credentialFiles = [{ hostPath: passwordFile,
            containerPath: '/run/happier/backup/repository-password', readOnly: true as const }];
        if (input.sshPrivateKey !== undefined) {
            const keyFile = join(directory, 'ssh-key');
            await createProtectedLocalStateFileExclusive(keyFile, input.sshPrivateKey);
            credentialFiles.push({ hostPath: keyFile, containerPath: '/run/happier/backup/ssh-key', readOnly: true });
            if (input.sftp) {
                const { host, username, port = 22, hostKey } = input.sftp;
                const parsed = parseSshKnownHostLine(hostKey);
                const token = port === 22 ? host : `[${host}]:${port}`;
                if (!parsed || resolveSshKnownHostTrust({ scannedHostKeyLine: `${token} ${parsed.keyType} ${parsed.key}`,
                    trustedHostKey: parsed.line }).status !== 'trusted') throw new PluginError({ code: 'invalid_input',
                    message: 'The pinned SSH host key does not identify this destination' });
                // The descriptor validates host/user operands. Quote them too so
                // OpenSSH configuration never interprets spaces or comments.
                const quote = (value: string) => `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
                const config = ['Host backup', `  HostName ${quote(host)}`, `  User ${quote(username)}`, `  Port ${port}`,
                    '  IdentityFile /run/happier/backup/ssh-key', '  IdentitiesOnly yes', '  IdentityAgent none',
                    '  BatchMode yes', '  PasswordAuthentication no', '  KbdInteractiveAuthentication no',
                    '  StrictHostKeyChecking yes', '  UserKnownHostsFile /run/happier/backup/known-hosts',
                    '  GlobalKnownHostsFile /dev/null', ''].join('\n');
                for (const [name, content] of [['ssh-config', config], ['known-hosts', `${parsed.line}\n`]]) {
                    const hostPath = join(directory, name);
                    await createProtectedLocalStateFileExclusive(hostPath, content);
                    credentialFiles.push({ hostPath, containerPath: `/run/happier/backup/${name}`, readOnly: true });
                }
            }
        }
        // The host file remains private custody; Docker's target is Linux even
        // when the executing host uses a different home or path syntax.
        return { env, credentialFiles, dispose };
    } catch (error) { dispose(); throw error; }
}
