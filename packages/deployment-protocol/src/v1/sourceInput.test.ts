import { describe, expect, it } from 'vitest';

import { createDeploymentTargetV1, createDeploymentV1, createDeploymentEnvironmentV1 } from '../testing/v1.js';
import { DeploymentPendingDeployV1Schema, DeploymentSourceIntentV1Schema, DeploymentV1Schema } from './deployment.js';
import { DeploymentTargetV1Schema } from './target.js';
import { DeploymentDeployAdmissionInputV1Schema, DeploymentEnvironmentGetResultV1Schema, DeploymentDeployIntentInputV1Schema } from '@happier-dev/protocol';
import { createDeploymentEnvironmentHeaderV1 } from '../testing/v1.js';
import { DeploymentEnvironmentV1Schema } from './environment.js';

describe('protected pending transport', () => {
    it('carries explicit supersession through admission and the exact Environment read without flattening private intent', () => {
        const receipt = createDeploymentV1();
        if (receipt.content.t !== 'plain') throw new Error('Expected opened receipt fixture');
        const pendingDeploy = DeploymentPendingDeployV1Schema.parse({ t: 'plain', v: {
            sourceIntent: receipt.content.v.sourceIntent, requestKey: receipt.requestKey,
            targetLinkId: receipt.targetLinkId, actionOperationId: receipt.actionOperationId,
        } });
        const input = { serverId: 'home', environmentId: receipt.environmentId, expectedRevision: 1,
            targetLinkId: receipt.targetLinkId, expectedTargetLinkRevision: 1, requestKey: receipt.requestKey,
            actionOperationId: receipt.actionOperationId, contentArtifactId: 'candidate', contentHeaderVersion: 1, contentBodyVersion: 1,
            whenBusy: 'supersede', pendingDeploy };
        expect(DeploymentDeployAdmissionInputV1Schema.parse(input)).toEqual(input);
        expect(DeploymentEnvironmentGetResultV1Schema.parse({ ok: true, environment: createDeploymentEnvironmentHeaderV1(),
            targetLinks: [], pendingDeploy })).toMatchObject({ pendingDeploy });
        expect(DeploymentEnvironmentV1Schema.parse({ ...createDeploymentEnvironmentV1(), pendingDeploy }).pendingDeploy).toEqual(pendingDeploy);
        const encrypted = { t: 'encrypted', c: 'sealed-pending' };
        expect(DeploymentDeployAdmissionInputV1Schema.parse({ ...input, pendingDeploy: encrypted }).pendingDeploy).toEqual(encrypted);
        expect(DeploymentDeployAdmissionInputV1Schema.safeParse({ ...input, whenBusy: 'queue' }).success).toBe(false);
        expect(DeploymentDeployAdmissionInputV1Schema.safeParse({ ...input, whenBusy: 'refuse' }).success).toBe(false);
        expect(DeploymentDeployAdmissionInputV1Schema.safeParse({ ...input, actionOperationId: 'foreign-operation' }).success).toBe(false);
        expect(DeploymentDeployAdmissionInputV1Schema.safeParse({ ...input, pendingDeploy: { t: 'plain', c: 'sealed-pending' } }).success).toBe(false);
        expect(DeploymentDeployAdmissionInputV1Schema.safeParse({ ...input, pendingDeploy: { t: 'plain', v: {
            ...(pendingDeploy.t === 'plain' ? pendingDeploy.v : {}), requestKey: 'other-request',
        } } }).success).toBe(false);
    });
});

