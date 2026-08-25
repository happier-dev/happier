import { definePlugin } from '@happier-dev/plugin-sdk';
import {
  defineContributionPoint,
  defineContributionProtocol,
  type ContributionPointAuthorDefinition,
} from '@happier-dev/plugin-sdk/contributions';
import {
  defineProtocolObject,
} from '@happier-dev/plugin-sdk/protocol';

const resultSchema = defineProtocolObject({}, { policy: 'closed' });

const protocol = defineContributionProtocol({
  id: 'example.declaration-target',
  version: 1,
  operations: {
    inspect: {
      required: true,
      input: { kind: 'contributorDefined' },
      resultSchema,
      action: { surface: 'plugin', dangerLevel: 'safe' },
    },
  },
});

export const contributionTarget = definePlugin({
  id: 'example.declaration-target',
  version: '0.1.0',
  contributionPoints: {
    providers: defineContributionPoint([protocol]),
  },
});

type Equal<TLeft, TRight> = (<T>() => T extends TLeft ? 1 : 2) extends (<T>() => T extends TRight ? 1 : 2)
  ? true
  : false;
type Expect<T extends true> = T;

// An explicit protocol tuple is the only annotation that can carry the point's
// operation/surface contract, so annotating a helper result must keep exact
// inference all the way through `definePlugin`.
const annotatedPoint: ContributionPointAuthorDefinition<readonly [typeof protocol]> =
  defineContributionPoint([protocol]);

export const annotatedContributionTarget = definePlugin({
  id: 'example.annotated-declaration-target',
  version: '0.1.0',
  contributionPoints: {
    providers: annotatedPoint,
  },
});

type AnnotatedPoint = typeof annotatedContributionTarget.contributionPoints.providers;
type _AnnotatedPointId = Expect<Equal<AnnotatedPoint['id'], 'providers'>>;
type _AnnotatedProtocolId = Expect<Equal<AnnotatedPoint['protocol']['id'], 'example.declaration-target'>>;
type _AnnotatedProtocolVersion = Expect<Equal<AnnotatedPoint['protocol']['version'], 1>>;

// A bare annotation must fail loudly. With a defaulted protocol tuple it is
// silently widened to `readonly unknown[]`, which erases the operation/surface
// contract while still compiling — the exact API-inference loss this fixture guards.
// @ts-expect-error the protocol tuple is required; it cannot be defaulted away.
const _bareAnnotation: ContributionPointAuthorDefinition = defineContributionPoint([protocol]);
