import { describe, expect, it } from 'vitest';
import { SessionModelSelectionSchema } from '@happier-dev/protocol/providers/selection/v2';
import { captureSessionLaunchControlMetadata } from '../createSessionMetadata';
import { readPersistedProviderResumeState } from '@/providers/lifecycle/readPersistedResumeSelection';
import { createDeferredStartupMetadataPlan } from './createDeferredStartupMetadataPlan';

const nativeRef = { agentTargetKey: 'agent:happier.agent.muse/muse', modelId: 'meta/muse-spark-1.3-contributor' };

describe('deferred startup → launch intent reader', () => {
    it.each([
        { v: 1, updatedAt: 1794915637618, ref: { ...nativeRef, providerConnectionId: null } },
        // Redacted selection from FW-BROWSER-1115/r119/spawn-input.json.
        { v: 2, updatedAt: 1794915637618, ref: { ...nativeRef, source: 'native' } },
        { v: 2, updatedAt: 42, ref: { ...nativeRef, source: 'account_provider_connection', providerConnectionId: 'pc_work' } },
        { v: 2, updatedAt: 42, ref: { ...nativeRef, source: 'team_resource', resourceId: 'resource-1', teamId: 'team-1', expectedResourceRevision: 4, deliveryMode: 'brokered' } },
    ])('preserves the exact launch selection $v / $ref.source', raw => {
        const modelSelection = SessionModelSelectionSchema.parse(raw);
        const plan = createDeferredStartupMetadataPlan({
            flavor: 'muse', initialMachineId: '', directory: '/project', initialPermissionMode: 'default',
            launchControlMetadata: captureSessionLaunchControlMetadata({ processEnvironment: {} }), modelSelection,
        });
        for (const metadata of [plan.initialMetadata, plan.createInitializedSessionMetadata('machine-1').metadata]) {
            expect(readPersistedProviderResumeState(metadata).selection).toEqual(modelSelection);
            if (modelSelection.v === 2) expect(metadata).not.toHaveProperty('modelSelectionIntentV1');
        }
    });
});
