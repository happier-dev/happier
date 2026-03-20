import type { Capability } from '../service';
import { CapabilityError } from '../errors';
import { getCodexAcpDepStatus, installCodexAcp } from '../deps/codexAcp';
import { CODEX_ACP_DEP_ID } from '@happier-dev/protocol/installables';

export const codexAcpDepCapability: Capability = {
    descriptor: {
        id: CODEX_ACP_DEP_ID,
        kind: 'dep',
        title: 'Codex ACP',
        methods: {
            install: { title: 'Install' },
            upgrade: { title: 'Upgrade' },
        },
    },
    detect: async ({ request }) => {
        const includeLatestVersion = Boolean((request.params ?? {}).includeLatestVersion);
        const onlyIfInstalled = Boolean((request.params ?? {}).onlyIfInstalled);
        return await getCodexAcpDepStatus({ includeLatestVersion, onlyIfInstalled });
    },
    invoke: async ({ method }) => {
        if (method !== 'install' && method !== 'upgrade') {
            throw new CapabilityError(`Unsupported method: ${method}`, 'unsupported-method');
        }

        const result = await installCodexAcp();
        if (!result.ok) {
            return { ok: false, error: { message: result.errorMessage, code: 'install-failed' }, logPath: result.logPath };
        }
        return { ok: true, result: { logPath: result.logPath } };
    },
};
