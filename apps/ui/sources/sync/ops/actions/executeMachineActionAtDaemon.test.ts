import { expect, it, vi } from 'vitest';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import { confirmOwnUiRefusal, isUiMachineOwnedAdmissionAction } from './executeMachineActionAtDaemon';

const context: ActionExecutorContext = { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } };
const reviewDigest = 'M'.repeat(43);
const refused = (actionArgs: unknown): ActionExecuteResult => ({ ok: false,
    errorCode: 'action_interactive_review_required', error: 'action_interactive_review_required',
    details: { reviewDigest, review: { actionArgs, preview: { summary: 'Review the prepared effect' } } } });

it('keeps approval creation on the originating account executor', () => {
    expect(isUiMachineOwnedAdmissionAction('approval.request.create', {
        actionId: 'session.spawn_new', actionArgs: {}, summary: 'Create a Session', createdBy: 'voice',
    })).toBe(false);
    expect(isUiMachineOwnedAdmissionAction('session.spawn_new', {})).toBe(true);
});

it('retries the prepared candidate carried by the receiving Machine after one native decision', async () => {
    const input = { serverId: 'home', environmentId: 'environment', targetLinkId: 'target' };
    const prepared = getActionSpec('deployments.deploy').inputSchema.parse({ ...input, expectedRevision: 1,
        expectedTargetLinkRevision: 1, requestKey: 'prepared-request', contentArtifactId: 'prepared-candidate',
        contentHeaderVersion: 1, contentBodyVersion: 1 });
    // Network and the native confirmation host are the substituted boundaries.
    const execute = vi.fn(async (candidate: unknown, digest: string): Promise<ActionExecuteResult> =>
        digest === reviewDigest && sameStrictJsonValue(candidate, prepared)
            ? { ok: true, result: { state: 'succeeded' } } : refused({ ...prepared, requestKey: 'another-candidate' }));
    const confirm = vi.fn(async () => true);
    const result = await confirmOwnUiRefusal('deployments.deploy', input, context, refused(prepared), confirm, execute);
    expect(result).toMatchObject({ ok: true, result: { state: 'succeeded' } });
    expect(confirm).toHaveBeenCalledExactlyOnceWith({ actionId: 'deployments.deploy', input: prepared, context,
        preview: { summary: 'Review the prepared effect' } });
    expect(execute).toHaveBeenCalledExactlyOnceWith(prepared, reviewDigest);
});

it('presents a value-free carried review while retaining private operands under the declared live custody', async () => {
    const input = getActionSpec('secrets.create').inputSchema.parse({ name: 'Private token', kind: 'token', value: 'private-value' });
    const review = { name: 'Private token', kind: 'token' };
    const confirm = vi.fn(async () => true);
    const execute = vi.fn(async (): Promise<ActionExecuteResult> => ({ ok: true, result: { secretId: 'created-secret' } }));
    const result = await confirmOwnUiRefusal('secrets.create', input, context, refused(review), confirm, execute);
    expect(result).toMatchObject({ ok: true, result: { secretId: 'created-secret' } });
    expect(confirm).toHaveBeenCalledExactlyOnceWith({ actionId: 'secrets.create', input: review, context,
        preview: { summary: 'Review the prepared effect' } });
    expect(execute).toHaveBeenCalledExactlyOnceWith(input, reviewDigest);
});

it.each([false, true])('settles a carried review before dispatch when aborted=%s', async aborted => {
    const controller = new AbortController();
    const input = { action: { pluginId: 'acme.tasks', localId: 'create' }, input: { title: 'A task' } };
    const execute = vi.fn();
    const result = await confirmOwnUiRefusal('action.invoke', input, { ...context, signal: controller.signal },
        refused(input), async () => {
            if (aborted) controller.abort();
            return false;
        }, execute);
    expect(result).toMatchObject({ ok: false, errorCode: aborted ? 'cancelled' : 'approval_canceled', effectAttempted: false });
    expect(execute).not.toHaveBeenCalled();
});
