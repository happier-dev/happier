import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  createScmCapabilities,
  createScmCapabilitiesFromBackendCapabilities,
} from './capabilities.js';
import {
  ScmBackendCapabilitiesSchema,
  supportedCapability,
  unsupportedCapability,
  type ScmBackendCapabilities,
  type ScmBackendCapabilityLeaf,
  type ScmBackendCapabilityUnavailableReason,
} from './backendCapabilities.js';
import {
  ScmHostingProviderKindSchema,
  resolveScmHostingProviderFollowupAllowedBaseUrl,
  type ScmHostingProviderKind,
  type ScmHostingProviderRef,
} from './pullRequests.js';
import { resolveScmScopedChangedPaths } from './pathScope.js';
import { SCM_WORKTREE_REMOVE_AUTHORIZATION_TOKEN } from './worktrees.js';
import {
  ScmBackendContributionSchema,
  type ScmBackendContribution,
} from '../plugins/contributions/scmBackends.js';

import * as narrowScm from './index.js';
import type {
  ScmBackendCapabilities as NarrowScmBackendCapabilities,
  ScmBackendCapabilityLeaf as NarrowScmBackendCapabilityLeaf,
  ScmBackendCapabilityUnavailableReason as NarrowScmBackendCapabilityUnavailableReason,
  ScmBackendContribution as NarrowScmBackendContribution,
  ScmHostingProviderKind as NarrowScmHostingProviderKind,
  ScmHostingProviderRef as NarrowScmHostingProviderRef,
} from './index.js';

describe('@happier-dev/protocol/scm narrow exports', () => {
  it('re-exports portable SDK projections from their canonical source owners', () => {
    expect(narrowScm.createScmCapabilities).toBe(createScmCapabilities);
    expect(narrowScm.createScmCapabilitiesFromBackendCapabilities)
      .toBe(createScmCapabilitiesFromBackendCapabilities);
    expect(narrowScm.resolveScmScopedChangedPaths).toBe(resolveScmScopedChangedPaths);
    expect(narrowScm.SCM_WORKTREE_REMOVE_AUTHORIZATION_TOKEN)
      .toBe(SCM_WORKTREE_REMOVE_AUTHORIZATION_TOKEN);
    expect(narrowScm.ScmBackendCapabilitiesSchema).toBe(ScmBackendCapabilitiesSchema);
    expect(narrowScm.ScmBackendContributionSchema).toBe(ScmBackendContributionSchema);
    expect(narrowScm.supportedCapability).toBe(supportedCapability);
    expect(narrowScm.unsupportedCapability).toBe(unsupportedCapability);
    expect(narrowScm.ScmHostingProviderKindSchema).toBe(ScmHostingProviderKindSchema);
    expect(narrowScm.resolveScmHostingProviderFollowupAllowedBaseUrl)
      .toBe(resolveScmHostingProviderFollowupAllowedBaseUrl);
  });

  it('preserves the canonical SCM projection type identities', () => {
    expectTypeOf<NarrowScmBackendCapabilities>().toEqualTypeOf<ScmBackendCapabilities>();
    expectTypeOf<NarrowScmBackendCapabilityLeaf>().toEqualTypeOf<ScmBackendCapabilityLeaf>();
    expectTypeOf<NarrowScmBackendCapabilityUnavailableReason>()
      .toEqualTypeOf<ScmBackendCapabilityUnavailableReason>();
    expectTypeOf<NarrowScmBackendContribution>().toEqualTypeOf<ScmBackendContribution>();
    expectTypeOf<NarrowScmHostingProviderKind>().toEqualTypeOf<ScmHostingProviderKind>();
    expectTypeOf<NarrowScmHostingProviderRef>().toEqualTypeOf<ScmHostingProviderRef>();
  });
});
