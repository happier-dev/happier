import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import type { RoleArtifactV1 } from '@happier-dev/protocol/prompts/roles/roleArtifactV1';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import { DEMO_NOW_MS } from './constants';

/**
 * A5 "One session. A whole team of agents."
 *
 * Role documents use the same Artifact shape as the live Roles catalog.
 * They remain in the demo-owned in-memory store and are removed on teardown.
 */
export function buildDemoRoleArtifacts(): DecryptedArtifact[] {
    const roles = [
        {
            id: 'demo-role-review',
            name: 'Send diffs out for a second opinion',
            instructions:
                'Before proposing a large change, delegate a review pass to a different agent and fold its findings back into this session.',
            enabled: true,
            runsAs: { kind: 'background_run', intent: 'review' },
            engine: { agentTargetKey: buildBackendTargetKeyV2({ kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } }) },
            workspaceWrites: 'deny',
            secondOpinion: 'off',
        },
        {
            id: 'demo-role-research',
            name: 'Delegate wide code searches',
            instructions:
                'Repository-wide searches and dependency archaeology go to a delegate so the main session keeps its context for the change itself.',
            enabled: true,
            runsAs: { kind: 'background_run', intent: 'delegate' },
            engine: { agentTargetKey: buildBackendTargetKeyV2({ kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } }) },
            workspaceWrites: 'deny',
            secondOpinion: 'off',
        },
        {
            id: 'demo-role-plan',
            name: 'Plan migrations before touching files',
            instructions:
                'Multi-package migrations start with a planning run that lists the owners and the order of the edits; implementation only starts once that plan comes back.',
            enabled: true,
            runsAs: { kind: 'background_run', intent: 'plan' },
            engine: { agentTargetKey: buildBackendTargetKeyV2({ kind: 'agent', identity: { pluginId: 'happier.agent.opencode', localId: 'opencode' } }) },
            workspaceWrites: 'deny',
            secondOpinion: 'off',
        },
    ] satisfies Array<RoleArtifactV1 & { id: string }>;
    return roles.map(({ id, ...role }, index) => ({
        id,
        header: { kind: 'role.v1', title: role.name, name: role.name },
        title: role.name,
        body: JSON.stringify(role),
        isDecrypted: true,
        storageMode: 'plain',
        access: 'owner',
        headerVersion: 1,
        bodyVersion: 1,
        seq: index + 1,
        createdAt: DEMO_NOW_MS,
        updatedAt: DEMO_NOW_MS,
    }));
}
