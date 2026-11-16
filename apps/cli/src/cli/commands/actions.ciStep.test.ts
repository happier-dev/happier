import type { ActionExecutorContext } from '@happier-dev/protocol/actions/actionExecutor';
import { ActionSurfaceSchema } from '@happier-dev/protocol/actions/metadata';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import fastify from 'fastify';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { registerAccountArtifactRoutes } from '@/session/actions/widgetApproval.testkit';
import { encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { z } from 'zod/mini';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { createDeploymentApprovalScopeResolverV1, DeploymentEnvironmentGetResultV1Schema,
  type ActionExecutorDeps } from '@happier-dev/protocol';
import { handleActionsCommand } from './actions';
import { dispatchCli } from '@/cli/dispatch';
import { reloadConfiguration } from '@/configuration';
import { writeCredentialsTokenOnlyForServerId } from '@/persistence';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';
import { seedTestServerProfile } from '@/testkit/serverProfiles';
import { captureConsoleLogAndMuteStdout } from '@/testkit/logger/captureOutput';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { createActionOperationStore } from '@/daemon/actionOperations/actionOperationStore';
import { executeActionOperationActionV1 } from '@happier-dev/protocol/actions/executor/actionOperationActions';
import { createDeploymentEnvironmentDetailV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1 } from '@happier-dev/deployment-protocol';
import { HomeApplicationOriginV1Schema } from '@happier-dev/protocol/auth/accountDirectory';
import { renderDeploymentGithubActionsStep } from '@/cli/actions/deploymentCiStep';

const exec = promisify(execFile);
const token = `hap_v1_11111111-1111-4111-8111-111111111111_${'A'.repeat(43)}`;
const homeId = 'srv_ci_home';
const environmentId = "prod'quoted-$(printf unexpected)-${{ secrets.NOT_AN_INPUT }}";
const sha = 'a'.repeat(40);
const httpFixtures: Array<() => Promise<void>> = [];
function generationDeps(kind: 'repository' | 'stored' = 'repository', supported = true, mode: string = 'plain', origin = 'https://ci.example.test') {
  const detail = createDeploymentEnvironmentDetailV1();
  detail.environment.id = environmentId;
  detail.environment.serverId = homeId;
  detail.content.definition = kind === 'repository'
    ? { kind, ref: 'main', compose: { path: 'compose.yaml', profiles: [], services: ['app'] } }
    : { kind, document: 'services: {app: {image: nginx:1}}', composeDigest: `sha256:${'a'.repeat(64)}`,
      contentRevision: 1, profiles: [], services: ['app'] };
  // The Home is a genuine system boundary. Reuse the canonical Artifact HTTP
  // testkit so the real client opens the actual plain storage envelope.
  const home = fastify();
  home.get('/v1/account/encryption', async () => ({ mode, updatedAt: 0 }));
  const artifacts = registerAccountArtifactRoutes(home, 'account', { encryptionMode: 'plain' });
  artifacts.seed(detail.environment.contentArtifactId,
    encodePlainArtifactStoredContent({ kind: DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, title: 'CI' }),
    encodePlainArtifactStoredContent({ body: JSON.stringify(detail.content) }));
  const restoreHttp = installAxiosFastifyAdapter({ app: home, origin });
  httpFixtures.push(async () => { restoreHttp(); await home.close(); });
  const transport: NonNullable<ActionExecutorDeps['deploymentAction']> = async () => supported
    ? { ok: true, environment: detail.environment, targetLinks: [] }
    : { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' };
  const executor = createActionExecutor({
    readActionsSettings: (context: ActionExecutorContext) => ActionsSettingsV1Schema.parse({ v: 1, ...context.actionsSettings, approvalWaivedSurfaces: {"deployments.deploy": Object.keys(ActionSurfaceSchema.shape), "deployments.environments.get": Object.keys(ActionSurfaceSchema.shape), ...context.actionsSettings?.approvalWaivedSurfaces} }), ...createUnavailableActionTransportDeps(),
    deploymentAction: transport, resolveEnvironmentApprovalScope: createDeploymentApprovalScopeResolverV1(transport) });
  return { createExecutorFn: () => ({ ...executor, resolveSessionTarget: async (): Promise<never> => { throw new Error('No Session'); } }) };
}
const StepSchema = z.array(z.strictObject({ name: z.string(), shell: z.literal('bash'),
  env: z.record(z.string(), z.string()), run: z.string() }));
// GitHub is an external boundary. Model its documented string-literal grammar
// and one synthetic secret, with single-pass (not recursive) interpolation.
// https://docs.github.com/en/actions/reference/workflows-and-actions/expressions#literals
function evaluateGithubEnvironment(value: string): string {
  const literal = /^\$\{\{\s*'((?:[^']|'')*)'\s*\}\}$/u.exec(value);
  return literal ? literal[1]!.replaceAll("''", "'")
    : value.replaceAll('${{secrets.CI_SECRET}}', 'synthetic-secret-value');
}
let envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_TOKEN', 'HAPPIER_ACTIVE_SERVER_ID',
  'HAPPIER_SERVER_URL', 'HAPPIER_LOCAL_SERVER_URL', 'HAPPIER_PUBLIC_SERVER_URL', 'HAPPIER_WEBAPP_URL']);

