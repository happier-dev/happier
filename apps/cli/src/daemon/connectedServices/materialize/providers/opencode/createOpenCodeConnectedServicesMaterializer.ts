import type { ConnectedServicesMaterializer } from '@/daemon/connectedServices/materialization/materializer';
import { createBestEffortConnectedServicesMaterialization } from '@/daemon/connectedServices/materialization/materializer';
import { resolveConnectedServiceHomeDir } from '@/daemon/connectedServices/homes/resolveConnectedServiceHomeDir';

import { materializeOpenCodeConnectedServiceAuth } from './materializeOpenCodeConnectedServiceAuth';

export const createOpenCodeConnectedServicesMaterializer = (): ConnectedServicesMaterializer => {
    return async ({ activeServerDir, recordsByServiceId }) => {
        const openaiCodex = recordsByServiceId.get('openai-codex') ?? null;
        const openai = recordsByServiceId.get('openai') ?? null;
        const anthropic = recordsByServiceId.get('anthropic') ?? null;

        if (!openaiCodex && !openai && !anthropic) return null;

        const primary = openaiCodex ?? openai ?? anthropic;
        if (!primary) return null;

        const stableRootDir = resolveConnectedServiceHomeDir({
            activeServerDir,
            serviceId: primary.serviceId,
            profileId: primary.profileId,
            agentId: 'opencode',
        });

        const materialized = await materializeOpenCodeConnectedServiceAuth({
            rootDir: stableRootDir,
            openaiCodex,
            openai,
            anthropic,
        });

        return createBestEffortConnectedServicesMaterialization({
            rootDir: stableRootDir,
            env: materialized.env,
        });
    };
};
