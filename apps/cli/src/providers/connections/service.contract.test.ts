import { describe, expectTypeOf, it } from 'vitest';
import type {
  DaemonProviderConnectionsDescribeResponseV1,
  DaemonProviderConnectionViewV1,
} from '@happier-dev/protocol/rpc';

import type { ProviderConnectionDescription, ProviderConnectionView } from './service/types';

type DescribeSuccess = Extract<DaemonProviderConnectionsDescribeResponseV1, { status: 'success' }>;

describe('provider connection service contracts', () => {
  it('derives connection views and successful descriptions from the RPC contract', () => {
    expectTypeOf<ProviderConnectionView>().toEqualTypeOf<DaemonProviderConnectionViewV1>();
    expectTypeOf<ProviderConnectionDescription>().toEqualTypeOf<Omit<DescribeSuccess, 'status'>>();
  });
});
