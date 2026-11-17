import { describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import axios from 'axios';
import type { StoredCredentials } from '@/persistence';
import { updateSettings } from '@/persistence';
import { configuration, reloadConfiguration } from '@/configuration';
import { withTempDir } from '@/testkit/fs/tempDir';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { scmDiffSummaryResultStore } from '@/agent/executionRuns/tasks/scmDiffSummary/results/resultStore';
import { ScmDiffSummaryGenerateOutputSchema } from '@happier-dev/protocol/scm/diffSummary';
import { writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import nacl from 'tweetnacl';
import { createTargetedActionRpcRequestV1 } from '@happier-dev/protocol/actions/actionRpcTransport';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { projectExternalActionRequesterHttpAuthorization } from '@/api/externalActionExecutionAuthorization';
import { captureScmComparison, deleteCapturedScmComparison } from '@/scm/comparisons/captureScmComparison';
import { runWithScmAccountScope } from '@/scm/accountScope';
import { createGitWorkspace, createTestGitScmBackendRegistry, runGit } from '@/scm/rpc/__tests__/testRpcHarness';

import type { RpcHandler, RpcHandlerContext } from '@/api/rpc/types';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { registerScmHandlers } from './scm';

// Authentication persistence is the external boundary; RPC/Action dispatch stay real.
const persistence = vi.hoisted(() => ({ credentials: null as StoredCredentials | null }));
vi.mock('@/persistence', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/persistence')>(),
    readStoredCredentials: async () => persistence.credentials,
}));

