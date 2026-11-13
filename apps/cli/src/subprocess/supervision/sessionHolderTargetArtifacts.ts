import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { resolveSessionTargetHolderExecutablePath } from '@happier-dev/iroh-native/node';
import type { ManagedGuestPlatform, SessionHolderArtifact } from '@happier-dev/cli-common/machines/managed';
import { PluginError } from '@happier-dev/plugin-sdk/errors';

import { resolveProcessCustodyTargetExecutable } from './processCustody';

async function artifact(path: string): Promise<SessionHolderArtifact> {
    const bytes = await readFile(path);
    return { bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
}

/**
 * The static holder and custody helper this build ships for a Linux target of
 * the guest's architecture (`ensureManagedGuestSessionHolder`'s artifact source).
 * A build without them is the typed `session_holder_unavailable` refusal.
 */
export async function readSessionTargetHolderArtifacts(platform: ManagedGuestPlatform): Promise<Readonly<{ holder: SessionHolderArtifact; helper: SessionHolderArtifact }>> {
    const holderPath = resolveSessionTargetHolderExecutablePath({ arch: platform.arch });
    const helperPath = resolveProcessCustodyTargetExecutable(platform.arch);
    if (platform.os !== 'linux' || !holderPath || !helperPath) {
        throw new PluginError({ code: 'session_holder_unavailable', retryable: false,
            message: `This Happier build has no Session holder for a ${platform.os}-${platform.arch} target` });
    }
    return { holder: await artifact(holderPath), helper: await artifact(helperPath) };
}
