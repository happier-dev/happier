import type { ScmHostingProviderKind } from './pullRequests.js';
import type {
  normalizeScmHostingRepositoryIdentity,
  ScmHostingRepositoryIdentityV1,
} from './hostingRepositoryIdentity.js';

type Assert<Condition extends true> = Condition;

type ExpectedNormalizer = {
  <TKind extends ScmHostingProviderKind>(
    value: Readonly<{
      kind: TKind;
      deployment?: unknown;
      repository?: unknown;
    }>,
  ): ScmHostingRepositoryIdentityV1<TKind> | null;
  (
    value: Readonly<{
      kind?: unknown;
      deployment?: unknown;
      repository?: unknown;
    }> | null | undefined,
  ): ScmHostingRepositoryIdentityV1 | null;
};

type _NormalizerPreservesValidatedKindLiteralsAndKeepsUntypedInputBroad = Assert<
  typeof normalizeScmHostingRepositoryIdentity extends ExpectedNormalizer ? true : false
>;

export type {};
