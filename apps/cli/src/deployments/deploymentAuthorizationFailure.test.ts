import axios from 'axios';
import { afterEach, expect, it, vi } from 'vitest';
import { EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER } from '@happier-dev/protocol/actions';
import { createCliDeploymentActionDeps } from './createCliDeploymentActionDeps';
import { readDeploymentAuthorizationFailure, refuseDeploymentAuthorization } from './deploymentAuthorizationFailure';
import { projectDeploymentFailure } from './deploymentFailure';
import { normalizeActionExecuteResult, projectCliActionFailure } from '@/cli/commands/session/shared/normalizeActionExecuteResult';

afterEach(() => vi.restoreAllMocks());

it('retains recovery on the public Action when Home request headers are unavailable', async () => {
    const deps = createCliDeploymentActionDeps({ serverHttpBaseUrl: 'https://home.test', admitAccount: async () => null,
        resolveRequestHeaders: () => null,
        dispatchReceipt: async () => { throw new Error('A refused read cannot issue a deploy effect'); } });
    const result = await deps.deploymentAction!('deployments.receipts.list', { serverId: 'home', environmentId: 'retained' }, {});
    expect(result).toMatchObject({ ok: false, errorCode: 'action_forbidden',
        details: { requiredFact: 'deploymentActionResult', remedy: expect.stringMatching(/\S/) },
        failureCause: { phase: 'deployment.authorization.home_request_headers_refused' } });
});

it('names a local signed-header refusal through the native adapter and public CLI result', () => {
    let refusal: unknown;
    try { refuseDeploymentAuthorization('home_request_headers_refused'); }
    catch (error) { refusal = error; }
    const result = normalizeActionExecuteResult(projectDeploymentFailure('action_forbidden', refusal));
    if (result.ok) throw new Error('A header refusal cannot become success');
    expect(projectCliActionFailure(result)).toMatchObject({ code: 'action_forbidden',
        details: { requiredFact: 'deploymentActionResult', remedy: expect.stringMatching(/\S/) }, failureCause: {
        phase: 'deployment.authorization.home_request_headers_refused', errorCode: null, httpStatus: null,
    } });
});

it('keeps the signed purpose requirement and remedy through the Home and parent Action projections', async () => {
    vi.spyOn(axios, 'request').mockResolvedValue({ status: 401,
        data: { error: 'invalid_token', authorizationRefusal: 'verification_purpose' } });
    const deps = createCliDeploymentActionDeps({ serverHttpBaseUrl: 'https://home.test', admitAccount: async () => null,
        resolveRequestHeaders: () => ({ [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: 'never-record-proof' }),
        dispatchReceipt: async () => { throw new Error('A refused read cannot issue a deploy effect'); } });
    const child = await deps.deploymentAction!('deployments.receipts.list', { serverId: 'home', environmentId: 'retained' }, {});
    const expected = { errorCode: 'action_forbidden', details: {
        requiredFact: 'verification_purpose', remedy: expect.any(String),
    }, failureCause: { phase: 'home.authorization.verification_purpose', httpStatus: 401 } };
    expect(child).toMatchObject(expected);
    const parent = projectDeploymentFailure('action_forbidden', Object.assign(new Error('Private transport context'), { cause: child }));
    expect(parent).toMatchObject(expected);
    const normalized = normalizeActionExecuteResult(parent);
    if (normalized.ok) throw new Error('A rejected signed purpose cannot become success');
    const output = projectCliActionFailure(normalized);
    expect(output).toMatchObject({ code: 'action_forbidden', details: expected.details, failureCause: expected.failureCause });
    expect(JSON.stringify(output)).not.toMatch(/never-record-proof|Private transport context/u);
});

it.each([[401, true], [403, true], [401, false], [403, false]] as const)(
    'retains the Home refusal through child result, exception and public CLI output (%s, classified: %s)', async (status, classified) => {
    vi.spyOn(axios, 'request').mockResolvedValue({ status, data: { error: status === 401 ? 'invalid_token' : 'credential_scope_denied',
        ...(classified ? { authorizationRefusal: 'deployment_child_http' } : {}) } });
    const deps = createCliDeploymentActionDeps({ serverHttpBaseUrl: 'https://home.test', admitAccount: async () => null,
        resolveRequestHeaders: () => ({ [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: 'never-record-proof' }),
        dispatchReceipt: async () => { throw new Error('No deploy effect may occur'); } });
    const child = await deps.deploymentAction!('deployments.receipts.list', { serverId: 'home', environmentId: 'retained' }, {});
    const parent = readDeploymentAuthorizationFailure(child);
    const phase = classified ? 'home.authorization.deployment_child_http' : 'home.authorization.signed_request';
    expect(parent).toMatchObject({ errorCode: 'action_forbidden',
        failureCause: { phase, errorClass: 'HttpStatusError', httpStatus: status } });
    if (classified) expect(parent).toMatchObject({ details: {
        requiredFact: 'deployment_child_http', remedy: expect.any(String),
    } });
    else expect(parent).toMatchObject({ details: { requiredFact: 'deploymentActionResult', remedy: expect.stringMatching(/\S/) } });
    const retained = readDeploymentAuthorizationFailure(Object.assign(new Error('private content'), { cause: parent }));
    if (!retained) throw new Error('Parent must retain the typed refusal');
    const normalized = normalizeActionExecuteResult(retained);
    if (normalized.ok) throw new Error('Refusal cannot become success');
    const output = projectCliActionFailure(normalized);
    const reason = classified ? 'home_signed_authorization_rejected:deployment_child_http'
        : status === 401 ? 'home_signed_authorization_rejected' : 'home_deployment_http_forbidden';
    expect(output).toMatchObject({ code: 'action_forbidden', message: `action_forbidden (${reason})`,
        failureCause: { phase, errorClass: 'HttpStatusError', httpStatus: status } });
    if (classified) expect(output).toMatchObject({ details: {
        requiredFact: 'deployment_child_http', remedy: expect.any(String),
    } });
    expect(JSON.stringify(output)).not.toMatch(/never-record-proof|private content/u);
});

it('carries every phase Home refuses with, including the managed bound-Session setup phase', async () => {
    // Home already sends this phase (externalActionExecutionAuthorization managed_bound_session_setup);
    // an unknown phase fails the strict HTTP schema and loses the cause.
    vi.spyOn(axios, 'request').mockResolvedValue({ status: 401,
        data: { error: 'invalid_token', authorizationRefusal: 'managed_bound_session_setup' } });
    const deps = createCliDeploymentActionDeps({ serverHttpBaseUrl: 'https://home.test', admitAccount: async () => null,
        resolveRequestHeaders: () => ({ [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: 'never-record-proof' }),
        dispatchReceipt: async () => { throw new Error('A refused read cannot issue a deploy effect'); } });
    const child = await deps.deploymentAction!('deployments.receipts.list', { serverId: 'home', environmentId: 'retained' }, {});
    expect(child).toMatchObject({ errorCode: 'action_forbidden',
        failureCause: { phase: 'home.authorization.managed_bound_session_setup', httpStatus: 401 } });
});
