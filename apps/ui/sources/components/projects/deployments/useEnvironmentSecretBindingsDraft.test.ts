import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as React from 'react';
import type { DeploymentEnvironmentDetailV1 } from '@happier-dev/deployment-protocol';
import { createDeploymentEnvironmentDetailV1, createDeploymentSecretVariableBindingV1 } from '@happier-dev/deployment-protocol/testing/v1';
import type { DeploymentReadSnapshotV1 } from '@happier-dev/deployments';
import { DeploymentActionInputSchemasV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { answerExternalActionAccountForHome } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import { environmentSecretBindingIdentityV1 } from '@happier-dev/deployment-protocol';
import { act, renderHook, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
const { useEnvironmentSecretBindingsDraft } = await import('./useEnvironmentSecretBindingsDraft');
const { createDeploymentActions } = await import('./deploymentActions');
await import('@/sync/ops/actions/defaultActionExecutor');
const ready = (value: DeploymentEnvironmentDetailV1): DeploymentReadSnapshotV1<DeploymentEnvironmentDetailV1> => ({
    status: 'ready', value, failure: null,
});
const grantRef = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
const accounts: Awaited<ReturnType<typeof captureLazyActionAccountContext>>[] = [];
async function captureAccount(serverId: string) {
    const account = await captureLazyActionAccountContext(serverId);
    accounts.push(account);
    return account;
}
beforeEach(() => { installHomeGovernanceBoundaries(homes); });
afterEach(async () => { await standardCleanup(); for (const account of accounts.splice(0)) account.dispose(); await homes.reset(); });

describe('Environment Variables consumer draft', () => {
    it('edits preview blueprints without reading or changing the parent bindings', async () => {
        const serverId = await homes.addHome({ name: 'Preview variables', serverUrl: 'https://preview-vars.test', accountId: 'owner', currentAccount: true });
        const lifetime = (await captureAccount(serverId)).accountLifetime;
        const base = createDeploymentEnvironmentDetailV1();
        const production = createDeploymentSecretVariableBindingV1({ name: 'PRODUCTION_TOKEN', phase: 'runtime', resourceId: 'prod', resourceRevision: 1 });
        const blueprint = { purpose: 'variable' as const, name: 'PUBLIC_URL', phase: 'runtime' as const, grantRef: grantRef(1),
            source: { kind: 'deploymentFact' as const, fact: 'primaryUrl' as const } };
        const detail = { ...base, content: { ...base.content, bindings: [production], previewTemplate: {
            v: 1 as const, enabled: true, forkPreviews: 'off' as const,
            repository: { kind: 'github' as const, deployment: 'https://github.com', repository: 'acme/app' },
            runtimeTargetLinkId: base.environment.runtimeTargetLinkId!, domain: null, bindingBlueprints: [blueprint], data: [],
        } } };
        const hook = await renderHook(() => useEnvironmentSecretBindingsDraft({ environmentId: detail.environment.id,
            lifetime, snapshot: ready(detail), setBindings: null, bindingTarget: 'previewTemplate' }));
        expect(hook.getCurrent().editor.rows.map(row => row.binding)).toEqual([blueprint]);
        await act(async () => { hook.getCurrent().editor.setVariable({ name: 'PREVIEW_MODE', phase: 'runtime', source: { kind: 'value', value: 'true' } }); });
        expect(hook.getCurrent().dirty).toBe(true);
        expect(detail.content.bindings).toEqual([production]);
        await act(async () => hook.getCurrent().cancel());
        expect(hook.getCurrent().editor.rows.map(row => row.binding)).toEqual([blueprint]);
    });

    it('edits preview blueprints through the Environment update Action and retains the saved draft until its echo', async () => {
        const homeId = `srv_${'9'.repeat(32)}`;
        const serverId = await homes.addHome({ name: 'Preview blueprint save', serverUrl: 'https://preview-blueprint-save.test',
            serverIdentityId: homeId, accountId: 'account-owner', currentAccount: true });
        const lifetime = (await captureAccount(serverId)).accountLifetime;
        const base = createDeploymentEnvironmentDetailV1();
        const detail = { ...base, environment: { ...base.environment, serverId: homeId }, content: { ...base.content, previewTemplate: {
            v: 1 as const, enabled: true, forkPreviews: 'off' as const,
            repository: { kind: 'github' as const, deployment: 'https://github.com', repository: 'acme/app' },
            runtimeTargetLinkId: base.environment.runtimeTargetLinkId!, domain: null, bindingBlueprints: [], data: [],
        } } };
        const blueprint = { purpose: 'variable' as const, name: 'PUBLIC_URL', phase: 'runtime' as const,
            source: { kind: 'deploymentFact' as const, fact: 'primaryUrl' as const } };
        const nextBlueprint = { ...blueprint, name: 'COMMIT_SHA', source: { kind: 'deploymentFact' as const, fact: 'commitSha' as const } };
        let revision = detail.environment.revision;
        let preparedArtifact = {
            contentArtifactId: detail.environment.contentArtifactId,
            contentHeaderVersion: detail.environment.contentHeaderVersion,
            contentBodyVersion: detail.environment.contentBodyVersion,
        };
        homes.answer(serverId, `GET /v1/deployments/environments/${detail.environment.id}`, { select: () => ({ body: {
            ok: true, environment: { ...detail.environment, revision, ...preparedArtifact }, targetLinks: detail.targetLinks.map(item => item.targetLink),
        } }) });
        let boundaryFailure: unknown;
        const diagnosticHome: Pick<typeof homes, 'answer'> = { answer(id, path, reply) {
            const select = reply.select;
            homes.answer(id, path, select ? { ...reply, select: async (body, request) => {
                try { return await select(body, request); }
                catch (cause) { boundaryFailure = cause; throw cause; }
            } } : reply);
        } };
        await answerExternalActionAccountForHome(diagnosticHome, serverId, {
            machineId: 'machine-a', actionId: 'deployments.environments.update', tokenEpoch: 0, execute: operand => {
                const input = DeploymentActionInputSchemasV1['deployments.environments.update'].parse(operand);
                expect(input.expectedRevision).toBe(revision);
                expect(input).toMatchObject(preparedArtifact);
                const expectedBlueprints = (revision === detail.environment.revision ? [blueprint] : [blueprint, nextBlueprint])
                    .map(binding => ({ ...binding, grantRef: expect.any(String) }));
                expect(input.patch).toEqual({ previewTemplate: { ...detail.content.previewTemplate,
                    bindingBlueprints: expectedBlueprints } });
                // A successful private update publishes a new Artifact; its Action result owns that reference.
                preparedArtifact = { contentArtifactId: `saved-preview-blueprints-${++revision}`,
                    contentHeaderVersion: 1, contentBodyVersion: 1 };
                return { ok: true, environmentId: detail.environment.id, revision, preparedArtifact };
            },
        });
        const actions = createDeploymentActions(lifetime, detail.environment.projectSourceId);
        const hook = await renderHook(() => useEnvironmentSecretBindingsDraft({ environmentId: detail.environment.id,
            lifetime, snapshot: ready(detail), bindingTarget: 'previewTemplate',
            setBindings: (patch, operation, base) => actions.setPreviewBindings(base.environment, base.content.previewTemplate!, patch, operation) }));
        await act(async () => { expect(hook.getCurrent().editor.put(blueprint)).toEqual({ ok: true }); });
        await act(async () => { expect(await hook.getCurrent().save().catch((cause: unknown) => {
            if (boundaryFailure) throw boundaryFailure;
            throw new Error(`Blueprint save failed after ${JSON.stringify(homes.requests.map(({ method, path }) => ({ method, path })))}`, { cause });
        })).toMatchObject({ ok: true }); });
        expect(hook.getCurrent().dirty).toBe(false);
        expect(hook.getCurrent().editor.rows.map(row => row.binding)).toMatchObject([
            { ...blueprint, grantRef: expect.any(String) },
        ]);
        const count = homes.requests.length;
        expect(await hook.getCurrent().save()).toBeNull();
        expect(homes.requests.length).toBe(count);
        // A second edit before the read echo must retain the first acknowledged blueprint and its revision.
        await act(async () => { expect(hook.getCurrent().editor.put(nextBlueprint)).toEqual({ ok: true }); });
        await act(async () => { expect(await hook.getCurrent().save().catch((cause: unknown) => {
            throw boundaryFailure ?? cause;
        })).toMatchObject({ ok: true }); });
        expect(hook.getCurrent().editor.rows.map(row => row.binding)).toMatchObject([
            { ...blueprint, grantRef: expect.any(String) },
            { ...nextBlueprint, grantRef: expect.any(String) },
        ]);
        expect(homes.requestsFor('/v1/actions/deployments.environments.update')).toHaveLength(2);
        expect(homes.requestsFor('/v1/actions/deployments.bindings.set')).toHaveLength(0);
    });

    it('projects Team Machine disclosure for a newly selected secret without a value read, write or second approval', async () => {
        const serverId = await homes.addHome({ name: 'Disclosure data', serverUrl: 'https://disclosure.test',
            accountId: 'owner', currentAccount: true });
        const account = await captureAccount(serverId);
        const base = createDeploymentEnvironmentDetailV1();
        const detail = { ...base, environment: { ...base.environment, owner: { kind: 'team' as const, teamId: 'team-a' } },
            content: { ...base.content, bindings: [] } };
        const before = homes.requests.length;
        const hook = await renderHook((snapshot: DeploymentReadSnapshotV1<DeploymentEnvironmentDetailV1>) =>
            useEnvironmentSecretBindingsDraft({ environmentId: detail.environment.id,
                lifetime: account.accountLifetime, snapshot, setBindings: null }), { initialProps: ready(detail) });
        const selected = createDeploymentSecretVariableBindingV1({ name: 'TOKEN', phase: 'runtime', resourceId: 'owned-token', resourceRevision: 1 });
        await act(async () => { expect(hook.getCurrent().editor.put(selected)).toEqual({ ok: true }); });
        expect(hook.getCurrent().editor.rows[0]?.secretDisclosure).toEqual({ kind: 'teamEnvironmentMachines', teamId: 'team-a' });
        expect(hook.getCurrent().editor.rows[0]?.binding).toMatchObject({ ...selected, grantRef: expect.any(String) });
        expect(hook.getCurrent().editor.rows[0]?.binding.purpose === 'variable'
            ? hook.getCurrent().editor.rows[0]?.binding.grantRef : undefined).not.toBe(selected.grantRef);
        await hook.rerender(ready({ ...detail, environment: { ...detail.environment,
            owner: { kind: 'team', teamId: 'team-b' } } }));
        expect(hook.getCurrent().editor.rows[0]?.secretDisclosure).toEqual({ kind: 'teamEnvironmentMachines', teamId: 'team-b' });
        expect(homes.requests.length).toBe(before);
    });

    it.each(['set', 'both', 'remove'] as const)('saves %s through the authored Action while no-op and cancel commit nothing', async change => {
        const homeId = `srv_${'8'.repeat(32)}`;
        const serverId = await homes.addHome({ name: 'Save Variables', serverUrl: 'https://variables-save.test',
            serverIdentityId: homeId, accountId: 'owner', currentAccount: true });
        const lifetime = (await captureAccount(serverId)).accountLifetime;
        const base = createDeploymentEnvironmentDetailV1();
        const runtime = { purpose: 'variable' as const, name: 'PORT', phase: 'runtime' as const,
            grantRef: grantRef(2), source: { kind: 'value' as const, value: '3000' } };
        const detail = { ...base, environment: { ...base.environment, serverId: homeId },
            content: { ...base.content, bindings: change === 'set' ? [] : [runtime] } };
        homes.answer(serverId, `GET /v1/deployments/environments/${detail.environment.id}`, { body: {
            ok: true, environment: detail.environment, targetLinks: detail.targetLinks.map(item => item.targetLink),
        } });
        await answerExternalActionAccountForHome(homes, serverId, {
            machineId: 'machine-a', actionId: 'deployments.bindings.set', tokenEpoch: 0, execute: operand => {
                const input = DeploymentActionInputSchemasV1['deployments.bindings.set'].parse(operand);
                const expectedSet = change === 'set' ? [{ ...runtime, grantRef: expect.any(String) }]
                    : change === 'both' ? [{ ...runtime, phase: 'build', grantRef: expect.any(String) }] : [];
                expect(input).toEqual({ serverId: homeId, environmentId: detail.environment.id,
                    expectedRevision: detail.environment.revision,
                    set: expectedSet,
                    remove: change === 'remove' ? [{ purpose: runtime.purpose, name: runtime.name, phase: runtime.phase }] : [] });
                return { ok: true, environmentId: detail.environment.id, revision: detail.environment.revision + 1 };
            },
        });
        const actions = createDeploymentActions(lifetime, detail.environment.projectSourceId);
        const hook = await renderHook(() => useEnvironmentSecretBindingsDraft({ environmentId: detail.environment.id,
            lifetime, snapshot: ready(detail), setBindings: actions.setBindings ?? null }));
        const before = homes.requests.length;
        expect(await hook.getCurrent().save()).toBeNull();
        await act(async () => { hook.getCurrent().editor.stageBulk('TOKEN=cancelled-local-bytes', 'runtime'); hook.getCurrent().cancel(); });
        expect(homes.requests.length).toBe(before);
        await act(async () => {
            const editor = hook.getCurrent().editor;
            const conversion = { name: runtime.name, phase: 'both' as const, source: runtime.source,
                originalIdentity: environmentSecretBindingIdentityV1(runtime) };
            expect(change === 'remove' ? editor.remove(environmentSecretBindingIdentityV1(runtime))
                : change === 'both' ? editor.setVariable(conversion)
                    : editor.setVariable({ name: runtime.name, phase: runtime.phase, source: runtime.source })).toEqual({ ok: true });
        });
        await act(async () => { expect(await hook.getCurrent().save()).toEqual({ ok: true,
            environmentId: detail.environment.id, revision: detail.environment.revision + 1 }); });
        expect(hook.getCurrent().dirty).toBe(false);
        const expected = change === 'remove' ? [] : change === 'both' ? [runtime, { ...runtime, phase: 'build' }] : [runtime];
        const saved = hook.getCurrent().editor.rows.map(row => row.binding);
        expect(saved).toHaveLength(expected.length);
        expect(saved).toMatchObject(expected.map(binding => ({ ...binding, grantRef: expect.any(String) })));
        const after = homes.requests.length;
        expect(await hook.getCurrent().save()).toBeNull();
        expect(homes.requests.length).toBe(after);
        expect(homes.requestsFor('/v1/actions/deployments.bindings.set')).toHaveLength(1);
        expect(homes.requestsFor('/v1/artifacts')).toHaveLength(0);
        expect(homes.requestsFor(`/v1/deployments/environments/${detail.environment.id}/secret-launch-admission`)).toHaveLength(0);
        expect(homes.requestsFor(`/v1/deployments/environments/${detail.environment.id}/bindings`)).toHaveLength(0);
    });

    it('preserves exact refs across equal reads, pins conflicts and clears local bytes on cancel and scope retirement', async () => {
        const serverId = await homes.addHome({ name: 'Variables', serverUrl: 'https://variables.test', accountId: 'owner', currentAccount: true });
        const lifetime = (await captureAccount(serverId)).accountLifetime;
        const binding = createDeploymentSecretVariableBindingV1({ name: 'TOKEN', phase: 'runtime', resourceId: 'token', resourceRevision: 2 });
        const base = createDeploymentEnvironmentDetailV1();
        const detail = { ...base, environment: { ...base.environment, serverId }, content: { ...base.content, bindings: [binding] } };
        const hook = await renderHook((snapshot: DeploymentReadSnapshotV1<DeploymentEnvironmentDetailV1>) =>
            useEnvironmentSecretBindingsDraft({ lifetime, environmentId: detail.environment.id, snapshot, setBindings: null }), { initialProps: ready(detail) });
        expect(hook.getCurrent().canEdit).toBe(true);
        await act(async () => { hook.getCurrent().editor.setVariable({ name: 'PORT', phase: 'runtime', source: { kind: 'value', value: '3000' } }); });
        expect(hook.getCurrent().dirty).toBe(true);
        const rows = hook.getCurrent().editor.rows;
        expect(rows[0]?.binding.source).toBe(binding.source);
        await hook.rerender(ready(structuredClone(detail)));
        expect(hook.getCurrent().editor.rows).toBe(rows);
        expect(hook.getCurrent().conflict).toBe(false);
        await hook.rerender(ready({ ...detail, environment: { ...detail.environment, revision: detail.environment.revision + 1 } }));
        expect(hook.getCurrent().conflict).toBe(true);
        await expect(hook.getCurrent().save()).rejects.toMatchObject({ code: 'deployment_conflict' });
        expect(hook.getCurrent().dirty).toBe(true);
        await act(async () => { hook.getCurrent().cancel(); });
        expect(hook.getCurrent().dirty).toBe(false);
        expect(hook.getCurrent().editor.rows.map(row => row.binding)).toEqual([binding]);
        await act(async () => { hook.getCurrent().editor.stageBulk('SECRET=local-only-bytes', 'runtime'); });
        const staleEditor = hook.getCurrent().editor;
        await act(async () => { await homes.switchAccount(serverId, 'replacement', { currentAccount: true }); });
        expect(hook.getCurrent().editor.bulk).toBeNull();
        expect(hook.getCurrent().editor.rows).toEqual([]);
        expect(hook.getCurrent().canEdit).toBe(false);
        expect(staleEditor.setVariable({ name: 'AFTER', phase: 'runtime', source: { kind: 'value', value: 'x' } }))
            .toEqual({ ok: false, error: 'unavailable' });
    });

    it('keeps pending, loaded empty and typed read refusal distinct without authoring bindings', async () => {
        const serverId = await homes.addHome({ name: 'Read states', serverUrl: 'https://variables-read.test', accountId: 'owner', currentAccount: true });
        const lifetime = (await captureAccount(serverId)).accountLifetime;
        const detail = createDeploymentEnvironmentDetailV1();
        const hook = await renderHook((snapshot: DeploymentReadSnapshotV1<DeploymentEnvironmentDetailV1>) =>
            useEnvironmentSecretBindingsDraft({ lifetime, environmentId: detail.environment.id, snapshot, setBindings: null }),
        { initialProps: { status: 'loading', value: null, failure: null } });
        expect(hook.getCurrent().status).toBe('loading');
        expect(hook.getCurrent().canEdit).toBe(false);
        await hook.rerender(ready({ ...detail, environment: { ...detail.environment, serverId } }));
        expect(hook.getCurrent().status).toBe('ready');
        expect(hook.getCurrent().editor.rows).toEqual([]);
        expect(hook.getCurrent().canEdit).toBe(true);
        await hook.rerender({ status: 'unavailable', value: null, failure: { code: 'deployment_access_denied', retryable: false } });
        expect(hook.getCurrent().failure).toEqual({ code: 'deployment_access_denied', retryable: false });
        expect(hook.getCurrent().canEdit).toBe(false);
        expect(await hook.getCurrent().save()).toBeNull();
    });

    it('refuses dirty read/capability loss and fences retained handlers before Environment effect cleanup', async () => {
        const serverId = await homes.addHome({ name: 'Draft scope', serverUrl: 'https://variables-scope.test', accountId: 'owner', currentAccount: true });
        const lifetime = (await captureAccount(serverId)).accountLifetime;
        const base = createDeploymentEnvironmentDetailV1();
        const detail = { ...base, environment: { ...base.environment, serverId } };
        let previous: ReturnType<typeof useEnvironmentSecretBindingsDraft> | null = null;
        let invokeBeforeCleanup = false;
        const hook = await renderHook((props: { environmentId: string; snapshot: DeploymentReadSnapshotV1<DeploymentEnvironmentDetailV1> }) => {
            const { environmentId, snapshot } = props;
            const value = useEnvironmentSecretBindingsDraft({ lifetime, environmentId, snapshot, setBindings: null });
            React.useLayoutEffect(() => {
                if (invokeBeforeCleanup && previous) {
                    expect(previous.editor.setVariable({ name: 'STALE', phase: 'runtime', source: { kind: 'value', value: 'wrong-environment' } }))
                        .toEqual({ ok: false, error: 'unavailable' });
                    expect(value.editor.bulk).toBeNull();
                    expect(value.editor.rows).toEqual([]);
                }
            }, [snapshot]);
            return value;
        }, { initialProps: { environmentId: detail.environment.id, snapshot: ready(detail) } });
        await act(async () => { hook.getCurrent().editor.setVariable({ name: 'PORT', phase: 'runtime', source: { kind: 'value', value: '3000' } }); });
        await hook.rerender({ environmentId: detail.environment.id, snapshot: { status: 'unavailable', value: null, failure: { code: 'deployment_access_denied', retryable: false } } });
        expect(hook.getCurrent().dirty).toBe(true);
        expect(hook.getCurrent().canSave).toBe(false);
        await expect(hook.getCurrent().save()).rejects.toMatchObject({ code: 'deployment_access_denied' });
        await hook.rerender({ environmentId: detail.environment.id, snapshot: ready({ ...detail, environment: { ...detail.environment,
            capabilities: { ...detail.environment.capabilities, manageBindings: false } } }) });
        expect(hook.getCurrent().canEdit).toBe(false);
        await expect(hook.getCurrent().save()).rejects.toMatchObject({ code: 'deployment_access_denied' });
        await hook.rerender({ environmentId: detail.environment.id, snapshot: ready({ ...detail, content: { ...detail.content, name: 'Different canonical content' } }) });
        expect(hook.getCurrent().conflict).toBe(true);
        await hook.rerender({ environmentId: detail.environment.id, snapshot: ready(detail) });
        await act(async () => { hook.getCurrent().editor.stageBulk('TOKEN=only-in-local-draft', 'runtime'); });
        previous = hook.getCurrent();
        invokeBeforeCleanup = true;
        await hook.rerender({ environmentId: 'another-environment', snapshot: { status: 'loading', value: null, failure: null } });
        expect(hook.getCurrent().dirty).toBe(false);
    });
});
