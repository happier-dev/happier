import * as React from 'react';
import { createFeatureDecision, type FeatureDecision, type FeatureId } from '@happier-dev/protocol';
import type { Settings } from '@/sync/domains/settings/settings';

import {
    getCachedServerFeaturesSnapshot,
    getServerFeaturesSnapshot,
    type ServerFeaturesSnapshot,
} from '@/sync/api/capabilities/serverFeaturesClient';
import { subscribeActiveServer } from '@/sync/domains/server/serverRuntime';
import { evaluateFeatureDecision } from './featureDecisionEngine';
import { getFeatureBuildPolicyDecision } from './featureBuildPolicy';
import { resolveLocalFeaturePolicyEnabled } from './featureLocalPolicy';
import { getUiFeatureDefinition } from './featureRegistry';

export type ServerFeaturesRuntimeSnapshot =
    | Readonly<{ status: 'loading' }>
    | ServerFeaturesSnapshot;

export function useServerFeaturesRuntimeSnapshot(): ServerFeaturesRuntimeSnapshot {
    const [snapshot, setSnapshot] = React.useState<ServerFeaturesRuntimeSnapshot>(() => {
        const cached = getCachedServerFeaturesSnapshot();
        return cached ?? { status: 'loading' };
    });

    React.useEffect(() => {
        let cancelled = false;
        let requestToken = 0;

        const loadForServerId = async (serverId: string | undefined, force?: boolean) => {
            const token = requestToken + 1;
            requestToken = token;
            const next = await getServerFeaturesSnapshot({
                serverId,
                ...(force ? { force: true } : {}),
            });
            if (!cancelled && token === requestToken) {
                setSnapshot(next);
            }
        };

        const unsubscribe = subscribeActiveServer((active) => {
            const serverId = typeof (active as any)?.serverId === 'string' ? String((active as any).serverId).trim() : '';
            if (!serverId) return;

            const cached = getCachedServerFeaturesSnapshot({ serverId });
            setSnapshot(cached ?? { status: 'loading' });
            void loadForServerId(serverId, true);
        });

        void (async () => {
            const cached = getCachedServerFeaturesSnapshot();
            if (cached) {
                if (!cancelled) setSnapshot(cached);
                return;
            }
            await loadForServerId(undefined, false);
        })();

        return () => {
            cancelled = true;
            unsubscribe();
        };
    }, []);

    return snapshot;
}

export function resolveFeatureDecision(params: {
    featureId: FeatureId;
    settings: Settings;
    snapshot: ServerFeaturesRuntimeSnapshot;
}): FeatureDecision | null {
    const definition = getUiFeatureDefinition(params.featureId);

    if (params.snapshot.status === 'loading' && definition.serverRequired) {
        return null;
    }

    if (params.snapshot.status === 'error' && definition.serverRequired) {
        return createFeatureDecision({
            featureId: params.featureId,
            state: 'unknown',
            blockedBy: 'server',
            blockerCode: 'probe_failed',
            diagnostics: [`server_error:${params.snapshot.reason}`],
            evaluatedAt: Date.now(),
            scope: { scopeKind: 'runtime' },
        });
    }

    if (params.snapshot.status === 'unsupported' && definition.serverRequired) {
        return createFeatureDecision({
            featureId: params.featureId,
            state: 'unsupported',
            blockedBy: 'server',
            blockerCode: params.snapshot.reason === 'endpoint_missing' ? 'endpoint_missing' : 'misconfigured',
            diagnostics: [`server_unsupported:${params.snapshot.reason}`],
            evaluatedAt: Date.now(),
            scope: { scopeKind: 'runtime' },
        });
    }

    const buildPolicy = getFeatureBuildPolicyDecision(params.featureId);
    const localPolicyEnabled = resolveLocalFeaturePolicyEnabled(params.featureId, params.settings);

    const serverSupported = !definition.serverRequired || params.snapshot.status === 'ready';
    const serverEnabled =
        !definition.serverRequired
            ? true
            : params.snapshot.status === 'ready'
                ? definition.serverEnabled(params.snapshot.features)
                : false;

    return evaluateFeatureDecision({
        featureId: params.featureId,
        supportsClient: true,
        buildPolicy,
        localPolicyEnabled,
        serverSupported,
        serverEnabled,
    });
}
