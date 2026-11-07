import { writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';

/** Source guest process: real pairing, claim, credential persistence and Machine registration. */
export async function runEnrollmentGuestBoundary(command: 'request' | 'wait', args: string[], resultPath: string, serverUrl: string, input = ''): Promise<void> {
    // Request does not need the Machine/session runtime graph. Loading that
    // unrelated graph before the short request command distorted its OS budget.
    if (command === 'request') {
        const { handleAuthRequest } = await import('@/cli/commands/auth/request');
        return handleAuthRequest(args, undefined, Readable.from([input]));
    }
    const { handleAuthWait } = await import('@/cli/commands/auth/wait');
    await handleAuthWait(args);
    const { readSettings, readStoredCredentials } = await import('@/persistence');
    const { readInstallationIdentityIfExistsSync } = await import('@/daemon/identity/store');
    const { ApiClient } = await import('@/api/api');
    const { runWithServerHttpBaseUrl } = await import('@/api/client/serverHttpBaseUrl');
    const { encodeBase64 } = await import('@/api/encryption');
    const credentials = await readStoredCredentials();
    const installation = readInstallationIdentityIfExistsSync();
    const machineId = (await readSettings()).machineId;
    if (!credentials || !installation || !machineId) throw new Error('Guest enrollment did not persist its identity');
    const machine = await runWithServerHttpBaseUrl(serverUrl, async () => (await ApiClient.create(credentials)).getMachine(machineId));
    if (!machine) throw new Error('Guest enrollment did not publish its Machine');
    if (machine.encryptionMode === 'plain') throw new Error('The S0 guest must retain its E2EE Machine content');
    await writeFile(resultPath, JSON.stringify({ machineId, installation, daemonToken: credentials.token,
        machineEncryptionKey: encodeBase64(machine.encryptionKey) }), { mode: 0o600 });
}