afterEach(async () => {
  for (const dispose of httpFixtures.splice(0).reverse()) await dispose();
  envScope.restore();
  envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_TOKEN', 'HAPPIER_ACTIVE_SERVER_ID',
    'HAPPIER_SERVER_URL', 'HAPPIER_LOCAL_SERVER_URL', 'HAPPIER_PUBLIC_SERVER_URL', 'HAPPIER_WEBAPP_URL']);
  reloadConfiguration();
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

describe('emitted deployment CI step through the Actions command', () => {
  it('dispatches the documented helper option to its Environment argument validation', async () => {
    const output = captureConsoleLogAndMuteStdout();
    const args = ['actions', 'get', 'deployments.deploy', '--github-actions', '--json'];
    try {
      await dispatchCli({ args, rawArgv: args, terminalRuntime: null });
      expect(JSON.parse(output.logs.join('\n'))).toMatchObject({
        ok: false, error: { code: 'invalid_arguments', message: expect.stringContaining('--environment') },
      });
      expect(process.exitCode).toBe(1);
    } finally { output.restore(); }
  });

  it.each([
    'https://ci.example.test',
    'https://ci.example.test/$ordinary',
    'https://example.invalid/${{secrets.CI_SECRET}}',
    'https://${{secrets.CI_SECRET}}',
    "https://example.invalid/'}}/${{secrets.CI_SECRET}}/it's-literal",
  ])('preserves the admitted Home URL literally through workflow and shell consumption: %s', async url => {
    const admitted = HomeApplicationOriginV1Schema.parse(url);
    const [step] = StepSchema.parse(parse(renderDeploymentGithubActionsStep({ serverIdentityId: homeId,
      serverApiUrl: admitted, environmentId })));
    if (!step) throw new Error('Missing emitted step');
    const consumed = evaluateGithubEnvironment(step.env.HAPPIER_SERVER_URL!);
    expect(consumed).toBe(admitted);
    const shell = await exec('bash', ['-c', 'printf %s "$HAPPIER_SERVER_URL"'], {
      env: { ...process.env, HAPPIER_SERVER_URL: consumed },
    });
    expect(shell.stdout).toBe(admitted);
  });
  it.each([
    ['stored', 'plain', true, 'needs_repository'],
    ['repository', 'e2ee', true, 'client_required'],
    ['repository', 'unknown', true, 'client_required'],
    ['repository', 'plain', false, 'unsupported_action'],
  ] as const)('does not emit an unusable %s/%s helper', async (kind, mode, supported, code) => {
    await withTempDir('happier-deployment-ci-unavailable-', async homeDir => {
      envScope.patch({ HAPPIER_HOME_DIR: homeDir, HAPPIER_TOKEN: undefined, HAPPIER_ACTIVE_SERVER_ID: undefined,
        HAPPIER_SERVER_URL: undefined, HAPPIER_LOCAL_SERVER_URL: undefined,
        HAPPIER_PUBLIC_SERVER_URL: undefined, HAPPIER_WEBAPP_URL: undefined });
      reloadConfiguration();
      await seedTestServerProfile({ id: 'ci-profile', homeId, serverUrl: 'https://ci.example.test' });
      await writeCredentialsTokenOnlyForServerId('ci-profile', { token: 'interactive' });
      // Only the Account HTTP boundary is substituted; the real Action facade,
      // Artifact schema and exact Environment content opener run underneath get.
      const output = captureConsoleLogAndMuteStdout();
      try {
        await handleActionsCommand(['get', 'deployments.deploy', '--github-actions', '--environment', environmentId,
          '--server-id', 'ci-profile', '--json'], generationDeps(kind, supported, mode));
        expect(output.logs.join('\n')).not.toContain('${{ github.sha }}');
        expect(JSON.parse(output.logs.join('\n'))).toMatchObject({ ok: false, error: { code } });
        expect(process.exitCode).toBe(1);
      } finally { output.restore(); }
    });
  });
  it.each([
    ['succeeded', 0, undefined], ['running_unverified', 0, undefined],
    ['failed', 1, 'deployment_failed'], ['waitingApproval', 3, 'approval_waiting'],
    ['offline', 4, 'machine_unavailable'], ['outcome_unknown', 5, 'outcome_unknown'],
    ['client_required', 1, 'client_required'],
    ['pending', 0, undefined], ['pendingHeld', 3, 'approval_waiting'], ['pendingMissing', 5, 'outcome_unknown'],
  ] as const)('executes the emitted %s step with truthful exit %s and no resubmission', async (state, exitCode, code) => {
    await withTempDir('happier-deployment-ci-step-', async homeDir => {
      envScope.patch({ HAPPIER_HOME_DIR: homeDir, HAPPIER_TOKEN: undefined, HAPPIER_ACTIVE_SERVER_ID: undefined,
        HAPPIER_SERVER_URL: undefined, HAPPIER_LOCAL_SERVER_URL: undefined,
        HAPPIER_PUBLIC_SERVER_URL: undefined, HAPPIER_WEBAPP_URL: undefined });
      reloadConfiguration();
      await seedTestServerProfile({ id: 'ci-profile', homeId, serverUrl: 'https://ci.example.test',
        localServerUrl: 'http://127.0.0.1:1' });
      await writeCredentialsTokenOnlyForServerId('ci-profile', { token: 'interactive' });
      const output = captureConsoleLogAndMuteStdout();
      try {
        await handleActionsCommand(['get', 'deployments.deploy', '--github-actions', '--environment', environmentId,
          '--server-id', 'ci-profile'], generationDeps('repository', true, 'plain', 'http://127.0.0.1:1'));
        const emitted = output.logs.join('\n');
        expect(emitted, 'Actions discovery must emit the requested runnable CI step').toContain('${{ github.sha }}');
        const [step] = StepSchema.parse(parse(emitted));
        expect(step).toBeDefined();
        if (!step) throw new Error('Missing emitted step');
        expect(step.env.HAPPIER_TOKEN).toBe('${{ secrets.HAPPIER_TOKEN }}');
        expect(evaluateGithubEnvironment(step.env.HAPPIER_SERVER_URL!)).toBe('https://ci.example.test');
        expect(emitted).not.toContain(token);
        expect(step.run).not.toContain('--machine-id');
        expect(step.run).not.toMatch(/expectedRevision|targetLinkId|contentArtifactId/u);
        expect(step.run).toContain('${{ github.sha }}');
        expect(step.run).toContain('${{ github.run_id }}-${{ github.run_attempt }}');
        expect(step.run).not.toContain('${{ secrets.NOT_AN_INPUT }}');
        // Substitute only the GitHub-owned values. The real shell must retain
        // arbitrary Home/Environment bytes as one JSON operand, not execute them.
        const run = step.run.replaceAll('${{ github.sha }}', sha)
          .replaceAll('${{ github.run_id }}', '123').replaceAll('${{ github.run_attempt }}', '2');
        const shell = await exec('bash', ['-c', `happier() { printf '%s\\0' "$@"; }; ${run}`]);
        const argv = shell.stdout.split('\0').slice(0, -1);
        expect(argv.slice(0, 3)).toEqual(['actions', 'invoke', 'deployments.deploy']);
        const inputIndex = argv.indexOf('--input-json');
        expect(JSON.parse(argv[inputIndex + 1]!)).toEqual({ serverId: homeId, environmentId, sha, requestKey: '123-2' });
        envScope.patch({ HAPPIER_TOKEN: token, HAPPIER_SERVER_URL: evaluateGithubEnvironment(step.env.HAPPIER_SERVER_URL!) });
        reloadConfiguration();
        let submissions = 0;
        let observations = 0;
        const operationInputs: unknown[] = [];
        const store = createActionOperationStore();
        const scope = { accountId: 'account', machineId: 'original-host' };
        store.create({ operationId: 'operation', actionId: 'deployments.deploy', scope,
          title: 'Deploy', cancellation: 'unsupported', inputIdentity: 'reviewed' });
        store.markRunning('operation');
        const transport: NonNullable<ActionExecutorDeps['deploymentAction']> = async (actionId, input) => {
          if (actionId === 'deployments.environments.get') return DeploymentEnvironmentGetResultV1Schema.parse({ ok: true,
            environment: { v: 1, id: environmentId, serverId: homeId, projectSourceId: 'source', revision: 1,
              owner: { kind: 'account', accountId: 'account' }, protection: 'nonProduction', purpose: 'standard',
              deployerMode: 'managers', controllerMachineId: 'controller', createdByAccountId: 'account',
              contentArtifactId: 'content', contentHeaderVersion: 1, contentBodyVersion: 1,
              capabilities: { role: 'manager', read: true, deploy: true, manage: true,
                manageBindings: true, manageTargets: true, delete: true }, createdAtMs: 1, updatedAtMs: 1 }, targetLinks: [] });
          submissions += 1;
          expect(input).toEqual({ serverId: homeId, environmentId, sha, requestKey: '123-2' });
          if (state === 'offline' || state === 'client_required' || state === 'waitingApproval') return { ok: false,
            errorCode: state === 'offline' ? 'machine_unavailable' : state === 'waitingApproval' ? 'approval_waiting' : state,
            error: state, ...(state === 'offline' ? { details: { role: 'controller', machineIds: ['controller'], nextActions: ['start'] } } : {}) };
          if (state === 'pending' || state === 'pendingHeld' || state === 'pendingMissing') return {
            ok: true, environmentId, revision: 2, kind: 'pending', actionOperationId: 'operation',
            ...(state === 'pendingMissing' ? {} : { operation: { serverId: homeId, machineId: 'original-host', operationId: 'operation' } }),
          };
          return { ok: true, environmentId, revision: 2, deploymentId: 'deployment', deploymentRevision: 1, state };
        };
        const executor = createActionExecutor({
    readActionsSettings: (context: ActionExecutorContext) => ActionsSettingsV1Schema.parse({ v: 1, ...context.actionsSettings, approvalWaivedSurfaces: {"deployments.deploy": Object.keys(ActionSurfaceSchema.shape), "deployments.environments.get": Object.keys(ActionSurfaceSchema.shape), ...context.actionsSettings?.approvalWaivedSurfaces} }), ...createUnavailableActionTransportDeps(), deploymentAction: transport,
          actionOperationAction: request => {
            operationInputs.push(request.input);
            return executeActionOperationActionV1({ ...request, transport: async read => {
              observations += 1;
              expect(read).toMatchObject({ serverId: homeId, machineId: 'original-host',
                payload: { operationId: 'operation', waitForTerminal: true } });
              if (state === 'pendingHeld') store.updateProgress('operation', { kind: 'phase', phase: 'waiting_for_approval', label: 'Waiting' });
              else store.succeed('operation', { ok: true, environmentId, revision: 2,
                deploymentId: 'deployment', deploymentRevision: 1, state: 'succeeded' });
              return { kind: 'found', operation: store.get(scope, 'operation') };
            } });
          },
          resolveEnvironmentApprovalScope: createDeploymentApprovalScopeResolverV1(transport) });
        output.logs.length = 0;
        await handleActionsCommand(argv.slice(1), { createExecutorFn: params => {
          // The emitted variable reaches the actual CLI credential reader;
          // this is not an injected token or a second CI auth implementation.
          expect(params.credentials).toMatchObject({ token, credentialProvenance: 'api_token', encryption: null });
          return { ...executor, resolveSessionTarget: async () => { throw new Error('No Session'); } };
        } });
        expect(process.exitCode ?? 0, output.logs.join('\n')).toBe(exitCode);
        expect(JSON.parse(output.logs.join('\n'))).toMatchObject(code ? { ok: false, error: { code } }
          : { ok: true, data: { state: state === 'pending' ? 'succeeded' : state } });
        expect(submissions).toBe(1);
        expect(observations).toBe(state === 'pending' || state === 'pendingHeld' ? 1 : 0);
        expect(operationInputs).toEqual(state === 'pending' || state === 'pendingHeld' ? [{
          serverId: homeId, machineId: 'original-host', operationId: 'operation', environmentId, waitForTerminal: true,
        }] : []);
      } finally { output.restore(); }
    });
  });
});
