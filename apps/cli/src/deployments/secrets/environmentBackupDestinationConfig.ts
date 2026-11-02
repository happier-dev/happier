import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { createProtectedLocalStateDirectory, createProtectedLocalStateFileExclusive,
    ensureProtectedLocalStateDirectory } from '@/utils/fs/protectedLocalState';

/** Host-private selected-destination adapter; the existing materializer owns
 * exact row/grant admission and the opaque attachment owns finite settlement. */
export async function createEnvironmentBackupDestinationConfigForHost(input: Readonly<{
    baseDir: string;
    repositoryPassword: string;
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
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
        Object.assign(env, { RESTIC_PASSWORD_FILE: passwordFile, AWS_ACCESS_KEY_ID: input.accessKeyId,
            AWS_SECRET_ACCESS_KEY: input.secretAccessKey });
        if (input.sessionToken !== undefined) env.AWS_SESSION_TOKEN = input.sessionToken;
        // The host file remains private custody; Docker's target is Linux even
        // when the executing host uses a different home or path syntax.
        return { env, credentialFiles: [{ hostPath: passwordFile,
            containerPath: '/run/happier/backup/repository-password', readOnly: true as const }], dispose };
    } catch (error) { dispose(); throw error; }
}
