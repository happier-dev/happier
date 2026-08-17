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
  AgentExecutionRunRuntimeFactory,
  AgentRuntime,
  AgentRuntimeFactory,
  AgentRuntimeRegistrationOptions,
  AgentSessionRunnerFactoryLocatorV1,
  AgentSessionRuntimeFactory,
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

  it('carries the locator through the one Agent registration options object', () => {
    expectTypeOf<keyof AgentRuntimeRegistrationOptions>().toEqualTypeOf<
      'providerBinding' | 'sessionRunnerFactory'
    >();
    expectTypeOf<NonNullable<AgentRuntimeRegistrationOptions['sessionRunnerFactory']>>()
      .toEqualTypeOf<AgentSessionRunnerFactoryLocatorV1>();
  });

  it('projects the registration and locator types through the normal Agent runtime surface', () => {
    const agentRuntimeSurface = new Set<string>(
      readAuthorSurfaceContract().exports['./agents/runtime'],
    );

    expect([
      'AgentRuntimeRegistrationOptions',
      'AgentSessionRunnerFactoryLocatorV1',
    ].filter((name) => !agentRuntimeSurface.has(name))).toEqual([]);
  });
});