describe('platform upload and PR-head provenance', () => {
    it('admits the explicit platform method on the originating deploy intent without selecting a fallback', () => {
        const intent = { serverId: 'home', environmentId: 'environment', targetLinkId: 'platform', sourceMethod: 'upload' };
        expect(DeploymentDeployIntentInputV1Schema.parse(intent)).toEqual(intent);
        expect(DeploymentDeployIntentInputV1Schema.safeParse({ ...intent, sourceMethod: 'fallback' }).success).toBe(false);
        const { sourceMethod: _method, ...existingIntent } = intent;
        expect(DeploymentDeployIntentInputV1Schema.parse(existingIntent)).toEqual(existingIntent);
    });
    it('reads the normalized managed capability without runtime roles or a provider bag', () => {
        const runtime = createDeploymentTargetV1();
        const { actions: _runtimeActions, ...common } = runtime;
        const target = { ...common, role: 'data', targetKind: 'database',
            source: { kind: 'plugin', contribution: { pluginId: 'example.deploy', localId: 'database' } },
            dataV1: {
                projects: { list: { kind: 'plugin', resourceId: 'example.deploy/projects/list' } },
                branches: { create: { kind: 'plugin', actionId: 'example.deploy/actions/branches/create' } },
            },
        };
        expect(DeploymentTargetV1Schema.parse(target)).toEqual(target);
        expect(DeploymentTargetV1Schema.safeParse({ ...target, dataV1: { ...target.dataV1,
            provider: { arbitrary: true },
        } }).success).toBe(false);
        expect(DeploymentTargetV1Schema.safeParse({ ...target, dataV1: { projects: {
            list: { kind: 'plugin', resourceId: 'unqualified' },
        } } }).success).toBe(false);
        expect(DeploymentTargetV1Schema.safeParse({ ...target, actions: runtime.actions }).success).toBe(false);
        expect(DeploymentTargetV1Schema.safeParse({ ...target, dataV1: { query: {
            readOnly: { kind: 'plugin', actionId: 'foreign.plugin/actions/query' },
        } } }).success).toBe(false);
        expect(DeploymentTargetV1Schema.safeParse({ ...target, dataV1: { projects: {
            list: { kind: 'plugin', resourceId: 'foreign.plugin/projects/list' },
        } } }).success).toBe(false);
    });

    it('retains the effective method and authoritative PR selector beside the immutable SHA', () => {
        const receipt = createDeploymentV1();
        if (receipt.content.t !== 'plain' || receipt.content.v.sourceIntent.kind !== 'repository') throw new Error('Expected repository fixture');
        const content = { ...receipt.content.v, sourceMethod: 'upload',
            sourceIntent: { ...receipt.content.v.sourceIntent, pullRequestHead: { number: 42 } } };
        expect(DeploymentV1Schema.parse({ ...receipt, content: { t: 'plain', v: content } }).content).toEqual({ t: 'plain', v: content });
        const pending = { t: 'plain', v: { sourceIntent: content.sourceIntent, sourceMethod: content.sourceMethod,
            targetLinkId: receipt.targetLinkId, requestKey: receipt.requestKey,
            actionOperationId: receipt.actionOperationId } };
        expect(DeploymentPendingDeployV1Schema.parse(JSON.parse(JSON.stringify(pending)))).toEqual(pending);
        expect(DeploymentPendingDeployV1Schema.safeParse({ ...pending, v: { ...pending.v, origin: 'trigger' } }).success).toBe(false);
        expect(DeploymentSourceIntentV1Schema.safeParse({ ...content.sourceIntent, pullRequestHead: { number: 0 } }).success).toBe(false);
        expect(DeploymentSourceIntentV1Schema.safeParse({ ...content.sourceIntent, repository: 'fork/override' }).success).toBe(false);
        expect(DeploymentSourceIntentV1Schema.safeParse({ ...content.sourceIntent, sha: 'main' }).success).toBe(false);
        expect(DeploymentV1Schema.safeParse({ ...receipt, content: { t: 'plain', v: { ...content, sourceMethod: 'fallback' } } }).success).toBe(false);
    });

    it('retains the optional qualified upload role on the normalized platform descriptor', () => {
        const target = createDeploymentTargetV1();
        const descriptor = { ...target, targetKind: 'platform',
            source: { kind: 'plugin', contribution: { pluginId: 'happier.deploy.example', localId: 'platform' } },
            actions: { ...target.actions, uploadDeploy: { kind: 'plugin', actionId: 'happier.deploy.example/actions/deploy-upload-v1' } } };
        expect(DeploymentTargetV1Schema.parse(descriptor)).toEqual(descriptor);
        expect(DeploymentTargetV1Schema.safeParse({ ...descriptor, actions: { ...descriptor.actions,
            uploadDeploy: { kind: 'plugin', actionId: 'deploy-upload-v1' } } }).success).toBe(false);
        expect(DeploymentTargetV1Schema.safeParse({ ...descriptor, actions: { ...descriptor.actions,
            uploadDeploy: { kind: 'plugin', actionId: 'happier.foreign/actions/deploy-upload-v1' } } }).success).toBe(false);
    });
});
