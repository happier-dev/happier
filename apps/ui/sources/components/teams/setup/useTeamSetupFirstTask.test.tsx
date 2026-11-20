import { afterAll, beforeAll, expect, it, onTestFinished } from 'vitest';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { createDeferred, renderHook } from '@/dev/testkit';
import { createPlainArtifactHomeFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { teamProjectSourceFixture } from '@/dev/testkit/fixtures/teamFixtures';
import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { useTeamSetupFirstTask } from './useTeamSetupFirstTask';

let disposeExecutorLoader: (() => void) | undefined;
beforeAll(async () => { disposeExecutorLoader = await installRealActionExecutorModuleLoader(); });
afterAll(() => { disposeExecutorLoader?.(); });

it.each([false, true])('observes the captured Account prompt read policy (enabled=%s)', async (enabled) => {
    const settings = { actionsSettingsV1: { v: 1, actions: { 'prompt_doc.get': { enabled } } } };
    const settled = createDeferred<'action-settled' | 'artifact-read'>();
    let observeHook = false;
    const home = await createPlainArtifactHomeFixture('https://team-first-task.test', {
        accountId: 'team-member', currentAccount: true, accountSettingsVersion: 1,
        handleRequest: async (path) => {
            if (path === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: settings }, version: 1 });
            if (observeHook && path.startsWith('/v1/artifacts')) settled.resolve('artifact-read');
            return null;
        },
    });
    onTestFinished(home.dispose);
    await home.hydrateAccountSettings();
    await home.boundary.handle('/v1/artifacts', { method: 'POST', body: JSON.stringify({
        id: 'cart-first-task', dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
        header: encodePlainArtifactStoredContent({ v: 1, kind: 'prompt_doc.v2', title: 'Cart badge' }),
        body: encodePlainArtifactStoredContent({ body: JSON.stringify({ v: 1, markdown: 'Fix the cart badge', createdAtMs: 1, updatedAtMs: 1 }) }),
    }) });
    const source = teamProjectSourceFixture({ id: 'cart', name: 'Cart', nameWithOwner: 'shop/cart', firstTask: true });
    const context = { serverId: home.home.id, expectedAccountId: 'team-member', surface: 'ui' as const };
    const execute = createFrontDoorActionExecute(createDefaultActionExecutor());
    const decision = await execute('prompt_doc.get', { artifactId: 'cart-first-task' }, context);
    if (enabled) expect(decision).toMatchObject({ ok: true, result: { markdown: 'Fix the cart badge' } });
    else expect(decision).toMatchObject({ ok: false, errorCode: 'action_disabled' });
    const observeExecution = Object.assign(async (...args: Parameters<typeof execute>) => {
        const result = await execute(...args);
        settled.resolve('action-settled');
        return result;
    }, execute);
    observeHook = true;
    const inputs = { execute: observeExecution, context, sources: [source], enabled: true };
    const hook = await renderHook(() => useTeamSetupFirstTask(inputs));
    onTestFinished(hook.unmount);
    if (enabled) await expect.poll(() => hook.getCurrent()).toMatchObject({ title: 'Cart badge', markdown: 'Fix the cart badge' });
    else {
        // A policy refusal must settle before any request for private prompt content.
        await expect(settled.promise).resolves.toBe('action-settled');
        expect(hook.getCurrent()).toBeNull();
        expect(home.requests.filter(({ path }) => path.startsWith('/v1/artifacts'))).toEqual([]);
    }
});
