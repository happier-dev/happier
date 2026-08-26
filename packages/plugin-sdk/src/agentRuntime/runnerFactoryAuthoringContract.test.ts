import { describe, expect, expectTypeOf, it } from 'vitest';

/* @sdk-negative-type-case:src-agentRuntime-runnerFactoryAuthoringContract-test-ts-88:LS0gdGhlIGNhbm9uaWNhbCB2YWxpZGF0b3IgaXMgY2hlY2tlZCBKYXZhU2NyaXB0IHdpdGhvdXQgZW1pdHRlZCBkZWNsYXJhdGlvbnMu:aW1wb3J0IHsgcmVhZFZhbGlkYXRlZEFwaVN1cmZhY2VJbnZlbnRvcnlJZlByZXNlbnQgfSBmcm9tICcuLi8uLi9zY3JpcHRzL2FwaVN1cmZhY2UubWpzJzs */
const apiSurfaceValidatorModulePath: string = '../../scripts/apiSurface.mjs';
const readValidatedApiSurfaceInventoryIfPresent = (
  await import(apiSurfaceValidatorModulePath) as Readonly<{
    readValidatedApiSurfaceInventoryIfPresent(
      url: URL,
    ): Promise<Readonly<{ status: 'available'; inventory: never } | { status: 'missing' }>>;
  }>
).readValidatedApiSurfaceInventoryIfPresent; /* @sdk-negative-type-case-end */

import {
  type ApiSurfaceInventoryContract,
  projectAuthorSurfaceContract,
  requireApiSurfaceInventory,
} from '../normalSurfaceContract.js';

import type {
  AgentCliAuthContributionV1,
  AgentCliSessionCommandBuildInputV1,
  AgentCliSessionCommandBuildOptionsResultV1,
  AgentCliSessionCommandDeclarationV1,
  AgentCliSessionCommandOptionsV1,
  AgentCliSessionCommandParsedArgsV1,
  AgentDeferredStartupEligibilityInputV1,
  AgentExecutionRunRuntimeFactory,
  AgentDaemonSpawnConnectedServicesV1,
  AgentDaemonSpawnHooks,
  AgentDaemonSpawnRuntimeSelectionV1,
  AgentExperimentalVendorResumeSupportContributionV1,
  AgentExperimentalVendorResumeSupportInputV1,
  AgentPreflightJsonRpcRequestClientV1,
  AgentPreflightSessionControlsCommandV1,
  AgentPreflightSessionControlsContributionV1,
  AgentPreflightSessionControlsProbeContextV1,
  AgentPreflightSessionControlsProbeInputV1,
  AgentProviderCliAttachDeclarationV1,
  AgentProviderCliAttachTargetResolutionV1,
  AgentProviderCliAttachTargetV1,
  AgentRuntime,
  AgentRuntimeFactory,
  AgentRuntimeRegistrationOptions,
  AgentSessionRunnerFactoryLocatorV1,
  AgentSessionRuntimeFactory,
  AgentSessionStartupContributionV1,
  AgentTerminalPromptSubmitVerificationPolicyV1,
} from './index.js';

const apiSurfaceInventoryRead: Readonly<
  | { status: 'available'; inventory: ApiSurfaceInventoryContract }
  | { status: 'missing' }
> = await readValidatedApiSurfaceInventoryIfPresent(
  new URL('../../api-surface.json', import.meta.url),
);

function readAuthorSurfaceContract() {
  return projectAuthorSurfaceContract(
    requireApiSurfaceInventory<ApiSurfaceInventoryContract>(apiSurfaceInventoryRead),
  );
}

