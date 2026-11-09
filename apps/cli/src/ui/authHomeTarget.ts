import { HomeTargetResolutionError, type ResolvedHomeTarget } from '@happier-dev/cli-common/homeTarget';

import { configuration } from '@/configuration';
import { resolveCliHomeTarget, resolveCurrentCliHomeTarget } from '@/server/homeTarget';

export async function resolveTerminalAuthHomeTarget(): Promise<ResolvedHomeTarget | null> {
    try {
        const selectedTarget = await resolveCurrentCliHomeTarget();
        return selectedTarget.descriptor
            ? selectedTarget
            : await resolveCliHomeTarget({ kind: 'https_url', url: configuration.apiServerUrl });
    } catch (error) {
        console.log(error instanceof HomeTargetResolutionError
            ? `${error.code}: ${error.message}`
            : 'The selected Home address is not eligible for terminal authentication. Use HTTPS or loopback HTTP.');
        return null;
    }
}
