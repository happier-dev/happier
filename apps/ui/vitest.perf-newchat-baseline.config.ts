import { defineConfig, mergeConfig } from 'vitest/config';
import base from './vitest.config';

// Temporary validation basis: restore only PERF-NEWCHAT's cancellation delta
// in memory, preserving the shared checkout and every other lane's changes.
const current = 'params.targetAccountScope?.serverId ?? params.draftScope?.serverId,\n        params.targetAccountScope?.accountId ?? params.draftScope?.accountId,';
const predecessor = 'params.targetAccountScope?.serverId, params.targetAccountScope?.accountId,';

export default mergeConfig(base, defineConfig({
    plugins: [{
        name: 'perf-newchat-cancellation-predecessor',
        enforce: 'pre',
        transform(code, id) {
            if (!id.split('?')[0]?.replaceAll('\\', '/').endsWith('/hooks/useCreateNewSession.ts')) return;
            if (!code.includes(current)) throw new Error('PERF-NEWCHAT cancellation basis no longer matches');
            return { code: code.replace(current, predecessor), map: null };
        },
    }],
}));