describe('public Agent runner-factory authoring contract', () => {
  it('keeps the composite factory process-neutral and requires at least one primary facet', () => {
    expectTypeOf<AgentRuntimeFactory>().returns.toMatchTypeOf<
      AgentRuntime | Promise<AgentRuntime>
    >();

    const sessions = {} as AgentSessionRuntimeFactory;
    const executionRuns = {} as AgentExecutionRunRuntimeFactory;
    const sessionRuntime = { sessions } satisfies AgentRuntime;
    const executionRuntime = { executionRuns } satisfies AgentRuntime;
    const compositeRuntime = { sessions, executionRuns } satisfies AgentRuntime;

    expectTypeOf(sessionRuntime).toMatchTypeOf<AgentRuntime>();
    expectTypeOf(executionRuntime).toMatchTypeOf<AgentRuntime>();
    expectTypeOf(compositeRuntime).toMatchTypeOf<AgentRuntime>();

/* @sdk-negative-type-case:src-agentRuntime-runnerFactoryAuthoringContract-test-ts-89:4oCUIGEgZmFjdG9yeSB3aXRoIG5laXRoZXIgcHJpbWFyeSBmYWNldCBpcyBub3QgYW4gQWdlbnQgcnVudGltZS4:Y29uc3QgZW1wdHlSdW50aW1lOiBBZ2VudFJ1bnRpbWUgPSB7fTs */
const emptyRuntime = undefined as never; /* @sdk-negative-type-case-end */
    void emptyRuntime;
  });

  it('keeps the runner locator as leaf identity rather than process custody', () => {
    expectTypeOf<keyof AgentSessionRunnerFactoryLocatorV1>().toEqualTypeOf<
      'module' | 'export' | 'runtimeApiVersion' | 'externalSessionsExport'
    >();
    expectTypeOf<AgentSessionRunnerFactoryLocatorV1['runtimeApiVersion']>()
      .toEqualTypeOf<1>();
    expectTypeOf<AgentSessionRunnerFactoryLocatorV1['externalSessionsExport']>()
      .toEqualTypeOf<string | undefined>();
    expectTypeOf<AgentSessionRunnerFactoryLocatorV1>()
      .not.toHaveProperty('process');
    expectTypeOf<AgentSessionRunnerFactoryLocatorV1>()
      .not.toHaveProperty('custody');
    expectTypeOf<AgentSessionRunnerFactoryLocatorV1>()
      .not.toHaveProperty('token');
  });

  it('carries bounded daemon spawn hooks through the one Agent registration options object', () => {
    expectTypeOf<keyof AgentRuntimeRegistrationOptions>().toEqualTypeOf<
      | 'providerBinding'
      | 'sessionRunnerFactory'
      | 'daemonSpawnHooks'
      | 'providerCliAttach'
      | 'cliSessionCommand'
      | 'cliAuth'
      | 'connectedAccountLaunch'
      | 'preflightSessionControls'
      | 'terminalPromptSubmitVerification'
      | 'sessionStartup'
      | 'vendorResumeSupport'
    >();
    expectTypeOf<NonNullable<AgentRuntimeRegistrationOptions['sessionRunnerFactory']>>()
      .toEqualTypeOf<AgentSessionRunnerFactoryLocatorV1>();
    expectTypeOf<NonNullable<AgentRuntimeRegistrationOptions['daemonSpawnHooks']>>()
      .toEqualTypeOf<AgentDaemonSpawnHooks>();
    expectTypeOf<keyof AgentDaemonSpawnHooks>().toEqualTypeOf<
      'resolveRuntimePrerequisites' | 'augmentEnv'
    >();
    expectTypeOf<NonNullable<AgentRuntimeRegistrationOptions['providerCliAttach']>>()
      .toEqualTypeOf<AgentProviderCliAttachDeclarationV1>();
    expectTypeOf<keyof AgentProviderCliAttachDeclarationV1>().toEqualTypeOf<
      'resolveTarget' | 'createArgs' | 'buildHealthUrl'
    >();
    expectTypeOf<ReturnType<AgentProviderCliAttachDeclarationV1['resolveTarget']>>()
      .toEqualTypeOf<AgentProviderCliAttachTargetResolutionV1>();
    expectTypeOf<Extract<AgentProviderCliAttachTargetResolutionV1, { ok: true }>['value']>()
      .toEqualTypeOf<AgentProviderCliAttachTargetV1>();
    expectTypeOf<NonNullable<AgentRuntimeRegistrationOptions['cliSessionCommand']>>()
      .toEqualTypeOf<AgentCliSessionCommandDeclarationV1>();
    expectTypeOf<keyof AgentCliSessionCommandDeclarationV1>().toEqualTypeOf<
      | 'sessionRuntimeId'
      | 'deprecatedAliasAgentId'
      | 'accountSettingsAgentId'
      | 'implicitResumeDelegation'
      | 'directoryFlags'
      | 'forwardModelFlag'
      | 'forwardResumeFlag'
      | 'yoloAgentArgs'
      | 'versionFlags'
      | 'infoCommandPrefixes'
      | 'buildSessionOptions'
    >();
    expectTypeOf<Parameters<NonNullable<AgentCliSessionCommandDeclarationV1['buildSessionOptions']>>[0]>()
      .toEqualTypeOf<AgentCliSessionCommandBuildInputV1>();
    expectTypeOf<ReturnType<NonNullable<AgentCliSessionCommandDeclarationV1['buildSessionOptions']>>>()
      .toEqualTypeOf<AgentCliSessionCommandBuildOptionsResultV1>();
    expectTypeOf<AgentCliSessionCommandBuildInputV1>().not.toHaveProperty('rawArgv');
    expectTypeOf<AgentCliSessionCommandBuildInputV1>().not.toHaveProperty('process');
    expectTypeOf<AgentCliSessionCommandBuildInputV1>().toHaveProperty('settings');
    expectTypeOf<AgentCliSessionCommandBuildInputV1>().toHaveProperty('environment');
    expectTypeOf<AgentCliSessionCommandBuildInputV1>().toHaveProperty('startOrigin');
    expectTypeOf<AgentCliSessionCommandBuildInputV1>().not.toHaveProperty('processEnv');
    expectTypeOf<AgentCliSessionCommandBuildInputV1>().not.toHaveProperty('startedBy');
    expectTypeOf<AgentCliSessionCommandParsedArgsV1>().toHaveProperty('agentArgs');
    expectTypeOf<AgentCliSessionCommandParsedArgsV1>().not.toHaveProperty('providerArgs');
    expectTypeOf<Extract<AgentCliSessionCommandBuildOptionsResultV1, { ok: true }>['options']>()
      .toEqualTypeOf<AgentCliSessionCommandOptionsV1>();
    expectTypeOf<NonNullable<AgentRuntimeRegistrationOptions['cliAuth']>>()
      .toEqualTypeOf<AgentCliAuthContributionV1>();
    expectTypeOf<NonNullable<AgentRuntimeRegistrationOptions['preflightSessionControls']>>()
      .toEqualTypeOf<AgentPreflightSessionControlsContributionV1>();
    expectTypeOf<keyof AgentPreflightSessionControlsContributionV1>().toEqualTypeOf<
      | 'resolveProbeVariant'
      | 'models'
      | 'jsonRpcCommand'
      | 'probeModels'
      | 'probeModes'
      | 'probeConfigOptions'
      | 'probePassiveRealtimeSetup'
    >();
    expectTypeOf<AgentPreflightSessionControlsContributionV1>()
      .not.toHaveProperty('failureCacheStrategy');
    expectTypeOf<AgentPreflightSessionControlsContributionV1>()
      .not.toHaveProperty('connectedServiceAuth');
    expectTypeOf<keyof AgentPreflightSessionControlsCommandV1>().toEqualTypeOf<
      'toolId' | 'args' | 'environmentKeys' | 'environmentExcludeKeys' | 'ci'
    >();
    expectTypeOf<AgentPreflightSessionControlsCommandV1>()
      .not.toHaveProperty('timeoutMs');
    expectTypeOf<keyof AgentPreflightSessionControlsProbeInputV1>().toEqualTypeOf<
      'accountSettings' | 'environment'
    >();
    expectTypeOf<AgentPreflightSessionControlsProbeContextV1>()
      .not.toHaveProperty('exec');
    expectTypeOf<AgentPreflightSessionControlsProbeContextV1>()
      .not.toHaveProperty('process');
    expectTypeOf<keyof AgentPreflightJsonRpcRequestClientV1>().toEqualTypeOf<'request'>();
    expectTypeOf<AgentPreflightJsonRpcRequestClientV1>()
      .not.toHaveProperty('dispose');
    expectTypeOf<NonNullable<AgentRuntimeRegistrationOptions['terminalPromptSubmitVerification']>>()
      .toEqualTypeOf<AgentTerminalPromptSubmitVerificationPolicyV1>();
    expectTypeOf<keyof AgentTerminalPromptSubmitVerificationPolicyV1>().toEqualTypeOf<
      'shouldVerifyAfterSubmit' | 'verifyBeforeSubmitStaging' | 'verifyAfterSubmit'
    >();
    expectTypeOf<AgentTerminalPromptSubmitVerificationPolicyV1>()
      .not.toHaveProperty('terminal');
    expectTypeOf<AgentTerminalPromptSubmitVerificationPolicyV1>()
      .not.toHaveProperty('submit');
    expectTypeOf<AgentTerminalPromptSubmitVerificationPolicyV1>()
      .not.toHaveProperty('retry');
    expectTypeOf<NonNullable<AgentRuntimeRegistrationOptions['sessionStartup']>>()
      .toEqualTypeOf<AgentSessionStartupContributionV1>();
    expectTypeOf<keyof AgentSessionStartupContributionV1>()
      .toEqualTypeOf<'shouldUseDeferredBootstrap'>();
    expectTypeOf<keyof AgentDeferredStartupEligibilityInputV1>().toEqualTypeOf<
      | 'startedBy'
      | 'startingMode'
      | 'hasExistingSession'
      | 'hasSessionAttachFile'
      | 'hasProviderResumeId'
      | 'hasExplicitPermissionMode'
      | 'hasPersistedPermissionModeSeed'
      | 'hasTerminalTty'
    >();
    expectTypeOf<AgentDeferredStartupEligibilityInputV1>()
      .not.toHaveProperty('existingSessionId');
    expectTypeOf<AgentDeferredStartupEligibilityInputV1>()
      .not.toHaveProperty('sessionAttachFilePath');
    expectTypeOf<AgentDeferredStartupEligibilityInputV1>()
      .not.toHaveProperty('providerResumeId');
    expectTypeOf<NonNullable<AgentRuntimeRegistrationOptions['vendorResumeSupport']>>()
      .toEqualTypeOf<AgentExperimentalVendorResumeSupportContributionV1>();
    expectTypeOf<keyof AgentExperimentalVendorResumeSupportContributionV1>()
      .toEqualTypeOf<'supportsVendorResume'>();
    expectTypeOf<keyof AgentExperimentalVendorResumeSupportInputV1>()
      .toEqualTypeOf<'agentRuntimeSelection' | 'runtimeDescriptorV1'>();
    expectTypeOf<AgentDaemonSpawnRuntimeSelectionV1>()
      .toHaveProperty('connectedServices');
    expectTypeOf<AgentDaemonSpawnRuntimeSelectionV1>()
      .toHaveProperty('tools');
    expectTypeOf<AgentDaemonSpawnRuntimeSelectionV1>()
      .toHaveProperty('agentRuntimeSelection');
    expectTypeOf<AgentDaemonSpawnRuntimeSelectionV1>()
      .toHaveProperty('hasExternalModelBinding');
    expectTypeOf<AgentDaemonSpawnRuntimeSelectionV1>()
      .not.toHaveProperty('providerRuntimeSelection');
    expectTypeOf<AgentDaemonSpawnRuntimeSelectionV1>()
      .not.toHaveProperty('providerBinding');
    expectTypeOf<AgentDaemonSpawnRuntimeSelectionV1>()
      .not.toHaveProperty('daemon');
    expectTypeOf<AgentDaemonSpawnRuntimeSelectionV1>()
      .not.toHaveProperty('process');
    expectTypeOf<AgentDaemonSpawnConnectedServicesV1['v']>().toEqualTypeOf<1>();
  });

  it('projects the registration and locator types through the normal Agent runtime surface', () => {
    const agentRuntimeSurface = new Set<string>(
      readAuthorSurfaceContract().exports['./agents/runtime'],
    );

    expect([
      'AgentRuntimeRegistrationOptions',
      'AgentSessionRunnerFactoryLocatorV1',
      'AgentDaemonSpawnHooks',
      'AgentDaemonSpawnRuntimeSelectionV1',
      'AgentDaemonSpawnConnectedServicesV1',
    ].filter((name) => !agentRuntimeSurface.has(name))).toEqual([]);
  });
});
