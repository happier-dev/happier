import { definePlugin } from '@happier-dev/plugin-sdk';
import {
  defineContributionPoint,
  defineContributionProtocol,
} from '@happier-dev/plugin-sdk/contributions';
import {
  defineProtocolObject,
} from '@happier-dev/plugin-sdk/protocol';

type Equal<TLeft, TRight> = (<T>() => T extends TLeft ? 1 : 2) extends (<T>() => T extends TRight ? 1 : 2)
  ? true
  : false;
type Expect<T extends true> = T;

const resultSchema = defineProtocolObject({}, { policy: 'closed' });

const providersV1 = defineContributionProtocol({
  id: 'example.providers',
  version: 1,
  operations: {
    setup: {
      required: true,
      input: { kind: 'contributorDefined' },
      resultSchema,
      action: { surfaces: ['plugin'], dangerLevel: 'safe' },
    },
  },
});

const providersV2 = defineContributionProtocol({
  id: 'example.providers',
  version: 2,
  operations: {
    deliver: {
      required: true,
      input: { kind: 'contributorDefined' },
      resultSchema,
      action: { surfaces: ['plugin'], dangerLevel: 'safe' },
    },
  },
});

export const contributionTarget = definePlugin({
  id: 'example.targeted-contributions',
  version: '0.1.0',
  contributionPoints: {
    providers: defineContributionPoint([providersV1, providersV2], {
      maxContributionsPerContributor: 1,
    }),
  },
});

type _V1Operations = Expect<Equal<keyof typeof providersV1.operations, 'setup'>>;
type _V2Operations = Expect<Equal<keyof typeof providersV2.operations, 'deliver'>>;
type V1Point = typeof contributionTarget.contributionPoints.providers.protocols[0];
type V2Point = typeof contributionTarget.contributionPoints.providers.protocols[1];
type _V1PointIdentity = Expect<Equal<V1Point['id'], 'providers'>>;
type _V2PointIdentity = Expect<Equal<V2Point['id'], 'providers'>>;
type _V1ProtocolShape = Expect<V1Point['protocol'] extends Readonly<{
  id: string;
  version: number;
}> ? true : false>;
type _V2ProtocolShape = Expect<V2Point['protocol'] extends Readonly<{
  id: string;
  version: number;
}> ? true : false>;