describe('SCM diff-summary RPC admission', () => {
    it.each(['signed-custodian', 'stale-signed-custodian', 'shared-manage', 'session-origin', 'wrong-session',
        'exact-session', 'custodian', 'stale-custodian', 'use-owner', 'wrong-machine'] as const)(
        'uses one admission for captured index and immutable file evidence (%s)', async caller => {
        await withTempDir('scm-rpc-captured-admission-', async home => runWithScmAccountScope(
            caller === 'shared-manage' ? 'member' : 'owner', async () => {
            const env = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_ACTIVE_SERVER_ID']);
            const workspace = createGitWorkspace();
            const sessionId = 'c222222222222222222222222';
            const captures: Array<{ comparisonId: string; sessionId?: string }> = [];
            try {
                env.patch({ HAPPIER_HOME_DIR: home, HAPPIER_ACTIVE_SERVER_ID: 'rpc-evidence-home' });
                reloadConfiguration();
                await updateSettings(settings => ({ ...settings, machineIdByServerId: { 'rpc-evidence-home': 'machine' } }));
                persistence.credentials = { token: `fixture.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`, encryption: null };
                writeFileSync(join(workspace, 'a.txt'), 'before\n');
                runGit(workspace, ['add', 'a.txt']); runGit(workspace, ['commit', '-m', 'base']);
                writeFileSync(join(workspace, 'a.txt'), 'pinned bytes\n');
                const scoped = await captureScmComparison({ cwd: workspace, sessionId,
                    source: { kind: 'workingTree' }, registry: createTestGitScmBackendRegistry() });
                const standalone = await runWithScmAccountScope('owner', () => captureScmComparison({ cwd: workspace,
                    source: { kind: 'workingTree' }, registry: createTestGitScmBackendRegistry() }));
                captures.push({ comparisonId: scoped.comparison.id, sessionId }, { comparisonId: standalone.comparison.id });
                writeFileSync(join(workspace, 'a.txt'), 'mutated live bytes\n');
                let sessionReads = 0;
                // Only Home HTTP and stored credentials are boundaries. Registration,
                // Action admission, signed requester ports and capture storage stay real.
                vi.spyOn(axios, 'get').mockImplementation(async url => {
                    const path = new URL(String(url)).pathname;
                    if (path === '/v1/account/encryption/currentness') return { status: 200, data: {
                        mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
                    } };
                    if (path === '/v1/account/profile') return { status: 200, data: { id: 'owner' } };
                    if (path === '/v2/account/settings') return { status: 200, data: { content: { t: 'plain', v: {} }, version: 1 } };
                    if (path.endsWith(`/sessions/${sessionId}`)) {
                        sessionReads++;
                        if (caller === 'shared-manage' || caller === 'session-origin') return { status: 200, data: {
                            session: createSessionRecordFixture({ id: sessionId, encryptionMode: 'plain', machineId: 'machine',
                                metadata: JSON.stringify({ path: workspace }), share: null }),
                        } };
                    }
                    return { status: 404, data: {} };
                });
                const handlers = new Map<string, RpcHandler>();
                registerScmHandlers({ registerHandler: (method, handler) => { handlers.set(method, handler); } }, workspace,
                    { machineId: 'machine', accessPolicy: { kind: 'restrictedRoots', roots: [workspace] } });
                const target = { kind: 'machine' as const, machineId: 'machine', project: { machineId: 'machine', directory: workspace } };
                const keys = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(8));
                let currentChecks = 0;
                const invoke = async (actionId: 'scm.diffSummary.capture' | 'scm.diff.file', input: unknown, unbound = false) => {
                    const signed = caller.includes('signed') || caller === 'wrong-session';
                    const proof = signed ? await projectExternalActionRequesterHttpAuthorization({
                        authorization: ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-admitted-original-action',
                            binding: { accountId: 'owner', custodianAccountId: 'owner', authentication: { kind: 'account', tokenEpoch: 0 },
                                accountEncryptionMode: 'plain', serverIdentityId: 'rpc-evidence-home', machineId: 'machine',
                                installationId: 'installation', actionId, requestId: 'request', requestEnvelopeDigest: 'A'.repeat(43), target } }),
                        serverId: 'rpc-evidence-home', serverIdentityId: 'rpc-evidence-home', serverHttpBaseUrl: configuration.serverUrl,
                        target, installationId: 'installation', privateKey: keys.secretKey, rootAdmitted: true,
                        isCurrent: async () => { currentChecks++; return caller !== 'stale-signed-custodian'; },
                    }) : null;
                    const ingress: RpcHandlerContext = { signal: new AbortController().signal,
                        ...(caller === 'wrong-session' || caller === 'exact-session' ? { authorization: { kind: 'session.write',
                            sessionId: caller === 'exact-session' ? sessionId : 'foreign-session' } } : {}),
                        ...(!caller.includes('signed') ? { machineAdmission: {
                            actorAccountId: caller === 'shared-manage' ? 'member' : 'owner', custodianAccountId: 'owner',
                            machineId: caller === 'wrong-machine' ? 'foreign-machine' : 'machine', installationId: 'installation',
                            role: caller === 'use-owner' ? 'use' : 'manage', encryptionMode: 'plain' },
                            verifyMachineAdmissionCurrent: async () => { currentChecks++; return caller !== 'stale-custodian'; },
                        } : {}),
                        ...(caller === 'session-origin' ? { sessionActionOrigin: { v: 1,
                            caller: { kind: 'session', sessionId, starterDepth: 0, turnDepth: 0 },
                            sourceTurnId: 'turn', callerPermissionMode: 'default', requestId: 'request' } } : {}),
                        // Original account-authenticated public Actions retain their
                        // admitted UI origin; ordinary socket callers remain RPC.
                        localActionContext: { surface: proof ? 'ui' : 'rpc',
                            ...(proof ? { externalActionExecutionAuthorization: proof } : {}) },
                    };
                    return await handlers.get(actionId)!(createTargetedActionRpcRequestV1(input,
                        unbound ? { kind: 'machine', machineId: 'machine' } : target), ingress);
                };
                const allowedScoped = ['signed-custodian', 'shared-manage', 'session-origin', 'custodian', 'exact-session'].includes(caller);
                // A Session-origin workspace is bound to its Session before storage
                // lookup. The existing repository-capture fallback remains available.
                const allowedStandalone = caller === 'signed-custodian' || caller === 'custodian' || caller === 'session-origin';
                for (const [captured, scope, allowed] of [[scoped, sessionId, allowedScoped], [standalone, undefined, allowedStandalone]] as const) {
                    const index = await invoke('scm.diffSummary.capture', { cwd: workspace, comparisonId: captured.comparison.id,
                        source: captured.comparison.source, ...(scope ? { sessionId: scope } : {}), projection: { kind: 'index' } });
                    expect.soft(index, JSON.stringify(index)).toMatchObject(allowed ? { success: true, comparison: { inventory: { files: [{ path: 'a.txt' }] } } }
                        : { success: false });
                    const file = await invoke('scm.diff.file', { cwd: workspace, captured: { comparisonId: captured.comparison.id,
                        source: captured.comparison.source, path: 'a.txt', ...(scope ? { sessionId: scope } : {}) } });
                    expect.soft(file, JSON.stringify(file)).toMatchObject(allowed ? { success: true, diff: expect.stringContaining('+pinned bytes'),
                        capturedFile: { path: 'a.txt' } } : { success: false });
                    expect.soft(JSON.stringify(file)).not.toContain('mutated live bytes');
                }
                if (caller === 'session-origin') {
                    for (const scope of [undefined, 'foreign-session']) {
                        expect(await invoke('scm.diffSummary.capture', { cwd: workspace, comparisonId: standalone.comparison.id,
                            source: standalone.comparison.source, ...(scope ? { sessionId: scope } : {}), projection: { kind: 'index' } }, true))
                            .toMatchObject({ success: false });
                        expect(await invoke('scm.diff.file', { cwd: workspace, captured: { comparisonId: standalone.comparison.id,
                            source: standalone.comparison.source, path: 'a.txt', ...(scope ? { sessionId: scope } : {}) } }, true))
                            .toMatchObject({ success: false });
                    }
                }
                if (caller === 'session-origin') expect(sessionReads).toBeGreaterThan(0);
                // Machine admission selects the member's private shelf directly;
                // it never reacquires Session authority for each captured read.
                if (caller === 'shared-manage') expect(sessionReads).toBe(0);
                if (caller === 'signed-custodian') expect(sessionReads).toBe(0);
                if (caller === 'custodian') expect(currentChecks).toBe(4);
            } finally {
                for (const capture of captures) await runWithScmAccountScope(capture.sessionId
                    && caller === 'shared-manage' ? 'member' : 'owner', () => deleteCapturedScmComparison({ cwd: workspace, ...capture }));
                await rm(workspace, { recursive: true, force: true });
                persistence.credentials = null;
                vi.restoreAllMocks(); env.restore(); reloadConfiguration();
            }
        }));
    });
    it.each(['unrelated-session-proof', 'shared-use', 'exact-session-proof', 'custodian', 'stale-custodian'] as const)(
        'enforces saved-result scope through the default receiving factory (%s)', async caller => {
        await withTempDir('scm-rpc-result-scope-', async home => runWithScmAccountScope(
            caller === 'shared-use' ? 'shared-member' : 'owner', async () => {
            const env = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_ACTIVE_SERVER_ID']);
            try {
                env.patch({ HAPPIER_HOME_DIR: home, HAPPIER_ACTIVE_SERVER_ID: 'rpc-scope-home' });
                reloadConfiguration();
                await updateSettings(settings => ({ ...settings, machineIdByServerId: { 'rpc-scope-home': 'machine' } }));
                persistence.credentials = { token: `fixture.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`, encryption: null };
                const sessionId = 'c111111111111111111111111';
                // Only HTTP and credential persistence are replaced. Session records use
                // the real boundary fixture; registration, policy, deps and storage are real.
                vi.spyOn(axios, 'get').mockImplementation(async url => {
                    const path = new URL(String(url)).pathname;
                    if (path === '/v1/account/encryption/currentness') return { status: 200, data: {
                        mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
                    } };
                    if (path === '/v1/account/profile') return { status: 200, data: { id: 'owner' } };
                    if (path === '/v2/account/settings') return { status: 200, data: { content: { t: 'plain', v: {
                        actionsSettingsV1: { v: 1, actions: {}, approvalWaivedSurfaces: {
                            'scm.diffSummary.result.edit': ['ui'], 'scm.diffSummary.result.undo': ['ui'],
                            'scm.diffSummary.result.delete': ['ui'], 'scm.diffSummary.result.clear': ['ui'],
                        } },
                    } }, version: 1 } };
                    if (path.endsWith(`/sessions/${sessionId}`) && caller === 'shared-use') return { status: 200, data: {
                        session: createSessionRecordFixture({ id: sessionId, encryptionMode: 'plain', machineId: 'machine',
                            metadata: JSON.stringify({ path: home }), share: null }),
                    } };
                    return { status: 404, data: {} };
                });
                const output = ScmDiffSummaryGenerateOutputSchema.parse({ success: true, sourceKey: 'scope-comparison',
                    metadata: { source: { kind: 'workingTree' }, sourceKey: 'scope-comparison' },
                    comparison: { id: 'scope-comparison', source: { kind: 'workingTree' }, repository: { rootPath: home },
                        endpoints: {}, inventory: { state: 'complete', files: [], reasons: [] } },
                    requestedOutputs: ['walkthrough'], outputs: { walkthrough: { state: 'complete', value: {
                        title: 'Standalone private title', intro: 'Standalone private prose', stops: [], otherChangeRefs: [],
                    } } }, analysis: { suppliedChangeRefs: [], analysedChangeRefs: [], remainingChangeRefs: [] },
                });
                const standalone = await scmDiffSummaryResultStore.create({ cwd: home, output });
                const bound = await scmDiffSummaryResultStore.create({ cwd: home, sessionId, output: { ...output,
                    outputs: { walkthrough: { state: 'complete', value: {
                        title: 'Session title', intro: 'Session prose', stops: [], otherChangeRefs: [],
                    } } },
                } });
                const handlers = new Map<string, RpcHandler>();
                registerScmHandlers({ registerHandler: (method, handler) => { handlers.set(method, handler); } }, home,
                    { machineId: 'machine', accessPolicy: { kind: 'restrictedRoots', roots: [home] } });
                let verifications = 0;
                const ingress: RpcHandlerContext = { signal: new AbortController().signal,
                    ...(caller.endsWith('session-proof') ? { authorization: { kind: 'session.write',
                        sessionId: caller === 'exact-session-proof' ? sessionId : 'unrelated-session' } } : {
                        machineAdmission: { actorAccountId: caller === 'shared-use' ? 'shared-member' : 'owner',
                            custodianAccountId: 'owner', machineId: 'machine', installationId: 'installation',
                            role: caller === 'shared-use' ? 'use' : 'manage', encryptionMode: 'plain' },
                        verifyMachineAdmissionCurrent: async () => { verifications++; return caller !== 'stale-custodian'; },
                    }),
                };
                const invoke = (method: string, request: unknown) => handlers.get(method)!(request, ingress);
                const custodian = caller === 'custodian';
                const sessionAllowed = custodian || caller === 'exact-session-proof' || caller === 'shared-use';
                const listed = await invoke('scm.diffSummary.result.list', {});
                expect.soft(listed).toMatchObject({ success: true, count: custodian ? 2 : sessionAllowed ? 1 : 0 });
                if (custodian) expect.soft(verifications).toBe(1); // Currentness is per Action, not per saved row.
                if (!custodian) {
                    expect.soft(JSON.stringify(listed)).not.toContain(standalone.resultId);
                    expect.soft(JSON.stringify(listed)).not.toContain('Standalone private');
                }
                expect.soft(await invoke('scm.diffSummary.result.read', { cwd: home, resultId: standalone.resultId }))
                    .toMatchObject(custodian ? { success: true, result: { resultId: standalone.resultId } }
                        : { success: false, errorCode: 'result_unavailable' });
                expect.soft(await invoke('scm.diffSummary.result.read', { cwd: home, resultId: bound.resultId }))
                    .toMatchObject(sessionAllowed ? { success: true, result: { resultId: bound.resultId } }
                        : { success: false, errorCode: 'result_unavailable' });
                const request = { cwd: home, resultId: standalone.resultId, expectedRevision: 0 };
                if (!custodian) {
                    for (const [method, input] of [
                        ['scm.diffSummary.result.edit', { ...request, edit: { kind: 'renameWalkthrough', title: 'Unauthorized' } }],
                        ['scm.diffSummary.result.undo', request], ['scm.diffSummary.result.delete', request],
                    ] as const) expect.soft(await invoke(method, input)).toMatchObject({ success: false, errorCode: 'result_unavailable' });
                    expect.soft(await invoke('scm.diffSummary.result.clear', { results: [{ ...request, comparisonId: 'scope-comparison' }] }))
                        .toMatchObject({ success: true, deleted: [], failures: [{ resultId: standalone.resultId, errorCode: 'result_unavailable' }] });
                    expect.soft(await scmDiffSummaryResultStore.read(request)).toMatchObject({ success: true,
                        result: { revision: 0, output: { outputs: { walkthrough: { value: { title: 'Standalone private title' } } } } } });
                } else {
                    expect(await invoke('scm.diffSummary.result.edit', { ...request, edit: { kind: 'renameWalkthrough', title: 'Edited' } }))
                        .toMatchObject({ success: true, result: { revision: 1 } });
                    expect(await invoke('scm.diffSummary.result.undo', { ...request, expectedRevision: 1 }))
                        .toMatchObject({ success: true, result: { revision: 2, output: { outputs: { walkthrough: { value: { title: 'Standalone private title' } } } } } });
                    expect(await invoke('scm.diffSummary.result.clear', { results: [{ ...request, expectedRevision: 2, comparisonId: 'scope-comparison' }] }))
                        .toMatchObject({ success: true, failures: [], deleted: [{ resultId: standalone.resultId }] });
                }
            } finally {
                persistence.credentials = null;
                vi.restoreAllMocks();
                env.restore(); reloadConfiguration();
            }
        }));
    });
    it('keeps custodian results reachable after Session deletion through the registered receiving factory', async () => {
        await withTempDir('scm-rpc-retained-custody-', async home => runWithScmAccountScope('owner', async () => {
            const env = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_ACTIVE_SERVER_ID']);
            try {
                env.patch({ HAPPIER_HOME_DIR: home, HAPPIER_ACTIVE_SERVER_ID: 'rpc-custody-home' });
                reloadConfiguration();
                await updateSettings(settings => ({ ...settings, machineIdByServerId: { 'rpc-custody-home': 'machine' } }));
                persistence.credentials = { token: `fixture.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`, encryption: null };
                // HTTP and credential persistence are the boundaries. Receiving registration,
                // executor construction, policy, scope admission and filesystem store remain real.
                vi.spyOn(axios, 'get').mockImplementation(async url => {
                    const path = new URL(String(url)).pathname;
                    if (path === '/v1/account/encryption/currentness') return { status: 200, data: {
                        mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
                    } };
                    if (path === '/v1/account/profile') return { status: 200, data: { id: 'owner' } };
                    if (path === '/v2/account/settings') return { status: 200, data: { content: { t: 'plain', v: {} }, version: 1 } };
                    return { status: 404, data: {} };
                });
                const saved = await scmDiffSummaryResultStore.create({ cwd: home, sessionId: 'deleted-session',
                    output: ScmDiffSummaryGenerateOutputSchema.parse({ success: true, sourceKey: 'retained',
                        metadata: { source: { kind: 'workingTree' }, sourceKey: 'retained' },
                        comparison: { id: 'retained', source: { kind: 'workingTree' }, repository: { rootPath: home },
                            endpoints: {}, inventory: { state: 'complete', files: [], reasons: [] } },
                        requestedOutputs: ['summary'], outputs: { summary: { state: 'complete', value: { summaryMarkdown: 'Retained' } } },
                        analysis: { suppliedChangeRefs: [], analysedChangeRefs: [], remainingChangeRefs: [] },
                    }) });
                const handlers = new Map<string, RpcHandler>();
                registerScmHandlers({ registerHandler: (method, handler) => { handlers.set(method, handler); } }, home,
                    { machineId: 'machine', accessPolicy: { kind: 'restrictedRoots', roots: [home] } });
                const ingress = { signal: new AbortController().signal,
                    machineAdmission: { actorAccountId: 'owner', custodianAccountId: 'owner', machineId: 'machine',
                        installationId: 'installation', role: 'manage' as const, encryptionMode: 'plain' as const },
                    verifyMachineAdmissionCurrent: async () => true };
                expect(await handlers.get('scm.diffSummary.result.list')!({ query: { cwd: home, sessionId: 'deleted-session' } }, ingress))
                    .toMatchObject({ success: true, count: 1, results: [{ resultId: saved.resultId }] });
                expect(await handlers.get('scm.diffSummary.result.read')!({ cwd: home, resultId: saved.resultId }, ingress))
                    .toMatchObject({ success: true, result: { resultId: saved.resultId } });
            } finally {
                persistence.credentials = null;
                vi.restoreAllMocks();
                env.restore(); reloadConfiguration();
            }
        }));
    });
    it('rejects unauthenticated saved-result reads and edits through the same Action admission', async () => {
        const handlers = new Map<string, RpcHandler>();
        registerScmHandlers({ registerHandler: (method, handler) => { handlers.set(method, handler); } }, '/workspace');
        for (const [method, request] of [
            [RPC_METHODS.SCM_BLAME_FILE, { cwd: '/workspace', path: 'a.ts' }],
            ['scm.diffSummary.result.list', {}],
            ['scm.diffSummary.result.clear', { results: [] }],
            ['scm.diffSummary.result.read', { cwd: '/workspace', resultId: 'saved' }],
            ['scm.diffSummary.result.edit', { cwd: '/workspace', resultId: 'saved', expectedRevision: 0, edit: { kind: 'renameWalkthrough', title: 'Manual title' } }],
        ] as const) {
            const handler = handlers.get(method);
            expect(handler).toBeDefined();
            if (!handler) continue;
            await expect(handler(request)).resolves.toMatchObject({ ok: false, errorCode: 'not_authenticated' });
        }
    });
    it('provides the canonical RPC operation and rejects unauthenticated generation', async () => {
        const handlers = new Map<string, RpcHandler>();
        registerScmHandlers({ registerHandler: (method, handler) => { handlers.set(method, handler); } }, '/workspace');
        const handler = handlers.get(RPC_METHODS.SCM_DIFF_SUMMARY_GENERATE);
        expect(handler).toBeDefined();
        if (!handler) return;
        await expect(handler({ sessionId: 'session-1', cwd: '/workspace', source: { kind: 'workingTree' } }))
            .resolves.toMatchObject({ ok: false, errorCode: 'not_authenticated' });
        const capture = handlers.get(RPC_METHODS.SCM_DIFF_SUMMARY_CAPTURE);
        expect(capture).toBeDefined();
        if (!capture) return;
        await expect(capture({ sessionId: 'session-1', cwd: '/workspace', source: { kind: 'workingTree' } }))
            .resolves.toMatchObject({ ok: false, errorCode: 'not_authenticated' });
    });
});
